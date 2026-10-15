/**
 * Reads a Tally report printed or saved as PDF, by column position the way a person reads it.
 * Works for Tally's own prints (Particulars | Vch Type | Vch No. | Debit | Credit) and for the
 * same table with a single Amount column and a Dr/Cr column. Totals Tally printed are added up
 * against the entries read, so a missing row shows as a difference instead of passing quietly.
 */
import { PDFParse } from "pdf-parse";
import { normalizeDate } from "./bankStatement";
import { classifyTallyHeader, sideOf, TALLY_FORMATS, type TallyColumn } from "./tallyColumns";
import { isDate, loadRows, rowText, type Item, type PdfDocument, type Row } from "./pdfStatement";
import type { TallyRow } from "./statementCompare";

export type TallyPdfRead = { ok: true; rows: TallyRow[]; notes: string[] } | { ok: false; message: string };

interface Col { kind: TallyColumn; item: Item; center: number }
/** Where cells of one column actually start, learned from the rows (headings may be centred). */
interface Cluster { left: number; minLeft: number; maxRight: number; count: number; kind: TallyColumn | null }
interface Header { text: Col[]; amounts: Col[]; kinds: Set<TallyColumn>; clusters: Cluster[] | null }

const AMOUNT_TEXT = /^-?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?(?:\s*(?:cr|dr)\.?)?$/i;
const SKIP_LINE = /^(page\s*\d+|\d+\s*of\s*\d+|continued\b|printed\b|powered by|tallyprime|tally\.erp)/i;
const BALANCE_LINE = /opening\s+balance|closing\s+balance|carried\s+(over|forward)|brought\s+forward|balance\s+(b|c)\/?f/i;
const TOTAL_LINE = /^(grand\s+)?total\b|^total\s+(of|for)\b/i;
const LINE_GAP = 22;

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** "118,000.00", "INR 118,000.00", "1,200.50 Dr". Dates and words are not amounts. */
function amountText(text: string): { value: number; side: "debit" | "credit" | null } | null {
  const cleaned = text.trim().replace(/^(?:inr|rs\.?|₹)\s*/i, "");
  if (!AMOUNT_TEXT.test(cleaned)) return null;
  const suffix = cleaned.match(/(cr|dr)\.?$/i);
  const value = Number(cleaned.replace(/(cr|dr)\.?$/i, "").replace(/[,\s]/g, ""));
  return Number.isFinite(value) ? { value, side: suffix ? sideOf(suffix[1]) : null } : null;
}

function headerOf(items: Item[]): Header | null {
  const cols: Col[] = [];
  const kinds = new Set<TallyColumn>();
  for (const item of items) {
    const kind = classifyTallyHeader(item.text);
    if (!kind || kinds.has(kind)) continue;
    kinds.add(kind);
    cols.push({ kind, item, center: (item.left + item.right) / 2 });
  }
  if (!kinds.has("date") || !kinds.has("particulars")) return null;
  // A bank statement has a running balance; a Tally voucher table has none.
  if (kinds.has("balance")) return null;
  if (!kinds.has("debit") && !kinds.has("credit") && !kinds.has("amount")) return null;
  // What makes it Tally: the voucher (type or number) or the Dr/Cr side is named.
  if (!kinds.has("vchType") && !kinds.has("vchNo") && !kinds.has("drcr")) return null;
  const isAmount = (col: Col) => col.kind === "debit" || col.kind === "credit" || col.kind === "amount";
  return {
    kinds,
    amounts: cols.filter(isAmount).sort((a, b) => a.center - b.center),
    text: cols.filter(col => !isAmount(col)).sort((a, b) => a.item.left - b.item.left),
    clusters: null,
  };
}

/**
 * Headings are often centred over left-aligned cells, so the heading's own edge says little about
 * where its cells start. Cells of one column share a left edge, so group the text cells by it and
 * give each group to the heading it sits under.
 */
function learnColumns(items: Item[], header: Header): Cluster[] {
  const sorted = items.filter(item => !amountText(item.text)).sort((a, b) => a.left - b.left);
  const groups: Cluster[] = [];
  for (const item of sorted) {
    const last = groups[groups.length - 1];
    if (last && item.left - last.left <= 6) {
      last.minLeft = Math.min(last.minLeft, item.left);
      last.maxRight = Math.max(last.maxRight, item.right);
      last.count += 1;
    } else {
      groups.push({ left: item.left, minLeft: item.left, maxRight: item.right, count: 1, kind: null });
    }
  }
  // A real column repeats on every row; a one-off cell (a footnote) is not a column.
  const minCount = Math.max(2, Math.ceil(sorted.length / Math.max(1, header.text.length) / 4));
  for (const group of groups) {
    if (group.count < minCount) continue;
    let bestKind: TallyColumn | null = null;
    let bestDistance = Infinity;
    for (const col of header.text) {
      const distance = col.center < group.minLeft ? group.minLeft - col.center : col.center > group.maxRight ? col.center - group.maxRight : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestKind = col.kind;
      }
    }
    group.kind = bestKind;
  }
  return groups.filter(group => group.kind != null);
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

