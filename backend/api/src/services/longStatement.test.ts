import assert from "node:assert/strict";
import test from "node:test";
import PDFDocument from "pdfkit";
import { bankStatementAnswerSchema, compactPrompt, compactStatementSchema, type AIBankStatement } from "./aiStatementShape";
import { chronological } from "./statementCheck";
import { outOfOrderIndices } from "./dateOrder";
import { mergeStatements, readBankStatementByPages, type DocFile, type PageGroupReader } from "./statementPageReader";
import { readStatementPdf } from "./pdfStatement";
import { clearReadJobs, findReadJob, finishedWithin, releaseReadJob, startReadJob } from "./readJobs";
import { OCR_MAX_PAGES, chainIntact, pageGroups, pageRanges, pagesNeedingOcr, planAiRead } from "./statementReadPlan";
import { clearStatementCache, recallStatement, rememberStatement, statementCacheKey } from "./statementCache";
import type { StatementRead } from "./fileReaders";
import { recognizeStatement } from "./statementOcr";
import type { StatementCheck } from "./statementCheck";

// ── Plan ────────────────────────────────────────────────────────────────────

function check(overrides: Partial<StatementCheck> = {}): StatementCheck {
  return { rows: 100, checked: 100, passed: 100, failed: 0, failedRows: [], openingBalance: 1000, closingBalance: 5000, printedClosing: 5000, closingMatches: true, serialComplete: null, verified: true, ...overrides };
}

test("a table read whose balances chain is never sent to AI, however long the statement", () => {
  assert.equal(planAiRead({ hasTableRead: true, check: check({ verified: false, checked: 99, passed: 99, closingMatches: null }), pageCount: 160 }), "skip");
  assert.equal(planAiRead({ hasTableRead: true, check: check(), pageCount: 3 }), "skip");
});

test("a long statement with rows that do not chain keeps the table read and flags those rows", () => {
  const broken = check({ verified: false, failed: 7, passed: 93, failedRows: [4, 9] });
  assert.equal(planAiRead({ hasTableRead: true, check: broken, pageCount: 160 }), "skip");
  assert.equal(planAiRead({ hasTableRead: true, check: broken, pageCount: 6 }), "whole_document");
});

test("a scan is read as one document when short and in page groups when long", () => {
  assert.equal(planAiRead({ hasTableRead: false, pageCount: 0 }), "whole_document");
  assert.equal(planAiRead({ hasTableRead: false, pageCount: 12 }), "whole_document");
  assert.equal(planAiRead({ hasTableRead: false, pageCount: 13 }), "by_pages");
  assert.equal(planAiRead({ hasTableRead: false, pageCount: 158 }), "by_pages");
});

test("the chain test needs every comparable row to pass and nothing printed to contradict it", () => {
  assert.equal(chainIntact(check({ checked: 99, passed: 99 })), true);
  assert.equal(chainIntact(check({ checked: 50, passed: 50 })), false);
  assert.equal(chainIntact(check({ failed: 1, passed: 99 })), false);
  assert.equal(chainIntact(check({ closingMatches: false })), false);
  assert.equal(chainIntact(check({ rows: 0, checked: 0, passed: 0 })), false);
  assert.equal(chainIntact(null), false);
});

test("pages are grouped in order and named in plain ranges", () => {
  assert.deepEqual(pageGroups(10, 4), [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]]);
  assert.deepEqual(pageGroups(0, 4), []);
  assert.equal(pageRanges([5, 6, 7, 8, 13, 9, 10]), "5–10, 13");
  assert.equal(pageRanges([2]), "2");
});

// ── Reading a long scan in page groups ──────────────────────────────────────

type Row = { date: string; narration: string; debit: number | null; credit: number | null; balance: number };
const ROWS_PER_PAGE = 5;

/** Rows in paise-exact running-balance order, so every row proves the next. */
function statementRows(pages: number): { rows: Row[]; opening: number; closing: number } {
  const rows: Row[] = [];
  let paise = 50_000_00;
  for (let index = 0; index < pages * ROWS_PER_PAGE; index += 1) {
    const amount = 1_000_00 + ((index * 7919) % 90_000);
    const credit = index % 3 === 0;
    paise += credit ? amount : -amount;
    const day = String(1 + Math.floor(index / 15)).padStart(2, "0");
    rows.push({ date: `2025-04-${day}`, narration: `UPI/${100000 + index}/PARTY ${index % 17}`, debit: credit ? null : amount / 100, credit: credit ? amount / 100 : null, balance: paise / 100 });
  }
  return { rows, opening: 50_000, closing: rows[rows.length - 1].balance };
}

