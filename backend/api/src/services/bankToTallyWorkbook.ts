import ExcelJS from "exceljs";
import { z } from "zod";
import { resolveLedger } from "./tallyVoucherXml";

const rowSchema = z.object({
  rowNumber: z.number().int().nonnegative(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  narration: z.string().max(1000),
  reference: z.string().max(200).nullable(),
  debit: z.number().finite().nonnegative().nullable(),
  credit: z.number().finite().nonnegative().nullable(),
  balance: z.number().finite().nullable(),
  counterparty: z.string().max(200).nullable(),
  ledgerChoice: z.string().max(200),
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
  rows: z.array(rowSchema).min(1).max(20000),
});

export type BankWorkbookInput = z.infer<typeof bankWorkbookSchema>;

const MONEY = '#,##0.00;[Red](#,##0.00)';

function addTransactionsSheet(workbook: ExcelJS.Workbook, name: string, rows: BankWorkbookInput["rows"]) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "Date", key: "date", width: 16 },
    { header: "Narration", key: "narration", width: 55 },
    { header: "Reference", key: "reference", width: 25 },
    { header: "Paid", key: "debit", width: 17 },
    { header: "Received", key: "credit", width: 17 },
    { header: "Statement balance", key: "balance", width: 22 },
    { header: "Tally ledger", key: "ledger", width: 30 },
    { header: "Review", key: "review", width: 20 },
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF263341" } };
  sheet.getRow(1).height = 24;
  for (const row of rows) {
    const entry = sheet.addRow({
      date: new Date(`${row.date}T00:00:00.000Z`),
      narration: row.narration,
      reference: row.reference ?? "",
      debit: row.debit,
      credit: row.credit,
      balance: row.balance,
      ledger: resolveLedger(
        { narration: row.narration, description: row.narration, counterparty: row.counterparty, credit: row.credit },
        [{ counterparty: row.counterparty || row.narration.slice(0, 40).trim(), ledgerName: row.ledgerChoice }],
      ).name,
      review: row.edited ? "Changed in review" : row.needsReview ? (row.reviewed ? "Checked" : "Needs review") : "Ready",
    });
    entry.getCell(1).numFmt = "dd mmm yyyy";
    for (const col of [4, 5, 6]) entry.getCell(col).numFmt = MONEY;
    if (row.needsReview && !row.reviewed) entry.getCell(8).font = { color: { argb: "FF9A5B00" }, bold: true };
  }
  if (rows.length > 0) sheet.autoFilter = { from: "A1", to: `H${rows.length + 1}` };
  return sheet;
}

/** Excel working copy of exactly the rows and ledger choices used for Tally XML. */
export function buildBankToTallyWorkbook(input: BankWorkbookInput) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TallyThis";
  const included = input.rows.filter(row => !row.excluded);
  const excluded = input.rows.filter(row => row.excluded);
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [{ width: 29 }, { width: 62 }];
  summary.addRow(["Bank → Tally working copy"]);
  summary.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF263341" } };
  summary.addRow([]);
  for (const pair of [
    ["Client", input.clientName],
    ["Bank", input.bankName],
    ["Account ending", input.accountNumberMasked ?? "Not found"],
    ["Statement period", input.periodLabel ?? "Not found"],
    ["Transactions included", included.length],
    ["Transactions left out", excluded.length],
    ["Money paid", included.reduce((sum, row) => sum + (row.debit ?? 0), 0)],
    ["Money received", included.reduce((sum, row) => sum + (row.credit ?? 0), 0)],
    ["Rows still needing review", included.filter(row => row.needsReview && !row.reviewed).length],
  ] as const) summary.addRow(pair);
  for (const row of [9, 10]) summary.getCell(`B${row}`).numFmt = MONEY;
  summary.addRow([]);
  summary.addRow(["Note", "This is a working copy. Check unreviewed rows against the bank statement before importing the Tally XML."]);
  if (input.rows.some(row => row.edited || row.excluded)) {
    summary.addRow(["Edited statement", "The original running balance check does not verify changed or excluded transactions."]);
  }
  addTransactionsSheet(workbook, "Transactions", included);
  if (excluded.length > 0) addTransactionsSheet(workbook, "Left out", excluded);
  return workbook;
}