/** The text column a cell sits in: the last heading that starts at or before the cell. */
function textColumn(item: Item, header: Header): Col | null {
  if (header.clusters) {
    let nearest: Cluster | null = null;
    for (const cluster of header.clusters) {
      if (Math.abs(item.left - cluster.left) > 8) continue;
      if (!nearest || Math.abs(item.left - cluster.left) < Math.abs(item.left - nearest.left)) nearest = cluster;
    }
    const byKind = nearest ? header.text.find(col => col.kind === nearest!.kind) : null;
    if (byKind) return byKind;
  }
  let found: Col | null = null;
  for (const col of header.text) if (col.item.left - 6 <= item.left) found = col;
  return found;
}

function amountColumn(item: Item, header: Header): Col | null {
  if (header.amounts.length === 0 || !amountText(item.text)) return null;
  const center = (item.left + item.right) / 2;
  let best: Col | null = null;
  let bestDistance = Infinity;
  for (const col of header.amounts) {
    // Numbers are usually right-aligned under their heading, sometimes centred or left-aligned.
    const distance = Math.min(Math.abs(center - col.center), Math.abs(item.right - col.item.right), Math.abs(item.left - col.item.left));
    if (distance < bestDistance) {
      best = col;
      bestDistance = distance;
    }
  }
  const text = textColumn(item, header);
  const textDistance = text ? Math.abs(item.left - text.item.left) : Infinity;
  return best && bestDistance <= textDistance + 2 ? best : null;
}

interface Draft {
  page: number;
  lastY: number;
  date: string;
  ledger: string[];
  narration: string[];
  voucherNo: string;
  debit: number | null;
  credit: number | null;
}

