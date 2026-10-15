/**
 * Reads whatever a CA can export from Tally: Excel, CSV, XML, HTML or a printed PDF.
 * Every format ends as the same TallyRow list the comparison already understands.
 * Nothing here uses AI. A PDF is read by column position and, when Tally printed totals,
 * the rows are added up and compared with them; a difference is reported, never hidden.
 */
import { PDFParse } from "pdf-parse";
import { normalizeAmount, normalizeDate } from "./bankStatement";
import { UnreadableFileError, extensionOf, sheetToCsvText, type UploadedFile } from "./fileDetect";
import { isDate, loadRows, money, rowText, type Item, type PdfDocument, type Row } from "./pdfStatement";
import { parseTallyLedgerCsv, type TallyRow } from "./statementCompare";

export type TallySource = "sheet" | "pdf" | "xml" | "html";

export interface TallyRead {
  ok: boolean;
  rows: TallyRow[];
  source: TallySource | "none";
  /** Shown to the person when ok is false. */
  message: string;
  /** Plain remarks about how the file was read (a ledger chosen, totals that did not add up). */
  notes: string[];
}

export const TALLY_FORMATS = "Excel, CSV, XML, HTML or PDF";
const NO_ENTRIES = `No entries were found in this Tally file. Export the bank ledger or Day Book from Tally as ${TALLY_FORMATS} and try again.`;

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function ok(rows: TallyRow[], source: TallySource, notes: string[] = []): TallyRead {
  return { ok: true, rows, source, message: "", notes };
}

function fail(message: string, extra: Partial<TallyRead> = {}): TallyRead {
  return { ok: false, rows: [], source: "none", message, notes: [], ...extra };
}

// ── PDF ─────────────────────────────────────────────────────────────────────

type Kind = "date" | "particulars" | "vchType" | "vchNo" | "debit" | "credit" | "amount";

function classify(label: string): Kind | null {
  const text = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (/vch\.?\s*type|voucher\s*type/.test(text)) return "vchType";
  if (/vch\.?\s*no|voucher\s*(no|num)/.test(text)) return "vchNo";
  if (/debit/.test(text)) return "debit";
  if (/credit/.test(text)) return "credit";
  if (/particular|ledger|account/.test(text)) return "particulars";
  if (/^date$/.test(text)) return "date";
  if (/^amount$/.test(text)) return "amount";
  return null;
}

interface Header {
  cols: Partial<Record<Kind, Item>>;
  /** Money to the right of this is in an amount column. */
  amountStart: number;
  amounts: Array<{ kind: "debit" | "credit" | "amount"; center: number; max: number }>;
  particularsLeft: number;
  vchTypeLeft: number | null;
  vchNoLeft: number | null;
}

function headerOf(items: Item[]): Header | null {
  const cols: Partial<Record<Kind, Item>> = {};
  for (const item of items) {
    const kind = classify(item.text);
    if (kind && !cols[kind]) cols[kind] = item;
  }
  if (!cols.date || !cols.particulars) return null;
  if (!cols.vchType && !cols.vchNo) return null;
  if (!cols.debit && !cols.credit && !cols.amount) return null;
  const amountCols = (["debit", "credit", "amount"] as const).filter(kind => cols[kind]).map(kind => ({ kind, item: cols[kind] as Item }));
  amountCols.sort((a, b) => (a.item.left + a.item.right) - (b.item.left + b.item.right));
  const textRights = [cols.particulars, cols.vchType, cols.vchNo].filter((item): item is Item => Boolean(item)).map(item => item.right);
  const firstAmount = amountCols[0].item;
  const amountStart = (Math.max(...textRights) + firstAmount.left) / 2;
  const centerOf = (item: Item) => (item.left + item.right) / 2;
  const amounts = amountCols.map((column, index) => ({
    kind: column.kind,
    center: centerOf(column.item),
    max: index < amountCols.length - 1 ? (centerOf(column.item) + centerOf(amountCols[index + 1].item)) / 2 : Infinity,
  }));
  return {
    cols,
    amountStart,
    amounts,
    particularsLeft: cols.particulars.left,
    vchTypeLeft: cols.vchType?.left ?? null,
    vchNoLeft: cols.vchNo?.left ?? null,
  };
}

