/**
 * Working papers for a marketplace period: a ten-sheet Excel workbook (every transaction, traceable to its file and row)
 * and a short PDF (figures, HSN summary, exceptions). Built from data the store has already worked out; nothing here
 * calculates tax. Large transaction lists go to Excel only, never into the PDF.
 */
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { rateText } from "./gstEngine";
import { rupees, type Paise } from "./money";
import type { Gstr1Working, HsnRow, Overview, StateRow, Totals } from "./summaries";

export interface ExportEvent {
  id: number;
  eventType: string;
  orderId: string | null;
  subOrderId: string | null;
  orderDate: string | null;
  returnDate: string | null;
  documentNumber: string | null;
  reportPeriod: string;
  hsn: string | null;
  quantity: number;
  taxable: Paise;
  rateMilli: number | null;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  invoiceValue: Paise;
  sourceTax: Paise | null;
  computedTax: Paise | null;
  placeOfSupply: string | null;
  supplyType: string;
  ecoGstin: string | null;
  status: string;
  duplicateOf: number | null;
  relatedEventId: number | null;
  fileName: string;
  sheetName: string | null;
  sourceRow: number;
  raw: Record<string, string>;
  notes: string[];
}

export interface ExportException {
  id: number;
  eventId: number | null;
  kind: string;
  severity: string;
  status: string;
  message: string;
  note: string | null;
  sourceRef: string;
}

export interface ExportReview { at: string; actor: string | null; action: string; target: string; note: string | null }

export interface ExportFile {
  fileName: string;
  containerName: string | null;
  sheetName: string | null;
  sha256: string;
  reportType: string;
  status: string;
  rowCount: number;
  periods: string[];
  columnMap: Record<string, string>;
  unknownColumns: string[];
  importedAt: string;
}

export interface ReportData {
  companyName: string;
  marketplaceName: string;
  sellerGstin: string | null;
  period: string;
  financialYear: string;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  generatedAt: Date;
  rounding: "line" | "aggregate";
  overview: Overview;
  hsn: HsnRow[];
  states: StateRow[];
  gstr1: Gstr1Working;
  exceptions: ExportException[];
  events: ExportEvent[];
  reviews: ExportReview[];
  files: ExportFile[];
  openBlocking: number;
}

const MONEY = "#,##0.00";
const BRAND = "FF143E2C";

function money(p: Paise | null | undefined) {
  return p == null ? null : rupees(p);
}

function dateCell(iso: string | null) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function sheetWith(wb: ExcelJS.Workbook, name: string, columns: Array<{ header: string; key: string; width: number; money?: boolean; date?: boolean }>) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width, style: c.money ? { numFmt: MONEY } : c.date ? { numFmt: "dd-mm-yyyy" } : {} }));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 30;
  return ws;
}

function finish(ws: ExcelJS.Worksheet, columnCount: number) {
  if (ws.rowCount > 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: ws.rowCount, column: columnCount } };
}

function totalsRow(label: string, t: Totals) {
  return { label, count: t.count, quantity: t.quantity, taxable: money(t.taxable), igst: money(t.igst), cgst: money(t.cgst), sgst: money(t.sgst), cess: money(t.cess), tax: money(t.tax), invoice: money(t.invoiceValue) };
}