function groupReader(all: Row[], options: {
  opening?: number | null;
  closing?: number | null;
  drop?: (page: number) => boolean;
  fail?: (pages: number[]) => boolean;
  calls?: number[][];
  /** Pages of the groups read with the strongest model. */
  strongCalls?: number[][];
  /** Added to every balance of a group: rows that follow each other but not their neighbours. */
  shift?: (pages: number[], strong: boolean) => number;
  /** Reads April as January for a whole group: dates the running balance cannot see. */
  wrongMonth?: (pages: number[], strong: boolean) => boolean;
} = {}): PageGroupReader {
  return async ({ pages, strong }) => {
    options.calls?.push(pages);
    if (strong) options.strongCalls?.push(pages);
    if (options.fail?.(pages)) return { ok: false, error: "ai_read_failed" };
    const rows = pages.filter(page => !options.drop?.(page)).flatMap(page => all.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE));
    const last = pages[pages.length - 1] * ROWS_PER_PAGE >= all.length;
    const statement: AIBankStatement = {
      bankName: pages[0] === 1 ? "Sample Bank" : null,
      ifsc: null,
      accountNumberLast4: pages[0] === 1 ? "4321" : null,
      periodFrom: null,
      periodTo: null,
      openingBalance: pages[0] === 1 ? options.opening ?? null : 99999,
      closingBalance: last ? options.closing ?? null : 12345,
      transactions: rows.map(row => ({ date: options.wrongMonth?.(pages, strong === true) ? row.date.replace("-04-", "-01-") : row.date, valueDate: null, narration: row.narration, reference: null, debit: row.debit, credit: row.credit, balance: Math.round((row.balance + (options.shift?.(pages, strong === true) ?? 0)) * 100) / 100 })),
    };
    return { ok: true, data: statement, provider: "gemini", model: "test-model" };
  };
}

const render = async (pages: number[]): Promise<DocFile[]> => pages.map(() => ({ data: Buffer.from("png"), mimeType: "image/png" }));

test("40 scanned pages are read in groups and joined into one statement that proves", async () => {
  const { rows, opening, closing } = statementRows(40);
  const calls: number[][] = [];
  const progress: number[] = [];
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 40,
    groups: pageGroups(40, 4),
    render,
    concurrency: 3,
    budgetMs: 60_000,
    read: groupReader(rows, { opening, closing, calls }),
    onProgress: done => progress.push(done),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(calls.length, 10);
  assert.equal(result.read.summary.transactions.length, 200);
  // Every row proves the next, but a read from images is never called verified: see the tests below.
  assert.equal(result.read.check.verified, false);
  assert.equal(chainIntact(result.read.check), true);
  assert.equal(result.read.check.failed, 0);
  assert.match(result.read.summary.message, /Compare the transaction count and totals/);
  assert.equal(result.read.summary.bankName, "Sample Bank");
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // Joined in page order: the first and last rows are the statement's first and last.
  assert.equal(result.read.summary.transactions[0].narration, rows[0].narration);
  assert.equal(result.read.summary.transactions[199].narration, rows[199].narration);
});

test("rows missing from the end of a scan are not reported as verified", async () => {
  const { rows, opening } = statementRows(40);
  // The last page group comes back with only its first half, and the model reports the last row it
  // read as the closing balance. Nothing breaks the running balance, so only the rule below catches it.
  const kept = rows.slice(0, 190);
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 40,
    groups: pageGroups(40, 4),
    render,
    concurrency: 4,
    budgetMs: 60_000,
    read: groupReader(kept, { opening, closing: kept[kept.length - 1].balance }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.read.summary.transactions.length, 190);
  assert.equal(result.read.check.failed, 0);
  assert.equal(result.read.check.closingMatches, true);
  assert.equal(result.read.check.verified, false, "a closing balance the model reports is its own claim");
  assert.equal(result.read.summary.status, "needs_review");
});

