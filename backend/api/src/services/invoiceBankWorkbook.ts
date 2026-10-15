import ExcelJS from "exceljs";
import { z } from "zod";

const amount = z.number().finite().nullable().optional();

const item = z.object({
  key: z.string().max(60),
  bucket: z.enum(["matched", "suggested", "amount_mismatch", "payment_without_invoice", "invoice_without_payment", "no_invoice_expected"]),
  decision: z.enum(["suggested", "approved", "rejected", "needs_info"]).default("suggested"),
  why: z.array(z.string().max(400)).max(10).default([]),
  bank: z
    .object({ date: z.string().max(20), narration: z.string().max(500).default(""), debit: amount, credit: amount })
    .optional(),
  invoice: z
    .object({
      invoiceNumber: z.string().max(120).default(""),
      vendorName: z.string().max(200).default(""),
      total: amount,
      invoiceDate: z.string().max(20).nullable().optional(),
      label: z.string().max(80).optional(),
    })
    .optional(),
});

export const invoiceBankWorkbookSchema = z.object({
  clientName: z.string().max(200).default("Client"),
  items: z.array(item).max(60000),
});

export type InvoiceBankWorkbookInput = z.infer<typeof invoiceBankWorkbookSchema>;

const MONEY = "#,##0.00;[Red](#,##0.00)";

const RESULT: Record<string, string> = {
  matched: "Matched",
  suggested: "Probable match — confirm",
  amount_mismatch: "Amount differs",
  payment_without_invoice: "Bank entry without an invoice",
  invoice_without_payment: "Invoice not paid yet",
  no_invoice_expected: "No invoice expected",
};

const DECISION: Record<string, string> = {
  suggested: "Not reviewed",
  approved: "Confirmed",
  rejected: "Not a match",
  needs_info: "Ask client",
};

const dateCell = (value: string | null | undefined) =>
  value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : (value ?? "");

/** A message a CA can send to the client for payments that have no invoice behind them. */
export function invoiceRequestText(input: InvoiceBankWorkbookInput) {
  const rows = input.items.filter(entry => entry.bucket === "payment_without_invoice" && entry.bank && entry.decision !== "rejected");
  const lines = rows.slice(0, 40).map(entry => {
    const money = entry.bank!.debit ?? entry.bank!.credit ?? 0;
    return `• ${entry.bank!.date} — ₹${money.toLocaleString("en-IN", { minimumFractionDigits: 2 })} — ${entry.bank!.narration.slice(0, 80)}`;
  });
  if (lines.length === 0) return "";
  return [
    "Hello,",
    "",
    "Please share the invoice or bill for these payments from the bank statement:",
    ...lines,
    rows.length > 40 ? `…and ${rows.length - 40} more.` : "",
    "",
    "Thank you.",
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");
}

export function buildInvoiceBankWorkbook(input: InvoiceBankWorkbookInput) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TallyThis";

  const counts = new Map<string, number>();
  for (const entry of input.items) counts.set(entry.bucket, (counts.get(entry.bucket) ?? 0) + 1);

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [{ width: 44 }, { width: 18 }];
  summary.addRow(["Invoices ↔ bank"]);
  summary.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF143E2C" } };
  summary.addRow([]);
  summary.addRow(["Client", input.clientName]);
  summary.addRow([]);
  summary.addRow(["Result", "Entries"]);
  summary.getRow(summary.rowCount).font = { bold: true };
  for (const key of Object.keys(RESULT)) summary.addRow([RESULT[key], counts.get(key) ?? 0]);
  summary.addRow([]);
  summary.addRow(["Suggested matches need review. Potential risk — needs CA review."]);

  const columns = [
    { header: "Result", width: 30 },
    { header: "Your decision", width: 16 },
    { header: "Bank date", width: 14 },
    { header: "Bank narration", width: 54 },
    { header: "Bank amount ₹", width: 16 },
    { header: "Invoice no.", width: 20 },
    { header: "Vendor", width: 30 },
    { header: "Invoice date", width: 14 },
    { header: "Invoice total ₹", width: 16 },
    { header: "Why", width: 60 },
  ];
  const add = (name: string, rows: typeof input.items) => {
    const sheet = workbook.addWorksheet(name);
    sheet.columns = columns;
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const head = sheet.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF143E2C" } };
    head.height = 24;
    for (const entry of rows) {
      const row = sheet.addRow([
        RESULT[entry.bucket] ?? entry.bucket,
        entry.bucket === "matched" ? "Matched" : DECISION[entry.decision],
        dateCell(entry.bank?.date),
        entry.bank?.narration ?? "",
        entry.bank ? (entry.bank.debit ?? entry.bank.credit ?? null) : null,
        entry.invoice?.invoiceNumber ?? "",
        entry.invoice?.vendorName ?? "",
        dateCell(entry.invoice?.invoiceDate),
        entry.invoice?.total ?? null,
        entry.why.join(". "),
      ]);
      row.getCell(3).numFmt = "dd mmm yyyy";
      row.getCell(8).numFmt = "dd mmm yyyy";
      row.getCell(5).numFmt = MONEY;
      row.getCell(9).numFmt = MONEY;
    }
    sheet.autoFilter = { from: "A1", to: `J${Math.max(rows.length + 1, 2)}` };
  };
  add("Needs attention", input.items.filter(entry => entry.bucket !== "matched" && entry.bucket !== "no_invoice_expected"));
  add("Matched", input.items.filter(entry => entry.bucket === "matched"));
  add("No invoice expected", input.items.filter(entry => entry.bucket === "no_invoice_expected"));
  return workbook;
}
