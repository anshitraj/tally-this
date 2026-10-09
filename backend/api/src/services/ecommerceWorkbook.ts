import ExcelJS from "exceljs";
import { z } from "zod";

const saleSchema = z.object({
  platform: z.string().max(80),
  orderId: z.string().max(120).nullable(),
  invoiceNumber: z.string().max(120).nullable(),
  invoiceDate: z.string().nullable(),
  gstin: z.string().max(30).nullable(),
  placeOfSupply: z.string().max(100).nullable(),
  taxableValue: z.number().finite(),
  cgst: z.number().finite(),
  sgst: z.number().finite(),
  igst: z.number().finite(),
  grossAmount: z.number().finite(),
  tcsAmount: z.number().finite(),
  hsn: z.string().max(30).nullable(),
  gstRate: z.number().finite().nullable(),
  issues: z.array(z.string().max(300)).max(20),
});

export const ecommerceWorkbookSchema = z.object({
  clientName: z.string().max(200),
  sales: z.array(saleSchema).min(1).max(20000),
  documents: z.array(z.object({ platform: z.string().max(80), issued: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative(), source: z.string().max(40) })).max(100).optional(),
  tcsComparison: z.object({ rows: z.array(z.object({ state: z.string().max(100), code: z.string().max(10), uploaded: z.number().finite(), portal: z.number().finite(), difference: z.number().finite() })).max(50) }).optional(),
});

export type EcommerceWorkbookInput = z.infer<typeof ecommerceWorkbookSchema>;

const MONEY = '#,##0.00;[Red](#,##0.00)';
const sum = (sales: EcommerceWorkbookInput["sales"], key: "taxableValue" | "cgst" | "sgst" | "igst" | "grossAmount" | "tcsAmount") =>
  Math.round(sales.reduce((total, sale) => total + sale[key], 0) * 100) / 100;

function styleHeader(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF263341" } };
  sheet.getRow(1).height = 24;
}