test("a misread date is flagged even though the running balance still follows", async () => {
  const { rows, opening, closing } = statementRows(8);
  const wrong = rows.map((row, index) => (index === 17 ? { ...row, date: "2024-04-02" } : row));
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 8,
    groups: pageGroups(8, 4),
    render,
    concurrency: 2,
    budgetMs: 60_000,
    read: groupReader(wrong, { opening, closing }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.read.check.failed, 0);
  const flagged = result.read.summary.transactions.filter(txn => txn.confidence < 0.9);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].date, "2024-04-02");
  assert.ok(result.read.summary.warnings.some(warning => /out of date order/.test(warning)));
});

test("rows with no readable date are counted in a warning, never dropped quietly", async () => {
  const { rows, opening, closing } = statementRows(4);
  const broken = rows.map((row, index) => (index === 3 ? { ...row, date: "not a date" } : row));
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 4,
    groups: pageGroups(4, 4),
    render,
    concurrency: 1,
    budgetMs: 60_000,
    read: groupReader(broken, { opening, closing }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.read.summary.transactions.length, 19);
  assert.ok(result.read.summary.warnings.some(warning => /no readable date/.test(warning)));
  assert.equal(result.read.check.verified, false);
});

test("a group whose balances do not join its neighbours is read again by the strongest model", async () => {
  const { rows, opening, closing } = statementRows(40);
  const calls: number[][] = [];
  const strongCalls: number[][] = [];
  // Pages 17-20 come back with balances 1,000 too high: every row follows the one before it, so only
  // the joins with the groups either side reveal the problem. The second look reads them correctly.
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 40,
    groups: pageGroups(40, 4),
    render,
    concurrency: 3,
    budgetMs: 60_000,
    read: groupReader(rows, { opening, closing, calls, strongCalls, shift: (pages, strong) => (pages.includes(18) && !strong ? 1000 : 0) }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(strongCalls, [[17, 18, 19, 20]]);
  assert.equal(result.repaired, 1);
  assert.equal(calls.length, 11);
  assert.equal(result.read.check.failed, 0);
  assert.equal(result.read.summary.transactions.length, 200);
  assert.ok(result.read.summary.transactions.every(txn => txn.confidence >= 0.9));
});

test("a whole group with the month misread is read again, though its balances all follow", async () => {
  const { rows, opening, closing } = statementRows(40);
  const strongCalls: number[][] = [];
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 40,
    groups: pageGroups(40, 4),
    render,
    concurrency: 3,
    budgetMs: 60_000,
    read: groupReader(rows, { opening, closing, strongCalls, wrongMonth: (pages, strong) => pages.includes(26) && !strong }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(strongCalls, [[25, 26, 27, 28]]);
  assert.equal(result.repaired, 1);
  assert.equal(result.read.check.failed, 0);
  assert.ok(result.read.summary.transactions.every(txn => txn.date.startsWith("2025-04-")));
  assert.ok(result.read.summary.transactions.every(txn => txn.confidence >= 0.9));
});

test("a month misread that cannot be repaired leaves those rows flagged", async () => {
  const { rows, opening, closing } = statementRows(40);
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 40,
    groups: pageGroups(40, 4),
    render,
    concurrency: 3,
    budgetMs: 60_000,
    read: groupReader(rows, { opening, closing, wrongMonth: pages => pages.includes(26) }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.repaired, 0);
  assert.equal(result.read.check.failed, 0);
  const flagged = result.read.summary.transactions.filter(txn => txn.confidence < 0.9);
  assert.equal(flagged.length, 20);
  assert.ok(flagged.every(txn => txn.date.startsWith("2025-01-")));
  assert.ok(result.read.summary.warnings.some(warning => /out of date order/.test(warning)));
});

test("dates out of order are the ones outside the longest run that moves forward", () => {
  assert.deepEqual(outOfOrderIndices([]), []);
  assert.deepEqual(outOfOrderIndices(["2025-04-01", "2025-04-01", "2025-04-02"]), []);
  assert.deepEqual(outOfOrderIndices(["2025-04-01", "2025-04-02", "2024-04-02", "2025-04-03", "2025-04-04"]), [2]);
  // A block that jumps back is the minority, so the block is what disagrees.
  assert.deepEqual(outOfOrderIndices(["2025-10-01", "2025-10-02", "2025-10-03", "2025-01-03", "2025-01-04"]), [3, 4]);
  // A short run at the start that the long rest contradicts is the odd one out.
  assert.deepEqual(outOfOrderIndices(["2025-12-01", "2025-04-01", "2025-04-02", "2025-04-03"]), [0]);
});

test("a statement whose groups all join is not read a second time", async () => {
  const { rows, opening, closing } = statementRows(40);
  const strongCalls: number[][] = [];
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 40,
    groups: pageGroups(40, 4),
    render,
    concurrency: 4,
    budgetMs: 60_000,
    read: groupReader(rows, { opening, closing, strongCalls }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(strongCalls, []);
  if (result.ok) assert.equal(result.repaired, 0);
});

test("a group the second look cannot fix stays flagged instead of being hidden", async () => {
  const { rows, opening, closing } = statementRows(40);
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 40,
    groups: pageGroups(40, 4),
    render,
    concurrency: 3,
    budgetMs: 60_000,
    read: groupReader(rows, { opening, closing, shift: pages => (pages.includes(18) ? 1000 : 0) }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.repaired, 0);
  assert.ok(result.read.check.failed >= 1);
  assert.ok(result.read.summary.transactions.some(txn => txn.confidence < 0.9));
  assert.equal(result.read.check.verified, false);
});

test("a page group that cannot be read fails the whole statement and names its pages", async () => {
  const { rows, opening, closing } = statementRows(40);
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 40,
    groups: pageGroups(40, 4),
    render,
    concurrency: 3,
    budgetMs: 60_000,
    read: groupReader(rows, { opening, closing, fail: pages => pages.includes(18) }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.failedPages, [17, 18, 19, 20]);
});

test("a group the model returned empty shows up as rows that do not follow the balance, not as a clean statement", async () => {
  const { rows, opening, closing } = statementRows(40);
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 40,
    groups: pageGroups(40, 4),
    render,
    concurrency: 4,
    budgetMs: 60_000,
    read: groupReader(rows, { opening, closing, drop: page => page >= 21 && page <= 24 }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.read.summary.transactions.length, 180);
  assert.equal(result.read.check.verified, false);
  assert.ok(result.read.check.failed >= 1, "the row after the gap must be flagged");
  assert.equal(result.read.check.closingMatches, true);
  assert.ok(result.read.summary.transactions.some(txn => txn.confidence < 0.9));
});

test("balances a middle page carries forward are not mistaken for the opening or closing balance", async () => {
  const { rows } = statementRows(8);
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 8,
    groups: pageGroups(8, 4),
    render,
    concurrency: 2,
    budgetMs: 60_000,
    // Page 1 prints no opening balance; the later group reports a carried-forward 99999 as its opening.
    read: groupReader(rows, { opening: null, closing: rows[rows.length - 1].balance }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.read.check.openingBalance, null);
  assert.equal(result.read.check.closingMatches, true);
  assert.equal(result.read.check.failed, 0);
});

test("when nothing can be read the remaining page groups are not attempted", async () => {
  const calls: number[][] = [];
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 80,
    groups: pageGroups(80, 4),
    render,
    concurrency: 4,
    budgetMs: 60_000,
    read: groupReader([], { fail: () => true, calls }),
  });
  assert.equal(result.ok, false);
  assert.ok(calls.length < 20, `expected the read to stop early, made ${calls.length} calls`);
  if (!result.ok) assert.equal(result.failedPages.length, 80);
});

test("an exhausted time budget returns nothing partial", async () => {
  const { rows, opening, closing } = statementRows(8);
  const result = await readBankStatementByPages({
    fileName: "scan.pdf",
    totalPages: 8,
    groups: pageGroups(8, 4),
    render,
    concurrency: 1,
    budgetMs: -1,
    read: groupReader(rows, { opening, closing }),
  });
  assert.equal(result.ok, false);
});

test("merging keeps the first bank details, the first opening balance and the last closing balance", () => {
  const part = (over: Partial<AIBankStatement>): AIBankStatement => ({ bankName: null, ifsc: null, accountNumberLast4: null, periodFrom: null, periodTo: null, openingBalance: null, closingBalance: null, transactions: [], ...over });
  const merged = mergeStatements([
    part({ bankName: "Sample Bank", ifsc: "SBIN0001234", periodFrom: "2025-04-01", openingBalance: 100, closingBalance: 7 }),
    part({ openingBalance: 555, closingBalance: 8 }),
    part({ periodTo: "2026-03-31", closingBalance: 900 }),
  ]);
  assert.equal(merged.bankName, "Sample Bank");
  assert.equal(merged.ifsc, "SBIN0001234");
  assert.equal(merged.periodFrom, "2025-04-01");
  assert.equal(merged.periodTo, "2026-03-31");
  assert.equal(merged.openingBalance, 100);
  assert.equal(merged.closingBalance, 900);
});

// ── Answer shapes ───────────────────────────────────────────────────────────

test("a page-group answer of 7-item rows becomes a statement", () => {
  const parsed = compactStatementSchema.safeParse({
    bankName: "Sample Bank",
    openingBalance: "5,000.00",
    closingBalance: 5300,
    rows: [
      ["2025-04-03", "2025-04-03", "UPI/100/RAVI", null, null, 300, 5300],
      ["2025-04-09", null, "ATM WDL", "S7313", "2,000.00", null, "3300.00"],
    ],
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.openingBalance, 5000);
  assert.deepEqual(parsed.data.transactions[0], { date: "2025-04-03", valueDate: "2025-04-03", narration: "UPI/100/RAVI", reference: null, debit: null, credit: 300, balance: 5300 });
  assert.equal(parsed.data.transactions[1].debit, 2000);
  assert.equal(parsed.data.transactions[1].reference, "S7313");
});

test("a row that is not exactly 7 items invalidates the answer instead of being guessed", () => {
  const short = compactStatementSchema.safeParse({ rows: [["2025-04-03", null, "UPI", null, 300, 5300]] });
  const long = compactStatementSchema.safeParse({ rows: [["2025-04-03", null, "UPI", null, null, 300, 5300, "extra"]] });
  assert.equal(short.success, false);
  assert.equal(long.success, false);
});

test("a list holding one object per page is joined into one statement", () => {
  const compact = compactStatementSchema.safeParse([
    { bankName: "Sample Bank", openingBalance: 100, closingBalance: 7, rows: [["2025-04-01", null, "A", null, null, 10, 110]] },
    { bankName: null, openingBalance: 999, closingBalance: 500, rows: [["2025-04-02", null, "B", null, 10, null, 100]] },
  ]);
  assert.equal(compact.success, true);
  if (compact.success) {
    assert.equal(compact.data.transactions.length, 2);
    assert.equal(compact.data.bankName, "Sample Bank");
    assert.equal(compact.data.openingBalance, 100);
    assert.equal(compact.data.closingBalance, 500);
  }
  const verbose = bankStatementAnswerSchema.safeParse([
    { openingBalance: 100, transactions: [{ date: "2025-04-01", narration: "A", debit: null, credit: 10, balance: 110 }] },
    { closingBalance: 100, transactions: [{ date: "2025-04-02", narration: "B", debit: 10, credit: null, balance: 100 }] },
  ]);
  assert.equal(verbose.success, true);
  if (verbose.success) assert.equal((verbose.data as AIBankStatement).transactions.length, 2);
  // A single object still works as before.
  assert.equal(bankStatementAnswerSchema.safeParse({ transactions: [] }).success, true);
});

test("the group prompt names the pages and asks for one object of 7-item rows", () => {
  const prompt = compactPrompt("5–8", 152);
  assert.match(prompt, /pages 5–8 of a 152-page/);
  assert.match(prompt, /exactly 7 items/);
  assert.match(prompt, /not a list/);
});

test("one misread date does not turn a whole statement around", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ date: `2025-04-${String(index + 1).padStart(2, "0")}`, n: index }));
  rows[29] = { date: "2024-04-30", n: 29 };
  assert.deepEqual(chronological(rows).map(row => row.n), rows.map(row => row.n));
  const newestFirst = [...Array.from({ length: 30 }, (_, index) => ({ date: `2025-04-${String(index + 1).padStart(2, "0")}`, n: index }))].reverse();
  assert.deepEqual(chronological(newestFirst).map(row => row.n), Array.from({ length: 30 }, (_, index) => index));
  assert.deepEqual(chronological([{ date: "2025-04-02", n: 1 }, { date: "2025-04-01", n: 0 }]).map(row => row.n), [0, 1]);
  assert.deepEqual(chronological([{ date: "2025-04-01", n: 0 }]).map(row => row.n), [0]);
});

