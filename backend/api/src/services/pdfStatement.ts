/**
 * Bank statement PDFs read by position, the way a person reads the table.
 * Each amount is taken from the column it sits under (Withdrawal, Deposit, Balance),
 * never guessed from the text order. Every row is then proved against the bank's
 * printed running balance: previous balance + deposit − withdrawal = balance.
 */
import { PDFParse } from "pdf-parse";
import { detectBankFromStatement } from "./bankDirectory";
import { counterpartyFrom, normalizeDate, type BankStatementSummary, type NormalizedBankTxn } from "./bankStatement";
import { checkRunningBalance, type StatementCheck } from "./statementCheck";

type ColumnKind = "serial" | "date" | "valueDate" | "narration" | "ref" | "debit" | "credit" | "amount" | "drcr" | "balance";

interface Item { text: string; raw: string; left: number; right: number; y: number }
interface Row { page: number; y: number; items: Item[] }
interface Column { kind: ColumnKind; left: number; right: number; center: number; label: string }

interface Layout {
  columns: Column[];
  amountStart: number;
  amountZones: Array<{ kind: ColumnKind; max: number }>;
  dateMax: number;
  date: Column | null;
  valueDate: Column | null;
  ref: Column | null;
  serial: Column | null;
  drcr: Column | null;
}

interface PdfTextItem { str?: string; transform?: number[]; width?: number }
interface PdfPage { getTextContent(): Promise<{ items: PdfTextItem[] }> }
interface PdfDocument { numPages: number; getPage(pageNumber: number): Promise<PdfPage> }

interface DraftTxn {
  page: number;
  lastY: number;
  date: string;
  valueDate: string | null;
  serial: number | null;
  narrationRows: Item[][];
  ref: string[];
  debit: number | null;
  credit: number | null;
  amount: number | null;
  drcr: "dr" | "cr" | null;
  balance: number | null;
  inferred: boolean;
  raw: string[];
}

export type { StatementCheck };

export interface PdfStatementRead {
  status: "ok" | "needs_password" | "wrong_password" | "no_text" | "no_table";
  summary?: BankStatementSummary;
  check?: StatementCheck;
  headerText: string;
  pageCount: number;
}

const MONEY = /^-?(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{1,2}(?:\s*(?:cr|dr)\.?)?$/i;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const TIME = "(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[ap]m)?)?";
const DATE_PATTERNS = [
  new RegExp(`^\\d{1,2}[\\s\\-/.]+${MONTH}[\\s\\-/.,]+\\d{2,4}${TIME}$`, "i"),
  new RegExp(`^\\d{1,2}[\\-/.]\\d{1,2}[\\-/.]\\d{2,4}${TIME}$`),
  /^\d{4}-\d{2}-\d{2}$/,
];

function isDate(text: string) {
  return DATE_PATTERNS.some(pattern => pattern.test(text));
}

function money(text: string): { value: number; suffix: "cr" | "dr" | null } | null {
  if (!MONEY.test(text)) return null;
  const suffix = /dr\.?$/i.test(text) ? "dr" : /cr\.?$/i.test(text) ? "cr" : null;
  const value = Number(text.replace(/(cr|dr)\.?$/i, "").replace(/[,\s]/g, ""));
  return Number.isFinite(value) ? { value, suffix } : null;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function center(item: { left: number; right: number }) {
  return (item.left + item.right) / 2;
}

// ── Reading the PDF ────────────────────────────────────────────────────────

async function loadRows(doc: PdfDocument): Promise<Row[]> {
  const rows: Row[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const item of content.items) {
      const raw = item.str ?? "";
      if (!raw.trim() || !item.transform) continue;
      const left = item.transform[4];
      items.push({ text: raw.trim(), raw, left, right: left + (item.width ?? 0), y: item.transform[5] });
    }
    items.sort((a, b) => b.y - a.y || a.left - b.left);
    const pageRows: Row[] = [];
    for (const item of items) {
      const row = pageRows.find(candidate => Math.abs(candidate.y - item.y) <= 2.5);
      if (row) row.items.push(item);
      else pageRows.push({ page: pageNumber, y: item.y, items: [item] });
    }
    pageRows.sort((a, b) => b.y - a.y);
    for (const row of pageRows) row.items = mergeCells(row.items.sort((a, b) => a.left - b.left));
    rows.push(...pageRows);
  }
  return rows;
}

/** Joins pieces of one cell that pdf.js emitted separately ("31", "Mar", "2026"). */
function mergeCells(items: Item[]): Item[] {
  const merged: Item[] = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    const gap = last ? item.left - last.right : Infinity;
    // About one space wide, scaled to the font; column gaps are much wider.
    const charWidth = last ? (last.right - last.left) / Math.max(1, last.text.length) : 0;
    if (last && gap < Math.max(3.5, Math.min(1.6 * charWidth, 7))) {
      const joiner = gap > 0.8 || /\s$/.test(last.raw) || /^\s/.test(item.raw) ? " " : "";
      last.text = `${last.text}${joiner}${item.text}`.trim();
      last.raw = `${last.raw}${joiner}${item.raw}`;
      last.right = Math.max(last.right, item.right);
    } else {
      merged.push({ ...item });
    }
  }
  return merged;
}