/** A header split over two lines ("Vch" above "Type") is joined by horizontal overlap. */
function combine(top: Item[], bottom: Item[]): Item[] {
  const combined = top.map(item => ({ ...item }));
  for (const item of bottom) {
    const over = combined.find(cell => item.left < cell.right + 2 && item.right > cell.left - 2);
    if (over) {
      over.text = `${over.text} ${item.text}`;
      over.left = Math.min(over.left, item.left);
      over.right = Math.max(over.right, item.right);
    } else {
      combined.push({ ...item });
    }
  }
  return combined.sort((a, b) => a.left - b.left);
}

function findHeader(rows: Row[], from: number, page: number): { header: Header; next: number } | null {
  for (let index = from; index < rows.length && rows[index].page === page; index += 1) {
    const single = headerOf(rows[index].items);
    if (single) return { header: single, next: index + 1 };
    const below = rows[index + 1];
    if (below && below.page === page && rows[index].y - below.y <= 14) {
      const joined = headerOf(combine(rows[index].items, below.items));
      if (joined) return { header: joined, next: index + 2 };
    }
  }
  return null;
}

interface Draft {
  page: number;
  date: string;
  ledger: string;
  narration: string[];
  voucherType: string;
  voucherNo: string;
  debit: number | null;
  credit: number | null;
}

const SKIP_LINE = /^(page\s*\d+|\d+\s*of\s*\d+|continued\b|printed\b|powered by|tallyprime|tally\.erp)/i;
const BALANCE_LINE = /opening\s+balance|closing\s+balance|carried\s+(over|forward)|brought\s+forward|balance\s+(b|c)\/?f/i;
const TOTAL_LINE = /^(grand\s+)?total\b|^total\s+(of|for)\b/i;

function amountsOf(items: Item[], header: Header): { debit: number | null; credit: number | null; seen: boolean } {
  const out: { debit: number | null; credit: number | null; seen: boolean } = { debit: null, credit: null, seen: false };
  for (const item of items) {
    const value = money(item.text);
    if (!value) continue;
    const mid = (item.left + item.right) / 2;
    if (mid < header.amountStart) continue;
    const zone = header.amounts.find(candidate => mid < candidate.max) ?? header.amounts[header.amounts.length - 1];
    out.seen = true;
    if (zone.kind === "debit") out.debit = value.value;
    else if (zone.kind === "credit") out.credit = value.value;
    // One "Amount" column carries Dr/Cr in the amount or beside it.
    else if (value.suffix === "cr") out.credit = value.value;
    else out.debit = value.value;
  }
  return out;
}

