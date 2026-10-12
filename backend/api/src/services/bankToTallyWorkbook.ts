import ExcelJS from "exceljs";
import { z } from "zod";
import { defaultVoucherType, partyKey, resolveLedger } from "./tallyVoucherXml";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const rowSchema = z.object({
  rowNumber: z.number().int().nonnegative(),
  date: isoDate,
  valueDate: isoDate.nullable(),
  narration: z.string().max(1000),
  reference: z.string().max(200).nullable(),
  debit: z.number().finite().nonnegative().nullable(),
  credit: z.number().finite().nonnegative().nullable(),
  balance: z.number().finite().nullable(),
  counterparty: z.string().max(200).nullable(),
  ledgerChoice: z.string().max(200),
  /** False while the party's ledger is still a suggestion the reviewer has not chosen or confirmed. */
  ledgerConfirmed: z.boolean(),
  voucherType: z.enum(["Receipt", "Payment", "Contra"]).nullish(),
  /** A question the CA wants the client to answer about this row. */
  query: z.string().max(500).nullish(),
  needsReview: z.boolean(),
  reviewed: z.boolean(),
  edited: z.boolean(),
  excluded: z.boolean(),
});

export const bankWorkbookSchema = z.object({
  clientName: z.string().max(200),
  bankName: z.string().max(200),
  accountNumberMasked: z.string().max(40).nullable(),
  periodLabel: z.string().max(100).nullable(),
  openingBalance: z.number().finite().nullable(),
  closingBalance: z.number().finite().nullable(),
  /** Where the running-balance proof stands, exactly as the review screen shows it. */
  balanceCheck: z.enum(["passed", "checked_by_reviewer", "needs_check", "failed"]),
  rows: z.array(rowSchema).min(1).max(20000),
});

export type BankWorkbookInput = z.infer<typeof bankWorkbookSchema>;
type WorkbookRow = BankWorkbookInput["rows"][number];

const MONEY = '#,##0.00;[Red](#,##0.00)';
const DATE = "dd/mm/yyyy";
const INK = "FF263341";
const ATTENTION = { color: { argb: "FF9A5B00" }, bold: true } as const;
const NEEDS_ACTION = new Set(["Check with statement", "Choose ledger", "Confirm ledger"]);

const BALANCE_CHECK: Record<BankWorkbookInput["balanceCheck"], string> = {
  passed: "Passed: every row agrees with the bank's running balance",
  checked_by_reviewer: "Totals checked by the reviewer against the bank statement",
  needs_check: "Not proved: compare the totals with the bank statement",
  failed: "Failed: the closing balance or row sequence does not agree. Do not import.",
};

/** The ledger the Tally XML posts this row to, from the same resolver the XML uses. */
function ledgerFor(row: WorkbookRow) {
  return resolveLedger(
    { narration: row.narration, description: row.narration, counterparty: row.counterparty, credit: row.credit },
    [{ counterparty: partyKey(row), ledgerName: row.ledgerChoice }],
  );
}

function reviewLabel(row: WorkbookRow, ledgerName: string) {
  if (row.excluded) return "Left out of Tally file";
  if (row.needsReview && !row.reviewed) return "Check with statement";
  if (!row.ledgerConfirmed) return ledgerName === "Suspense" ? "Choose ledger" : "Confirm ledger";
  if (row.edited) return "Changed in review";
  if (ledgerName === "Suspense") return "Goes to Suspense";
  return row.needsReview ? "Checked" : "Ready";
}

/** Sums in paise so the totals carry no floating-point residue. */
function total(rows: WorkbookRow[], side: "debit" | "credit") {
  return rows.reduce((sum, row) => sum + Math.round((row[side] ?? 0) * 100), 0) / 100;
}

const excelDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/**
 * The statement as the bank printed it (dates, details, debit, credit, balance), every row in order,
 * with the Tally ledger and review status alongside.
 */