// ── Finding the table header ────────────────────────────────────────────────

function classifyHeader(label: string): ColumnKind | null {
  const text = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (/value\s*(date|dt)/.test(text)) return "valueDate";
  if (/narration|particular|description|details|remark/.test(text)) return "narration";
  if (/chq|cheque|ref\b|ref\.|reference|utr/.test(text)) return "ref";
  if (/withdraw|debit|^dr\.?$|\(dr/.test(text)) return "debit";
  if (/deposit|credit|^cr\.?$|\(cr/.test(text)) return "credit";
  if (/balance/.test(text)) return "balance";
  if (/^(dr\s*\/\s*cr|cr\s*\/\s*dr|type)$/.test(text)) return "drcr";
  if (/amount|amt/.test(text)) return "amount";
  if (/date/.test(text)) return "date";
  if (/^(#|sl|sr|s\.?\s?no|no|sl\.?\s?no)\.?$/.test(text)) return "serial";
  return null;
}

function toColumns(items: Item[]): Column[] {
  const columns: Column[] = [];
  for (const item of items) {
    const kind = classifyHeader(item.text);
    if (!kind) continue;
    // Keep the first column of a kind (a "Date" inside "Value Date" is already handled).
    if (columns.some(column => column.kind === kind)) continue;
    columns.push({ kind, left: item.left, right: item.right, center: center(item), label: item.text });
  }
  return columns;
}

function isHeader(columns: Column[]) {
  const kinds = new Set(columns.map(column => column.kind));
  return kinds.has("date") && kinds.has("balance") && (kinds.has("debit") || kinds.has("credit") || kinds.has("amount")) && columns.length >= 4;
}

/** Two-line headers ("Withdrawal" over "Amount (INR)") are joined by horizontal overlap. */
function combineHeaderRows(top: Item[], bottom: Item[]): Item[] {
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

function buildLayout(columns: Column[]): Layout {
  const amountKinds = new Set<ColumnKind>(["debit", "credit", "amount", "balance"]);
  const amounts = columns.filter(column => amountKinds.has(column.kind)).sort((a, b) => a.center - b.center);
  const texts = columns.filter(column => !amountKinds.has(column.kind) && column.kind !== "drcr" && column.center < amounts[0].center);
  const lastTextRight = texts.length > 0 ? Math.max(...texts.map(column => column.right)) : null;
  const amountStart = lastTextRight != null ? (lastTextRight + amounts[0].left) / 2 : amounts[0].left - 40;
  const amountZones = amounts.map((column, index) => ({
    kind: column.kind,
    max: index < amounts.length - 1 ? (column.center + amounts[index + 1].center) / 2 : Infinity,
  }));
  const find = (kind: ColumnKind) => columns.find(column => column.kind === kind) ?? null;
  const narration = find("narration");
  const ref = find("ref");
  return {
    columns,
    amountStart,
    amountZones,
    dateMax: narration?.left ?? ref?.left ?? amountStart,
    date: find("date"),
    valueDate: find("valueDate"),
    ref,
    serial: find("serial"),
    drcr: find("drcr"),
  };
}

function findHeader(rows: Row[], from: number, page: number): { layout: Layout; next: number } | null {
  for (let index = from; index < rows.length && rows[index].page === page; index += 1) {
    const row = rows[index];
    let columns = toColumns(row.items);
    let consumed = 1;
    const below = rows[index + 1];
    if (!isHeader(columns) && below && below.page === page && row.y - below.y <= 14) {
      columns = toColumns(combineHeaderRows(row.items, below.items));
      consumed = 2;
    }
    if (isHeader(columns)) return { layout: buildLayout(columns), next: index + consumed };
  }
  return null;
}

// ── Reading rows under the header ───────────────────────────────────────────

interface Cells {
  dates: Item[];
  serial: number | null;
  narration: Item[];
  ref: Item[];
  debit: number | null;
  credit: number | null;
  amount: number | null;
  amountSuffix: "cr" | "dr" | null;
  balance: number | null;
  balanceSuffix: "cr" | "dr" | null;
  drcr: "dr" | "cr" | null;
  money: number[];
}

function readCells(items: Item[], layout: Layout): Cells {
  const cells: Cells = { dates: [], serial: null, narration: [], ref: [], debit: null, credit: null, amount: null, amountSuffix: null, balance: null, balanceSuffix: null, drcr: null, money: [] };
  let lastAmountKind: ColumnKind | null = null;
  for (const item of items) {
    const value = money(item.text);
    const mid = center(item);
    if (value && mid >= layout.amountStart) {
      cells.money.push(value.value);
      const zone = layout.amountZones.find(candidate => mid < candidate.max) ?? layout.amountZones[layout.amountZones.length - 1];
      lastAmountKind = zone.kind;
      if (zone.kind === "balance") {
        cells.balance = value.value;
        cells.balanceSuffix = value.suffix;
      } else if (zone.kind === "debit") cells.debit = value.value;
      else if (zone.kind === "credit") cells.credit = value.value;
      else {
        cells.amount = value.value;
        cells.amountSuffix = value.suffix;
      }
      continue;
    }
    if (/^(dr|cr)\.?$/i.test(item.text)) {
      const flag = item.text.toLowerCase().startsWith("d") ? "dr" : "cr";
      if (lastAmountKind === "balance" && mid >= layout.amountStart) cells.balanceSuffix = flag;
      else cells.drcr = flag;
      continue;
    }
    if (isDate(item.text) && item.left < layout.dateMax) {
      cells.dates.push(item);
      continue;
    }
    if (layout.serial && /^\d{1,5}$/.test(item.text) && mid < (layout.date?.left ?? layout.serial.right + 20)) {
      cells.serial = Number(item.text);
      continue;
    }
    if (/^[-–—]$/.test(item.text)) continue;
    if (layout.ref && item.left >= layout.ref.left - 10 && mid < layout.amountStart) {
      cells.ref.push(item);
      continue;
    }
    if (mid < layout.amountStart) cells.narration.push(item);
  }
  return cells;
}

function splitDates(cells: Cells, layout: Layout): { date: string | null; valueDate: string | null } {
  if (cells.dates.length === 0) return { date: null, valueDate: null };
  const sorted = [...cells.dates].sort((a, b) => a.left - b.left);
  if (layout.valueDate && layout.date && sorted.length > 1) {
    const nearDate = (item: Item) => Math.abs(center(item) - layout.date!.center) <= Math.abs(center(item) - layout.valueDate!.center);
    const txn = sorted.find(nearDate) ?? sorted[0];
    const value = sorted.find(item => item !== txn) ?? null;
    return { date: normalizeDate(txn.text), valueDate: value ? normalizeDate(value.text) : null };
  }
  if (layout.valueDate && layout.date && sorted.length === 1) {
    const only = sorted[0];
    const isValue = Math.abs(center(only) - layout.valueDate.center) < Math.abs(center(only) - layout.date.center);
    return isValue ? { date: null, valueDate: normalizeDate(only.text) } : { date: normalizeDate(only.text), valueDate: null };
  }
  return { date: normalizeDate(sorted[0].text), valueDate: null };
}

function rowText(row: Row) {
  return row.items.map(item => item.text).join(" ");
}

// ── Main entry ──────────────────────────────────────────────────────────────

export async function readStatementPdf(buffer: Buffer, options: { password?: string; fileName?: string } = {}): Promise<PdfStatementRead> {
  const parser = new PDFParse({ data: new Uint8Array(buffer), password: options.password || undefined });
  try {
    try {
      await parser.getInfo();
    } catch (err) {
      const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
      if (/password/i.test(text)) {
        return { status: /incorrect|invalid|wrong/i.test(text) ? "wrong_password" : "needs_password", headerText: "", pageCount: 0 };
      }
      throw err;
    }
    const doc = (parser as unknown as { doc?: PdfDocument }).doc;
    if (!doc) return { status: "no_table", headerText: "", pageCount: 0 };
    const rows = await loadRows(doc);
    const allText = rows.map(rowText).join("\n");
    if (allText.replace(/\s/g, "").length < 50) return { status: "no_text", headerText: "", pageCount: doc.numPages };
    return { ...interpret(rows, allText, options.fileName ?? ""), pageCount: doc.numPages };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function interpret(rows: Row[], allText: string, fileName: string): Omit<PdfStatementRead, "pageCount"> {
  const drafts: DraftTxn[] = [];
  const headerLines: string[] = [];
  let opening: number | null = null;
  let layout: Layout | null = null;
  let firstHeaderSeen = false;
  let current: DraftTxn | null = null;
  let narrationLeft = Infinity;
  let narrationRight = 0;
  const closingRows: number[] = [];

  const close = () => {
    if (current) drafts.push(current);
    current = null;
  };

  const pages = [...new Set(rows.map(row => row.page))];
  for (const page of pages) {
    close();
    const start = rows.findIndex(row => row.page === page);
    const found = findHeader(rows, start, page);
    const bodyStart = found ? found.next : start;
    if (found) layout = found.layout;
    if (!firstHeaderSeen) {
      const until = found ? found.next - 1 : rows.length;
      for (let index = start; index < until && rows[index]?.page === page; index += 1) headerLines.push(rowText(rows[index]));
      if (found) firstHeaderSeen = true;
    }
    if (!layout || !firstHeaderSeen) continue;

    for (let index = bodyStart; index < rows.length && rows[index].page === page; index += 1) {
      const row = rows[index];
      const text = rowText(row);
      const cells = readCells(row.items, layout);
      const { date, valueDate } = splitDates(cells, layout);
      const narrationText = cells.narration.map(item => item.text).join(" ");

      if (/opening\s+balance|balance\s+b\/?f|brought\s+forward/i.test(text) && cells.debit == null && cells.credit == null) {
        close();
        if (opening == null) opening = cells.balance ?? cells.amount ?? cells.money[cells.money.length - 1] ?? null;
        continue;
      }
      if (/closing\s+balance|carried\s+forward|balance\s+c\/?f|^total\b|grand\s+total/i.test(narrationText || text)) {
        close();
        if (cells.balance != null) closingRows.push(cells.balance);
        continue;
      }
      if (date) {
        close();
        current = {
          page,
          lastY: row.y,
          date,
          valueDate,
          serial: cells.serial,
          narrationRows: cells.narration.length > 0 ? [cells.narration] : [],
          ref: cells.ref.map(item => item.text),
          debit: cells.debit,
          credit: cells.credit,
          amount: cells.amount,
          drcr: cells.drcr ?? cells.amountSuffix,
          balance: cells.balance == null ? null : cells.balanceSuffix === "dr" ? -cells.balance : cells.balance,
          inferred: false,
          raw: [text],
        };
        for (const item of cells.narration) {
          narrationLeft = Math.min(narrationLeft, item.left);
          narrationRight = Math.max(narrationRight, item.right);
        }
        continue;
      }
      if (!current) continue;
      const near = current.lastY - row.y <= 20;
      const inside = cells.dates.length === 0
        && cells.narration.every(item => item.left >= narrationLeft - 6 && item.right <= layout!.amountStart + 5)
        && cells.narration.length + cells.ref.length + cells.money.length > 0;
      if (!near || !inside) {
        close();
        continue;
      }
      if (cells.narration.length > 0) current.narrationRows.push(cells.narration);
      current.ref.push(...cells.ref.map(item => item.text));
      current.debit ??= cells.debit;
      current.credit ??= cells.credit;
      current.amount ??= cells.amount;
      current.drcr ??= cells.drcr ?? cells.amountSuffix;
      if (current.balance == null && cells.balance != null) current.balance = cells.balanceSuffix === "dr" ? -cells.balance : cells.balance;
      for (const item of cells.narration) narrationRight = Math.max(narrationRight, item.right);
      current.lastY = row.y;
      current.raw.push(text);
    }
    close();
  }

  const headerText = headerLines.join("\n");
  if (drafts.length === 0) return { status: "no_table", headerText };

  // Character-wrapped narrations ("IN/Swig" + "gy") join without a space; word-wrapped ones with a space.
  const fills = drafts
    .filter(draft => draft.narrationRows.length > 1)
    .map(draft => {
      const first = draft.narrationRows[0];
      const right = Math.max(...first.map(item => item.right));
      return (right - narrationLeft) / Math.max(1, narrationRight - narrationLeft);
    });
  const charWrap = fills.length > 0 && fills.every(fill => fill >= 0.8);

  const newestFirst = drafts.length > 1 && drafts[0].date > drafts[drafts.length - 1].date;
  const chronological = newestFirst ? [...drafts].reverse() : drafts;

  // Single amount column without a Dr/Cr marker: the balance movement gives the direction.
  chronological.forEach((draft, index) => {
    if (draft.debit != null || draft.credit != null) return;
    const value = draft.amount;
    if (value == null) return;
    if (draft.drcr) {
      if (draft.drcr === "dr") draft.debit = value;
      else draft.credit = value;
      return;
    }
    const previous = index === 0 ? opening : chronological[index - 1].balance;
    if (previous == null || draft.balance == null) return;
    const delta = round2(draft.balance - previous);
    if (Math.abs(Math.abs(delta) - value) <= 0.01) {
      if (delta >= 0) draft.credit = value;
      else draft.debit = value;
      draft.inferred = true;
    }
  });

  const transactions: NormalizedBankTxn[] = chronological.map((draft, index) => {
    const debit = draft.debit != null && draft.debit !== 0 ? Math.abs(draft.debit) : null;
    const credit = draft.credit != null && draft.credit !== 0 ? Math.abs(draft.credit) : null;
    // Read straight from a Withdrawal/Deposit column; the balance check below raises or lowers this.
    const confidence = draft.inferred ? 0.7 : 0.97;
    const narration = draft.narrationRows
      .map(rowItems => rowItems.map(item => item.text).join(" "))
      .reduce((joined, part) => {
        if (!joined) return part;
        // Word-wrapping banks also break after "-" or "/" ("24-08-" + "25/BHARAT").
        return charWrap || /[-/]$/.test(joined) ? `${joined}${part}` : `${joined} ${part}`;
      }, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return {
      date: draft.date,
      valueDate: draft.valueDate,
      description: narration,
      narration,
      reference: draft.ref.join("").trim() || null,
      debit,
      credit,
      balance: draft.balance,
      counterparty: counterpartyFrom(narration),
      accountName: null,
      accountNumberMasked: null,
      bankName: null,
      rowNumber: index + 1,
      confidence,
      sourceFile: fileName,
      sourcePage: draft.page,
      sourceQuote: draft.raw.join(" | ").slice(0, 500),
    };
  });

  const serials = drafts.map(draft => draft.serial);
  const serialComplete = serials.every(serial => serial != null)
    ? serials.every((serial, index) => index === 0 || Math.abs((serial as number) - (serials[index - 1] as number)) === 1)
    : null;

  const closingBalance = transactions[transactions.length - 1]?.balance ?? null;
  const printedClosing = printedClosingBalance(allText, closingRows, closingBalance);
  const check = checkRunningBalance(transactions, opening, { printedClosing, serialComplete });
  const { failed, closingMatches } = check;

  // Transaction narrations often contain another bank's name or IFSC. Only the
  // account header and the uploaded file name can identify the statement bank.
  const detection = detectBankFromStatement(headerText, fileName);
  const accountNumberMasked = accountNumber(headerText);
  transactions.forEach(txn => {
    txn.bankName = detection?.name ?? null;
    txn.accountName = detection?.name ?? null;
    txn.accountNumberMasked = accountNumberMasked;
  });

  const debitTotal = round2(transactions.reduce((sum, txn) => sum + (txn.debit ?? 0), 0));
  const creditTotal = round2(transactions.reduce((sum, txn) => sum + (txn.credit ?? 0), 0));
  const first = transactions[0];
  const openingBalance = opening ?? (first?.balance != null ? round2(first.balance - (first.credit ?? 0) + (first.debit ?? 0)) : null);
  const warnings: string[] = [];
  if (failed > 0) warnings.push(`${failed} row(s) do not match the running balance. Compare them with the statement.`);
  if (closingMatches === false) warnings.push("The closing balance printed on the statement differs from the last row.");
  if (serialComplete === false) warnings.push("Row numbers on the statement skip a number. A row may be missing.");
  const lowConfidenceCount = transactions.filter(txn => txn.confidence < 0.9).length;

  const summary: BankStatementSummary = {
    status: check.verified ? "parsed" : "needs_review",
    message: check.verified
      ? `${transactions.length} transactions read. Every row matches the bank's running balance.`
      : `${transactions.length} transactions read. ${lowConfidenceCount} need a check.`,
    bankName: detection?.name ?? null,
    periodLabel: periodLabel(headerText) ?? dateRange(transactions),
    accountNumberMasked,
    transactions,
    openingBalance,
    closingBalance,
    debitTotal,
    creditTotal,
    lowConfidenceCount,
    detectedColumns: (layout as Layout | null)?.columns.map(column => column.label) ?? [],
    warnings,
  };
  return { status: "ok", summary, check, headerText };
}

function printedClosingBalance(allText: string, closingRows: number[], last: number | null): number | null {
  if (closingRows.length > 0) return closingRows[closingRows.length - 1];
  // "Closing Balance" is also a very common column heading. A heading is followed by the first
  // transaction (a date), so only figures that come before the next date count as a printed total.
  const dateAhead = new RegExp(`\\d{1,2}[\\-/.]\\d{1,2}[\\-/.]\\d{2,4}|\\d{1,2}[\\s\\-/.]+${MONTH}[\\s\\-/.,]+\\d{2,4}`, "i");
  for (const label of allText.matchAll(/closing\s+balance/gi)) {
    const tail = allText.slice((label.index ?? 0) + label[0].length, (label.index ?? 0) + label[0].length + 160);
    const beforeNextDate = tail.slice(0, tail.search(dateAhead) >= 0 ? tail.search(dateAhead) : tail.length);
    const values = (beforeNextDate.match(/-?(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}/g) ?? []).map(value => Number(value.replace(/,/g, "")));
    if (values.length === 0) continue;
    if (last != null && values.some(value => Math.abs(value - last) <= 0.011)) return last;
    return values[values.length - 1];
  }
  return null;
}

function accountNumber(headerText: string): string | null {
  const labeled = headerText.match(/(?:account|a\/c)\s*(?:no|number|#)\.?\s*[:\-]?\s*([Xx*\d][\dXx*\- ]{4,22}\d)/i);
  let digits = labeled?.[1].replace(/[^\dXx*]/g, "") ?? null;
  if (!digits || digits.replace(/\D/g, "").length < 4) {
    const counts = new Map<string, number>();
    for (const match of headerText.matchAll(/\b\d{9,18}\b/g)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
    digits = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
  return digits ? digits.slice(-4) : null;
}

function formatDay(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function periodLabel(headerText: string): string | null {
  const token = `(\\d{1,2}[\\s\\-/.]+${MONTH}[\\s\\-/.,]+\\d{2,4}|\\d{1,2}[\\-/.]\\d{1,2}[\\-/.]\\d{2,4})`;
  const match = headerText.match(new RegExp(`${token}\\s*(?:-|–|to|till)\\s*${token}`, "i"));
  if (!match) return null;
  const from = normalizeDate(match[1]);
  const to = normalizeDate(match[2]);
  return from && to ? `${formatDay(from)} – ${formatDay(to)}` : null;
}

function dateRange(transactions: NormalizedBankTxn[]): string | null {
  if (transactions.length === 0) return null;
  const dates = transactions.map(txn => txn.date).sort();
  return `${formatDay(dates[0])} – ${formatDay(dates[dates.length - 1])}`;
}

/** Page images for reading a locked or scanned PDF with AI. */
export async function renderPdfPages(buffer: Buffer, password?: string, maxPages = 12): Promise<Buffer[]> {
  const parser = new PDFParse({ data: new Uint8Array(buffer), password: password || undefined });
  try {
    const shots = await parser.getScreenshot({ scale: 2, imageDataUrl: false, imageBuffer: true, first: maxPages });
    return shots.pages.map(page => Buffer.from(page.data));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