export async function buildWorkbook(data: ReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "TallyThis";
  wb.created = data.generatedAt;

  // 1. Summary
  const summary = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 0 }] });
  summary.columns = [{ width: 34 }, { width: 18 }, { width: 14 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 18 }, { width: 18 }];
  summary.addRow([`${data.marketplaceName} reconciliation — ${data.period}`]).font = { bold: true, size: 14, color: { argb: BRAND } };
  const facts: Array<[string, string]> = [
    ["Business", data.companyName],
    ["Seller GSTIN", data.sellerGstin ?? "Not given"],
    ["Marketplace", data.marketplaceName],
    ["Financial year", data.financialYear],
    ["Reporting period", data.period],
    ["Report status", data.status + (data.approvedBy ? ` (approved by ${data.approvedBy} on ${data.approvedAt})` : "")],
    ["Open items needing review", String(data.openBlocking)],
    ["Tax rounding", data.rounding === "line" ? "Each line's tax as reported, then added" : "Tax worked out once per group"],
    ["Generated", data.generatedAt.toISOString()],
  ];
  for (const [k, v] of facts) {
    const row = summary.addRow([k, v]);
    row.getCell(1).font = { bold: true };
  }
  summary.addRow([]);
  const head = summary.addRow(["", "Count", "Quantity", "Taxable value", "IGST", "CGST", "SGST/UTGST", "Cess", "Total tax", "Invoice value"]);
  head.font = { bold: true };
  for (const t of [totalsRow("Sales", data.overview.sales), totalsRow("Returns", data.overview.returns), totalsRow("Credit notes", data.overview.creditNotes), totalsRow("Net for the period", data.overview.net)]) {
    const row = summary.addRow([t.label, t.count, t.quantity, t.taxable, t.igst, t.cgst, t.sgst, t.cess, t.tax, t.invoice]);
    for (let c = 4; c <= 10; c += 1) row.getCell(c).numFmt = MONEY;
    if (t.label.startsWith("Net")) row.font = { bold: true };
  }
  summary.addRow([]);
  for (const note of [
    "Sales totals are invoice values for GST, not money received and not profit. Settlements are not part of this report.",
    "Returns and credit notes reduce the period in which they are reported. Duplicates are listed in Exceptions and never counted.",
    "Draft working papers for CA review, not a filing-ready return. Potential risk — needs CA review.",
  ]) summary.addRow([note]);

  // 2. Raw Transactions: every source column, as the file had it
  const rawKeys: string[] = [];
  const seen = new Set<string>();
  for (const e of data.events) for (const k of Object.keys(e.raw)) if (!seen.has(k)) { seen.add(k); rawKeys.push(k); }
  const raw = sheetWith(wb, "Raw Transactions", [
    { header: "Event ID", key: "id", width: 10 }, { header: "File", key: "file", width: 28 }, { header: "Sheet", key: "sheet", width: 14 }, { header: "Row", key: "row", width: 8 },
    ...rawKeys.map(k => ({ header: k, key: `raw:${k}`, width: Math.min(28, Math.max(12, k.length + 2)) })),
  ]);
  for (const e of data.events) {
    const values: Record<string, unknown> = { id: e.id, file: e.fileName, sheet: e.sheetName ?? "", row: e.sourceRow };
    for (const k of rawKeys) values[`raw:${k}`] = e.raw[k] ?? "";
    raw.addRow(values);
  }
  finish(raw, 4 + rawKeys.length);

  // 3 and 4. Normalized sales; returns and credit notes
  const eventColumns = [
    { header: "Event ID", key: "id", width: 10 }, { header: "Type", key: "type", width: 12 }, { header: "Order", key: "order", width: 22 }, { header: "Sub-order", key: "sub", width: 24 },
    { header: "Order date", key: "orderDate", width: 12, date: true }, { header: "Return date", key: "returnDate", width: 12, date: true }, { header: "Document no.", key: "doc", width: 16 },
    { header: "Period", key: "period", width: 9 }, { header: "HSN", key: "hsn", width: 10 }, { header: "Qty", key: "qty", width: 7 }, { header: "Rate %", key: "rate", width: 8 },
    { header: "Taxable value", key: "taxable", width: 14, money: true }, { header: "IGST", key: "igst", width: 12, money: true }, { header: "CGST", key: "cgst", width: 12, money: true },
    { header: "SGST/UTGST", key: "sgst", width: 12, money: true }, { header: "Cess", key: "cess", width: 10, money: true }, { header: "Invoice value", key: "invoice", width: 14, money: true },
    { header: "Tax in report", key: "sourceTax", width: 13, money: true }, { header: "Tax recalculated", key: "computedTax", width: 14, money: true }, { header: "Place of supply", key: "pos", width: 9 },
    { header: "Supply", key: "supply", width: 9 }, { header: "Operator GSTIN", key: "eco", width: 18 }, { header: "Status", key: "status", width: 16 }, { header: "Matched to event", key: "related", width: 12 },
    { header: "File", key: "file", width: 26 }, { header: "Row", key: "row", width: 7 }, { header: "Notes", key: "notes", width: 50 },
  ];
  const eventRow = (e: ExportEvent) => ({
    id: e.id, type: e.eventType, order: e.orderId, sub: e.subOrderId, orderDate: dateCell(e.orderDate), returnDate: dateCell(e.returnDate), doc: e.documentNumber,
    period: e.reportPeriod, hsn: e.hsn, qty: e.quantity, rate: rateText(e.rateMilli), taxable: money(e.taxable), igst: money(e.igst), cgst: money(e.cgst), sgst: money(e.sgst),
    cess: money(e.cess), invoice: money(e.invoiceValue), sourceTax: money(e.sourceTax), computedTax: money(e.computedTax), pos: e.placeOfSupply, supply: e.supplyType, eco: e.ecoGstin,
    status: e.duplicateOf ? `duplicate of ${e.duplicateOf}` : e.status, related: e.relatedEventId, file: e.fileName, row: e.sourceRow, notes: e.notes.join(" "),
  });
  const salesSheet = sheetWith(wb, "Normalized Sales", eventColumns);
  for (const e of data.events.filter(e => e.eventType === "sale")) salesSheet.addRow(eventRow(e));
  finish(salesSheet, eventColumns.length);
  const returnsSheet = sheetWith(wb, "Sales Returns", eventColumns);
  for (const e of data.events.filter(e => e.eventType !== "sale")) returnsSheet.addRow(eventRow(e));
  finish(returnsSheet, eventColumns.length);

  // 5. HSN
  const hsnColumns = [
    { header: "HSN", key: "hsn", width: 10 }, { header: "Description", key: "desc", width: 20 }, { header: "UQC", key: "uqc", width: 7 }, { header: "Rate %", key: "rate", width: 8 },
    { header: "Sales qty", key: "sq", width: 10 }, { header: "Sales taxable", key: "st", width: 15, money: true }, { header: "Returns qty", key: "rq", width: 11 }, { header: "Returns taxable", key: "rt", width: 15, money: true },
    { header: "Net qty", key: "nq", width: 9 }, { header: "Net taxable", key: "nt", width: 15, money: true }, { header: "Net IGST", key: "ni", width: 12, money: true }, { header: "Net CGST", key: "nc", width: 12, money: true },
    { header: "Net SGST/UTGST", key: "ns", width: 14, money: true }, { header: "Net cess", key: "nce", width: 10, money: true },
  ];
  const hsn = sheetWith(wb, "HSN-wise Summary", hsnColumns);
  for (const r of data.hsn) {
    hsn.addRow({ hsn: r.hsn, desc: r.description, uqc: r.uqc, rate: r.rate, sq: r.sales.quantity, st: money(r.sales.taxable), rq: r.returns.quantity, rt: money(r.returns.taxable), nq: r.net.quantity, nt: money(r.net.taxable), ni: money(r.net.igst), nc: money(r.net.cgst), ns: money(r.net.sgst), nce: money(r.net.cess) });
  }
  finish(hsn, hsnColumns.length);

  // 6. State
  const stateColumns = [
    { header: "Place of supply", key: "pos", width: 22 }, { header: "Rate %", key: "rate", width: 8 }, { header: "Supply", key: "supply", width: 9 }, { header: "Operator GSTIN", key: "eco", width: 18 },
    { header: "Sales taxable", key: "st", width: 15, money: true }, { header: "Returns taxable", key: "rt", width: 15, money: true }, { header: "Net taxable", key: "nt", width: 15, money: true },
    { header: "Net IGST", key: "ni", width: 12, money: true }, { header: "Net CGST", key: "nc", width: 12, money: true }, { header: "Net SGST/UTGST", key: "ns", width: 14, money: true },
  ];
  const state = sheetWith(wb, "State-wise GST", stateColumns);
  for (const r of data.states) state.addRow({ pos: `${r.pos}-${r.posName}`, rate: r.rate, supply: r.supplyType, eco: r.ecoGstin, st: money(r.sales.taxable), rt: money(r.returns.taxable), nt: money(r.net.taxable), ni: money(r.net.igst), nc: money(r.net.cgst), ns: money(r.net.sgst) });
  finish(state, stateColumns.length);

  // 7. GSTR-1 working
  const g = wb.addWorksheet("GSTR-1 Working", { views: [{ state: "frozen", ySplit: 2 }] });
  g.columns = [{ width: 26 }, { width: 22 }, { width: 10 }, { width: 18 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }];
  g.addRow([`GSTR-1 working — ${data.period} (draft for CA review)`]).font = { bold: true, size: 13, color: { argb: BRAND } };
  const b2csHead = g.addRow(["Table 7 — B2C Others: Type", "Place of supply", "Rate %", "E-commerce GSTIN", "Taxable value", "IGST", "CGST", "SGST/UTGST", "Cess"]);
  b2csHead.font = { bold: true };
  for (const r of data.gstr1.b2cs) {
    const row = g.addRow([r.type === "E" ? "E-Commerce" : "Other than e-commerce", `${r.pos}-${r.posName}`, r.rate, r.ecoGstin ?? "", money(r.taxable), money(r.igst), money(r.cgst), money(r.sgst), money(r.cess)]);
    for (let c = 5; c <= 9; c += 1) row.getCell(c).numFmt = MONEY;
    if (r.negative) row.getCell(5).font = { color: { argb: "FFB91C1C" } };
  }
  g.addRow([]);
  g.addRow(["Table 14(a) — supplies through e-commerce operators (already in Table 7)"]).font = { bold: true };
  for (const r of data.gstr1.table14a) {
    const row = g.addRow([r.ecoGstin, "", "", "", money(r.taxable), money(r.igst), money(r.cgst), money(r.sgst), money(r.cess)]);
    for (let c = 5; c <= 9; c += 1) row.getCell(c).numFmt = MONEY;
  }
  g.addRow([]);
  g.addRow(["Table 13 — documents issued"]).font = { bold: true };
  if (!data.gstr1.table13.available) g.addRow([data.gstr1.table13.reason ?? "Not available."]);
  for (const [label, list] of [["Invoices for outward supply", data.gstr1.table13.invoices], ["Credit notes", data.gstr1.table13.creditNotes]] as const) {
    for (const s of list) g.addRow([label, s.from, s.to, s.count]);
  }
  g.addRow([]);
  g.addRow(["B2C (Large) candidates — inter-State invoices above the threshold"]).font = { bold: true };
  if (data.gstr1.b2clCandidates.length === 0) g.addRow(["None."]);
  for (const r of data.gstr1.b2clCandidates) g.addRow([r.reference, r.pos ?? "", "", "", money(r.taxable), "", "", "", ""]).getCell(5).numFmt = MONEY;
  g.addRow([]);
  g.addRow(["TCS under Section 52 (not output tax)"]).font = { bold: true };
  g.addRow(["Net value through operators", money(data.gstr1.tcs.netTaxable)]).getCell(2).numFmt = MONEY;
  g.addRow([`Expected TCS at ${data.gstr1.tcs.rate}%`, money(data.gstr1.tcs.expected)]).getCell(2).numFmt = MONEY;
  g.addRow([data.gstr1.tcs.note]);
  g.addRow([]);
  for (const note of data.gstr1.notes) g.addRow([note]);

  // 8. Exceptions
  const exColumns = [
    { header: "ID", key: "id", width: 8 }, { header: "Severity", key: "severity", width: 10 }, { header: "Kind", key: "kind", width: 22 }, { header: "Status", key: "status", width: 10 },
    { header: "Event", key: "event", width: 9 }, { header: "Source", key: "source", width: 34 }, { header: "What needs a look", key: "message", width: 80 }, { header: "Reviewer note", key: "note", width: 40 },
  ];
  const ex = sheetWith(wb, "Exceptions", exColumns);
  for (const e of data.exceptions) ex.addRow({ id: e.id, severity: e.severity, kind: e.kind, status: e.status, event: e.eventId, source: e.sourceRef, message: e.message, note: e.note });
  finish(ex, exColumns.length);

  // 9. Reconciliation audit
  const auditColumns = [{ header: "When", key: "at", width: 22 }, { header: "Who", key: "actor", width: 26 }, { header: "Action", key: "action", width: 24 }, { header: "On", key: "target", width: 22 }, { header: "Note", key: "note", width: 70 }];
  const audit = sheetWith(wb, "Reconciliation Audit", auditColumns);
  for (const r of data.reviews) audit.addRow(r);
  if (data.reviews.length === 0) audit.addRow({ at: "", actor: "", action: "No decisions recorded yet", target: "", note: "" });
  finish(audit, auditColumns.length);

  // 10. Source metadata
  const fileColumns = [
    { header: "File", key: "file", width: 30 }, { header: "Inside ZIP", key: "container", width: 22 }, { header: "Sheet", key: "sheet", width: 14 }, { header: "Report type", key: "type", width: 16 },
    { header: "Status", key: "status", width: 14 }, { header: "Rows", key: "rows", width: 8 }, { header: "Periods", key: "periods", width: 18 }, { header: "Columns used", key: "map", width: 60 },
    { header: "Columns kept for reference", key: "unknown", width: 40 }, { header: "SHA-256", key: "sha", width: 66 }, { header: "Imported", key: "at", width: 22 },
  ];
  const files = sheetWith(wb, "Source Metadata", fileColumns);
  for (const f of data.files) {
    files.addRow({ file: f.fileName, container: f.containerName, sheet: f.sheetName, type: f.reportType, status: f.status, rows: f.rowCount, periods: f.periods.join(", "), map: Object.entries(f.columnMap).map(([k, v]) => `${k} ← ${v}`).join("; "), unknown: f.unknownColumns.join(", "), sha: f.sha256, at: f.importedAt });
  }
  finish(files, fileColumns.length);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function rs(p: Paise): string {
  const sign = p < 0 ? "-" : "";
  const abs = Math.abs(p);
  const whole = String(Math.trunc(abs / 100));
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${sign}Rs. ${rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3}.${String(abs % 100).padStart(2, "0")}`;
}

/** A compact PDF. Helvetica cannot print the rupee sign, so amounts read "Rs.". */
export function buildPdf(data: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 42 });
    const chunks: Buffer[] = [];
    doc.on("data", c => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const width = doc.page.width - 84;
    const green = "#143E2C";
    const muted = "#6B7280";

    doc.font("Helvetica-Bold").fontSize(16).fillColor(green).text(`${data.marketplaceName} reconciliation`);
    doc.font("Helvetica").fontSize(9).fillColor(muted).text(`${data.companyName}  ·  GSTIN ${data.sellerGstin ?? "not given"}  ·  FY ${data.financialYear}  ·  Period ${data.period}`);
    doc.text(`Status: ${data.status}${data.approvedBy ? ` — approved by ${data.approvedBy} on ${data.approvedAt}` : ""}  ·  Generated ${data.generatedAt.toISOString().replace("T", " ").slice(0, 16)} UTC`);
    doc.moveDown(0.8);

    const table = (headers: string[], rows: string[][], widths: number[]) => {
      const x0 = doc.page.margins.left;
      const draw = (cells: string[], bold: boolean) => {
        if (doc.y > doc.page.height - 70) doc.addPage();
        const y = doc.y;
        let x = x0;
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor("#111827");
        cells.forEach((cell, i) => {
          doc.text(cell, x + 2, y, { width: widths[i] - 4, align: i === 0 ? "left" : "right", lineBreak: false });
          x += widths[i];
        });
        doc.moveTo(x0, y + 12).lineTo(x0 + widths.reduce((a, b) => a + b, 0), y + 12).strokeColor("#E5E7EB").lineWidth(0.5).stroke();
        doc.y = y + 15;
      };
      draw(headers, true);
      rows.forEach(r => draw(r, false));
      doc.x = x0;
      doc.moveDown(0.6);
    };
    const heading = (text: string) => {
      if (doc.y > doc.page.height - 110) doc.addPage();
      doc.font("Helvetica-Bold").fontSize(11).fillColor(green).text(text, doc.page.margins.left);
      doc.moveDown(0.3);
    };
    const t = (label: string, x: Totals) => [label, String(x.count), rs(x.taxable), rs(x.igst), rs(x.cgst), rs(x.sgst), rs(x.tax), rs(x.invoiceValue)];

    heading("Sales, returns and net for the period");
    table(["", "Count", "Taxable", "IGST", "CGST", "SGST/UTGST", "Total tax", "Invoice value"], [
      t("Sales", data.overview.sales), t("Returns", data.overview.returns), t("Credit notes", data.overview.creditNotes), t("Net", data.overview.net),
    ], [70, 40, 70, 58, 58, 64, 60, 70].map(w => (w * width) / 490));

    heading("HSN summary (net)");
    const hsnRows = data.hsn.slice(0, 25).map(r => [r.hsn, r.rate, String(r.net.quantity), rs(r.net.taxable), rs(r.net.igst), rs(r.net.cgst), rs(r.net.sgst)]);
    table(["HSN", "Rate %", "Net qty", "Net taxable", "IGST", "CGST", "SGST/UTGST"], hsnRows, [70, 45, 55, 90, 75, 75, 80].map(w => (w * width) / 490));
    if (data.hsn.length > 25) doc.font("Helvetica").fontSize(8).fillColor(muted).text(`${data.hsn.length - 25} more HSN rows are in the Excel workbook.`).moveDown(0.5);

    heading("Place of supply (net)");
    table(["Place of supply", "Rate %", "Net taxable", "IGST", "CGST", "SGST/UTGST"], data.states.slice(0, 20).map(r => [`${r.pos} ${r.posName}`, r.rate, rs(r.net.taxable), rs(r.net.igst), rs(r.net.cgst), rs(r.net.sgst)]), [130, 50, 90, 70, 70, 80].map(w => (w * width) / 490));

    heading("Exceptions and unresolved items");
    const open = data.exceptions.filter(e => e.status === "open" && e.severity !== "info");
    const byKind = new Map<string, number>();
    for (const e of data.exceptions) byKind.set(`${e.severity} · ${e.kind} · ${e.status}`, (byKind.get(`${e.severity} · ${e.kind} · ${e.status}`) ?? 0) + 1);
    table(["Severity · kind · status", "Count"], [...byKind.entries()].map(([k, n]) => [k, String(n)]), [380, 110].map(w => (w * width) / 490));
    if (open.length) {
      doc.font("Helvetica").fontSize(8).fillColor("#111827");
      for (const e of open.slice(0, 12)) doc.text(`• ${e.sourceRef}: ${e.message}`, { width });
      if (open.length > 12) doc.fillColor(muted).text(`${open.length - 12} more open items are in the Excel workbook.`);
      doc.moveDown(0.5);
    }

    doc.font("Helvetica").fontSize(7.5).fillColor(muted).text(
      "Sales totals are invoice values for GST, not money received or profit. Returns reduce the period in which they are reported. TCS collected by the operator is not output tax. Draft working papers for CA review, not a filing-ready return. Potential risk — needs CA review.",
      { width },
    );
    doc.end();
  });
}
