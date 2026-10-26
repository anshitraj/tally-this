/**
 * Sales register → GSTR-1 working.
 *
 * Reads a sales register export (Tally or any accounting software, Excel or CSV), sorts every
 * document into the GSTR-1 tables, and proves that nothing was lost: the tables add up to the
 * register. All money is whole paise. This is a working copy for a CA. It is not a return, it is
 * not validated by the GST portal, and a document the rules cannot place stays visible with the
 * reason instead of being guessed into a table.
 */
import {
  amountCell,
  findHeaderRow,
  gstinChecksumOk,
  headerKey,
  isoDate,
  mapColumns,
  normalizeGstin,
  sumColumns,
  textCell,
  type Cell,
  type Table,
} from "./gstrRecon";
import { stateCode, stateFromGstin } from "./gstStates";

export type SaleKind = "invoice" | "credit_note" | "debit_note";
export type Section = "b2b" | "b2cl" | "b2cs" | "cdnr" | "cdnur" | "exp" | "nil" | "review";

/** Standard GST rates, in percent. A derived rate is snapped to one of these only when it is close. */
export const STANDARD_RATES = [0, 0.1, 0.25, 0.5, 1, 1.5, 3, 5, 6, 7.5, 12, 14, 18, 28, 40];

/** Inter-state invoices to unregistered buyers above this value are "B2C Large". Rupees. */
export const DEFAULT_B2CL_LIMIT_RUPEES = 100000;

export interface SaleLine {
  rate: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  hsn: string | null;
  uqc: string | null;
  qty: number | null;
  /** The rate was worked out from tax ÷ taxable, not printed. */
  derived: boolean;
}

export interface SaleDoc {
  id: string;
  row: number;
  kind: SaleKind;
  number: string;
  date: string | null;
  customer: string;
  gstin: string;
  /** Place of supply as a two-digit state code, "" when unknown. */
  pos: string;
  interState: boolean | null;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  total: number;
  lines: SaleLine[];
  reverseCharge: boolean;
  originalInvoice: string;
  /** Text of the supply-type, place and party cells, used to spot exports and SEZ supplies. */
  supply: string;
  section: Section;
  flags: string[];
}

export interface RegisterRead {
  docs: SaleDoc[];
  cancelled: Array<{ number: string; date: string | null; row: number }>;
  sellerGstin: string | null;
  sellerState: string | null;
  notes: string[];
  rowsRead: number;
  /**
   * Taxable value and tax added straight from the register rows, credit notes taken away. It is
   * computed before any document is sorted, so the tables can be proved against it.
   */
  sourceTotals: Heads;
}

function snapRate(taxable: number, tax: number): { rate: number; derived: boolean; standard: boolean } {
  if (taxable <= 0 || tax <= 0) return { rate: 0, derived: true, standard: true };
  const raw = (tax / taxable) * 100;
  let best = STANDARD_RATES[0];
  for (const rate of STANDARD_RATES) if (Math.abs(rate - raw) < Math.abs(best - raw)) best = rate;
  // Rounding in the register moves the effective rate a little; beyond this it is a mixed-rate document.
  if (Math.abs(best - raw) <= 0.25) return { rate: best, derived: true, standard: true };
  return { rate: Math.round(raw * 100) / 100, derived: true, standard: false };
}

interface Extras {
  pos?: number;
  hsn?: number;
  rate?: number;
  qty?: number;
  uqc?: number;
  supply?: number;
  original?: number;
  status?: number;
}

function extraColumns(header: Cell[]): Extras {
  const extras: Extras = {};
  header.map(headerKey).forEach((key, index) => {
    if (!key) return;
    if (extras.pos === undefined && /place of supply|^pos$|^pos\b|state name|buyer state|ship to state|destination state|^state$|customer state|billing state/.test(key)) extras.pos = index;
    if (extras.hsn === undefined && /\bhsn\b|\bsac\b/.test(key)) extras.hsn = index;
    if (extras.rate === undefined && (/^(gst |tax |igst |cgst )?rate\b|\brate of tax\b|\bgst %|^tax %|^gst rate|^rate %|^%$/.test(key))) extras.rate = index;
    if (extras.qty === undefined && /^(qty|quantity|no of units|billed qty)\b/.test(key)) extras.qty = index;
    if (extras.uqc === undefined && /^(uqc|unit|uom|unit of measure)\b/.test(key)) extras.uqc = index;
    if (extras.supply === undefined && /supply type|type of supply|invoice type|export|sez/.test(key)) extras.supply = index;
    if (extras.original === undefined && /original (invoice|bill)|against (invoice|bill)|ref(erence)? (invoice|no)|invoice ref|original no/.test(key)) extras.original = index;
    if (extras.status === undefined && /^(status|voucher status|cancelled|is cancelled)\b/.test(key)) extras.status = index;
  });
  return extras;
}

