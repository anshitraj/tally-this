/**
 * Excel CA Pack export.
 * Generates a multi-sheet .xlsx workbook containing:
 *   Sheet 1 — Summary (score, period, company)
 *   Sheet 2 — Reconciliation matches
 *   Sheet 3 — Unmatched transactions
 *   Sheet 4 — Invoice list
 *   Sheet 5 — GST/TDS risk flags
 *   Sheet 6 — Trial Balance
 *   Sheet 7 — Journal Entries
 *
 * CAs work in Excel — this is the primary deliverable of the tool.
 */
import { Router, type IRouter } from "express";
import ExcelJS from "exceljs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getCompanyId, requirePermission } from "../middleware/authz";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const BRAND_COLOR = "143E2C"; // TallyThis forest green
const HEADER_FILL: ExcelJS.FillPattern = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND_COLOR } };
const ALT_FILL: ExcelJS.FillPattern = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFBF7F5" } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };

function styleHeaderRow(row: ExcelJS.Row, cols: number) {
  row.fill = HEADER_FILL;
  row.font = HEADER_FONT;
  row.height = 22;
  for (let c = 1; c <= cols; c++) {
    row.getCell(c).alignment = { vertical: "middle", horizontal: "center" };
  }
}

function alternateRow(row: ExcelJS.Row, idx: number) {
  if (idx % 2 === 0) {
    row.fill = ALT_FILL;
  }
}

function currencyFormat(cell: ExcelJS.Cell) {
  cell.numFmt = "₹#,##0.00";
}