/** Working summary of uploaded marketplace data; it does not assert GST portal agreement. */
export function buildEcommerceWorkbook(input: EcommerceWorkbookInput) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TallyThis";
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [{ width: 30 }, { width: 52 }];
  summary.addRow(["E-commerce sales working copy"]);
  summary.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF263341" } };
  summary.addRow([]);
  for (const pair of [
    ["Client", input.clientName],
    ["Uploaded sales rows", input.sales.length],
    ["Rows needing review", input.sales.filter(sale => sale.issues.length > 0).length],
    ["Taxable value", sum(input.sales, "taxableValue")],
    ["CGST", sum(input.sales, "cgst")],
    ["SGST", sum(input.sales, "sgst")],
    ["IGST", sum(input.sales, "igst")],
    ["Gross amount", sum(input.sales, "grossAmount")],
    ["TCS from uploaded reports", sum(input.sales, "tcsAmount")],
  ] as const) summary.addRow(pair);
  for (let row = 6; row <= 11; row += 1) summary.getCell(`B${row}`).numFmt = MONEY;
  summary.addRow([]);
  summary.addRow(["Note", input.tcsComparison
    ? "Draft from uploaded reports. TCS comparison uses a user-uploaded portal summary; verify taxpayer, period and source. Potential risk — needs CA review."
    : "Draft from uploaded marketplace reports. TCS has not been compared with the GST portal. Potential risk — needs CA review."]);

  const sales = workbook.addWorksheet("Sales");
  sales.columns = [
    { header: "Platform", key: "platform", width: 19 },
    { header: "Order ID", key: "orderId", width: 24 },
    { header: "Invoice", key: "invoice", width: 24 },
    { header: "Invoice date", key: "date", width: 17 },
    { header: "GSTIN", key: "gstin", width: 22 },
    { header: "Place of supply", key: "place", width: 20 },
    { header: "HSN", key: "hsn", width: 15 },
    { header: "GST rate %", key: "rate", width: 14 },
    { header: "Taxable", key: "taxable", width: 17 },
    { header: "CGST", key: "cgst", width: 15 },
    { header: "SGST", key: "sgst", width: 15 },
    { header: "IGST", key: "igst", width: 15 },
    { header: "Gross", key: "gross", width: 17 },
    { header: "TCS", key: "tcs", width: 15 },
    { header: "Review", key: "review", width: 42 },
  ];
  styleHeader(sales);
  for (const sale of input.sales) {
    const date = sale.invoiceDate && /^\d{4}-\d{2}-\d{2}$/.test(sale.invoiceDate) ? new Date(`${sale.invoiceDate}T00:00:00.000Z`) : sale.invoiceDate ?? "";
    const row = sales.addRow({
      platform: sale.platform, orderId: sale.orderId ?? "", invoice: sale.invoiceNumber ?? "", date,
      gstin: sale.gstin ?? "", place: sale.placeOfSupply ?? "", hsn: sale.hsn ?? "", rate: sale.gstRate,
      taxable: sale.taxableValue, cgst: sale.cgst, sgst: sale.sgst, igst: sale.igst,
      gross: sale.grossAmount, tcs: sale.tcsAmount, review: sale.issues.join("; ") || "Ready",
    });
    if (date instanceof Date) row.getCell(4).numFmt = "dd mmm yyyy";
    for (let col = 9; col <= 14; col += 1) row.getCell(col).numFmt = MONEY;
    if (sale.issues.length > 0) row.getCell(15).font = { color: { argb: "FF9A5B00" }, bold: true };
  }
  sales.autoFilter = { from: "A1", to: `O${input.sales.length + 1}` };

  const byState = new Map<string, EcommerceWorkbookInput["sales"]>();
  const byHsn = new Map<string, EcommerceWorkbookInput["sales"]>();
  for (const sale of input.sales) {
    const state = sale.placeOfSupply || "Not provided";
    byState.set(state, [...(byState.get(state) ?? []), sale]);
    const hsn = sale.hsn || "Not provided";
    byHsn.set(hsn, [...(byHsn.get(hsn) ?? []), sale]);
  }
  const tcs = workbook.addWorksheet("TCS by state");
  tcs.columns = [{ header: "Place of supply", width: 25 }, { header: "Rows", width: 12 }, { header: "Taxable", width: 20 }, { header: "TCS in uploads", width: 20 }];
  styleHeader(tcs);
  for (const [state, rows] of [...byState].sort(([a], [b]) => a.localeCompare(b))) {
    const row = tcs.addRow([state, rows.length, sum(rows, "taxableValue"), sum(rows, "tcsAmount")]);
    row.getCell(3).numFmt = MONEY;
    row.getCell(4).numFmt = MONEY;
  }
  if (input.tcsComparison) {
    const compared = workbook.addWorksheet("Portal TCS comparison");
    compared.columns = [{ header: "State", width: 25 }, { header: "Marketplace TCS", width: 20 }, { header: "Uploaded portal TCS", width: 20 }, { header: "Difference", width: 20 }];
    styleHeader(compared);
    for (const result of input.tcsComparison.rows) {
      const row = compared.addRow([result.state, result.uploaded, result.portal, result.difference]);
      for (let col = 2; col <= 4; col += 1) row.getCell(col).numFmt = MONEY;
    }
  }
  const hsn = workbook.addWorksheet("HSN summary");
  hsn.columns = [{ header: "HSN", width: 20 }, { header: "Rows", width: 12 }, { header: "Taxable", width: 20 }, { header: "Gross", width: 20 }];
  styleHeader(hsn);
  for (const [code, rows] of [...byHsn].sort(([a], [b]) => a.localeCompare(b))) {
    const row = hsn.addRow([code, rows.length, sum(rows, "taxableValue"), sum(rows, "grossAmount")]);
    row.getCell(3).numFmt = MONEY;
    row.getCell(4).numFmt = MONEY;
  }
  if (input.documents?.length) {
    const documents = workbook.addWorksheet("Documents");
    documents.columns = [{ header: "Marketplace", width: 25 }, { header: "Issued", width: 14 }, { header: "Cancelled", width: 14 }, { header: "Basis", width: 25 }];
    styleHeader(documents);
    for (const row of input.documents) documents.addRow([row.platform, row.issued, row.cancelled, row.source]);
  }
  return workbook;
}