function interpretPdf(rows: Row[]): { rows: TallyRow[]; notes: string[]; headerFound: boolean } {
  const drafts: Draft[] = [];
  const printed: { debit: number | null; credit: number | null } = { debit: null, credit: null };
  const opening = { debit: 0, credit: 0 };
  const closing = { debit: 0, credit: 0 };
  let header: Header | null = null;
  let current: Draft | null = null;
  let carriedDate = "";
  let totalLines = 0;

  const close = () => {
    if (current) drafts.push(current);
    current = null;
  };

  const pages = [...new Set(rows.map(row => row.page))];
  for (const page of pages) {
    close();
    const start = rows.findIndex(row => row.page === page);
    const found = findHeader(rows, start, page);
    if (found) header = found.header;
    if (!header) continue;
    const bodyStart = found ? found.next : start;
    for (let index = bodyStart; index < rows.length && rows[index].page === page; index += 1) {
      const row = rows[index];
      const text = rowText(row).trim();
      if (!text || SKIP_LINE.test(text)) continue;
      const amounts = amountsOf(row.items, header);
      const left = row.items.filter(item => (item.left + item.right) / 2 < header!.amountStart);

      // Opening and closing balances are not entries; their amounts only help prove the totals.
      if (BALANCE_LINE.test(text)) {
        close();
        const side = /opening|brought/i.test(text) ? opening : closing;
        side.debit += amounts.debit ?? 0;
        side.credit += amounts.credit ?? 0;
        continue;
      }
      if (TOTAL_LINE.test(text) && amounts.seen) {
        close();
        // The last total printed is the grand total; page totals before it are not summed.
        totalLines += 1;
        printed.debit = amounts.debit ?? printed.debit;
        printed.credit = amounts.credit ?? printed.credit;
        continue;
      }

      const dateItem = left.find(item => isDate(item.text) && item.left < header!.particularsLeft + 4);
      const particulars: string[] = [];
      const type: string[] = [];
      const number: string[] = [];
      for (const item of left) {
        if (item === dateItem) continue;
        if (item.left < header.particularsLeft - 6) continue;
        if (header.vchNoLeft != null && item.left >= header.vchNoLeft - 6) number.push(item.text);
        else if (header.vchTypeLeft != null && item.left >= header.vchTypeLeft - 6) type.push(item.text);
        else particulars.push(item.text);
      }

      // A standalone "Dr" or "Cr" marker is a side, not part of the name ("Dr Reddy's" stays whole).
      if (particulars.length > 1 && /^(dr|cr)\.?$/i.test(particulars[0])) particulars.shift();
      const date = dateItem ? normalizeDate(dateItem.text) : null;
      // A later voucher of the same day carries no date, but has its own type, number or amount.
      const startsVoucher = Boolean(date)
        || ((type.length > 0 || number.length > 0) && particulars.length > 0)
        || (amounts.seen && particulars.length > 0 && current != null && ((current as Draft).debit != null || (current as Draft).credit != null));
      if (startsVoucher) {
        // Tally prints the date once for a run of vouchers on the same day.
        if (date) carriedDate = date;
        close();
        if (!carriedDate) continue;
        current = {
          page,
          date: carriedDate,
          ledger: particulars.join(" ").trim(),
          narration: [],
          voucherType: type.join(" "),
          voucherNo: number.join(" "),
          debit: amounts.debit,
          credit: amounts.credit,
        };
        continue;
      }
      if (!current) continue;
      // A wrapped line: more narration, or an amount that wrapped below the entry.
      if (current.debit == null && current.credit == null && amounts.seen) {
        current.debit = amounts.debit;
        current.credit = amounts.credit;
      }
      if (particulars.length > 0) current.narration.push(particulars.join(" ").trim());
    }
    close();
  }

  const entries: TallyRow[] = [];
  for (const draft of drafts) {
    const debit = draft.debit != null && draft.debit !== 0 ? Math.abs(draft.debit) : null;
    const credit = draft.credit != null && draft.credit !== 0 ? Math.abs(draft.credit) : null;
    const ledgerName = draft.ledger.replace(/^(to|by)\s+/i, "").trim();
    if (!ledgerName || (debit == null && credit == null)) continue;
    entries.push({
      id: `tally-${entries.length + 1}`,
      date: draft.date,
      ledgerName,
      voucherNumber: draft.voucherNo.trim() || null,
      debit,
      credit,
      narration: draft.narration.join(" ").replace(/\s{2,}/g, " ").trim(),
      rowNumber: entries.length + 1,
    });
  }

  const notes: string[] = [];
  if (header && entries.length > 0) {
    const sum = (pick: (row: TallyRow) => number | null) => round2(entries.reduce((total, row) => total + (pick(row) ?? 0), 0));
    if (totalLines > 0 && (printed.debit != null || printed.credit != null)) {
      const sides: Array<[string, number | null, number]> = [
        ["Debit", printed.debit, sum(row => row.debit) + opening.debit + closing.debit],
        ["Credit", printed.credit, sum(row => row.credit) + opening.credit + closing.credit],
      ];
      const wrong = sides.filter(([, printedValue, got]) => printedValue != null && Math.abs(round2(got) - printedValue) > 0.01);
      if (wrong.length === 0) notes.push("The entries add up to the totals printed on the Tally PDF.");
      else {
        notes.push(`Potential risk — needs CA review. ${wrong.map(([label, printedValue, got]) => `${label} entries read from the PDF add up to ${round2(got).toFixed(2)} but Tally printed ${(printedValue as number).toFixed(2)}`).join("; ")}. Some entries may not have been read — export from Tally as Excel to be sure.`);
      }
    } else {
      notes.push("This Tally PDF has no printed total, so the entries could not be added up and checked. Compare the count with Tally.");
    }
  }
  return { rows: entries, notes, headerFound: header != null };
}