function interpret(rows: Row[]): { rows: TallyRow[]; notes: string[]; headerFound: boolean } {
  const drafts: Draft[] = [];
  const printed: { debit: number | null; credit: number | null } = { debit: null, credit: null };
  const opening = { debit: 0, credit: 0 };
  const closing = { debit: 0, credit: 0 };
  let header: Header | null = null;
  let current: Draft | null = null;
  let carriedDate = "";
  let totalLines = 0;
  let undirected = 0;

  const close = () => {
    if (current) drafts.push(current);
    current = null;
  };

  // First pass: where the table starts on each page, so column positions can be learned from every row.
  const sections: Array<{ page: number; header: Header; bodyStart: number }> = [];
  for (const page of [...new Set(rows.map(row => row.page))]) {
    const start = rows.findIndex(row => row.page === page);
    const found = findHeader(rows, start, page);
    if (found) header = found.header;
    if (!header) continue;
    sections.push({ page, header, bodyStart: found ? found.next : start });
  }
  if (sections.length > 0) {
    const body: Item[] = [];
    for (const section of sections) {
      for (let index = section.bodyStart; index < rows.length && rows[index].page === section.page; index += 1) {
        const text = rowText(rows[index]).trim();
        if (!text || SKIP_LINE.test(text) || BALANCE_LINE.test(text) || TOTAL_LINE.test(text)) continue;
        body.push(...rows[index].items);
      }
    }
    const clusters = learnColumns(body, sections[0].header);
    for (const section of sections) section.header.clusters = clusters;
  }

  for (const { page, header: layout, bodyStart } of sections) {
    close();
    for (let index = bodyStart; index < rows.length && rows[index].page === page; index += 1) {
      const row = rows[index];
      const text = rowText(row).trim();
      if (!text || SKIP_LINE.test(text)) continue;

      // Sort the row's cells into amounts and text columns.
      let debit: number | null = null;
      let credit: number | null = null;
      let single: { value: number; side: "debit" | "credit" | null } | null = null;
      const cells: Record<string, string[]> = {};
      let marker: "debit" | "credit" | null = null;
      let dateItem: Item | null = null;
      for (const item of row.items) {
        const amount = amountColumn(item, layout);
        if (amount) {
          const value = amountText(item.text)!;
          if (amount.kind === "debit") debit = value.value;
          else if (amount.kind === "credit") credit = value.value;
          else single = value;
          continue;
        }
        const column = textColumn(item, layout);
        if (!column) continue;
        if (column.kind === "date" && isDate(item.text) && !dateItem) {
          dateItem = item;
          continue;
        }
        // A standalone "Dr" or "Cr" is a side marker, not part of a name ("Dr Reddy's" stays whole).
        if (sideOf(item.text) && (column.kind === "drcr" || (column.kind !== "particulars" && column.kind !== "narration"))) {
          marker ??= sideOf(item.text);
          continue;
        }
        (cells[column.kind] ??= []).push(item.text);
      }
      if (single) {
        const value = single as { value: number; side: "debit" | "credit" | null };
        const side = marker ?? value.side;
        if (side === "credit") credit = value.value;
        else {
          debit = value.value;
          if (!side) undirected += 1;
        }
      }
      const hasAmount = debit != null || credit != null;
      const particulars = (cells.particulars ?? []).join(" ").trim();

      // Opening and closing balances are not entries; their amounts only help prove the totals.
      if (BALANCE_LINE.test(text)) {
        close();
        const side = /opening|brought/i.test(text) ? opening : closing;
        side.debit += debit ?? 0;
        side.credit += credit ?? 0;
        continue;
      }
      if (TOTAL_LINE.test(text) && hasAmount) {
        close();
        // The last total printed is the grand total; page totals before it are not summed.
        totalLines += 1;
        printed.debit = debit ?? printed.debit;
        printed.credit = credit ?? printed.credit;
        continue;
      }

      const date = dateItem ? normalizeDate((dateItem as Item).text) : null;
      const open = current as Draft | null;
      // A later voucher of the same day carries no date, but has its own number or its own amount.
      const hasVoucherCell = Boolean(cells.vchType?.length || cells.vchNo?.length);
      const startsVoucher = Boolean(date)
        || (Boolean(particulars) && hasVoucherCell)
        || (hasAmount && Boolean(particulars) && open != null && (open.debit != null || open.credit != null));
      if (startsVoucher) {
        // Tally prints the date once for a run of vouchers on the same day.
        if (date) carriedDate = date;
        close();
        if (!carriedDate) continue;
        current = {
          page,
          lastY: row.y,
          date: carriedDate,
          ledger: particulars ? [particulars] : [],
          narration: cells.narration ? [cells.narration.join(" ")] : [],
          voucherNo: (cells.vchNo ?? []).join(" "),
          debit,
          credit,
        };
        continue;
      }
      if (!open) continue;
      // Far below the entry it is a footnote, not a continuation.
      if (open.lastY - row.y > LINE_GAP) {
        close();
        continue;
      }
      if (open.debit == null && open.credit == null && hasAmount) {
        open.debit = debit;
        open.credit = credit;
      }
      if (particulars) open.narration.push(particulars);
      if (cells.narration) open.narration.push(cells.narration.join(" "));
      open.lastY = row.y;
    }
    close();
  }

  const entries: TallyRow[] = [];
  for (const draft of drafts) {
    const debitValue = draft.debit != null && draft.debit !== 0 ? Math.abs(draft.debit) : null;
    const creditValue = draft.credit != null && draft.credit !== 0 ? Math.abs(draft.credit) : null;
    const ledgerName = draft.ledger.join(" ").replace(/^(to|by)\s+/i, "").trim();
    if (!ledgerName || (debitValue == null && creditValue == null)) continue;
    entries.push({
      id: `tally-${entries.length + 1}`,
      date: draft.date,
      ledgerName,
      voucherNumber: draft.voucherNo.trim() || null,
      debit: debitValue,
      credit: creditValue,
      narration: draft.narration.join(" ").replace(/\s{2,}/g, " ").trim(),
      rowNumber: entries.length + 1,
    });
  }

  const notes: string[] = [];
  const hasSides = header != null && ((header as Header).kinds.has("debit") || (header as Header).kinds.has("credit"));
  if (header && entries.length > 0) {
    const sum = (pick: (row: TallyRow) => number | null) => round2(entries.reduce((total, row) => total + (pick(row) ?? 0), 0));
    if (hasSides && totalLines > 0 && (printed.debit != null || printed.credit != null)) {
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
      notes.push(`${entries.length} entries were read from this PDF. It has no printed total to add them up against, so compare the count with Tally.`);
    }
    if (undirected > 0) notes.push(`Potential risk — needs CA review. ${undirected} ${undirected === 1 ? "entry has" : "entries have"} no Dr/Cr marker and ${undirected === 1 ? "was" : "were"} taken as debit.`);
  }
  return { rows: entries, notes, headerFound: header != null };
}

export async function readTallyPdf(buffer: Buffer): Promise<TallyPdfRead> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    try {
      await parser.getInfo();
    } catch (err) {
      const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
      if (/password/i.test(text)) return { ok: false, message: "This Tally PDF is password-protected. Export it from Tally without a password, or as Excel." };
      return { ok: false, message: "This PDF could not be opened. It may be damaged. Export it from Tally again, or use Excel." };
    }
    const doc = (parser as unknown as { doc?: PdfDocument }).doc;
    if (!doc) return { ok: false, message: `No entries were found in this Tally file. Export the bank ledger or Day Book from Tally as ${TALLY_FORMATS} and try again.` };
    const rows = await loadRows(doc);
    const textLength = rows.map(rowText).join("").replace(/\s/g, "").length;
    if (textLength < 40) return { ok: false, message: "This PDF is a scan or picture, so Tally entries cannot be read from it. Export from Tally as Excel, XML or a PDF printed straight from Tally." };
    const read = interpret(rows);
    if (read.rows.length === 0) {
      return {
        ok: false,
        message: read.headerFound
          ? `No entries were found in this Tally file. Export the bank ledger or Day Book from Tally as ${TALLY_FORMATS} and try again.`
          : `This PDF does not look like a Tally Day Book or ledger (it needs Date, Particulars or Ledger Name, a voucher column and Debit/Credit or Amount with Dr/Cr). Export the bank ledger from Tally as ${TALLY_FORMATS}.`,
      };
    }
    return { ok: true, rows: read.rows, notes: read.notes };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