const SELLER_GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/;
const NOTE_TYPE = /credit\s*note|debit\s*note|sales\s*return|\bcdn\b|sale\s*return/i;
const EXPORT_WORDS = /\bexport|outside india|other country|overseas|\bshipping bill/i;
const SEZ_WORDS = /\bsez\b|special economic/i;

/**
 * The seller's GSTIN is printed above the table by most register exports ("GSTIN/UIN: 27…").
 * It is only taken from the lines above the heading row, never from a customer column.
 */
function sellerFromPreamble(table: Table, headerRow: number): string | null {
  for (let i = 0; i < Math.min(headerRow, 12); i += 1) {
    const text = (table[i] ?? []).map(cell => String(cell ?? "")).join(" ").toUpperCase();
    const match = SELLER_GSTIN.exec(text);
    if (match && gstinChecksumOk(match[0])) return match[0];
  }
  return null;
}

export interface ReadOptions {
  /** The client's own GSTIN, when known. It decides inter-state or intra-state for lines with no tax. */
  sellerGstin?: string | null;
}

/** A sales register. Throws a plain sentence when the columns cannot be found. */
export function readSalesRegister(table: Table, options: ReadOptions = {}): RegisterRead {
  const headerRow = findHeaderRow(table);
  if (headerRow < 0) {
    throw new Error(
      "We could not find the columns in this file. Export the Sales Register with the date, invoice number, party, GSTIN, taxable value and GST amounts, and upload it again.",
    );
  }
  const header = table[headerRow] ?? [];
  const map = mapColumns(header);
  const extras = extraColumns(header);
  const numberColumn = map.docNo ?? map.voucherNo;
  if (numberColumn === undefined) throw new Error("This file has no invoice or voucher number column. Add one and upload again.");
  if (map.taxable === undefined && map.total === undefined) throw new Error("This file has no taxable value or invoice total column. Add one and upload again.");
  if (map.igst.length + map.cgst.length + map.sgst.length === 0) throw new Error("This file has no IGST, CGST or SGST amount columns. Export the register with the GST columns shown.");

  const sellerGstin = normalizeGstin(options.sellerGstin ?? "") || sellerFromPreamble(table, headerRow);
  const stats = { rounded: 0 };
  interface RawRow {
    row: number;
    number: string;
    date: string | null;
    customer: string;
    gstin: string;
    pos: string;
    kind: SaleKind;
    taxable: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
    printed: number | null;
    hsn: string | null;
    uqc: string | null;
    qty: number | null;
    statedRate: number | null;
    reverse: boolean;
    original: string;
    supplyText: string;
  }
  const raw: RawRow[] = [];
  const cancelled: RegisterRead["cancelled"] = [];
  let skipped = 0;
  for (let i = headerRow + 1; i < table.length; i += 1) {
    const cells = table[i] ?? [];
    if (cells.every(cell => String(cell ?? "").trim() === "")) continue;
    const rowNumber = i + 1;
    const party = textCell(cells[map.party ?? -1]);
    if (/^(grand )?total\b|^closing|^opening|^sub ?total|^carried|^brought/i.test(party)) continue;
    const number = textCell(cells[numberColumn]);
    if (!number) {
      // A line under an invoice (a ledger or item continuation) has no number of its own.
      if (party || textCell(cells[map.taxable ?? -1])) skipped += 1;
      continue;
    }
    const typeText = `${textCell(cells[map.voucherType ?? -1])} ${textCell(cells[map.noteType ?? -1])}`;
    const statusText = textCell(cells[extras.status ?? -1]);
    const cancelledRow = /cancel/i.test(statusText) || /cancel/i.test(typeText) || /\(cancelled\)|^cancelled\b|\bcancelled\b$/i.test(party);
    const date = isoDate(cells[map.docDate ?? -1]) ?? isoDate(cells[map.voucherDate ?? -1]);
    if (cancelledRow) {
      cancelled.push({ number, date, row: rowNumber });
      continue;
    }
    const igst = sumColumns(cells, map.igst, "IGST", rowNumber, stats);
    const cgst = sumColumns(cells, map.cgst, "CGST", rowNumber, stats);
    const sgst = sumColumns(cells, map.sgst, "SGST", rowNumber, stats);
    const cess = sumColumns(cells, map.cess, "cess", rowNumber, stats);
    const printed = map.total !== undefined && textCell(cells[map.total]) !== "" ? amountCell(cells[map.total], "invoice value", rowNumber, stats) : null;
    const tax = igst + cgst + sgst + cess;
    let taxable = map.taxable !== undefined && textCell(cells[map.taxable]) !== "" ? amountCell(cells[map.taxable], "taxable value", rowNumber, stats) : null;
    if (taxable === null) taxable = printed !== null ? printed - tax : 0;
    const negative = taxable < 0 || (printed ?? 0) < 0 || tax < 0;
    const credit = /credit\s*note|sales?\s*return/i.test(typeText) || (negative && !/debit\s*note/i.test(typeText));
    const debit = /debit\s*note/i.test(typeText);
    const kind: SaleKind = NOTE_TYPE.test(typeText) || negative ? (debit ? "debit_note" : credit ? "credit_note" : "credit_note") : "invoice";
    const sign = negative ? -1 : 1;
    const hsnText = textCell(cells[extras.hsn ?? -1]).replace(/[^0-9A-Za-z]/g, "");
    const rateText = textCell(cells[extras.rate ?? -1]).replace(/%/g, "");
    const statedRate = rateText !== "" && Number.isFinite(Number(rateText)) ? Number(rateText) : null;
    const qtyText = textCell(cells[extras.qty ?? -1]);
    raw.push({
      row: rowNumber,
      number,
      date,
      customer: party,
      gstin: normalizeGstin(textCell(cells[map.gstin ?? -1])),
      pos: stateCode(textCell(cells[extras.pos ?? -1])) ?? "",
      kind,
      taxable: sign * taxable,
      igst: sign * igst,
      cgst: sign * cgst,
      sgst: sign * sgst,
      cess: sign * cess,
      printed: printed === null ? null : sign * printed,
      hsn: hsnText || null,
      uqc: textCell(cells[extras.uqc ?? -1]).toUpperCase().slice(0, 12) || null,
      qty: qtyText !== "" && Number.isFinite(Number(qtyText.replace(/,/g, ""))) ? Number(qtyText.replace(/,/g, "")) : null,
      statedRate: statedRate !== null && statedRate >= 0 && statedRate <= 100 ? statedRate : null,
      reverse: /^y/i.test(textCell(cells[map.reverse ?? -1])),
      original: textCell(cells[extras.original ?? -1]),
      supplyText: `${textCell(cells[extras.supply ?? -1])} ${textCell(cells[extras.pos ?? -1])} ${party}`,
    });
  }

  // Item lines of one invoice sit on several rows with the same number: merge them.
  const groups = new Map<string, RawRow[]>();
  for (const row of raw) {
    const key = `${row.kind}|${row.number}|${row.date ?? ""}|${row.gstin || row.customer.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const notes: string[] = [];
  const docs: SaleDoc[] = [];
  let mergedGroups = 0;
  let index = 0;
  for (const rows of groups.values()) {
    index += 1;
    const first = rows[0];
    const sum = (pick: (row: RawRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
    const taxable = sum(row => row.taxable);
    const igst = sum(row => row.igst);
    const cgst = sum(row => row.cgst);
    const sgst = sum(row => row.sgst);
    const cess = sum(row => row.cess);
    const flags: string[] = [];
    let total: number;
    if (rows.length === 1) {
      total = first.printed ?? taxable + igst + cgst + sgst + cess;
    } else {
      mergedGroups += 1;
      const lineTotals = rows.map(row => row.printed);
      const printedAll = lineTotals.every(value => value !== null) ? (lineTotals as number[]) : null;
      const everyLineAdds = printedAll !== null && rows.every((row, position) => Math.abs((printedAll[position] ?? 0) - (row.taxable + row.igst + row.cgst + row.sgst + row.cess)) <= 100);
      const allEqual = printedAll !== null && printedAll.every(value => value === printedAll[0]);
      if (printedAll === null) total = taxable + igst + cgst + sgst + cess;
      else if (everyLineAdds) total = printedAll.reduce((a, b) => a + b, 0);
      else if (allEqual) total = printedAll[0];
      else {
        total = taxable + igst + cgst + sgst + cess;
        flags.push("Item lines carry different totals; the invoice value was worked out from the lines.");
      }
    }
    const lines: SaleLine[] = rows.map(row => {
      const lineTax = row.igst + row.cgst + row.sgst;
      const snapped = row.statedRate !== null ? { rate: row.statedRate, derived: false, standard: STANDARD_RATES.includes(row.statedRate) } : snapRate(Math.abs(row.taxable), Math.abs(lineTax));
      return {
        rate: snapped.rate,
        taxable: row.taxable,
        igst: row.igst,
        cgst: row.cgst,
        sgst: row.sgst,
        cess: row.cess,
        hsn: row.hsn,
        uqc: row.uqc,
        qty: row.qty,
        derived: snapped.derived,
      };
    });
    if (lines.some(line => line.derived && line.taxable !== 0 && !STANDARD_RATES.includes(line.rate))) {
      flags.push("The tax is not a standard GST rate of the taxable value. The invoice may have items at different rates.");
    }
    const gstin = first.gstin;
    const gstinState = stateFromGstin(gstin);
    const posKnown = first.pos !== "";
    const pos = first.pos || gstinState || "";
    const sellerState = sellerGstin ? stateFromGstin(sellerGstin) : null;
    let interState: boolean | null = null;
    if (igst !== 0) interState = true;
    else if (cgst !== 0 || sgst !== 0) interState = false;
    else if (pos && sellerState) interState = pos !== sellerState;
    if (gstin && !gstinChecksumOk(gstin)) flags.push(`GSTIN ${gstin} does not look right.`);
    if (interState === true && !posKnown && !gstinState) flags.push("Place of supply is not in the register, so the state for this inter-state sale is unknown.");
    if (interState === false && sellerState && pos && pos !== sellerState) flags.push("CGST and SGST are charged but the place of supply is another state.");
    if (interState === true && sellerState && pos && pos === sellerState) flags.push("IGST is charged but the place of supply is the seller's own state.");
    if (igst !== 0 && (cgst !== 0 || sgst !== 0)) flags.push("IGST and CGST/SGST appear together on one document.");
    if (Math.abs(total - (taxable + igst + cgst + sgst + cess)) > 100) flags.push("Invoice value differs from taxable value plus tax by more than ₹1.");
    docs.push({
      id: `d${index}`,
      row: first.row,
      kind: first.kind,
      number: first.number,
      date: first.date,
      customer: first.customer,
      gstin,
      pos,
      interState,
      taxable,
      igst,
      cgst,
      sgst,
      cess,
      total,
      lines,
      reverseCharge: rows.some(row => row.reverse),
      originalInvoice: first.original,
      supply: rows.map(row => row.supplyText).join(" "),
      section: "review",
      flags,
    });
  }
  if (docs.length === 0) throw new Error("No sales documents were found in this file.");
  if (mergedGroups > 0) notes.push(`${mergedGroups} invoice${mergedGroups === 1 ? " has" : "s have"} several item lines; they were added together per invoice.`);
  if (skipped > 0) notes.push(`${skipped} line${skipped === 1 ? " has" : "s have"} no invoice number and ${skipped === 1 ? "was" : "were"} not counted. Check ${skipped === 1 ? "it" : "them"} in the file.`);
  if (cancelled.length > 0) notes.push(`${cancelled.length} cancelled ${cancelled.length === 1 ? "document was" : "documents were"} left out of the tables and counted in the document summary.`);
  if (stats.rounded > 0) notes.push(`${stats.rounded} amount${stats.rounded === 1 ? " carried" : "s carried"} more than two decimals and ${stats.rounded === 1 ? "was" : "were"} rounded to the nearest paisa.`);
  // Straight from the rows, before any grouping or sorting: the tables are proved against this.
  const sourceTotals = zeroHeads();
  for (const row of raw) {
    const sign = row.kind === "credit_note" ? -1 : 1;
    addHeads(sourceTotals, { taxable: Math.abs(row.taxable), igst: Math.abs(row.igst), cgst: Math.abs(row.cgst), sgst: Math.abs(row.sgst), cess: Math.abs(row.cess) }, sign);
  }
  return {
    docs,
    cancelled,
    sellerGstin: sellerGstin || null,
    sellerState: sellerGstin ? stateFromGstin(sellerGstin) : null,
    notes,
    rowsRead: raw.length,
    sourceTotals,
  };
}

// ── Sorting documents into GSTR-1 tables ────────────────────────────────────

export interface Gstr1Options {
  b2clLimitRupees?: number;
}

export interface Heads {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export const zeroHeads = (): Heads => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });

function addHeads(target: Heads, source: Partial<Heads>, sign = 1) {
  target.taxable += sign * (source.taxable ?? 0);
  target.igst += sign * (source.igst ?? 0);
  target.cgst += sign * (source.cgst ?? 0);
  target.sgst += sign * (source.sgst ?? 0);
  target.cess += sign * (source.cess ?? 0);
}

export interface RateRow extends Heads {
  rate: number;
}

export interface B2bRow {
  gstin: string;
  customer: string;
  number: string;
  date: string | null;
  value: number;
  pos: string;
  reverseCharge: boolean;
  rates: RateRow[];
  flags: string[];
}

export interface B2csRow extends RateRow {
  pos: string;
}

export interface NoteRow {
  type: "C" | "D";
  gstin: string;
  customer: string;
  number: string;
  date: string | null;
  originalInvoice: string;
  value: number;
  pos: string;
  rates: RateRow[];
  flags: string[];
}

export interface HsnRow {
  hsn: string;
  uqc: string;
  rate: number;
  qty: number;
  value: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface DocSeries {
  kind: "Invoices for outward supply" | "Credit note" | "Debit note";
  prefix: string;
  from: string;
  to: string;
  total: number;
  cancelled: number;
  net: number;
  missing: string[];
}

export interface Gstr1Result {
  period: string | null;
  periods: string[];
  sellerGstin: string | null;
  b2clLimitRupees: number;
  b2b: B2bRow[];
  b2cl: B2bRow[];
  b2cs: B2csRow[];
  cdnr: NoteRow[];
  cdnur: NoteRow[];
  exports: B2bRow[];
  nil: Array<{ nature: string; registered: boolean; interState: boolean | null; taxable: number; documents: number }>;
  review: SaleDoc[];
  hsnB2b: HsnRow[];
  hsnB2c: HsnRow[];
  hsnMissing: number;
  documents: DocSeries[];
  /** Tax and taxable value by section, net of credit notes, in paise. */
  totals: Record<Section, Heads> & { all: Heads };
  /** What the register itself added up to, in paise, to prove the tables lose nothing. */
  register: Heads;
  difference: Heads;
  flagged: Array<{ id: string; number: string; customer: string; date: string | null; section: Section; flags: string[] }>;
  notes: string[];
  counts: { documents: number; invoices: number; notes: number; cancelled: number };
}

function rateRows(doc: SaleDoc): RateRow[] {
  const rows = new Map<number, RateRow>();
  for (const line of doc.lines) {
    const row = rows.get(line.rate) ?? { rate: line.rate, ...zeroHeads() };
    addHeads(row, line);
    rows.set(line.rate, row);
  }
  return [...rows.values()].sort((a, b) => a.rate - b.rate);
}

function splitPrefix(number: string): { prefix: string; digits: string } {
  const match = /^(.*?)(\d+)$/.exec(number.trim());
  return match ? { prefix: match[1], digits: match[2] } : { prefix: number.trim(), digits: "" };
}

function documentSeries(docs: SaleDoc[], cancelled: RegisterRead["cancelled"]): DocSeries[] {
  const out: DocSeries[] = [];
  const kinds: Array<[SaleKind, DocSeries["kind"]]> = [
    ["invoice", "Invoices for outward supply"],
    ["credit_note", "Credit note"],
    ["debit_note", "Debit note"],
  ];
  for (const [kind, label] of kinds) {
    const numbers = [
      ...docs.filter(doc => doc.kind === kind).map(doc => ({ number: doc.number, cancelled: false })),
      ...(kind === "invoice" ? cancelled.map(entry => ({ number: entry.number, cancelled: true })) : []),
    ];
    const byPrefix = new Map<string, Array<{ number: string; digits: string; cancelled: boolean }>>();
    for (const entry of numbers) {
      const { prefix, digits } = splitPrefix(entry.number);
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), { number: entry.number, digits, cancelled: entry.cancelled }]);
    }
    for (const [prefix, entries] of byPrefix) {
      const numeric = entries.filter(entry => entry.digits !== "");
      const sorted = [...entries].sort((a, b) => (a.digits && b.digits ? Number(a.digits) - Number(b.digits) : a.number.localeCompare(b.number)));
      const missing: string[] = [];
      if (numeric.length > 1) {
        const present = new Set(numeric.map(entry => Number(entry.digits)));
        const low = Math.min(...present);
        const high = Math.max(...present);
        const width = Math.max(...numeric.map(entry => entry.digits.length));
        if (high - low < 5000) {
          for (let value = low; value <= high && missing.length < 25; value += 1) {
            if (!present.has(value)) missing.push(`${prefix}${String(value).padStart(width, "0")}`);
          }
        }
      }
      const cancelledCount = entries.filter(entry => entry.cancelled).length;
      out.push({
        kind: label,
        prefix,
        from: sorted[0].number,
        to: sorted[sorted.length - 1].number,
        total: entries.length,
        cancelled: cancelledCount,
        net: entries.length - cancelledCount,
        missing,
      });
    }
  }
  return out;
}

function monthOf(date: string | null) {
  return date && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : null;
}

export function buildGstr1(read: RegisterRead, options: Gstr1Options = {}): Gstr1Result {
  const limit = Math.round((options.b2clLimitRupees ?? DEFAULT_B2CL_LIMIT_RUPEES) * 100);
  const totals = {
    b2b: zeroHeads(),
    b2cl: zeroHeads(),
    b2cs: zeroHeads(),
    cdnr: zeroHeads(),
    cdnur: zeroHeads(),
    exp: zeroHeads(),
    nil: zeroHeads(),
    review: zeroHeads(),
    all: zeroHeads(),
  };
  const b2b: B2bRow[] = [];
  const b2cl: B2bRow[] = [];
  const exportsList: B2bRow[] = [];
  const cdnr: NoteRow[] = [];
  const cdnur: NoteRow[] = [];
  const b2csMap = new Map<string, B2csRow>();
  const nilMap = new Map<string, Gstr1Result["nil"][number]>();
  const review: SaleDoc[] = [];
  const hsnB2b = new Map<string, HsnRow>();
  const hsnB2c = new Map<string, HsnRow>();
  let hsnMissing = 0;
  const sellerState = read.sellerState;

  for (const doc of read.docs) {
    const taxPaise = Math.abs(doc.igst) + Math.abs(doc.cgst) + Math.abs(doc.sgst) + Math.abs(doc.cess);
    const registered = doc.gstin !== "";
    const gstinOk = registered && gstinChecksumOk(doc.gstin);
    const supplyText = doc.supply;
    const isExport = doc.pos === "96" || EXPORT_WORDS.test(supplyText);
    const isSez = SEZ_WORDS.test(supplyText);
    const absNet: Heads = { taxable: Math.abs(doc.taxable), igst: Math.abs(doc.igst), cgst: Math.abs(doc.cgst), sgst: Math.abs(doc.sgst), cess: Math.abs(doc.cess) };
    // A credit note takes away from the totals and is shown as positive amounts in its own table.
    const signed: Heads = doc.kind === "credit_note" ? { taxable: -absNet.taxable, igst: -absNet.igst, cgst: -absNet.cgst, sgst: -absNet.sgst, cess: -absNet.cess } : absNet;
    doc.flags = [...doc.flags];
    const value = Math.abs(doc.total);
    const interState = doc.interState;
    const pos = doc.pos || (interState === false ? sellerState ?? "" : "");

    if (isExport || (isSez && !registered)) {
      doc.section = "exp";
      doc.flags.push(isExport ? "Export: shipping bill and port details are not in the register. Complete the export table in the return." : "SEZ supply: report it with the SEZ options in the return.");
    } else if (doc.kind !== "invoice") {
      const interUnregistered = !registered && interState !== false && value > limit;
      if (registered) doc.section = "cdnr";
      else if (interUnregistered) doc.section = "cdnur";
      else doc.section = "b2cs";
      if (!doc.originalInvoice) doc.flags.push("The original invoice number is not in the register. GSTR-1 asks for it.");
      if (!registered) doc.flags.push("Credit note to an unregistered buyer: check whether the original sale was reported as B2C Large or B2C Small.");
    } else if (taxPaise === 0 && doc.taxable !== 0) {
      doc.section = "nil";
    } else if (registered) {
      doc.section = "b2b";
      if (isSez) doc.flags.push("SEZ supply: report it with the SEZ options in the return.");
    } else if (interState === true && value > limit) {
      doc.section = "b2cl";
    } else if (interState === null && value > limit) {
      doc.section = "review";
      doc.flags.push("Cannot tell whether this large sale to an unregistered buyer is inter-state. Add the place of supply.");
    } else {
      doc.section = "b2cs";
    }
    if (registered && !gstinOk) {
      if (doc.section === "b2b" || doc.section === "cdnr") {
        doc.section = "review";
        doc.flags.push("The buyer GSTIN is not valid, so this document is not placed in a registered-buyer table. Correct the GSTIN in the register.");
      }
    }
    if ((doc.section === "b2b" || doc.section === "b2cs" || doc.section === "b2cl") && interState === true && !pos) {
      // The state is required for B2CL and B2CS.
      if (doc.section !== "b2b") {
        doc.section = "review";
        doc.flags.push("Place of supply is missing for an inter-state sale, so it cannot be put in a state-wise table.");
      }
    }
    if (!doc.date) doc.flags.push("The invoice date is missing.");
    addHeads(totals[doc.section], signed);

    const rates = rateRows(doc);
    const row: B2bRow = { gstin: doc.gstin, customer: doc.customer, number: doc.number, date: doc.date, value, pos, reverseCharge: doc.reverseCharge, rates, flags: doc.flags };
    switch (doc.section) {
      case "b2b":
        b2b.push(row);
        break;
      case "b2cl":
        b2cl.push(row);
        break;
      case "exp":
        exportsList.push(row);
        break;
      case "cdnr":
      case "cdnur": {
        const note: NoteRow = {
          type: doc.kind === "debit_note" ? "D" : "C",
          gstin: doc.gstin,
          customer: doc.customer,
          number: doc.number,
          date: doc.date,
          originalInvoice: doc.originalInvoice,
          value,
          pos,
          rates: rates.map(rate => ({ ...rate, taxable: Math.abs(rate.taxable), igst: Math.abs(rate.igst), cgst: Math.abs(rate.cgst), sgst: Math.abs(rate.sgst), cess: Math.abs(rate.cess) })),
          flags: doc.flags,
        };
        (doc.section === "cdnr" ? cdnr : cdnur).push(note);
        break;
      }
      case "b2cs": {
        // B2CS is a state and rate summary; a credit note is netted into it as negative values.
        for (const rate of rates) {
          const key = `${pos}|${rate.rate}`;
          const entry = b2csMap.get(key) ?? { pos, ...rate, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
          addHeads(entry, doc.kind === "credit_note" ? { taxable: -Math.abs(rate.taxable), igst: -Math.abs(rate.igst), cgst: -Math.abs(rate.cgst), sgst: -Math.abs(rate.sgst), cess: -Math.abs(rate.cess) } : rate);
          b2csMap.set(key, entry);
        }
        break;
      }
      case "nil": {
        const nature = interState === true ? "Inter-state supplies" : "Intra-state supplies";
        const key = `${nature}|${registered}`;
        const entry = nilMap.get(key) ?? { nature, registered, interState, taxable: 0, documents: 0 };
        entry.taxable += signed.taxable;
        entry.documents += 1;
        nilMap.set(key, entry);
        break;
      }
      default:
        review.push(doc);
    }
    // HSN summary: only invoices and notes that carry an HSN, split by buyer type.
    if (doc.section !== "review") {
      for (const line of doc.lines) {
        if (!line.hsn) {
          hsnMissing += 1;
          continue;
        }
        const target = registered ? hsnB2b : hsnB2c;
        const key = `${line.hsn}|${line.uqc ?? ""}|${line.rate}`;
        const entry = target.get(key) ?? { hsn: line.hsn, uqc: line.uqc ?? "NA", rate: line.rate, qty: 0, value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
        const lineSign = doc.kind === "credit_note" ? -1 : 1;
        entry.qty += lineSign * Math.abs(line.qty ?? 0);
        entry.taxable += lineSign * Math.abs(line.taxable);
        entry.igst += lineSign * Math.abs(line.igst);
        entry.cgst += lineSign * Math.abs(line.cgst);
        entry.sgst += lineSign * Math.abs(line.sgst);
        entry.cess += lineSign * Math.abs(line.cess);
        entry.value += lineSign * (Math.abs(line.taxable) + Math.abs(line.igst) + Math.abs(line.cgst) + Math.abs(line.sgst) + Math.abs(line.cess));
        target.set(key, entry);
      }
    }
  }

  const months = new Map<string, number>();
  for (const doc of read.docs) {
    const month = monthOf(doc.date);
    if (month) months.set(month, (months.get(month) ?? 0) + 1);
  }
  const periods = [...months.keys()].sort();
  const period = [...months.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const notes = [...read.notes];
  notes.push(`B2C Large limit used: ₹${(limit / 100).toLocaleString("en-IN")} per inter-state invoice. Check it against the current notification.`);
  if (periods.length > 1) notes.push(`The register covers ${periods.length} months (${periods.join(", ")}). A return is filed for one month; split the register or filter it first.`);
  if (hsnMissing > 0) notes.push(`${hsnMissing} item line${hsnMissing === 1 ? " has" : "s have"} no HSN/SAC, so the HSN summary is incomplete. Add an HSN column to the register.`);
  if (!read.sellerGstin) notes.push("The seller GSTIN was not found in the file. Add it under More options for state checks.");

  // Every document lands in exactly one table, so the tables must add up to the register rows.
  for (const key of ["b2b", "b2cl", "b2cs", "cdnr", "cdnur", "exp", "nil", "review"] as const) addHeads(totals.all, totals[key]);
  const register = read.sourceTotals;
  const difference: Heads = {
    taxable: totals.all.taxable - register.taxable,
    igst: totals.all.igst - register.igst,
    cgst: totals.all.cgst - register.cgst,
    sgst: totals.all.sgst - register.sgst,
    cess: totals.all.cess - register.cess,
  };
  const flagged = read.docs
    .filter(doc => doc.flags.length > 0)
    .map(doc => ({ id: doc.id, number: doc.number, customer: doc.customer, date: doc.date, section: doc.section, flags: doc.flags }));
  const sortHsn = (map: Map<string, HsnRow>) => [...map.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate);
  return {
    period,
    periods,
    sellerGstin: read.sellerGstin,
    b2clLimitRupees: limit / 100,
    b2b,
    b2cl,
    b2cs: [...b2csMap.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate),
    cdnr,
    cdnur,
    exports: exportsList,
    nil: [...nilMap.values()],
    review,
    hsnB2b: sortHsn(hsnB2b),
    hsnB2c: sortHsn(hsnB2c),
    hsnMissing,
    documents: documentSeries(read.docs, read.cancelled),
    totals,
    register,
    difference,
    flagged,
    notes,
    counts: {
      documents: read.docs.length,
      invoices: read.docs.filter(doc => doc.kind === "invoice").length,
      notes: read.docs.filter(doc => doc.kind !== "invoice").length,
      cancelled: read.cancelled.length,
    },
  };
}