function addStatementSheet(workbook: ExcelJS.Workbook, input: BankWorkbookInput, status: string, ready: boolean) {
  const sheet = workbook.addWorksheet("Statement", { views: [{ state: "frozen", ySplit: 6 }] });
  sheet.columns = [
    { key: "date", width: 16 },
    { key: "valueDate", width: 14 },
    { key: "narration", width: 58 },
    { key: "reference", width: 20 },
    { key: "debit", width: 16 },
    { key: "credit", width: 16 },
    { key: "balance", width: 18 },
    { key: "voucher", width: 11 },
    { key: "ledger", width: 28 },
    { key: "group", width: 20 },
    { key: "review", width: 24 },
  ];
  const account = input.accountNumberMasked ? ` ••${input.accountNumberMasked}` : "";
  const period = input.periodLabel ? ` · ${input.periodLabel}` : "";
  sheet.getCell("A1").value = `${input.clientName} · ${input.bankName}${account}${period}`;
  sheet.getCell("A1").font = { bold: true, size: 14, color: { argb: INK } };
  for (const [rowNumber, label, value] of [
    [2, "Opening balance", input.openingBalance],
    [3, "Closing balance", input.closingBalance],
  ] as const) {
    sheet.getCell(`A${rowNumber}`).value = label;
    const cell = sheet.getCell(`C${rowNumber}`);
    cell.value = value ?? "Not found";
    cell.numFmt = MONEY;
    cell.font = { bold: true };
    cell.alignment = { horizontal: "left" };
  }
  sheet.getCell("A4").value = "Status";
  sheet.getCell("C4").value = status;
  sheet.getCell("C4").font = ready ? { bold: true, color: { argb: "FF166534" } } : ATTENTION;

  const header = sheet.getRow(6);
  header.values = ["Transaction Date", "Value Date", "Details of transaction", "Chq / Ref No", "Debit", "Credit", "Balance", "Voucher", "Tally ledger", "Under", "Review"];
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
  header.height = 24;
  for (const col of [5, 6, 7]) header.getCell(col).alignment = { horizontal: "right" };

  for (const row of input.rows) {
    const ledger = row.excluded ? null : ledgerFor(row);
    const review = reviewLabel(row, ledger?.name ?? "");
    const entry = sheet.addRow({
      date: excelDate(row.date),
      valueDate: row.valueDate ? excelDate(row.valueDate) : null,
      narration: row.narration,
      reference: row.reference ?? "",
      debit: row.debit,
      credit: row.credit,
      balance: row.balance,
      voucher: ledger ? row.voucherType ?? defaultVoucherType(row.credit, ledger.name) : "",
      ledger: ledger?.name ?? "",
      group: ledger?.group ?? "",
      review,
    });
    entry.getCell(1).numFmt = DATE;
    entry.getCell(2).numFmt = DATE;
    for (const col of [5, 6, 7]) entry.getCell(col).numFmt = MONEY;
    entry.getCell(5).font = { color: { argb: "FFB42318" } };
    entry.getCell(6).font = { color: { argb: "FF15803D" } };
    if (NEEDS_ACTION.has(review)) entry.getCell(11).font = ATTENTION;
    if (row.excluded) entry.font = { color: { argb: "FF8A94A6" }, strike: true };
  }
  const last = 6 + input.rows.length;
  sheet.autoFilter = { from: "A6", to: `K${last}` };
  const totals = sheet.addRow({ narration: "Total", debit: total(input.rows, "debit"), credit: total(input.rows, "credit") });
  totals.font = { bold: true };
  for (const col of [5, 6]) totals.getCell(col).numFmt = MONEY;
  for (const col of [3, 4, 5, 6, 7]) totals.getCell(col).border = { top: { style: "thin", color: { argb: INK } } };
  return sheet;
}

