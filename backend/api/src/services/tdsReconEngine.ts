/**
 * 26AS vs Books (26Q) TDS reconciliation — pure logic.
 *
 * Form 26AS is the tax-credit statement from TRACES (TDS deducted on the
 * assessee's income by others). "Books" is the TDS receivable the assessee has
 * recorded. A CA matches the two by deductor TAN + section to find:
 *   - Matched
 *   - Short credit in books (26AS > books) — claim more
 *   - Not in 26AS (books only)  — credit not yet reflected / wrong claim (risk)
 *   - Not in books (26AS only)  — claimable credit not recorded
 */

export interface TdsEntry {
  deductor: string;
  tan: string;
  section: string;   // e.g. 194C, 194J, 194H
  amount: number;    // TDS amount
  period?: string;
}

export interface ReconRow {
  deductor: string;
  tan: string;
  section: string;
  as26: number;
  books: number;
  difference: number;
  status: "Matched" | "Short credit in books" | "Excess in books" | "Not in 26AS" | "Not in books";
}

export interface ReconResult {
  rows: ReconRow[];
  totals: { as26: number; books: number; difference: number; matched: number; mismatched: number };
}

const norm = (s: string) => (s || "").trim().toUpperCase();
const r2 = (n: number) => Math.round(n * 100) / 100;
const keyOf = (e: TdsEntry) => `${norm(e.tan) || norm(e.deductor)}|${norm(e.section)}`;

export function reconcile26AS(as26: TdsEntry[], books: TdsEntry[]): ReconResult {
  const map = new Map<string, { deductor: string; tan: string; section: string; as26: number; books: number }>();

  const add = (e: TdsEntry, side: "as26" | "books") => {
    const k = keyOf(e);
    const row = map.get(k) ?? { deductor: e.deductor, tan: e.tan, section: e.section, as26: 0, books: 0 };
    row[side] += e.amount;
    if (!row.deductor && e.deductor) row.deductor = e.deductor;
    map.set(k, row);
  };
  as26.forEach(e => add(e, "as26"));
  books.forEach(e => add(e, "books"));

  const rows: ReconRow[] = [...map.values()].map(r => {
    const diff = r2(r.as26 - r.books);
    let status: ReconRow["status"];
    if (r.as26 === 0) status = "Not in 26AS";
    else if (r.books === 0) status = "Not in books";
    else if (Math.abs(diff) < 1) status = "Matched";
    else if (diff > 0) status = "Short credit in books";
    else status = "Excess in books";
    return { deductor: r.deductor, tan: r.tan, section: r.section, as26: r2(r.as26), books: r2(r.books), difference: diff, status };
  }).sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

  const totals = {
    as26: r2(rows.reduce((s, r) => s + r.as26, 0)),
    books: r2(rows.reduce((s, r) => s + r.books, 0)),
    difference: r2(rows.reduce((s, r) => s + r.difference, 0)),
    matched: rows.filter(r => r.status === "Matched").length,
    mismatched: rows.filter(r => r.status !== "Matched").length,
  };
  return { rows, totals };
}

// Demo so the screen renders before any upload.
export const DEMO_26AS: TdsEntry[] = [
  { deductor: "Brightline Retail Pvt Ltd", tan: "DELB12345A", section: "194C", amount: 48000 },
  { deductor: "Orbit Media LLP", tan: "MUMO54321B", section: "194J", amount: 30000 },
  { deductor: "Sunrise Traders", tan: "DELS99887C", section: "194C", amount: 22000 },
  { deductor: "Pinnacle Corp", tan: "DELP44556D", section: "194H", amount: 15000 },
];
export const DEMO_BOOKS: TdsEntry[] = [
  { deductor: "Brightline Retail Pvt Ltd", tan: "DELB12345A", section: "194C", amount: 48000 },   // matched
  { deductor: "Orbit Media LLP", tan: "MUMO54321B", section: "194J", amount: 24000 },              // short credit in books
  { deductor: "Zenith Exports", tan: "DELZ11223E", section: "194C", amount: 18000 },               // not in 26AS
];
