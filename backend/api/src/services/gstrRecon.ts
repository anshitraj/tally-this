/**
 * GSTR-2B ↔ purchase register reconciliation.
 *
 * Pure and deterministic: no database, no AI. Every amount is held in whole paise so nothing is
 * rounded by the arithmetic. A document is "matched" only when the supplier GSTIN and the invoice
 * number agree (after plain tidying such as case and punctuation) AND the amounts agree within a
 * stated tolerance. Anything found by looser rules (a different invoice number, a different
 * GSTIN) stays a suggestion that a person confirms. Nothing here decides whether ITC may be
 * claimed; documents are flagged for CA review.
 */
import { normalizeDate } from "./bankStatement";

// ── Types ───────────────────────────────────────────────────────────────────

export type DocKind = "invoice" | "note";

/** One purchase document, from the GST portal or from the books. Amounts are signed paise. */
export interface GstDoc {
  source: "portal" | "books";
  /** 1-based row in the file it came from, so a person can find it. */
  row: number;
  gstin: string;
  gstinValid: boolean;
  supplierName: string;
  docNumber: string;
  docKey: string;
  docDate: string | null;
  kind: DocKind;
  voucherNo: string | null;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  /** Document value as printed; falls back to taxable + taxes. */
  total: number;
  /** Portal only: false when GSTR-2B says ITC is not available for this document. */
  itcAvailable: boolean | null;
  itcReason: string | null;
  reverseCharge: boolean;
}

export type Bucket =
  | "matched"
  | "value_mismatch"
  | "probable"
  | "missing_in_2b"
  | "missing_in_books"
  | "not_eligible"
  | "duplicate";

export type ReviewStatus = "suggested" | "approved" | "rejected" | "needs_info";

/** Rupees, for display and export. */
export interface Side {
  docNumber: string;
  docDate: string | null;
  row: number;
  voucherNo: string | null;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  tax: number;
  total: number;
}

export interface ReconItem {
  key: string;
  bucket: Bucket;
  status: ReviewStatus;
  /** "exact" and "tolerance" were matched by rule; "review" needs a person. */
  confidence: "exact" | "tolerance" | "review";
  supplierGstin: string;
  supplierName: string;
  docNumber: string;
  docDate: string | null;
  kind: DocKind;
  books?: Side;
  portal?: Side;
  /** Books minus portal, in rupees, when both exist. */
  diff?: { taxable: number; igst: number; cgst: number; sgst: number; cess: number; tax: number };
  why: string[];
  /** Tax in books that GSTR-2B does not support. Rupees, never negative. */
  itcAtRisk: number;
  /** Tax in GSTR-2B that the books do not show. Rupees, never negative. */
  itcUnclaimed: number;
}

export interface SupplierFollowUp {
  gstin: string;
  name: string;
  /** Documents in books that the supplier has not reported. */
  missing: Array<{ docNumber: string; docDate: string | null; tax: number; total: number }>;
  mismatched: number;
  itcAtRisk: number;
}

/** Tax by head, in rupees. */
export interface Heads {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  total: number;
}

/** One supplier across everything that was compared, for the vendor view. */
export interface VendorSummary {
  gstin: string;
  name: string;
  booksDocs: number;
  portalDocs: number;
  matched: number;
  differing: number;
  missingIn2b: number;
  missingInBooks: number;
  booksTax: number;
  portalTax: number;
  itcAtRisk: number;
  itcUnclaimed: number;
}

export interface ReconResult {
  /** The first (or only) GSTR-2B month, "YYYY-MM". */
  period: string | null;
  /** Every GSTR-2B month that was uploaded. */
  periods: string[];
  recipientGstin: string | null;
  items: ReconItem[];
  counts: Record<Bucket, number> & { portal: number; books: number };
  totals: {
    /** Tax on GSTR-2B documents where ITC is available. */
    portalTax: number;
    booksTax: number;
    matchedTax: number;
    itcAtRisk: number;
    itcUnclaimed: number;
    /** Tax on documents GSTR-2B marks as ITC not available. */
    notEligibleTax: number;
  };
  /** The same totals split by tax head, which is how GSTR-3B asks for ITC. */
  byHead: { portal: Heads; books: Heads; matched: Heads; atRisk: Heads; unclaimed: Heads; notEligible: Heads };
  /** Suppliers that have something to fix. */
  suppliers: SupplierFollowUp[];
  /** Every supplier. */
  vendors: VendorSummary[];
  notes: string[];
}

export interface ReconOptions {
  /** Largest difference, in rupees, accepted per component as a rounding difference. */
  toleranceRupees?: number;
  /** "YYYY-MM" of the GSTR-2B, used to explain documents dated in other months. */
  period?: string | null;
  /** Several GSTR-2B months compared together. Takes the place of `period`. */
  periods?: string[];
  recipientGstin?: string | null;
  notes?: string[];
}

// ── Small helpers ───────────────────────────────────────────────────────────

export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHECK_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function normalizeGstin(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** The 15th character of a GSTIN is a checksum; a typo in the first fourteen breaks it. */
export function gstinChecksumOk(gstin: string): boolean {
  if (!GSTIN_PATTERN.test(gstin)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = CHECK_CHARS.indexOf(gstin[i]);
    const product = code * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHECK_CHARS[(36 - (sum % 36)) % 36] === gstin[14];
}

/** Case, spaces and punctuation are ignored; digits and letters decide. */
export function canonicalDocNumber(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** INV-0012 and INV12 are one bill; so are 2024-25/0012 and 12 once the year is set aside. */
function looseDocNumber(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/(?:20)?\d{2}[-/]\d{2}(?!\d)/g, "")
    .replace(/[^0-9A-Z]/g, "")
    .replace(/(?<=[A-Z]|^)0+(?=\d)/g, "");
}

function docNumbersAlike(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const la = looseDocNumber(a);
  const lb = looseDocNumber(b);
  if (la && la === lb) return true;
  const [short, long] = la.length <= lb.length ? [la, lb] : [lb, la];
  // One carries a prefix or suffix the other leaves out, and what they share is long enough to mean something.
  return short.length >= 4 && long.length - short.length <= 6 && (long.endsWith(short) || long.startsWith(short));
}

/**
 * Reads money cells such as "1,23,456.50", "(450.00)", "₹ 1,000 Dr". Returns paise, or null when
 * unreadable. A value with more than two decimals (100.005) is refused unless `nearest` is set.
 */
export function toPaise(value: unknown, nearest = false): number | null {
  if (value == null || value === "") return 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const cents = Math.round(value * 100);
    return nearest || Math.abs(cents - value * 100) <= 1e-6 ? cents : null;
  }
  let text = String(value).trim();
  if (!text || text === "-" || text === "—" || text === "–") return 0;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/₹|rs\.?|inr/gi, "").replace(/,/g, "").replace(/\s+/g, "").replace(/(cr|dr)$/i, "");
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  const extra = /[1-9]/.test(fraction.slice(2));
  if (extra && !nearest) return null;
  let cents = Number(match[1]) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
  if (extra && Number(fraction[2] ?? "0") >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

export function isoDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Spreadsheet dates arrive at local midnight; read the calendar day the person sees.
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  if (typeof value === "number" && value > 20000 && value < 80000) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  return normalizeDate(String(value));
}

function rupees(paise: number): number {
  return Math.round(paise) / 100;
}

function taxOf(doc: Pick<GstDoc, "igst" | "cgst" | "sgst" | "cess">) {
  return doc.igst + doc.cgst + doc.sgst + doc.cess;
}

function sideOf(doc: GstDoc): Side {
  return {
    docNumber: doc.docNumber,
    docDate: doc.docDate,
    row: doc.row,
    voucherNo: doc.voucherNo,
    taxable: rupees(doc.taxable),
    igst: rupees(doc.igst),
    cgst: rupees(doc.cgst),
    sgst: rupees(doc.sgst),
    cess: rupees(doc.cess),
    tax: rupees(taxOf(doc)),
    total: rupees(doc.total),
  };
}

/** Lines of one document added together. A document value printed on every line counts once. */
function combine(docs: GstDoc[]): GstDoc {
  if (docs.length === 1) return docs[0];
  const sum = (pick: (doc: GstDoc) => number) => docs.reduce((total, doc) => total + pick(doc), 0);
  const repeated = docs.every(doc => doc.total === docs[0].total);
  return {
    ...docs[0],
    taxable: sum(doc => doc.taxable),
    igst: sum(doc => doc.igst),
    cgst: sum(doc => doc.cgst),
    sgst: sum(doc => doc.sgst),
    cess: sum(doc => doc.cess),
    total: repeated && docs[0].source === "portal" ? docs[0].total : sum(doc => doc.total),
    itcAvailable: docs.some(doc => doc.itcAvailable === false) ? false : docs.every(doc => doc.itcAvailable === true) ? true : null,
  };
}

// ── GSTR-2B JSON from the portal ────────────────────────────────────────────

export interface PortalRead {
  docs: GstDoc[];
  period: string | null;
  recipientGstin: string | null;
  notes: string[];
}

function exactAmount(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    if (record[key] == null) continue;
    const cents = toPaise(record[key]);
    if (cents == null) throw new Error(`The amount "${String(record[key])}" could not be read exactly.`);
    return cents;
  }
  return 0;
}

