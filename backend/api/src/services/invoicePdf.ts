/**
 * Reads a text-based invoice PDF without AI: invoice number, date, seller, GSTIN, total and tax
 * are taken from their printed labels. Nothing is guessed. When the number or the total cannot
 * be found, or the file holds several invoices, nothing is returned so the caller can ask AI
 * or tell the person plainly. Values read here are always "pending review".
 */
import { PDFParse } from "pdf-parse";
import { normalizeAmount, normalizeDate } from "./bankStatement";
import type { InvoiceRow } from "./invoiceVerify";

export const PDF_READ_LABEL = "Read from PDF — pending review" as const;

const DATE_TOKEN = "(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}|\\d{1,2}[\\s\\-/.]+[A-Za-z]{3,9}[\\s\\-/.,]+\\d{2,4})";
const NUMBER_TOKEN = "([A-Za-z0-9][A-Za-z0-9\\-/_.]{1,29})";
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/;
const MONEY_TOKEN = /(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d{3,})(?!\d)/gi;

function moneyTokens(line: string): number[] {
  const out: number[] = [];
  for (const match of line.matchAll(MONEY_TOKEN)) {
    const value = normalizeAmount(match[1]);
    if (value != null && Number.isFinite(value)) out.push(Math.abs(value));
  }
  return out;
}

function clean(text: string) {
  return text.replace(/\t+/g, "  ").replace(/[  ]+/g, " ").trim();
}

const NOT_A_NUMBER = /^(date|dated|no|number|of|to|from|the|details|ref|reference|and|for|issue|period|total|amount|value|type|copy|original|duplicate)$/i;

function invoiceNumbers(lines: string[]): string[] {
  const found: string[] = [];
  const patterns = [
    new RegExp(`\\b(?:tax\\s+)?invoice\\s*(?:no|number|num|#)\\.?\\s*[:#\\-]?\\s*${NUMBER_TOKEN}`, "i"),
    new RegExp(`\\b(?:bill|inv)\\s*(?:no|number)\\.?\\s*[:#\\-]?\\s*${NUMBER_TOKEN}`, "i"),
    new RegExp(`\\binv(?:oice)?\\s*[#:]\\s*${NUMBER_TOKEN}`, "i"),
    // A title line that ends with the number: "TAX INVOICE - INV-2026-001".
    new RegExp(`\\b(?:tax\\s+invoice|purchase\\s+invoice|vendor\\s+bill|invoice|bill\\s+of\\s+supply)\\b[^\\n]{0,40}?\\s[-–:#]\\s*${NUMBER_TOKEN}\\s*$`, "i"),
  ];
  const accept = (value: string | undefined) => {
    const token = (value ?? "").replace(/[.,;:]+$/, "");
    // A date or a currency word is not a number.
    if (!token || NOT_A_NUMBER.test(token) || !/\d/.test(token) || /^(inr|rs)$/i.test(token) || normalizeDate(token)) return;
    if (!found.includes(token)) found.push(token);
  };
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        accept(match[1]);
        return;
      }
    }
    // "Invoice No." on one line, the value on the next.
    if (/\b(?:tax\s+)?invoice\s*(?:no|number|num)\.?\s*[:#\-]?\s*$/i.test(line) && lines[index + 1]) {
      const next = lines[index + 1].match(new RegExp(`^${NUMBER_TOKEN}\\b`));
      accept(next?.[1]);
    }
  });
  return found;
}

function invoiceDate(lines: string[]): string | null {
  const labelled = [
    new RegExp(`invoice\\s*date\\s*[:\\-]?\\s*${DATE_TOKEN}`, "i"),
    new RegExp(`\\b(?:bill\\s*)?dated?\\s*[:\\-]?\\s*${DATE_TOKEN}`, "i"),
    new RegExp(`\\bdate\\s*[:\\-]?\\s*${DATE_TOKEN}`, "i"),
  ];
  for (const pattern of labelled) {
    for (const line of lines) {
      if (/due\s*date|ship|delivery|order\s*date|po\s*date|supply/i.test(line) && !/invoice\s*date/i.test(line)) continue;
      const match = line.match(pattern);
      const date = match ? normalizeDate(match[1]) : null;
      if (date) return date;
    }
  }
  return null;
}

const BUYER_LABEL = /bill(?:ed)?\s*to|ship(?:ped)?\s*to|buyer|customer|consignee|recipient|sold\s*to|party\s*details/i;
const SELLER_LABEL = /supplier|vendor|seller|sold\s*by|\bfrom\b/i;

function gstins(lines: string[]): { seller: string | null; buyer: string | null } {
  let seller: string | null = null;
  let buyer: string | null = null;
  let buyerWindow = 0;
  for (const line of lines) {
    // "Supplier / Vendor   Customer / Bill To" names both sides at once; their order then says which is which.
    if (BUYER_LABEL.test(line) && !SELLER_LABEL.test(line)) buyerWindow = 6;
    const match = line.toUpperCase().match(GSTIN);
    if (match) {
      if (buyerWindow > 0 || /buyer|customer|recipient|consignee/i.test(line)) buyer ??= match[0];
      else if (seller && match[0] !== seller) buyer ??= match[0];
      else seller ??= match[0];
    }
    if (buyerWindow > 0) buyerWindow -= 1;
  }
  return { seller, buyer };
}