// ── A long text statement is read by the table reader and never by AI ───────

function longStatementPdf(pages: number, perPage: number): Promise<{ buffer: Buffer; rows: number }> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", chunk => chunks.push(chunk as Buffer));
    doc.on("end", () => resolve({ buffer: Buffer.concat(chunks), rows: pages * perPage }));
    doc.on("error", reject);
    doc.font("Helvetica").fontSize(8);
    const text = (value: string, x: number, y: number) => doc.text(value, x, y, { lineBreak: false });
    const money = (paise: number) => (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const right = (value: string, x: number, y: number) => doc.text(value, x - 76, y, { width: 76, align: "right", lineBreak: false });
    let paise = 470_822_68;
    let serial = 0;
    for (let page = 0; page < pages; page += 1) {
      if (page > 0) doc.addPage();
      let y = 40;
      if (page === 0) {
        text("Kotak Mahindra Bank", 40, y);
        text("Account No. 0211300197", 340, y + 20);
        text("IFSC Code KKBK0004264", 40, y + 35);
        text("01 Apr 2025 - 31 Mar 2026", 40, y + 50);
        y = 130;
      }
      text("#", 40, y); text("Date", 72, y); text("Description", 125, y); text("Chq/Ref. No.", 280, y);
      text("Withdrawal (Dr.)", 345, y); text("Deposit (Cr.)", 430, y); text("Balance", 505, y);
      y += 20;
      for (let row = 0; row < perPage; row += 1) {
        serial += 1;
        const amount = 1_000_00 + ((serial * 7919) % 90_000);
        const credit = serial % 3 === 0;
        paise += credit ? amount : -amount;
        text(String(serial), 40, y);
        text("05 Aug 2025", 72, y);
        text(`UPI/PARTY ${serial % 23}/${100000 + serial}`, 125, y);
        right(money(amount), credit ? 487 : 416, y);
        right(money(paise), 556, y);
        y += 11;
      }
    }
    doc.end();
  });
}