function lineAmounts(record: Record<string, unknown>) {
  const rows = ["items", "itms"].map(key => record[key]).find(Array.isArray) as Array<Record<string, unknown>> | undefined;
  const read = (source: Record<string, unknown>) => ({
    taxable: exactAmount(source, ["txval", "taxableValue"]),
    igst: exactAmount(source, ["igst", "iamt"]),
    cgst: exactAmount(source, ["cgst", "camt"]),
    sgst: exactAmount(source, ["sgst", "samt"]),
    cess: exactAmount(source, ["cess", "csamt"]),
  });
  if (!rows || rows.length === 0) return read(record);
  const total = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const row of rows) {
    const part = read((row.itm_det && typeof row.itm_det === "object" ? row.itm_det : row) as Record<string, unknown>);
    total.taxable += part.taxable;
    total.igst += part.igst;
    total.cgst += part.cgst;
    total.sgst += part.sgst;
    total.cess += part.cess;
  }
  return total;
}

/** "102026" → "2026-10". */
function periodFrom(rtnprd: unknown): string | null {
  const text = String(rtnprd ?? "").replace(/\D/g, "");
  if (text.length !== 6) return null;
  const month = Number(text.slice(0, 2));
  return month >= 1 && month <= 12 ? `${text.slice(2)}-${String(month).padStart(2, "0")}` : null;
}

/**
 * Reads the portal's GSTR-2B JSON (and the older GSTR-2A shape). Sections that are not matched
 * against a purchase register are counted in `notes` so nothing is dropped quietly.
 */
export function parsePortalJson(text: string): PortalRead {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error("This file is not a GSTR-2B JSON download. Download GSTR-2B as JSON from the GST portal, or upload the Excel version.");
  }
  const top = (root && typeof root === "object" ? root : {}) as Record<string, unknown>;
  const body = (top.data && typeof top.data === "object" ? top.data : top) as Record<string, unknown>;
  const docdata = (body.docdata && typeof body.docdata === "object" ? body.docdata : body) as Record<string, unknown>;
  const notes: string[] = [];
  const docs: GstDoc[] = [];
  let row = 0;

  const add = (supplier: Record<string, unknown>, record: Record<string, unknown>, kind: DocKind) => {
    row += 1;
    const gstin = normalizeGstin(supplier.ctin ?? supplier.gstin);
    const number = String(record.inum ?? record.ntnum ?? record.nt_num ?? record.docNo ?? "").trim();
    let money;
    try {
      money = lineAmounts(record);
    } catch (error) {
      throw new Error(`${number || `Entry ${row}`}: ${error instanceof Error ? error.message : "an amount could not be read"}`);
    }
    const noteType = String(record.typ ?? record.ntty ?? record.nt_ty ?? "").toUpperCase();
    // A supplier's credit note lowers ITC; a debit note raises it.
    const sign = kind === "note" && !noteType.startsWith("D") ? -1 : 1;
    const printed = toPaise(record.val ?? record.docVal ?? 0);
    if (printed == null) throw new Error(`${number || `Entry ${row}`}: the document value could not be read exactly.`);
    const itcavl = String(record.itcavl ?? record.itcAvl ?? "").toUpperCase();
    const taxable = sign * money.taxable;
    const igst = sign * money.igst;
    const cgst = sign * money.cgst;
    const sgst = sign * money.sgst;
    const cess = sign * money.cess;
    docs.push({
      source: "portal",
      row,
      gstin,
      gstinValid: GSTIN_PATTERN.test(gstin),
      supplierName: String(supplier.trdnm ?? supplier.tradeName ?? "").trim(),
      docNumber: number,
      docKey: canonicalDocNumber(number),
      docDate: isoDate(record.dt ?? record.idt ?? record.nt_dt ?? record.docDt),
      kind,
      voucherNo: null,
      taxable,
      igst,
      cgst,
      sgst,
      cess,
      total: printed !== 0 ? sign * printed : taxable + igst + cgst + sgst + cess,
      itcAvailable: itcavl === "Y" ? true : itcavl === "N" ? false : null,
      itcReason: String(record.rsn ?? "").trim() || null,
      reverseCharge: String(record.rev ?? record.rchrg ?? "").toUpperCase() === "Y",
    });
  };

  const sections: Array<[string, DocKind, string[]]> = [
    ["b2b", "invoice", ["inv", "docs", "docDtls"]],
    ["cdnr", "note", ["nt", "notes", "docDtls"]],
    ["b2bData", "invoice", ["docDtls", "docs", "inv"]],
  ];
  for (const [key, kind, childKeys] of sections) {
    const list = docdata[key];
    if (!Array.isArray(list)) continue;
    for (const supplier of list as Array<Record<string, unknown>>) {
      const children = childKeys.map(child => supplier[child]).find(Array.isArray) as Array<Record<string, unknown>> | undefined;
      for (const record of children ?? []) add(supplier, record, kind);
    }
  }

  const skipped: Array<[string, string]> = [
    ["b2ba", "amended invoices"],
    ["cdnra", "amended credit/debit notes"],
    ["isd", "ISD credits"],
    ["isda", "amended ISD credits"],
    ["impg", "imports of goods"],
    ["impgsez", "imports from SEZ"],
    ["eco", "e-commerce supplies"],
  ];
  for (const [key, label] of skipped) {
    const list = docdata[key];
    if (Array.isArray(list) && list.length > 0) {
      notes.push(`${key.toUpperCase()} (${label}): ${list.length} ${list.length === 1 ? "entry is" : "entries are"} in this file and not matched with your purchase register.`);
    }
  }

  if (docs.length === 0) {
    throw new Error("No supplier invoices were found in this GSTR-2B file. Check that it is the GSTR-2B JSON (not GSTR-1 or GSTR-3B).");
  }
  return {
    docs,
    period: periodFrom(body.rtnprd ?? body.fp ?? body.ret_period),
    recipientGstin: normalizeGstin(body.gstin) || null,
    notes,
  };
}

// ── Tables: portal Excel/CSV and purchase registers ─────────────────────────

export type Cell = string | number | boolean | Date | null | undefined;
export type Table = Cell[][];