const NAME_REJECT = /tax\s+invoice|invoice|original|duplicate|triplicate|bill\s+of\s+supply|gstin|gst\s*no|\bpan\b|phone|mobile|\btel\b|email|e-mail|www\.|@|page\s*\d|^\d|irn|ack\s*no|e-?way|cin\b|state\s*name|place\s+of\s+supply/i;
const NAME_HINT = /\b(pvt|private|ltd|limited|llp|traders?|enterprises?|solutions?|services?|industries|corporation|company|co\.|stores?|agency|agencies|associates|technologies|systems|infotech|exports?|imports?|marketing|distributors?|suppliers?|works|sons|brothers|mart)\b/i;

const ADDRESS_LINE = /^address\b|\bstreet\b|\broad\b|\bnagar\b|\bpark\b|\bfloor\b|\b\d{6}\b|^(?:supplier|vendor|customer|bill\s*to)\b/i;

/** The business name printed just above its GSTIN: the 1st GSTIN is the seller's, the 2nd the buyer's. */
function nameAboveGstin(lines: string[], nth: 0 | 1): string | null {
  const at = lines.map((line, index) => (GSTIN.test(line.toUpperCase()) ? index : -1)).filter(index => index >= 0);
  const index = at[nth];
  if (index == null) return null;
  const above = lines.slice(Math.max(0, index - 3), index).reverse().filter(line => line.length >= 3 && /[A-Za-z]{3}/.test(line) && !NAME_REJECT.test(line) && !ADDRESS_LINE.test(line));
  return (above.find(line => NAME_HINT.test(line)) ?? above[0])?.slice(0, 120) ?? null;
}

function sellerName(lines: string[]): string | null {
  // A heading that names both sides ("Supplier / Vendor   Customer / Bill To") holds no name itself.
  const labelled = lines.findIndex(line => /^(sold\s*by|seller|supplier|from|vendor)\b\s*[:\-]?/i.test(line) && !BUYER_LABEL.test(line));
  if (labelled >= 0) {
    const inline = lines[labelled].replace(/^(sold\s*by|seller|supplier|from|vendor)\b\s*[:\-]?\s*/i, "").trim();
    const value = inline || lines[labelled + 1]?.trim() || "";
    if (value && !NAME_REJECT.test(value)) return value.slice(0, 120);
  }
  const byGstin = nameAboveGstin(lines, 0);
  if (byGstin) return byGstin;
  const top = lines.slice(0, 12).filter(line => line.length >= 3 && /[A-Za-z]{3}/.test(line) && !NAME_REJECT.test(line));
  return (top.find(line => NAME_HINT.test(line)) ?? top[0])?.slice(0, 120) ?? null;
}

function customerName(lines: string[]): string | null {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(?:bill(?:ed)?\s*to|buyer|customer(?:\s*name)?|sold\s*to|consignee)\b\s*(?:\(.*?\))?\s*[:\-]?\s*(.*)$/i);
    if (!match) continue;
    const value = match[1].trim() || lines[index + 1]?.trim() || "";
    if (value && !GSTIN.test(value.toUpperCase()) && !NAME_REJECT.test(value) && !SELLER_LABEL.test(value)) return value.slice(0, 120);
  }
  return nameAboveGstin(lines, 1);
}

const STRONG_TOTAL = /grand\s*total|invoice\s*(?:total|value|amount)|total\s*invoice\s*(?:value|amount)|net\s*(?:amount\s*)?payable|amount\s*payable|total\s*amount|total\s*payable|amount\s*due|balance\s*due|total\s*value/i;
const NOT_A_TOTAL = /before\s*tax|excl|taxable|sub\s*-?\s*total|total\s*(?:tax|gst|cgst|sgst|igst|cess|discount|qty|quantity|units|items|weight)|in\s*words|round\s*off|tcs|tds/i;

function invoiceTotal(lines: string[]): number | null {
  const strong: number[] = [];
  const weak: number[] = [];
  lines.forEach((line, index) => {
    if (NOT_A_TOTAL.test(line) && !/grand\s*total/i.test(line)) return;
    const isStrong = STRONG_TOTAL.test(line);
    const isWeak = !isStrong && /\btotal\b/i.test(line);
    if (!isStrong && !isWeak) return;
    // The amount sits after the label; the value may also be on the next line.
    const label = line.match(isStrong ? STRONG_TOTAL : /\btotal\b/i);
    const after = label ? line.slice((label.index ?? 0) + label[0].length) : line;
    let values = moneyTokens(after);
    if (values.length === 0 && lines[index + 1] && moneyTokens(lines[index + 1]).length > 0 && !/[A-Za-z]{4}/.test(lines[index + 1])) values = moneyTokens(lines[index + 1]);
    if (values.length === 0) return;
    (isStrong ? strong : weak).push(values[values.length - 1]);
  });
  const pool = strong.length > 0 ? strong : weak;
  if (pool.length === 0) return null;
  const value = Math.max(...pool);
  return value > 0 ? Math.round(value * 100) / 100 : null;
}