test("a 150-page text statement is read by the table reader in seconds and is not sent to AI", async () => {
  // No opening balance is printed, so the statement cannot be called verified. That is the case
  // that used to send the whole file to AI and wait many minutes for an answer that cannot fit.
  const { buffer, rows } = await longStatementPdf(150, 52);
  const started = Date.now();
  const read = await readStatementPdf(buffer, { fileName: "long.pdf" });
  assert.equal(read.status, "ok");
  assert.equal(read.pageCount, 150);
  assert.equal(read.summary?.transactions.length, rows);
  assert.ok(read.check);
  assert.equal(read.check.failed, 0);
  assert.equal(read.check.verified, false, "an unanchored first row means the statement is not fully verified");
  assert.equal(chainIntact(read.check), true);
  assert.equal(planAiRead({ hasTableRead: true, check: read.check, pageCount: read.pageCount }), "skip");
  assert.ok(Date.now() - started < 60_000, "reading 150 pages should take seconds");
});

// ── Background jobs ─────────────────────────────────────────────────────────

test("a read job reports progress, delivers once and belongs to its company and user", async () => {
  clearReadJobs();
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const job = startReadJob({ companyId: 7, userId: 3 }, async report => {
    report(40, "Reading page 8 of 20");
    report(10, "must not move backwards");
    await gate;
    return { status: 200, body: { ok: true, rows: 12 } };
  });
  assert.equal(await finishedWithin(job, 20), null);
  assert.equal(findReadJob(job.id, { companyId: 7, userId: 3 })?.state, "working");
  assert.equal(findReadJob(job.id, { companyId: 7, userId: 3 })?.percent, 40);
  assert.equal(findReadJob(job.id, { companyId: 8, userId: 3 }), null);
  assert.equal(findReadJob(job.id, { companyId: 7, userId: 4 }), null);
  release();
  const outcome = await finishedWithin(job, 1000);
  assert.deepEqual(outcome, { status: 200, body: { ok: true, rows: 12 } });
  assert.equal(findReadJob(job.id, { companyId: 7, userId: 3 })?.state, "done");
  releaseReadJob(job.id);
  assert.equal(findReadJob(job.id, { companyId: 7, userId: 3 }), null);
});