export function headerKey(value: Cell): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/#/g, " no ")
    .replace(/[₹()]/g, " ")
    .replace(/[^a-z0-9%@/ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ColumnMap {
  gstin?: number;
  party?: number;
  docNo?: number;
  docDate?: number;
  voucherDate?: number;
  voucherNo?: number;
  voucherType?: number;
  noteType?: number;
  taxable?: number;
  total?: number;
  itc?: number;
  reason?: number;
  reverse?: number;
  igst: number[];
  cgst: number[];
  sgst: number[];
  cess: number[];
}

type SingleSlot = Exclude<keyof ColumnMap, "igst" | "cgst" | "sgst" | "cess">;

export function mapColumns(headers: Cell[]): ColumnMap {
  const map: ColumnMap = { igst: [], cgst: [], sgst: [], cess: [] };
  const score = new Map<SingleSlot, number>();
  const claim = (slot: SingleSlot, index: number, points: number) => {
    if (points > (score.get(slot) ?? 0)) {
      map[slot] = index;
      score.set(slot, points);
    }
  };
  headers.map(headerKey).forEach((key, index) => {
    if (!key) return;
    // Rate and percentage columns are not amounts. "Input CGST @9%" is an amount and stays.
    if (/\brate\b/.test(key) || key === "%" || /^applicable/.test(key)) return;

    const ownSide = /recipient|buyer|customer|company|billing|ship|own\b/.test(key);
    if (/\bgstin\b|\bgst no\b|\bgst number\b|\bctin\b|\bgst identification\b|\buin\b/.test(key)) {
      claim("gstin", index, ownSide ? 1 : /supplier|vendor|party|ctin/.test(key) ? 4 : 2);
    }
    // A name column, never "Supplier Invoice No." or "Supplier GSTIN".
    if (
      /^(trade\/legal name|trade name|legal name|supplier name|vendor name|party name|name of supplier|name of party|party ledger|particulars|party|supplier|vendor|name|ledger|account name)$/.test(key) ||
      (/^(supplier|vendor|party)\b/.test(key) && /\bname\b/.test(key) && !/invoice|bill|gstin|date|\bno\b|number/.test(key))
    ) {
      claim("party", index, /trade|legal|supplier|vendor|party/.test(key) ? 3 : 2);
    }
    if (!/voucher|vch|date|type|gstin/.test(key)) {
      if (/\b(invoice|inv|bill|document|doc|note)\b.*\b(no|number|num)\b/.test(key) || /^(ref no|reference no|reference number|inum|ntnum)\b/.test(key)) {
        claim("docNo", index, /supplier|vendor|party|invoice number|invoice no|bill no/.test(key) ? 3 : 2);
      }
    }
    if (/\b(invoice|bill|inv|document|note)\b.*\bdate\b/.test(key) && !/voucher/.test(key)) {
      claim("docDate", index, /supplier|vendor|invoice|bill/.test(key) ? 3 : 2);
    } else if (["date", "voucher date", "vch date", "posting date", "dt", "transaction date"].includes(key)) {
      claim("voucherDate", index, 1);
    }
    if (/\b(voucher|vch)\b.*\b(no|number)\b/.test(key)) claim("voucherNo", index, 1);
    if (/\b(voucher|vch)\b.*\btype\b/.test(key) || key === "document type") claim("voucherType", index, 1);
    if (key === "note type") claim("noteType", index, 1);
    if (/taxable/.test(key)) claim("taxable", index, 3);
    else if (["assessable value", "basic amount", "net amount", "value", "purchase value", "subtotal", "sub total", "basic value"].includes(key)) claim("taxable", index, 1);
    if (/^(invoice value|invoice amount|gross total|grand total|bill amount|document value|note value|invoice total|total invoice value|total amount|total|amount)\b/.test(key)) {
      claim("total", index, /invoice value|gross total|invoice amount|bill amount|note value|document value|grand total/.test(key) ? 3 : 1);
    }
    if (/igst|integrated/.test(key)) map.igst.push(index);
    else if (/cgst|central tax/.test(key)) map.cgst.push(index);
    else if (/sgst|utgst|state\/ut|state ut|state tax/.test(key)) map.sgst.push(index);
    else if (/\bcess\b/.test(key)) map.cess.push(index);
    if (["itc availability", "itc available", "eligible for itc", "itc eligibility"].includes(key)) claim("itc", index, 1);
    if (key === "reason") claim("reason", index, 1);
    if (/reverse charge/.test(key)) claim("reverse", index, 1);
  });
  return map;
}

function mappedCount(map: ColumnMap) {
  return (
    [map.gstin, map.docNo, map.taxable, map.total, map.party, map.docDate ?? map.voucherDate].filter(value => value !== undefined).length +
    (map.igst.length + map.cgst.length + map.sgst.length > 0 ? 1 : 0)
  );
}

/** Finds the header row among the first rows of a sheet; -1 when none looks like one. */
export function findHeaderRow(table: Table): number {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(table.length, 25); i++) {
    const row = table[i] ?? [];
    if (row.filter(cell => String(cell ?? "").trim() !== "").length < 3) continue;
    const score = mappedCount(mapColumns(row));
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : -1;
}

export function textCell(value: Cell): string {
  if (value instanceof Date) return isoDate(value) ?? "";
  return String(value ?? "").trim();
}

/**
 * Register software often stores computed taxes with extra decimals (90.0045). Those are rounded
 * to the nearest paisa and counted, so the person is told; text that is not an amount stops the file.
 */
export function amountCell(value: Cell, label: string, row: number, stats: { rounded: number }): number {
  const raw = value instanceof Date ? "" : value;
  const exact = toPaise(raw);
  if (exact != null) return exact;
  const nearest = toPaise(raw, true);
  if (nearest == null) {
    throw new Error(`Row ${row}: the ${label} "${String(value)}" could not be read as an amount. Fix it in the file and upload again.`);
  }
  stats.rounded += 1;
  return nearest;
}

export function sumColumns(cells: Cell[], indexes: number[], label: string, row: number, stats: { rounded: number }): number {
  return indexes.reduce((total, index) => total + amountCell(cells[index], label, row, stats), 0);
}

export interface TableRead {
  docs: GstDoc[];
  notes: string[];
  rowsRead: number;
  rowsSkipped: number;
}

// ── Column help when the headings are not recognised ────────────────────────

/** Overrides for the columns the heading rules could not find. Zero-based positions. */
export interface ColumnOverride {
  gstin?: number;
  party?: number;
  docNo?: number;
  docDate?: number;
  taxable?: number;
  total?: number;
  voucherType?: number;
  igst?: number[];
  cgst?: number[];
  sgst?: number[];
  cess?: number[];
}

/**
 * What one column holds, as shares of its cells: GSTIN-shaped, date-shaped, amount-shaped, text.
 * It carries the heading and these shares only, never a cell value, so it is safe to show an
 * assistant that has no business seeing the figures.
 */
export interface ColumnProfile {
  index: number;
  header: string;
  gstin: number;
  date: number;
  amount: number;
  text: number;
}

export const AI_FIELDS = [
  "supplier_gstin",
  "supplier_name",
  "invoice_number",
  "invoice_date",
  "taxable_value",
  "igst",
  "cgst",
  "sgst",
  "cess",
  "invoice_total",
  "voucher_type",
] as const;

export interface ColumnSuggestion {
  originalColumn: string;
  mappedField: string | null;
  confidence: number;
}

/** The first row that reads like a heading line: several text cells, then a row with numbers. */
export function guessHeaderRow(table: Table): number {
  const textual = (cell: Cell) => typeof cell === "string" && cell.trim() !== "" && toPaise(cell) === null;
  const numeric = (cell: Cell) => typeof cell === "number" || (typeof cell === "string" && cell.trim() !== "" && toPaise(cell) !== null);
  for (let i = 0; i < Math.min(table.length - 1, 25); i += 1) {
    const row = table[i] ?? [];
    const next = table[i + 1] ?? [];
    if (row.filter(textual).length >= 4 && next.filter(numeric).length >= 2) return i;
  }
  return -1;
}

export function profileColumns(table: Table, headerRow: number, sample = 40): ColumnProfile[] {
  const header = table[headerRow] ?? [];
  const rows = table.slice(headerRow + 1, headerRow + 1 + sample);
  return header
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => String(cell ?? "").trim() !== "")
    .map(({ cell, index }) => {
      let filled = 0;
      let gstin = 0;
      let date = 0;
      let amount = 0;
      let text = 0;
      for (const row of rows) {
        const value = row?.[index];
        if (value == null || String(value).trim() === "") continue;
        filled += 1;
        if (GSTIN_PATTERN.test(normalizeGstin(value))) gstin += 1;
        else if (value instanceof Date || isoDate(value) !== null && !(typeof value === "number" && value < 20000)) date += 1;
        else if (toPaise(value) !== null) amount += 1;
        else text += 1;
      }
      const share = (count: number) => (filled === 0 ? 0 : Math.round((count / filled) * 100) / 100);
      return { index, header: String(cell).trim(), gstin: share(gstin), date: share(date), amount: share(amount), text: share(text) };
    });
}

/**
 * Takes an assistant's column suggestions and keeps only those the data itself supports. A
 * heading the assistant invented, a field it was not offered, a low confidence, or a column whose
 * cells do not look like the field are all dropped. What remains is positions, never values.
 */
export function applySuggestions(profile: ColumnProfile[], suggestions: ColumnSuggestion[]): { override: ColumnOverride; used: Array<{ field: string; header: string }> } {
  const byHeader = new Map(profile.map(column => [column.header.toLowerCase(), column]));
  const fits = (field: string, column: ColumnProfile) => {
    switch (field) {
      case "supplier_gstin":
        return column.gstin >= 0.5;
      case "invoice_date":
        return column.date >= 0.5;
      case "taxable_value":
      case "igst":
      case "cgst":
      case "sgst":
      case "cess":
      case "invoice_total":
        return column.amount >= 0.6;
      case "supplier_name":
        return column.text >= 0.5 && column.gstin < 0.3;
      case "invoice_number":
        return column.gstin < 0.3 && column.date < 0.5 && column.text + column.amount >= 0.6;
      case "voucher_type":
        return column.text >= 0.5;
      default:
        return false;
    }
  };

  const best = new Map<string, { column: ColumnProfile; confidence: number }>();
  const many: Record<"igst" | "cgst" | "sgst" | "cess", ColumnProfile[]> = { igst: [], cgst: [], sgst: [], cess: [] };
  for (const suggestion of suggestions) {
    const field = suggestion.mappedField ?? "";
    const column = byHeader.get(suggestion.originalColumn.trim().toLowerCase());
    if (!column || !(AI_FIELDS as readonly string[]).includes(field)) continue;
    if (!(suggestion.confidence >= 0.6) || !fits(field, column)) continue;
    if (field === "igst" || field === "cgst" || field === "sgst" || field === "cess") {
      if (!many[field].some(existing => existing.index === column.index)) many[field].push(column);
      continue;
    }
    const current = best.get(field);
    if (!current || suggestion.confidence > current.confidence) best.set(field, { column, confidence: suggestion.confidence });
  }

  const pick = (field: string) => best.get(field)?.column;
  const override: ColumnOverride = {
    gstin: pick("supplier_gstin")?.index,
    party: pick("supplier_name")?.index,
    docNo: pick("invoice_number")?.index,
    docDate: pick("invoice_date")?.index,
    taxable: pick("taxable_value")?.index,
    total: pick("invoice_total")?.index,
    voucherType: pick("voucher_type")?.index,
    igst: many.igst.map(column => column.index),
    cgst: many.cgst.map(column => column.index),
    sgst: many.sgst.map(column => column.index),
    cess: many.cess.map(column => column.index),
  };
  const used: Array<{ field: string; header: string }> = [];
  for (const [field, entry] of best) used.push({ field, header: entry.column.header });
  for (const field of ["igst", "cgst", "sgst", "cess"] as const) for (const column of many[field]) used.push({ field, header: column.header });
  return { override, used };
}

function withOverride(map: ColumnMap, override: ColumnOverride | undefined): ColumnMap {
  if (!override) return map;
  const merged: ColumnMap = { ...map, igst: [...map.igst], cgst: [...map.cgst], sgst: [...map.sgst], cess: [...map.cess] };
  for (const key of ["gstin", "party", "docNo", "docDate", "taxable", "total", "voucherType"] as const) {
    if (override[key] !== undefined) merged[key] = override[key];
  }
  for (const key of ["igst", "cgst", "sgst", "cess"] as const) {
    if (override[key] && override[key]!.length > 0) merged[key] = [...override[key]!];
  }
  return merged;
}

/** Reads a purchase register (books) or a portal Excel/CSV page into documents. */
export function readDocsFromTable(
  table: Table,
  source: "books" | "portal",
  sheetLabel = "",
  options: { override?: ColumnOverride; headerRow?: number } = {},
): TableRead {
  const headerRow = options.headerRow ?? findHeaderRow(table);
  if (headerRow < 0) {
    throw new Error(
      source === "books"
        ? "We could not find the columns in this file. Export the Purchase Register with supplier GSTIN, supplier invoice number, invoice date, taxable value and GST amounts."
        : "We could not find the invoice columns in this GSTR-2B file. Upload the JSON download, or the Excel with the B2B sheet.",
    );
  }
  const map = withOverride(mapColumns(table[headerRow] ?? []), options.override);
  const missing: string[] = [];
  if (map.gstin === undefined) missing.push("supplier GSTIN");
  if (map.docNo === undefined) missing.push("supplier invoice number");
  if (map.taxable === undefined && map.total === undefined) missing.push("taxable value or invoice total");
  if (map.igst.length + map.cgst.length + map.sgst.length === 0) missing.push("IGST / CGST / SGST amounts");
  if (missing.length > 0) {
    throw new Error(
      `The ${source === "books" ? "purchase register" : "GSTR-2B file"} has no column for: ${missing.join(", ")}. Add ${missing.length === 1 ? "it" : "them"} and upload again.`,
    );
  }

  const docs: GstDoc[] = [];
  const stats = { rounded: 0 };
  let noGstin = 0;
  let noNumber = 0;
  for (let i = headerRow + 1; i < table.length; i++) {
    const cells = table[i] ?? [];
    const rowNumber = i + 1;
    if (cells.every(cell => String(cell ?? "").trim() === "")) continue;
    const gstin = normalizeGstin(textCell(cells[map.gstin ?? -1]));
    const docNumber = textCell(cells[map.docNo ?? -1]);
    const label = textCell(cells[map.party ?? -1]).toLowerCase();
    if (!docNumber && !gstin) continue; // headings, totals and blank lines
    if (/^(grand )?total\b|^closing|^opening|^sub ?total/.test(label)) continue;
    if (!gstin) {
      noGstin += 1;
      continue;
    }
    if (!docNumber) {
      noNumber += 1;
      continue;
    }

    const taxes = {
      igst: sumColumns(cells, map.igst, "IGST", rowNumber, stats),
      cgst: sumColumns(cells, map.cgst, "CGST", rowNumber, stats),
      sgst: sumColumns(cells, map.sgst, "SGST", rowNumber, stats),
      cess: sumColumns(cells, map.cess, "cess", rowNumber, stats),
    };
    const taxTotal = taxes.igst + taxes.cgst + taxes.sgst + taxes.cess;
    const printed = map.total !== undefined && textCell(cells[map.total]) !== "" ? amountCell(cells[map.total], "document value", rowNumber, stats) : null;
    let taxable = map.taxable !== undefined && textCell(cells[map.taxable]) !== "" ? amountCell(cells[map.taxable], "taxable value", rowNumber, stats) : null;
    if (taxable === null) taxable = printed !== null ? printed - taxTotal : 0;

    // Credit and debit notes: the portal says which; a register shows it in the voucher type or as negatives.
    const noteTypeText = textCell(cells[map.noteType ?? -1]);
    const typeText = `${textCell(cells[map.voucherType ?? -1])} ${noteTypeText} ${sheetLabel}`;
    const noteWords = /credit\s*note|debit\s*note|purchase\s*return|\bcdn/i.test(typeText);
    const negative = taxable < 0 || taxTotal < 0 || (printed ?? 0) < 0;
    const kind: DocKind = noteWords || negative ? "note" : "invoice";
    let sign = 1;
    if (kind === "note" && !negative) {
      // Entered as a positive document: a supplier's credit note (or a purchase return) reduces
      // ITC; a debit note from the supplier raises it.
      sign = source === "portal" && /debit/i.test(noteTypeText) ? 1 : -1;
    }

    const itcText = textCell(cells[map.itc ?? -1]).toLowerCase();
    docs.push({
      source,
      row: rowNumber,
      gstin,
      gstinValid: GSTIN_PATTERN.test(gstin),
      supplierName: textCell(cells[map.party ?? -1]),
      docNumber,
      docKey: canonicalDocNumber(docNumber),
      docDate: isoDate(cells[map.docDate ?? -1]) ?? isoDate(cells[map.voucherDate ?? -1]),
      kind,
      voucherNo: map.voucherNo !== undefined ? textCell(cells[map.voucherNo]) || null : null,
      taxable: sign * taxable,
      igst: sign * taxes.igst,
      cgst: sign * taxes.cgst,
      sgst: sign * taxes.sgst,
      cess: sign * taxes.cess,
      total: sign * (printed ?? taxable + taxTotal),
      itcAvailable: !itcText ? null : /^n|not\s*available|ineligible/.test(itcText) ? false : /^y|available|eligible/.test(itcText) ? true : null,
      itcReason: textCell(cells[map.reason ?? -1]) || null,
      reverseCharge: /^y/i.test(textCell(cells[map.reverse ?? -1])),
    });
  }

  if (docs.length === 0) throw new Error("No invoices with a supplier GSTIN and invoice number were found in this file.");
  const notes: string[] = [];
  if (noGstin > 0) {
    notes.push(
      source === "books"
        ? `${noGstin} ${noGstin === 1 ? "line has" : "lines have"} no supplier GSTIN, such as purchases from unregistered suppliers. They are not in GSTR-2B, so they were left out.`
        : `${noGstin} lines had no supplier GSTIN and were left out.`,
    );
  }
  if (noNumber > 0) notes.push(`${noNumber} ${noNumber === 1 ? "line has" : "lines have"} a GSTIN but no invoice number and could not be matched. Check them in the file.`);
  if (stats.rounded > 0) {
    notes.push(`${stats.rounded} ${stats.rounded === 1 ? "amount carried" : "amounts carried"} more than two decimals and ${stats.rounded === 1 ? "was" : "were"} rounded to the nearest paisa.`);
  }
  return { docs, notes, rowsRead: docs.length, rowsSkipped: noGstin + noNumber };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The portal Excel names the period on its Read me sheet: "Financial Year 2026-27", "Tax Period October". */
function periodFromReadMe(table: Table): { gstin: string | null; period: string | null } {
  const text = table.slice(0, 30).map(row => row.map(textCell).join(" ")).join(" \n ");
  const gstin = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/.exec(text.toUpperCase())?.[0] ?? null;
  const month = MONTHS.findIndex(name => new RegExp(`(?:tax period|return period|period|month of)[^a-z0-9]{0,14}${name}`, "i").test(text));
  const fy = /(20\d{2})\s*[-–]\s*(\d{2})\b/.exec(text);
  if (month < 0 || !fy) return { gstin, period: null };
  const start = Number(fy[1]);
  const year = month >= 3 ? start : start + 1; // April..December sit in the first year
  return { gstin, period: `${year}-${String(month + 1).padStart(2, "0")}` };
}

/** Portal Excel: the B2B sheet and the credit/debit note sheet. */
export function readPortalWorkbook(sheets: Array<{ name: string; table: Table }>): PortalRead {
  const docs: GstDoc[] = [];
  const notes: string[] = [];
  let period: string | null = null;
  let recipientGstin: string | null = null;

  for (const sheet of sheets) {
    const name = sheet.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (name === "readme") {
      const found = periodFromReadMe(sheet.table);
      period = found.period ?? period;
      recipientGstin = found.gstin ?? recipientGstin;
      continue;
    }
    const invoices = name === "b2b";
    const creditNotes = name === "b2bcdnr" || name === "cdnr";
    if (!invoices && !creditNotes) {
      if (/^(b2ba|b2bcdnra|cdnra|isd|isda|impg|impgsez|eco|ecoa)$/.test(name) && sheet.table.length > 6) {
        notes.push(`The ${sheet.name} sheet is not matched with your purchase register.`);
      }
      continue;
    }
    const read = readDocsFromTable(sheet.table, "portal", creditNotes ? "credit note" : "");
    docs.push(...read.docs);
    notes.push(...read.notes);
  }
  if (docs.length === 0) throw new Error("No supplier invoices were found. In the GSTR-2B Excel, the invoices are on the B2B sheet.");
  // Excel has one line per tax rate; a document is the lines added together.
  const merged = new Map<string, GstDoc[]>();
  for (const doc of docs) {
    const key = `${doc.gstin}|${doc.kind}|${doc.docKey}`;
    merged.set(key, [...(merged.get(key) ?? []), doc]);
  }
  const combined = [...merged.values()].map(lines => ({ ...combine(lines), row: lines[0].row }));
  return { docs: combined, period, recipientGstin, notes };
}

// ── Reconciliation ──────────────────────────────────────────────────────────

const PARTS = ["taxable", "igst", "cgst", "sgst", "cess"] as const;

function differences(books: GstDoc, portal: GstDoc, tolerance: number) {
  const diff = {
    taxable: books.taxable - portal.taxable,
    igst: books.igst - portal.igst,
    cgst: books.cgst - portal.cgst,
    sgst: books.sgst - portal.sgst,
    cess: books.cess - portal.cess,
  };
  const worst = Math.max(...PARTS.map(name => Math.abs(diff[name])));
  return { diff, worst, exact: worst === 0, within: worst <= tolerance };
}

function inRupees(diff: Record<(typeof PARTS)[number], number>): NonNullable<ReconItem["diff"]> {
  return {
    taxable: rupees(diff.taxable),
    igst: rupees(diff.igst),
    cgst: rupees(diff.cgst),
    sgst: rupees(diff.sgst),
    cess: rupees(diff.cess),
    tax: rupees(diff.igst + diff.cgst + diff.sgst + diff.cess),
  };
}

function describe(diff: Record<(typeof PARTS)[number], number>): string[] {
  const names: Record<string, string> = { taxable: "Taxable value", igst: "IGST", cgst: "CGST", sgst: "SGST", cess: "Cess" };
  const lines: string[] = [];
  // The same tax split between different heads is the classic place-of-supply mistake.
  if (diff.taxable === 0 && diff.cess === 0 && diff.igst + diff.cgst + diff.sgst === 0 && (diff.igst !== 0 || diff.cgst !== 0 || diff.sgst !== 0)) {
    lines.push("The total tax is the same but it is split differently between IGST and CGST/SGST. Check the place of supply");
  }
  for (const name of PARTS) {
    if (diff[name] === 0) continue;
    const amount = rupees(Math.abs(diff[name])).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    lines.push(`${names[name]} is ₹${amount} ${diff[name] > 0 ? "higher" : "lower"} in your books`);
  }
  return lines;
}

function monthOf(date: string | null) {
  return date ? date.slice(0, 7) : null;
}

function daysApart(a: string | null, b: string | null) {
  if (!a || !b) return Infinity;
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

function indexBy<T>(list: T[], key: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of list) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

export function reconcile(portalDocs: GstDoc[], booksDocs: GstDoc[], options: ReconOptions = {}): ReconResult {
  const tolerance = Math.round((options.toleranceRupees ?? 1) * 100);
  const periods = [...new Set(options.periods?.length ? options.periods : options.period ? [options.period] : [])].sort();
  const items: ReconItem[] = [];
  const notes = [...(options.notes ?? [])];
  const usedPortal = new Set<GstDoc>();
  const usedBooks = new Set<GstDoc>();
  const portalOf = new Map<ReconItem, GstDoc>();
  let sequence = 0;

  const push = (partial: Omit<ReconItem, "key" | "status">, prefix: string, portal?: GstDoc) => {
    const item: ReconItem = { ...partial, key: `${prefix}-${++sequence}`, status: "suggested" };
    items.push(item);
    if (portal) portalOf.set(item, portal);
    return item;
  };

  const identity = (portal: GstDoc | undefined, books: GstDoc | undefined) => {
    const source = (books ?? portal)!;
    return {
      supplierGstin: source.gstin,
      supplierName: books?.supplierName || portal?.supplierName || "",
      docNumber: source.docNumber,
      docDate: source.docDate,
      kind: source.kind,
      books: books ? sideOf(books) : undefined,
      portal: portal ? sideOf(portal) : undefined,
    };
  };
  const atRisk = (books: GstDoc, portal?: GstDoc) => rupees(Math.max(0, taxOf(books) - (portal ? taxOf(portal) : 0)));
  const unclaimed = (portal: GstDoc, books?: GstDoc) => rupees(Math.max(0, taxOf(portal) - (books ? taxOf(books) : 0)));

  const exactKey = (doc: GstDoc) => `${doc.gstin}|${doc.kind}|${doc.docKey}`;
  const portalGroups = indexBy(portalDocs, exactKey);
  const booksGroups = indexBy(booksDocs, exactKey);

  // Pass 1: same supplier GSTIN and same invoice number.
  for (const [key, bookRows] of booksGroups) {
    const portalRows = portalGroups.get(key);
    if (!portalRows) continue;
    const portal = combine(portalRows);
    const whole = combine(bookRows);
    let chosen = whole;
    let extras: GstDoc[] = [];
    if (bookRows.length > 1 && !differences(whole, portal, tolerance).within && differences(bookRows[0], portal, tolerance).within) {
      // The same bill entered more than once: the first entry is the match and the rest are extras.
      chosen = bookRows[0];
      extras = bookRows.slice(1);
    }
    const result = differences(chosen, portal, tolerance);
    const dateNote =
      monthOf(chosen.docDate) && monthOf(portal.docDate) && monthOf(chosen.docDate) !== monthOf(portal.docDate)
        ? [`Invoice date differs: books ${chosen.docDate}, GSTR-2B ${portal.docDate}`]
        : [];
    const lineNote = bookRows.length > 1 && extras.length === 0 ? [`${bookRows.length} lines in your books were added together`] : [];
    if (result.within) {
      push(
        {
          ...identity(portal, chosen),
          bucket: "matched",
          confidence: result.exact ? "exact" : "tolerance",
          diff: result.exact ? undefined : inRupees(result.diff),
          why: [result.exact ? "GSTIN, invoice number and amounts agree" : `Amounts agree within ₹${rupees(tolerance)} (rounding)`, ...dateNote, ...lineNote],
          itcAtRisk: 0,
          itcUnclaimed: 0,
        },
        "m",
        portal,
      );
    } else {
      push(
        {
          ...identity(portal, chosen),
          bucket: "value_mismatch",
          confidence: "review",
          diff: inRupees(result.diff),
          why: [...describe(result.diff), ...dateNote, ...lineNote],
          itcAtRisk: atRisk(chosen, portal),
          itcUnclaimed: unclaimed(portal, chosen),
        },
        "v",
        portal,
      );
    }
    portalRows.forEach(row => usedPortal.add(row));
    bookRows.forEach(row => usedBooks.add(row));
    for (const duplicate of extras) {
      push(
        {
          ...identity(undefined, duplicate),
          bucket: "duplicate",
          confidence: "review",
          why: ["This invoice is entered more than once in your books", "Only the first entry matches GSTR-2B, so ITC on this one is not supported"],
          itcAtRisk: rupees(Math.max(0, taxOf(duplicate))),
          itcUnclaimed: 0,
        },
        "d",
      );
    }
  }

  // Pass 2: same GSTIN, invoice numbers that differ only in how they are written, amounts agree.
  {
    const openPortal = indexBy(portalDocs.filter(doc => !usedPortal.has(doc)), doc => `${doc.gstin}|${doc.kind}`);
    for (const bookDoc of booksDocs) {
      if (usedBooks.has(bookDoc)) continue;
      const pool = (openPortal.get(`${bookDoc.gstin}|${bookDoc.kind}`) ?? []).filter(doc => !usedPortal.has(doc));
      const alike = pool.filter(doc => docNumbersAlike(doc.docKey, bookDoc.docKey) && differences(bookDoc, doc, tolerance).within);
      const portal = alike.find(doc => differences(bookDoc, doc, tolerance).exact) ?? (alike.length === 1 ? alike[0] : undefined);
      if (!portal) continue;
      usedPortal.add(portal);
      usedBooks.add(bookDoc);
      push(
        {
          ...identity(portal, bookDoc),
          bucket: "probable",
          confidence: "review",
          why: [
            `Invoice number is written differently: books “${bookDoc.docNumber}”, GSTR-2B “${portal.docNumber}”`,
            "Same GSTIN and the amounts agree. Confirm it is the same invoice",
          ],
          itcAtRisk: 0,
          itcUnclaimed: 0,
        },
        "p",
        portal,
      );
    }
  }

  // Pass 3: same GSTIN, exactly the same amounts, one-to-one, dates close.
  {
    const openPortal = indexBy(portalDocs.filter(doc => !usedPortal.has(doc)), doc => `${doc.gstin}|${doc.kind}`);
    const openBooks = indexBy(booksDocs.filter(doc => !usedBooks.has(doc)), doc => `${doc.gstin}|${doc.kind}`);
    for (const [pairKey, bookPool] of openBooks) {
      const portalPool = openPortal.get(pairKey) ?? [];
      for (const bookDoc of bookPool) {
        if (usedBooks.has(bookDoc)) continue;
        const same = portalPool.filter(doc => !usedPortal.has(doc) && differences(bookDoc, doc, 0).exact && daysApart(bookDoc.docDate, doc.docDate) <= 31);
        if (same.length !== 1) continue;
        const rivals = bookPool.filter(other => other !== bookDoc && !usedBooks.has(other) && differences(other, same[0], 0).exact);
        if (rivals.length > 0) continue;
        usedPortal.add(same[0]);
        usedBooks.add(bookDoc);
        push(
          {
            ...identity(same[0], bookDoc),
            bucket: "probable",
            confidence: "review",
            why: [
              `Invoice number differs: books “${bookDoc.docNumber}”, GSTR-2B “${same[0].docNumber}”`,
              "Same GSTIN, same amounts and nearly the same date. Confirm before relying on it",
            ],
            itcAtRisk: 0,
            itcUnclaimed: 0,
          },
          "p",
          same[0],
        );
      }
    }
  }

  // Pass 4: the GSTIN looks mistyped: same invoice number and exactly the same amounts.
  {
    const openPortal = indexBy(portalDocs.filter(doc => !usedPortal.has(doc)), doc => `${doc.kind}|${doc.docKey}`);
    for (const bookDoc of booksDocs) {
      if (usedBooks.has(bookDoc)) continue;
      const same = (openPortal.get(`${bookDoc.kind}|${bookDoc.docKey}`) ?? []).filter(
        doc => !usedPortal.has(doc) && doc.gstin !== bookDoc.gstin && differences(bookDoc, doc, 0).exact,
      );
      if (same.length !== 1) continue;
      usedPortal.add(same[0]);
      usedBooks.add(bookDoc);
      push(
        {
          ...identity(same[0], bookDoc),
          bucket: "probable",
          confidence: "review",
          why: [
            `Supplier GSTIN differs: books ${bookDoc.gstin}, GSTR-2B ${same[0].gstin}`,
            "Same invoice number and amounts. The GSTIN may be mistyped in your books",
          ],
          itcAtRisk: 0,
          itcUnclaimed: 0,
        },
        "p",
        same[0],
      );
    }
  }

  // What is left is on one side only.
  for (const bookDoc of booksDocs) {
    if (usedBooks.has(bookDoc)) continue;
    const month = monthOf(bookDoc.docDate);
    const why = ["Not found in GSTR-2B"];
    if (periods.length > 0 && month && !periods.includes(month)) {
      why.push(`Dated ${bookDoc.docDate}, outside ${periods.length === 1 ? "this GSTR-2B period" : "the GSTR-2B months uploaded"}. It may appear in another month’s GSTR-2B`);
    } else {
      why.push("The supplier may not have filed their return yet, or used a different GSTIN or invoice number");
    }
    push({ ...identity(undefined, bookDoc), bucket: "missing_in_2b", confidence: "review", why, itcAtRisk: rupees(Math.max(0, taxOf(bookDoc))), itcUnclaimed: 0 }, "b");
  }
  for (const portalDoc of portalDocs) {
    if (usedPortal.has(portalDoc)) continue;
    push(
      {
        ...identity(portalDoc, undefined),
        bucket: "missing_in_books",
        confidence: "review",
        why: ["In GSTR-2B but not in your purchase register", "It may be unrecorded, booked under another supplier, or recorded in another month"],
        itcAtRisk: 0,
        itcUnclaimed: rupees(Math.max(0, taxOf(portalDoc))),
      },
      "g",
      portalDoc,
    );
  }

  // GSTR-2B itself can say ITC is not available. That outranks the other findings.
  for (const item of items) {
    const portalDoc = portalOf.get(item);
    if (!portalDoc) continue;
    if (portalDoc.itcAvailable === false && item.bucket !== "duplicate") {
      const reason = portalDoc.itcReason
        ? `GSTR-2B marks ITC as not available (${portalDoc.itcReason})`
        : "GSTR-2B marks ITC as not available for this document";
      item.why = [reason, ...item.why.filter(line => line !== "Not found in GSTR-2B")];
      item.bucket = "not_eligible";
      item.confidence = "review";
      item.itcAtRisk = item.books ? Math.max(0, item.books.tax) : 0;
      item.itcUnclaimed = 0;
    } else if (portalDoc.reverseCharge) {
      item.why.push("Reverse charge supply: ITC is claimed after the tax is paid");
    }
  }

  const base = baseOf(portalDocs, booksDocs);
  const summary = summarize(items, base);
  items.sort(byImportance);

  const invalid = new Set([...booksDocs, ...portalDocs].filter(doc => !doc.gstinValid || !gstinChecksumOk(doc.gstin)).map(doc => doc.gstin));
  if (invalid.size > 0) {
    const sample = [...invalid].slice(0, 3).join(", ");
    notes.push(`${invalid.size} supplier ${invalid.size === 1 ? "GSTIN does" : "GSTINs do"} not look like a valid GSTIN (${sample}${invalid.size > 3 ? ", …" : ""}). Check ${invalid.size === 1 ? "it" : "them"} in your books.`);
  }

  return {
    period: periods[0] ?? null,
    periods,
    recipientGstin: options.recipientGstin ?? null,
    items,
    ...summary,
    notes,
  };
}

// ── Summaries ───────────────────────────────────────────────────────────────

const ORDER: Record<Bucket, number> = { missing_in_2b: 0, value_mismatch: 1, duplicate: 2, probable: 3, not_eligible: 4, missing_in_books: 5, matched: 6 };

function byImportance(a: ReconItem, b: ReconItem) {
  return ORDER[a.bucket] - ORDER[b.bucket] || b.itcAtRisk - a.itcAtRisk || a.supplierGstin.localeCompare(b.supplierGstin) || a.docNumber.localeCompare(b.docNumber);
}

type FourHeads = [number, number, number, number];

/** What the two files hold in total, before any matching. Paise throughout. */
interface Base {
  portalCount: number;
  booksCount: number;
  portal: FourHeads;
  books: FourHeads;
}

function headsOfDocs(docs: GstDoc[]): FourHeads {
  return docs.reduce<FourHeads>((total, doc) => [total[0] + doc.igst, total[1] + doc.cgst, total[2] + doc.sgst, total[3] + doc.cess], [0, 0, 0, 0]);
}

function baseOf(portalDocs: GstDoc[], booksDocs: GstDoc[]): Base {
  return {
    portalCount: portalDocs.length,
    booksCount: booksDocs.length,
    // GSTR-2B documents that say ITC is not available are not part of what can be claimed.
    portal: headsOfDocs(portalDocs.filter(doc => doc.itcAvailable !== false)),
    books: headsOfDocs(booksDocs),
  };
}

function toHeads(paise: FourHeads): Heads {
  const [igst, cgst, sgst, cess] = paise;
  return { igst: rupees(igst), cgst: rupees(cgst), sgst: rupees(sgst), cess: rupees(cess), total: rupees(igst + cgst + sgst + cess) };
}

function sideHeads(side: Side | undefined): FourHeads {
  return side ? [Math.round(side.igst * 100), Math.round(side.cgst * 100), Math.round(side.sgst * 100), Math.round(side.cess * 100)] : [0, 0, 0, 0];
}

function plus(a: FourHeads, b: FourHeads): FourHeads {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
}

function excess(a: FourHeads, b: FourHeads): FourHeads {
  return [Math.max(0, a[0] - b[0]), Math.max(0, a[1] - b[1]), Math.max(0, a[2] - b[2]), Math.max(0, a[3] - b[3])];
}

type Summary = Pick<ReconResult, "counts" | "totals" | "byHead" | "suppliers" | "vendors">;

function summarize(items: ReconItem[], base: Base): Summary {
  const counts = {
    matched: 0,
    value_mismatch: 0,
    probable: 0,
    missing_in_2b: 0,
    missing_in_books: 0,
    not_eligible: 0,
    duplicate: 0,
    portal: base.portalCount,
    books: base.booksCount,
  } as ReconResult["counts"];

  let matched: FourHeads = [0, 0, 0, 0];
  let atRisk: FourHeads = [0, 0, 0, 0];
  let unclaimed: FourHeads = [0, 0, 0, 0];
  let notEligible: FourHeads = [0, 0, 0, 0];
  const sum4 = (heads: FourHeads) => heads[0] + heads[1] + heads[2] + heads[3];

  const followUps = new Map<string, SupplierFollowUp>();
  const vendors = new Map<string, VendorSummary>();
  const vendorOf = (item: ReconItem) => {
    let vendor = vendors.get(item.supplierGstin);
    if (!vendor) {
      vendor = {
        gstin: item.supplierGstin,
        name: item.supplierName,
        booksDocs: 0,
        portalDocs: 0,
        matched: 0,
        differing: 0,
        missingIn2b: 0,
        missingInBooks: 0,
        booksTax: 0,
        portalTax: 0,
        itcAtRisk: 0,
        itcUnclaimed: 0,
      };
      vendors.set(item.supplierGstin, vendor);
    }
    if (!vendor.name && item.supplierName) vendor.name = item.supplierName;
    return vendor;
  };

  for (const item of items) {
    counts[item.bucket] += 1;
    const books = sideHeads(item.books);
    const portal = sideHeads(item.portal);
    switch (item.bucket) {
      case "matched":
        matched = plus(matched, books);
        break;
      case "value_mismatch":
        atRisk = plus(atRisk, excess(books, portal));
        unclaimed = plus(unclaimed, excess(portal, books));
        break;
      case "missing_in_2b":
      case "duplicate":
        atRisk = plus(atRisk, books);
        break;
      case "not_eligible":
        atRisk = plus(atRisk, books);
        notEligible = plus(notEligible, portal);
        break;
      case "missing_in_books":
        unclaimed = plus(unclaimed, portal);
        break;
      default:
        break;
    }

    const vendor = vendorOf(item);
    if (item.books) vendor.booksDocs += 1;
    if (item.portal) vendor.portalDocs += 1;
    vendor.booksTax = rupees(Math.round(vendor.booksTax * 100) + sum4(books));
    vendor.portalTax = rupees(Math.round(vendor.portalTax * 100) + sum4(portal));
    vendor.itcAtRisk = rupees(Math.round(vendor.itcAtRisk * 100) + Math.round(item.itcAtRisk * 100));
    vendor.itcUnclaimed = rupees(Math.round(vendor.itcUnclaimed * 100) + Math.round(item.itcUnclaimed * 100));
    if (item.bucket === "matched") vendor.matched += 1;
    else if (item.bucket === "missing_in_2b") vendor.missingIn2b += 1;
    else if (item.bucket === "missing_in_books") vendor.missingInBooks += 1;
    else vendor.differing += 1;

    if (item.bucket === "missing_in_2b" || item.bucket === "value_mismatch" || item.bucket === "duplicate") {
      const entry = followUps.get(item.supplierGstin) ?? { gstin: item.supplierGstin, name: item.supplierName, missing: [], mismatched: 0, itcAtRisk: 0 };
      if (!entry.name && item.supplierName) entry.name = item.supplierName;
      if (item.bucket === "missing_in_2b") entry.missing.push({ docNumber: item.docNumber, docDate: item.docDate, tax: item.books?.tax ?? 0, total: item.books?.total ?? 0 });
      else entry.mismatched += 1;
      entry.itcAtRisk = rupees(Math.round(entry.itcAtRisk * 100) + Math.round(item.itcAtRisk * 100));
      followUps.set(item.supplierGstin, entry);
    }
  }

  const paiseSum = (values: number[]) => values.reduce((total, value) => total + Math.round(value * 100), 0);
  return {
    counts,
    totals: {
      portalTax: rupees(sum4(base.portal)),
      booksTax: rupees(sum4(base.books)),
      matchedTax: rupees(sum4(matched)),
      itcAtRisk: rupees(paiseSum(items.map(item => item.itcAtRisk))),
      itcUnclaimed: rupees(paiseSum(items.map(item => item.itcUnclaimed))),
      notEligibleTax: rupees(sum4(notEligible)),
    },
    byHead: {
      portal: toHeads(base.portal),
      books: toHeads(base.books),
      matched: toHeads(matched),
      atRisk: toHeads(atRisk),
      unclaimed: toHeads(unclaimed),
      notEligible: toHeads(notEligible),
    },
    suppliers: [...followUps.values()].sort((a, b) => b.itcAtRisk - a.itcAtRisk),
    vendors: [...vendors.values()].sort((a, b) => b.itcAtRisk - a.itcAtRisk || b.itcUnclaimed - a.itcUnclaimed || a.gstin.localeCompare(b.gstin)),
  };
}

/** The file totals a saved result carries, so it can be re-summarised after a manual link. */
function baseFromResult(result: Pick<ReconResult, "counts" | "byHead">): Base {
  const paise = (heads: Heads): FourHeads => [Math.round(heads.igst * 100), Math.round(heads.cgst * 100), Math.round(heads.sgst * 100), Math.round(heads.cess * 100)];
  return { portalCount: result.counts.portal, booksCount: result.counts.books, portal: paise(result.byHead.portal), books: paise(result.byHead.books) };
}

/**
 * Pairs one document that is only in the books with one that is only in GSTR-2B, because the
 * person says they are the same. The amounts then decide whether it counts as matched or differing.
 */
export function linkItems(
  result: Pick<ReconResult, "items" | "counts" | "byHead">,
  booksKey: string,
  portalKey: string,
  toleranceRupees = 1,
): { ok: true; items: ReconItem[]; summary: Summary } | { ok: false; message: string } {
  const bookItem = result.items.find(item => item.key === booksKey);
  const portalItem = result.items.find(item => item.key === portalKey);
  if (!bookItem?.books || bookItem.portal || !portalItem?.portal || portalItem.books) {
    return { ok: false, message: "Choose one document that is only in your books and one that is only in GSTR-2B." };
  }
  if (bookItem.kind !== portalItem.kind) {
    return { ok: false, message: "An invoice cannot be linked with a credit or debit note." };
  }
  const books = bookItem.books;
  const portal = portalItem.portal;
  const tolerance = Math.round(toleranceRupees * 100);
  const diff = {
    taxable: Math.round((books.taxable - portal.taxable) * 100),
    igst: Math.round((books.igst - portal.igst) * 100),
    cgst: Math.round((books.cgst - portal.cgst) * 100),
    sgst: Math.round((books.sgst - portal.sgst) * 100),
    cess: Math.round((books.cess - portal.cess) * 100),
  };
  const worst = Math.max(...PARTS.map(name => Math.abs(diff[name])));
  const within = worst <= tolerance;
  const merged: ReconItem = {
    key: `l-${bookItem.key}-${portalItem.key}`,
    bucket: portalItem.bucket === "not_eligible" ? "not_eligible" : within ? "matched" : "value_mismatch",
    status: "approved",
    confidence: "review",
    supplierGstin: bookItem.supplierGstin,
    supplierName: bookItem.supplierName || portalItem.supplierName,
    docNumber: books.docNumber,
    docDate: books.docDate ?? portal.docDate,
    kind: bookItem.kind,
    books,
    portal,
    diff: inRupees(diff),
    why: [
      `Linked by you: books “${books.docNumber}” with GSTR-2B “${portal.docNumber}”`,
      ...(within ? ["Amounts agree after linking"] : describe(diff)),
      ...(portalItem.bucket === "not_eligible" ? portalItem.why.filter(line => /ITC/.test(line)) : []),
    ],
    itcAtRisk: rupees(Math.max(0, Math.round(books.tax * 100) - Math.round(portal.tax * 100))),
    itcUnclaimed: rupees(Math.max(0, Math.round(portal.tax * 100) - Math.round(books.tax * 100))),
  };
  const items = [...result.items.filter(item => item.key !== booksKey && item.key !== portalKey), merged].sort(byImportance);
  return { ok: true, items, summary: summarize(items, baseFromResult(result)) };
}

/** Records a person's decision on one item. The engine's own buckets never change. */
export function applyDecision(items: ReconItem[], key: string, status: ReviewStatus): ReconItem[] {
  return items.map(item => (item.key === key ? { ...item, status } : item));
}