function numeric(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

router.post("/reports/excel-export", requirePermission("reports.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const exportedOn = new Date().toISOString().slice(0, 10);

  try {
    // ── Fetch data ───────────────────────────────────────────────────────────
    const [reconRes, txnRes, invRes, riskRes, tbRes, jeRes, companyRes] = await Promise.all([
      db.execute(sql`
        SELECT r.id, r.match_type, r.confidence_score, r.status, r.created_at AS matched_at,
               t.narration AS txn_desc, t.amount AS txn_amount, t.date AS txn_date,
               t.reference AS txn_ref,
               i.invoice_number, i.amount AS inv_amount, i.vendor_name AS vendor
        FROM reconciliation_matches r
        LEFT JOIN bank_transactions t ON t.id = r.bank_transaction_id
        LEFT JOIN invoices i ON i.id = r.invoice_id
        WHERE r.company_id = ${companyId}
        ORDER BY r.created_at DESC LIMIT 2000`),
      db.execute(sql`
        SELECT id, date, narration AS description, amount, type, reference, status
        FROM bank_transactions WHERE company_id = ${companyId}
          AND NOT EXISTS (SELECT 1 FROM reconciliation_matches r WHERE r.company_id = ${companyId} AND r.bank_transaction_id = bank_transactions.id)
        ORDER BY date DESC LIMIT 1000`),
      db.execute(sql`
        SELECT id, invoice_number, vendor_name AS vendor, amount, gst_amount, status, date AS invoice_date, NULL::text AS due_date, type
        FROM invoices WHERE company_id = ${companyId}
        ORDER BY date DESC LIMIT 2000`),
      db.execute(sql`
        SELECT id, title, entity_type, severity, status, description
        FROM ca_review_items WHERE company_id = ${companyId}
        ORDER BY severity DESC, created_at DESC LIMIT 500`),
      db.execute(sql`
        SELECT NULL::text AS account_code, ledger_name AS account_name, NULL::text AS account_type,
               SUM(CASE WHEN LOWER(debit_credit) = 'debit' THEN amount ELSE 0 END) AS debit_total,
               SUM(CASE WHEN LOWER(debit_credit) = 'credit' THEN amount ELSE 0 END) AS credit_total,
               SUM(CASE WHEN LOWER(debit_credit) = 'debit' THEN amount ELSE -amount END) AS balance
        FROM ledger_entries WHERE company_id = ${companyId}
        GROUP BY ledger_name ORDER BY ledger_name LIMIT 500`),
      db.execute(sql`
        SELECT je.id, je.entry_date, je.narration AS description, je.voucher_no AS reference, je.status,
               jl.account_name, jl.debit, jl.credit
        FROM journal_entries je
        JOIN journal_entry_lines jl ON jl.journal_id = je.id
        WHERE je.company_id = ${companyId}
        ORDER BY je.entry_date DESC, je.id LIMIT 2000`).catch(() => ({ rows: [], unavailable: true })),
      db.execute(sql`SELECT name FROM companies WHERE id = ${companyId} LIMIT 1`),
    ]);

    const company = (companyRes.rows[0] as { name: string } | undefined)?.name ?? "Company";

    // ── Build workbook ───────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = "TallyThis";
    wb.lastModifiedBy = "TallyThis";
    wb.created = new Date();

    // ─── Sheet 1: Summary ────────────────────────────────────────────────────
    const summary = wb.addWorksheet("Summary");
    summary.columns = [{ width: 35 }, { width: 62 }];
    const titleRow = summary.addRow(["TallyThis — CA Pack", ""]);
    titleRow.font = { bold: true, size: 14, color: { argb: BRAND_COLOR } };
    titleRow.height = 28;
    summary.mergeCells("A1:B1");
    summary.addRow([]);
    const infoRows = [
      ["Company", company],
      ["Coverage", "Newest saved records, all dates; row limits apply"],
      ["Generated on", new Date().toLocaleString("en-IN")],
      ["Reconciliation matches", reconRes.rows.length],
      ["Unmatched transactions", txnRes.rows.length],
      ["Invoices", invRes.rows.length],
      ["Risk flags", riskRes.rows.length],
      ["Journal entries", "unavailable" in jeRes ? "Unavailable in this workspace" : new Set((jeRes.rows as { id: number }[]).map(r => r.id)).size],
    ];
    infoRows.forEach(([label, value], i) => {
      const r = summary.addRow([label, value]);
      if (i % 2 === 0) r.fill = ALT_FILL;
      r.getCell(1).font = { bold: true };
    });

    // ─── Sheet 2: Reconciliation Matches ─────────────────────────────────────
    const reconWs = wb.addWorksheet("Reconciliation");
    reconWs.columns = [
      { header: "Match Type", width: 18 },
      { header: "Confidence", width: 12 },
      { header: "Status", width: 14 },
      { header: "Txn Date", width: 14 },
      { header: "Txn Description", width: 35 },
      { header: "Txn Amount (₹)", width: 18 },
      { header: "Txn Reference", width: 18 },
      { header: "Invoice No.", width: 18 },
      { header: "Invoice Amount (₹)", width: 20 },
      { header: "Vendor", width: 24 },
    ];
    styleHeaderRow(reconWs.getRow(1), 10);
    (reconRes.rows as Record<string, unknown>[]).forEach((r, i) => {
      const row = reconWs.addRow([
        r.match_type, numeric(r.confidence_score), r.status,
        r.txn_date, r.txn_desc, numeric(r.txn_amount), r.txn_ref,
        r.invoice_number, numeric(r.inv_amount), r.vendor,
      ]);
      alternateRow(row, i);
      currencyFormat(row.getCell(6));
      currencyFormat(row.getCell(9));
    });

    // ─── Sheet 3: Unmatched Transactions ─────────────────────────────────────
    const unmatchedWs = wb.addWorksheet("Unmatched Transactions");
    unmatchedWs.columns = [
      { header: "Date", width: 14 },
      { header: "Description", width: 40 },
      { header: "Amount (₹)", width: 16 },
      { header: "Type", width: 10 },
      { header: "Reference", width: 20 },
      { header: "Status", width: 14 },
    ];
    styleHeaderRow(unmatchedWs.getRow(1), 6);
    (txnRes.rows as Record<string, unknown>[]).forEach((r, i) => {
      const row = unmatchedWs.addRow([r.date, r.description, numeric(r.amount), r.type, r.reference, r.status]);
      alternateRow(row, i);
      currencyFormat(row.getCell(3));
    });

    // ─── Sheet 4: Invoices ───────────────────────────────────────────────────
    const invWs = wb.addWorksheet("Invoices");
    invWs.columns = [
      { header: "Invoice No.", width: 20 },
      { header: "Vendor", width: 28 },
      { header: "Amount (₹)", width: 16 },
      { header: "GST (₹)", width: 14 },
      { header: "Type", width: 12 },
      { header: "Invoice Date", width: 16 },
      { header: "Due Date", width: 14 },
      { header: "Status", width: 14 },
    ];
    styleHeaderRow(invWs.getRow(1), 8);
    (invRes.rows as Record<string, unknown>[]).forEach((r, i) => {
      const row = invWs.addRow([r.invoice_number, r.vendor, numeric(r.amount), numeric(r.gst_amount), r.type, r.invoice_date, r.due_date, r.status]);
      alternateRow(row, i);
      currencyFormat(row.getCell(3));
      currencyFormat(row.getCell(4));
    });

    // ─── Sheet 5: GST / TDS Risk Flags ───────────────────────────────────────
    const riskWs = wb.addWorksheet("Risk Flags");
    riskWs.columns = [
      { header: "Title", width: 35 },
      { header: "Category", width: 16 },
      { header: "Severity", width: 12 },
      { header: "Status", width: 14 },
      { header: "Description", width: 50 },
    ];
    styleHeaderRow(riskWs.getRow(1), 5);
    (riskRes.rows as Record<string, unknown>[]).forEach((r, i) => {
      const row = riskWs.addRow([r.title, r.entity_type, r.severity, r.status, r.description]);
      alternateRow(row, i);
      const sevCell = row.getCell(3);
      sevCell.font = { bold: true, color: { argb: r.severity === "high" ? "FFDC2626" : r.severity === "medium" ? "FFF97F06" : "FF16A34A" } };
    });

    // ─── Sheet 6: Trial Balance ───────────────────────────────────────────────
    const tbWs = wb.addWorksheet("Ledger Totals");
    tbWs.columns = [
      { header: "Account Code", width: 16 },
      { header: "Account Name", width: 32 },
      { header: "Type", width: 16 },
      { header: "Debit (₹)", width: 16 },
      { header: "Credit (₹)", width: 16 },
      { header: "Balance (₹)", width: 16 },
    ];
    styleHeaderRow(tbWs.getRow(1), 6);
    (tbRes.rows as Record<string, unknown>[]).forEach((r, i) => {
      const row = tbWs.addRow([r.account_code, r.account_name, r.account_type, numeric(r.debit_total), numeric(r.credit_total), numeric(r.balance)]);
      alternateRow(row, i);
      currencyFormat(row.getCell(4));
      currencyFormat(row.getCell(5));
      currencyFormat(row.getCell(6));
    });

    // ─── Sheet 7: Journal Entries ─────────────────────────────────────────────
    const jeWs = wb.addWorksheet("Journal Entries");
    jeWs.columns = [
      { header: "Entry ID", width: 12 },
      { header: "Date", width: 14 },
      { header: "Description", width: 35 },
      { header: "Reference", width: 18 },
      { header: "Status", width: 14 },
      { header: "Account", width: 28 },
      { header: "Debit (₹)", width: 16 },
      { header: "Credit (₹)", width: 16 },
    ];
    styleHeaderRow(jeWs.getRow(1), 8);
    if ("unavailable" in jeRes) jeWs.addRow(["Journal entries are unavailable in this workspace."]);
    (jeRes.rows as Record<string, unknown>[]).forEach((r, i) => {
      const row = jeWs.addRow([r.id, r.entry_date, r.description, r.reference, r.status, r.account_name, numeric(r.debit), numeric(r.credit)]);
      alternateRow(row, i);
      currencyFormat(row.getCell(7));
      currencyFormat(row.getCell(8));
    });

    // ── Stream response ───────────────────────────────────────────────────────
    const filename = `TallyThis_CA_Pack_${company.replace(/[^a-z0-9_-]+/gi, "_")}_${exportedOn}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    logger.error({ err }, "Excel export failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "Excel export failed" });
    }
  }
});

export default router;