test("a read job that throws ends with a plain error instead of hanging", async () => {
  clearReadJobs();
  const job = startReadJob({ companyId: 1, userId: null }, async () => { throw new Error("boom"); });
  const outcome = await finishedWithin(job, 1000);
  assert.equal(outcome?.status, 500);
  assert.equal((outcome?.body as { ok: boolean }).ok, false);
});

// ── No half-read scans ──────────────────────────────────────────────────────

test("OCR refuses a scan longer than it reads instead of returning its first pages", async () => {
  const pages = OCR_MAX_PAGES + 1;
  const outcome = await recognizeStatement({ buffer: Buffer.from("%PDF-1.4"), fileName: "scan.pdf", kind: "pdf", pageCount: pages });
  assert.equal(outcome.available, false);
  if (!outcome.available) assert.match(outcome.note, new RegExp(`${pages} pages`));
});

test("OCR will not guess how many pages a PDF has", async () => {
  const outcome = await recognizeStatement({ buffer: Buffer.from("%PDF-1.4"), fileName: "scan.pdf", kind: "pdf" });
  assert.equal(outcome.available, false);
  if (!outcome.available) assert.match(outcome.note, /number of pages/);
});

// ── Only scanned pages need OCR ─────────────────────────────────────────────

test("a page with a real text layer is never sent to OCR, and page markers do not count as text", () => {
  const text = "01 Apr 2025 UPI/1234567890/GROCERY STORE 1,250.00 48,750.00";
  const pages = [
    { num: 1, text },
    { num: 2, text: "\n\n" },
    { num: 3, text },
    { num: 4, text: "Page 4 of 9" },
    { num: 5, text: "   " },
  ];
  assert.deepEqual(pagesNeedingOcr(pages), [2, 4, 5]);
  assert.deepEqual(pagesNeedingOcr([{ num: 1, text }, { num: 2, text }]), []);
  assert.deepEqual(pagesNeedingOcr([]), []);
});