async function readTallyPdf(file: UploadedFile): Promise<TallyRead> {
  const parser = new PDFParse({ data: new Uint8Array(file.buffer) });
  try {
    try {
      await parser.getInfo();
    } catch (err) {
      const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
      if (/password/i.test(text)) return fail("This Tally PDF is password-protected. Export it from Tally without a password, or as Excel.");
      return fail("This PDF could not be opened. It may be damaged. Export it from Tally again, or use Excel.");
    }
    const doc = (parser as unknown as { doc?: PdfDocument }).doc;
    if (!doc) return fail(NO_ENTRIES);
    const rows = await loadRows(doc);
    const textLength = rows.map(rowText).join("").replace(/\s/g, "").length;
    if (textLength < 40) return fail("This PDF is a scan or picture, so Tally entries cannot be read from it. Export from Tally as Excel, XML or a PDF printed straight from Tally.");
    const read = interpretPdf(rows);
    if (read.rows.length === 0) {
      return fail(read.headerFound
        ? NO_ENTRIES
        : `This PDF does not look like a Tally Day Book or ledger (no Date, Particulars, Vch Type and Debit/Credit columns). Export the bank ledger from Tally as ${TALLY_FORMATS}.`);
    }
    return ok(read.rows, "pdf", read.notes);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

// ── XML ─────────────────────────────────────────────────────────────────────

function decodeXml(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => (Number(code) < 32 ? "" : String.fromCharCode(Number(code))))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

const BANK_LIKE = /\bbank\b|\bbanking\b|\b(?:current|savings|od|cc)\s+a\/?c\b|\boverdraft\b|\b(?:hdfc|icici|sbi|axis|kotak|indusind|idfc|pnb|canara|rbl|idbi|bandhan|federal|hsbc)\b/i;
// Expense and loan ledgers that carry the word "bank" are not the bank account itself.
const NOT_THE_ACCOUNT = /charge|interest|loan|guarantee|commission|\bfees?\b|reconcil|\bgst\b|\btds\b|\bemi\b|credit\s*card|payable|receivable/i;

function isBankLedger(name: string) {
  return BANK_LIKE.test(name) && !NOT_THE_ACCOUNT.test(name);
}

function readTallyXml(text: string, bankHint: string | null | undefined): TallyRead {
  const vouchers = [...text.matchAll(/<VOUCHER\b[^>]*>([\s\S]*?)<\/VOUCHER>/gi)].map(match => match[1]);
  if (vouchers.length === 0) return fail("This XML file has no vouchers in it. In Tally use Export → Format: XML (Data Interchange) on the Day Book or bank ledger.");
  interface Entry { ledger: string; amount: number }
  const parsed = vouchers.map(block => {
    const entries: Entry[] = [...block.matchAll(/<(?:ALL)?LEDGERENTRIES\.LIST>([\s\S]*?)<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi)].flatMap(match => {
      const ledger = tag(match[1], "LEDGERNAME");
      const amount = normalizeAmount(tag(match[1], "AMOUNT"));
      return ledger && amount != null && amount !== 0 ? [{ ledger, amount }] : [];
    });
    return {
      date: normalizeDate(tag(block, "DATE").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")),
      type: tag(block, "VOUCHERTYPENAME"),
      number: tag(block, "VOUCHERNUMBER"),
      narration: tag(block, "NARRATION"),
      party: tag(block, "PARTYLEDGERNAME"),
      cancelled: /^yes$/i.test(tag(block, "ISCANCELLED")) || /^yes$/i.test(tag(block, "ISOPTIONAL")),
      entries,
    };
  });
  const live = parsed.filter(voucher => !voucher.cancelled && voucher.date);
  const cancelled = parsed.length - live.length;

  // The bank ledger: the one named like a bank. A bank name from the statement breaks ties.
  const counts = new Map<string, number>();
  for (const voucher of live) {
    for (const entry of voucher.entries) if (isBankLedger(entry.ledger)) counts.set(entry.ledger, (counts.get(entry.ledger) ?? 0) + 1);
  }
  // No ledger is named like a bank. An export of one ledger has that ledger in nearly every voucher.
  let guessed = false;
  if (counts.size === 0) {
    for (const voucher of live) {
      for (const ledger of new Set(voucher.entries.map(entry => entry.ledger))) counts.set(ledger, (counts.get(ledger) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top || top[1] < live.length * 0.6) {
      return fail("Tally ledger names in this XML do not say which one is the bank. Export the bank ledger itself as Excel or XML, so only its entries are in the file.");
    }
    guessed = true;
  }
  const hint = (bankHint ?? "").toLowerCase().replace(/\s*(bank|ltd\.?|limited)\s*/g, " ").trim();
  const ranked = [...counts.entries()].sort((a, b) => {
    const aHint = hint && a[0].toLowerCase().includes(hint) ? 1 : 0;
    const bHint = hint && b[0].toLowerCase().includes(hint) ? 1 : 0;
    return bHint - aHint || b[1] - a[1];
  });
  const bankLedger = ranked[0][0];

  const rows: TallyRow[] = [];
  for (const voucher of live) {
    const others = voucher.entries.filter(entry => entry.ledger !== bankLedger);
    for (const entry of voucher.entries.filter(item => item.ledger === bankLedger)) {
      // In Tally data a debit is negative and a credit positive.
      const isDebit = entry.amount < 0;
      rows.push({
        id: `tally-${rows.length + 1}`,
        date: voucher.date as string,
        ledgerName: voucher.party || others[0]?.ledger || voucher.type || bankLedger,
        voucherNumber: voucher.number || null,
        debit: isDebit ? Math.abs(entry.amount) : null,
        credit: isDebit ? null : Math.abs(entry.amount),
        narration: voucher.narration,
        rowNumber: rows.length + 1,
      });
    }
  }
  if (rows.length === 0) return fail(NO_ENTRIES);
  const notes = guessed
    ? [`Potential risk — needs CA review. No ledger in this XML is named like a bank, so "${bankLedger}" was used because it is in most vouchers. If that is not your bank ledger, export only the bank ledger from Tally.`]
    : [`Compared against the Tally ledger "${bankLedger}".`];
  if (!guessed && ranked.length > 1) notes.push(`This file also has ${ranked.slice(1).map(([name]) => `"${name}"`).join(", ")}. Entries on those were not compared. If your statement belongs to one of them, export only that ledger.`);
  if (cancelled > 0) notes.push(`${cancelled} cancelled or optional ${cancelled === 1 ? "voucher was" : "vouchers were"} left out.`);
  return ok(rows, "xml", notes);
}

// ── HTML ────────────────────────────────────────────────────────────────────

function htmlToCsv(html: string): string {
  const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines: string[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell =>
      decodeXml(cell[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ")),
    );
    if (cells.some(Boolean)) lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\n");
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** Reads one uploaded Tally file in any supported format. `bankName` helps pick the ledger in XML. */
export async function readTallyExportFile(file: UploadedFile, ctx: { bankName?: string | null } = {}): Promise<TallyRead> {
  const ext = extensionOf(file.originalname);
  const head = file.buffer.subarray(0, 2048).toString("latin1");
  const isPdf = ext === "pdf" || file.mimetype === "application/pdf" || head.startsWith("%PDF");
  if (isPdf) return readTallyPdf(file);
  if ((file.mimetype ?? "").startsWith("image/") || ["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"].includes(ext)) {
    return fail(`A picture of a Tally report cannot be read reliably. Export it from Tally as ${TALLY_FORMATS}.`);
  }
  const isXml = ext === "xml" || /^\s*<\?xml|<ENVELOPE\b/i.test(head);
  if (isXml) return readTallyXml(file.buffer.toString("utf8").replace(/^﻿/, ""), ctx.bankName);
  const isHtml = ext === "html" || ext === "htm" || /^\s*<(!doctype html|html)\b/i.test(head);
  let csv: string;
  let source: TallySource = "sheet";
  if (isHtml) {
    csv = htmlToCsv(file.buffer.toString("utf8"));
    source = "html";
  } else {
    try {
      csv = sheetToCsvText(file);
    } catch (err) {
      if (err instanceof UnreadableFileError) return fail(err.message);
      throw err;
    }
  }
  if (!csv.trim()) return fail(NO_ENTRIES);
  const rows = parseTallyLedgerCsv(csv);
  if (rows.length === 0) return fail(NO_ENTRIES);
  return ok(rows, source);
}
