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

export interface Item { text: string; raw: string; left: number; right: number; y: number }
export interface Row { page: number; y: number; items: Item[] }
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

export interface PdfTextItem { str?: string; transform?: number[]; width?: number }
export interface PdfPage { getTextContent(): Promise<{ items: PdfTextItem[] }> }
export interface PdfDocument { numPages: number; getPage(pageNumber: number): Promise<PdfPage> }

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

export function isDate(text: string) {
  return DATE_PATTERNS.some(pattern => pattern.test(text));
}

export function money(raw: string): { value: number; suffix: "cr" | "dr" | null } | null {
  // Many statements print the currency in every amount: "INR 1,18,000.00", "Rs. 500.00", "₹2,400.50".
  const text = raw.trim().replace(/^(?:inr|rs\.?|₹)\s*/i, "");
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

export async function loadRows(doc: PdfDocument): Promise<Row[]> {
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

export function rowText(row: Row) {
  return row.items.map(item => item.text).join(" ");
}

/**
 * The last line of every transaction in some statements, e.g. Canara Bank's "Chq: 525805739236"
 * (or "Chq: 0" when there is no reference). Its value is the transaction's reference.
 */
const BLOCK_END = /^chq\s*[:.]\s*(\S*)\s*$/i;

/**
 * True when transactions are printed as blocks that end with a marker line and whose text starts
 * ABOVE the date and amount line (the cell text is centred on the amounts). Reading such a
 * statement line by line from the date downwards loses the top of every description.
 */
function usesMarkedBlocks(rows: Row[], pages: number[]): boolean {
  let layout: Layout | null = null;
  let anchors = 0;
  let markers = 0;
  let pagesWithLeadLines = 0;
  let pagesWithAnchors = 0;
  for (const page of pages) {
    const start = rows.findIndex(row => row.page === page);
    const found = findHeader(rows, start, page);
    if (found) layout = found.layout;
    if (!layout) continue;
    let seenAnchor = false;
    let leadLines = 0;
    for (let index = found ? found.next : start; index < rows.length && rows[index].page === page; index += 1) {
      const cells = readCells(rows[index].items, layout);
      if (splitDates(cells, layout).date && cells.money.length > 0) {
        anchors += 1;
        seenAnchor = true;
        continue;
      }
      const text = cells.narration.map(item => item.text).join(" ");
      if (BLOCK_END.test(text)) markers += 1;
      else if (!seenAnchor && text && !/opening\s+balance|brought\s+forward/i.test(rowText(rows[index]))) leadLines += 1;
    }
    if (seenAnchor) pagesWithAnchors += 1;
    if (seenAnchor && leadLines > 0) pagesWithLeadLines += 1;
  }
  return anchors >= 3 && markers >= anchors * 0.6 && pagesWithLeadLines >= Math.ceil(pagesWithAnchors / 2);
}

/**
 * Joins the wrapped lines of one description. A bank that wraps at the column's width breaks inside
 * a word only when a line is full ("UPI/DR/52580/COUNTR" + "YDE/UTIB"); a line that stops short of
 * the edge ended at a space ("GOOGLE INDIA" + "DIGITAL SERVICES").
 */
function joinWrappedLines(rows: Item[][], fullRight: number): string {
  let joined = "";
  rows.forEach((items, index) => {
    const line = items.map(item => item.text).join(" ");
    if (index === 0) {
      joined = line;
      return;
    }
    const previousWasFull = Math.max(...rows[index - 1].map(item => item.right)) >= fullRight;
    joined += `${previousWasFull ? "" : " "}${line}`;
  });
  return joined;
}

/** How far right a description line reaches when the bank filled it, from all the lines read. */
function fullLineEdge(drafts: DraftTxn[]): number {
  const rights: number[] = [];
  const charWidths: number[] = [];
  for (const draft of drafts) {
    for (const items of draft.narrationRows) {
      const left = Math.min(...items.map(item => item.left));
      const right = Math.max(...items.map(item => item.right));
      const length = items.map(item => item.text).join(" ").length;
      rights.push(right);
      if (length >= 8) charWidths.push((right - left) / length);
    }
  }
  if (rights.length === 0) return Infinity;
  rights.sort((a, b) => a - b);
  charWidths.sort((a, b) => a - b);
  const edge = rights[Math.floor(rights.length * 0.95)];
  const charWidth = charWidths[Math.floor(charWidths.length / 2)] ?? 6;
  return edge - 1.2 * charWidth;
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
  const markedBlocks = usesMarkedBlocks(rows, pages);
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

    if (markedBlocks) {
      // Description lines read since the last block ended: they belong to the next date line.
      let lead: Array<{ items: Item[]; raw: string }> = [];
      // Description lines below the current date line, until the block's end marker.
      let below: Array<{ y: number; items: Item[]; raw: string }> = [];
      let anchorY = 0;
      for (let index = bodyStart; index < rows.length && rows[index].page === page; index += 1) {
        const row = rows[index];
        const text = rowText(row);
        const cells = readCells(row.items, layout);
        const { date, valueDate } = splitDates(cells, layout);
        // A transaction's line carries its amounts. A wrapped description line can read like a
        // date ("9/11/2025 13:57:40"); without amounts it is part of the description.
        const isAnchor = Boolean(date) && cells.money.length > 0;
        const lineItems = isAnchor ? cells.narration : [...cells.dates, ...cells.narration].sort((a, b) => a.left - b.left);
        const narrationText = lineItems.map(item => item.text).join(" ");
        if (/opening\s+balance|balance\s+b\/?f|brought\s+forward/i.test(text) && cells.debit == null && cells.credit == null) {
          close();
          lead = [];
          if (opening == null) opening = cells.balance ?? cells.amount ?? cells.money[cells.money.length - 1] ?? null;
          continue;
        }
        if (/closing\s+balance|carried\s+forward|balance\s+c\/?f|^total\b|grand\s+total/i.test(narrationText || text)) {
          close();
          lead = [];
          if (cells.balance != null) closingRows.push(cells.balance);
          continue;
        }
        if (isAnchor && date) {
          if (current) {
            // The previous block had no end marker: the lines nearer this date line are this block's.
            const previous: DraftTxn = current;
            while (below.length > 0 && anchorY - below[below.length - 1].y > below[below.length - 1].y - row.y) {
              const moved = below.pop()!;
              previous.narrationRows.pop();
              lead.unshift(moved);
            }
          }
          close();
          current = {
            page,
            lastY: row.y,
            date,
            valueDate,
            serial: cells.serial,
            narrationRows: [...lead.map(line => line.items), ...(cells.narration.length > 0 ? [cells.narration] : [])],
            ref: cells.ref.map(item => item.text),
            debit: cells.debit,
            credit: cells.credit,
            amount: cells.amount,
            drcr: cells.drcr ?? cells.amountSuffix,
            balance: cells.balance == null ? null : cells.balanceSuffix === "dr" ? -cells.balance : cells.balance,
            inferred: false,
            raw: [...lead.map(line => line.raw), text],
          };
          lead = [];
          below = [];
          anchorY = row.y;
          continue;
        }
        if (lineItems.length + cells.ref.length + cells.money.length === 0) continue;
        const marker = BLOCK_END.exec(narrationText);
        if (marker) {
          const open: DraftTxn | null = current;
          if (open) {
            if (marker[1] && !/^0+$/.test(marker[1])) open.ref.push(marker[1]);
            open.raw.push(text);
          }
          close();
          lead = [];
          below = [];
          continue;
        }
        const open: DraftTxn | null = current;
        if (!open) {
          if (lineItems.length > 0) lead.push({ items: lineItems, raw: text });
          continue;
        }
        if (lineItems.length > 0) {
          open.narrationRows.push(lineItems);
          below.push({ y: row.y, items: lineItems, raw: text });
        }
        open.ref.push(...cells.ref.map(item => item.text));
        open.debit ??= cells.debit;
        open.credit ??= cells.credit;
        open.amount ??= cells.amount;
        open.drcr ??= cells.drcr ?? cells.amountSuffix;
        if (open.balance == null && cells.balance != null) open.balance = cells.balanceSuffix === "dr" ? -cells.balance : cells.balance;
        open.lastY = row.y;
        open.raw.push(text);
      }
      close();
      continue;
    }

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

  // A minus sign in the Withdrawal (or Deposit) column is a reversal: the money moved the other way
  // ("UPI/REV ... -40.00" under Withdrawals raises the balance). Swapped only when the balance agrees.
  chronological.forEach((draft, index) => {
    const side = draft.debit != null && draft.debit < 0 ? "debit" : draft.credit != null && draft.credit < 0 ? "credit" : null;
    if (!side) return;
    const previous = index === 0 ? opening : chronological[index - 1].balance;
    if (previous == null || draft.balance == null) return;
    const value = Math.abs((side === "debit" ? draft.debit : draft.credit) as number);
    const delta = round2(draft.balance - previous);
    if (side === "debit" && Math.abs(delta - value) <= 0.005) {
      draft.debit = null;
      draft.credit = value;
    } else if (side === "credit" && Math.abs(delta + value) <= 0.005) {
      draft.credit = null;
      draft.debit = value;
    }
  });

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

  // Marked-block statements wrap at the column's width: a line that reaches the edge was cut mid-word.
  const fullRight = markedBlocks ? fullLineEdge(drafts) : Infinity;

  const transactions: NormalizedBankTxn[] = chronological.map((draft, index) => {
    const debit = draft.debit != null && draft.debit !== 0 ? Math.abs(draft.debit) : null;
    const credit = draft.credit != null && draft.credit !== 0 ? Math.abs(draft.credit) : null;
    // Read straight from a Withdrawal/Deposit column; the balance check below raises or lowers this.
    const confidence = draft.inferred ? 0.7 : 0.97;
    const lines = draft.narrationRows.map(rowItems => rowItems.map(item => item.text).join(" "));
    const narration = (markedBlocks
      ? joinWrappedLines(draft.narrationRows, fullRight)
      : lines.reduce((joined, part) => {
          if (!joined) return part;
          // Word-wrapping banks also break after "-" or "/" ("24-08-" + "25/BHARAT").
          return charWrap || /[-/]$/.test(joined) ? `${joined}${part}` : `${joined} ${part}`;
        }, ""))
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

/** The slice of the PDF.js document that page rendering needs. */
interface RenderableDocument {
  getPage(pageNumber: number): Promise<{
    getViewport(options: { scale: number }): { width: number; height: number };
    render(context: { canvasContext: unknown; viewport: unknown; canvas: unknown }): { promise: Promise<void> };
    cleanup(): void;
  }>;
  canvasFactory: {
    create(width: number, height: number): { canvas: { encode?: (format: "png") => Promise<Buffer>; toBuffer?: (mime: "image/png") => Buffer }; context: unknown };
    destroy(canvasAndContext: unknown): void;
  };
}

/**
 * PNG images of the given 1-based pages, in page order, at twice the page size.
 *
 * pdf-parse's own getScreenshot encodes with a synchronous toBuffer and never releases the page
 * canvas, and @napi-rs/canvas then keeps about 8 MB of native memory per page for the life of the
 * process: a 150-page scan held more than a gigabyte. Encoding asynchronously and destroying each
 * canvas keeps memory flat and gives the same pixels. If a future pdf-parse no longer exposes the
 * document this falls back to getScreenshot.
 */
async function renderPagesPng(parser: PDFParse, pages: number[]): Promise<Buffer[]> {
  const load = (parser as unknown as { load?: () => Promise<RenderableDocument> }).load;
  const doc = typeof load === "function" ? await load.call(parser).catch(() => null) : null;
  if (!doc?.canvasFactory || typeof doc.getPage !== "function") {
    const shots = await parser.getScreenshot({ scale: 2, imageDataUrl: false, imageBuffer: true, partial: pages });
    return [...shots.pages].sort((a, b) => a.pageNumber - b.pageNumber).map(page => Buffer.from(page.data));
  }
  const images: Buffer[] = [];
  for (const pageNumber of [...pages].sort((a, b) => a - b)) {
    const page = await doc.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale: 2 });
      const surface = doc.canvasFactory.create(viewport.width, viewport.height);
      try {
        await page.render({ canvasContext: surface.context, viewport, canvas: surface.canvas }).promise;
        const { canvas } = surface;
        images.push(typeof canvas.encode === "function" ? await canvas.encode("png") : Buffer.from(canvas.toBuffer?.("image/png") ?? []));
      } finally {
        doc.canvasFactory.destroy(surface);
      }
    } finally {
      page.cleanup();
    }
  }
  return images;
}

/** Page images for reading a locked or scanned PDF with AI. */
export async function renderPdfPages(buffer: Buffer, password?: string, maxPages = 12): Promise<Buffer[]> {
  const parser = new PDFParse({ data: new Uint8Array(buffer), password: password || undefined });
  try {
    const total = (await parser.getInfo()).total;
    return await renderPagesPng(parser, Array.from({ length: Math.min(maxPages, total) }, (_, index) => index + 1));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

export interface PdfPageRenderer {
  pageCount: number;
  /** Images of the given 1-based pages, in page order. Calls are served one at a time. */
  render(pages: number[]): Promise<Buffer[]>;
  close(): Promise<void>;
}

/** One opened document that renders any pages on request, so a long scan is parsed once. */
export async function openPdfRenderer(buffer: Buffer, password?: string): Promise<PdfPageRenderer> {
  const parser = new PDFParse({ data: new Uint8Array(buffer), password: password || undefined });
  let pageCount = 0;
  try {
    pageCount = (await parser.getInfo()).total;
  } catch (err) {
    await parser.destroy().catch(() => undefined);
    throw err;
  }
  let queue: Promise<unknown> = Promise.resolve();
  return {
    pageCount,
    render(pages) {
      const run = queue.then(() => renderPagesPng(parser, pages));
      queue = run.catch(() => undefined);
      return run;
    },
    close: () => parser.destroy().catch(() => undefined),
  };
}