function invoiceTax(lines: string[]): number | null {
  const total = lines
    .filter(line => /total\s*(?:tax|gst)|tax\s*amount|gst\s*amount|total\s*tax\s*amount/i.test(line) && !/in\s*words/i.test(line))
    .map(line => moneyTokens(line).pop())
    .filter((value): value is number => value != null);
  if (total.length > 0) return Math.max(...total);
  // "GST INR 18,000.00" on its own line under the subtotal.
  const plain = lines
    .filter(line => /^(?:total\s+)?(?:gst|tax)\b(?![^0-9]*%)/i.test(line) && !/in\s*words/i.test(line))
    .map(line => moneyTokens(line).pop())
    .filter((value): value is number => value != null);
  if (plain.length > 0) return Math.max(...plain);
  let sum = 0;
  let seen = false;
  for (const kind of ["cgst", "sgst", "igst"]) {
    const values = lines
      .filter(line => new RegExp(`\\b${kind}\\b`, "i").test(line))
      .map(line => moneyTokens(line.replace(/@?\s*\d+(?:\.\d+)?\s*%/g, " ")).pop())
      .filter((value): value is number => value != null);
    if (values.length > 0) {
      sum += Math.max(...values);
      seen = true;
    }
  }
  return seen ? Math.round(sum * 100) / 100 : null;
}

/**
 * Invoices that print "Supplier / Vendor   Customer / Bill To" side by side come out of a PDF as two
 * blocks in reading order, each ending at its "Address" line. A side with no GSTIN stays without one.
 */
function twoColumnParties(lines: string[]): { seller: { name: string | null; gstin: string | null }; buyer: { name: string | null; gstin: string | null } } | null {
  const head = lines.findIndex(line => SELLER_LABEL.test(line) && BUYER_LABEL.test(line));
  if (head < 0) return null;
  const blocks: string[][] = [[]];
  for (let index = head + 1; index < lines.length && blocks.length <= 2; index += 1) {
    const line = lines[index];
    if (/^(description|sl\.?\s*no|s\.?\s*no|item|particulars)\b/i.test(line)) break;
    blocks[blocks.length - 1].push(line);
    if (/^address\b/i.test(line)) blocks.push([]);
  }
  const read = (block: string[]) => ({
    name: block.find(line => !GSTIN.test(line.toUpperCase()) && !/^(gstin|address|pan|state)\b/i.test(line) && /[A-Za-z]{3}/.test(line))?.slice(0, 120) ?? null,
    gstin: block.map(line => line.toUpperCase().match(GSTIN)?.[0]).find(Boolean) ?? null,
  });
  if (blocks.length < 2 || blocks[0].length === 0 || blocks[1].length === 0) return null;
  return { seller: read(blocks[0]), buyer: read(blocks[1]) };
}

/** Pure: invoice text in, at most one invoice out. */
export function extractInvoicesFromText(text: string): InvoiceRow[] {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  if (lines.length < 3) return [];
  const numbers = invoiceNumbers(lines);
  // Several different invoice numbers: this is a bundle, not one invoice. Never pick one at random.
  if (numbers.length !== 1) return [];
  const total = invoiceTotal(lines);
  if (total == null) return [];
  const gst = gstins(lines);
  const sides = twoColumnParties(lines);
  return [{
    invoiceNumber: numbers[0],
    invoiceDate: invoiceDate(lines),
    vendorName: sides?.seller.name ?? sellerName(lines) ?? "Unknown vendor",
    vendorGstin: sides ? sides.seller.gstin : gst.seller,
    customerName: sides?.buyer.name ?? customerName(lines),
    total,
    tax: invoiceTax(lines),
    rowNumber: 1,
    label: PDF_READ_LABEL,
  }];
}

export type PdfText = { status: "ok"; text: string } | { status: "locked" } | { status: "no_text" } | { status: "unreadable" };

/** The text layer of a PDF, if it has one. Scans have none and are left to OCR or AI. */
export async function readPdfText(buffer: Buffer): Promise<PdfText> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    try {
      await parser.getInfo();
    } catch (err) {
      return /password/i.test(err instanceof Error ? `${err.name} ${err.message}` : String(err)) ? { status: "locked" } : { status: "unreadable" };
    }
    const result = await parser.getText();
    const text = result.text ?? "";
    return text.replace(/\s/g, "").length < 40 ? { status: "no_text" } : { status: "ok", text };
  } catch {
    return { status: "unreadable" };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