/** The rows the CA wants the client to explain, ready to send. */
function addQueriesSheet(workbook: ExcelJS.Workbook, rows: WorkbookRow[]) {
  const sheet = workbook.addWorksheet("Client queries", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "Date", key: "date", width: 14 },
    { header: "Details of transaction", key: "narration", width: 58 },
    { header: "Debit", key: "debit", width: 16 },
    { header: "Credit", key: "credit", width: 16 },
    { header: "Question", key: "query", width: 50 },
    { header: "Client's answer", key: "answer", width: 40 },
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
  for (const row of rows) {
    const entry = sheet.addRow({ date: excelDate(row.date), narration: row.narration, debit: row.debit, credit: row.credit, query: row.query?.trim(), answer: "" });
    entry.getCell(1).numFmt = DATE;
    for (const col of [3, 4]) entry.getCell(col).numFmt = MONEY;
    entry.getCell(5).alignment = { wrapText: true, vertical: "top" };
  }
  return sheet;
}

/** Excel copy of the statement with exactly the ledger choices used for Tally XML and the same open items as the review screen. */
export function buildBankToTallyWorkbook(input: BankWorkbookInput) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TallyThis";
  const included = input.rows.filter(row => !row.excluded);
  const parties = (test: (row: WorkbookRow) => boolean) => new Set(included.filter(test).map(row => partyKey(row))).size;
  const ledgersToChoose = parties(row => !row.ledgerConfirmed);
  const rowsToCheck = included.filter(row => row.needsReview && !row.reviewed).length;
  const totalsToCheck = input.balanceCheck === "needs_check" || input.balanceCheck === "failed" ? 1 : 0;
  const suspenseParties = parties(row => ledgerFor(row).name === "Suspense");
  const attention = ledgersToChoose + rowsToCheck + totalsToCheck;
  const status = attention > 0
    ? `Not ready for Tally: ${attention} ${attention === 1 ? "item needs" : "items need"} attention`
    : "Ready for Tally";

  addStatementSheet(workbook, input, status, attention === 0);

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [{ width: 34 }, { width: 70 }];
  summary.addRow(["Bank → Tally summary"]);
  summary.getCell("A1").font = { bold: true, size: 16, color: { argb: INK } };
  summary.addRow([]);
  summary.addRow(["Status", status]).getCell(2).font = attention > 0 ? ATTENTION : { bold: true, color: { argb: "FF166534" } };
  summary.addRow([]);
  const pairs: Array<[string, string | number, boolean?]> = [
    ["Client", input.clientName],
    ["Bank", input.bankName],
    ["Account ending", input.accountNumberMasked ?? "Not found"],
    ["Statement period", input.periodLabel ?? "Not found"],
    ["Transactions in Tally file", included.length],
    ["Transactions left out", input.rows.length - included.length],
    ["Money paid", total(included, "debit"), true],
    ["Money received", total(included, "credit"), true],
    ["Running-balance check", BALANCE_CHECK[input.balanceCheck]],
  ];
  for (const [label, value, money] of pairs) {
    const added = summary.addRow([label, value]);
    if (money) added.getCell(2).numFmt = MONEY;
  }
  summary.addRow([]);
  summary.addRow(["Needs attention"]).font = { bold: true };
  for (const [label, count] of [
    ["Party ledgers to choose or confirm", ledgersToChoose],
    ["Rows to check with the statement", rowsToCheck],
    ["Statement totals to check", totalsToCheck],
  ] as const) {
    const added = summary.addRow([label, count]);
    if (count > 0) added.getCell(2).font = ATTENTION;
  }
  summary.addRow(["Parties going to Suspense", suspenseParties]);
  const queries = input.rows.filter(row => row.query?.trim());
  summary.addRow(["Questions for the client", queries.length]);
  summary.addRow([]);
  summary.addRow(["Note", attention > 0
    ? "Rows marked Choose ledger, Confirm ledger or Check with statement are not final. Finish them in TallyThis before importing the Tally XML."
    : "The Tally ledger column matches the Tally XML."]);
  if (input.rows.some(row => row.edited || row.excluded)) {
    summary.addRow(["Edited statement", "The original running balance check does not verify changed or excluded transactions."]);
  }
  if (queries.length > 0) addQueriesSheet(workbook, queries);
  return workbook;
}