// ── Same file again ─────────────────────────────────────────────────────────

function remembered(rows: number): StatementRead {
  const { rows: data } = statementRows(Math.max(1, Math.ceil(rows / ROWS_PER_PAGE)));
  return {
    ok: true,
    source: "ai",
    message: "ok",
    summary: { transactions: data.slice(0, rows).map((row, index) => ({ rowNumber: index + 1, date: row.date, narration: row.narration, debit: row.debit, credit: row.credit, balance: row.balance })) } as unknown as StatementRead["summary"],
  };
}

test("the same file from the same company is remembered, and nothing else is", () => {
  clearStatementCache();
  const file = Buffer.from("statement bytes");
  const key = statementCacheKey({ companyId: 1, buffer: file, allowAi: false });
  assert.equal(recallStatement(key), null);
  rememberStatement(key, remembered(10));
  assert.equal(recallStatement(key)?.summary?.transactions.length, 10);
  // Another company, another file, a password, or a different AI choice never reaches this entry.
  assert.equal(recallStatement(statementCacheKey({ companyId: 2, buffer: file, allowAi: false })), null);
  assert.equal(recallStatement(statementCacheKey({ companyId: 1, buffer: Buffer.from("other"), allowAi: false })), null);
  assert.equal(recallStatement(statementCacheKey({ companyId: 1, buffer: file, password: "secret", allowAi: false })), null);
  assert.equal(recallStatement(statementCacheKey({ companyId: 1, buffer: file, allowAi: true })), null);
});

test("a remembered statement is a copy, a failure is not remembered, and an old entry expires", () => {
  clearStatementCache();
  const key = statementCacheKey({ companyId: 1, buffer: Buffer.from("a"), allowAi: false });
  rememberStatement(key, remembered(5), 1_000);
  const first = recallStatement(key, 2_000);
  first?.summary?.transactions.splice(0, 3);
  assert.equal(recallStatement(key, 2_000)?.summary?.transactions.length, 5);
  assert.equal(recallStatement(key, 1_000 + 31 * 60_000), null);

  const failedKey = statementCacheKey({ companyId: 1, buffer: Buffer.from("b"), allowAi: false });
  rememberStatement(failedKey, { ok: false, summary: null, source: "none", message: "could not read" });
  assert.equal(recallStatement(failedKey), null);
});

test("the oldest statements are dropped when too many are remembered", () => {
  clearStatementCache();
  const keys = Array.from({ length: 20 }, (_, index) => statementCacheKey({ companyId: 1, buffer: Buffer.from(`file-${index}`), allowAi: false }));
  keys.forEach(key => rememberStatement(key, remembered(2)));
  assert.equal(recallStatement(keys[0]), null);
  assert.notEqual(recallStatement(keys[19]), null);
});
