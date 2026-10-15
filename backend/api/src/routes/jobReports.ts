/**
 * Month summary for the saved jobs of one client.
 *
 * The four jobs never write to the older month-close tables, so the older CA pack cannot describe
 * their work. This reads the saved job runs themselves and gives the CA one place for what was
 * done this month and every item that still needs a decision.
 */
import { Router, type IRouter } from "express";
import ExcelJS from "exceljs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { auditAction, requirePermission } from "../middleware/authz";
import { resolveBooksCompanyId } from "../services/companyScope";
import { historyCutoff } from "../services/privacyPolicy";

const router: IRouter = Router();

const JOB_LABEL: Record<string, string> = {
  bank_to_tally: "Bank → Tally",
  bank_tally_reconciliation: "Bank ↔ Tally",
  ecommerce_gst: "E-commerce GST",
  bank_invoice_reconciliation: "Invoice ↔ Bank",
  gstr_2b_reconciliation: "GSTR-2B ↔ Books",
};

interface RunRow {
  id: string;
  run_type: string;
  title: string;
  status: string;
  created_at: string;
  user_name: string | null;
  artifacts: Array<{ type: string; data: Record<string, unknown> }> | null;
}

export interface OpenItem {
  job: string;
  runId: string;
  group: string;
  date: string;
  description: string;
  amount: number | null;
  note: string;
  decision: string;
}

export interface MonthRun {
  id: string;
  job: string;
  title: string;
  status: string;
  createdAt: string;
  by: string;
  headline: string;
  total: number | null;
  attention: number | null;
}

const OPEN_STATUS = new Set(["suggested", "needs_info", "document_requested", undefined]);

const BUCKET_TITLE: Record<string, string> = {
  bank_only: "In bank, missing in Tally",
  tally_only: "In Tally, missing in bank",
  amount_difference: "Amounts differ",
  suggested: "Probable match, not confirmed",
  duplicate: "Possible duplicate",
  payment_without_invoice: "Bank entry without an invoice",
  invoice_without_payment: "Invoice not paid yet",
  amount_mismatch: "Amount differs",
  value_mismatch: "Amounts differ in GSTR-2B and books",
  probable: "Probable match, not confirmed",
  missing_in_2b: "In books, not in GSTR-2B",
  missing_in_books: "In GSTR-2B, not in books",
  not_eligible: "ITC not available in GSTR-2B",
};

function istMonth(date = new Date()) {
  return new Date(date.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 7);
}

function monthLabel(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

function number(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function readRuns(rows: RunRow[]) {
  const runs: MonthRun[] = [];
  const open: OpenItem[] = [];
  for (const row of rows) {
    const job = JOB_LABEL[row.run_type] ?? row.title;
    const base = { id: row.id, job, title: row.title.replace(/^.*? — /, "") || row.title, status: row.status, createdAt: row.created_at, by: row.user_name ?? "" };
    const art = (type: string) => row.artifacts?.find(item => item.type === type)?.data;
    let headline = "";
    let total: number | null = null;
    let attention: number | null = null;

    if (row.run_type === "bank_to_tally") {
      const data = art("bank_statement") ?? {};
      const txns = Array.isArray(data.transactions) ? (data.transactions as Array<{ confidence?: number }>) : [];
      headline = [data.bankName, data.periodLabel].filter(Boolean).join(" · ");
      total = txns.length;
      attention = txns.filter(txn => (txn.confidence ?? 1) < 0.9).length;
    } else if (row.run_type === "ecommerce_gst") {
      const data = art("ecommerce_gst") ?? {};
      const summary = (data.summary ?? {}) as Record<string, unknown>;
      headline = String(data.platform ?? "");
      total = number(summary.documents);
      attention = number(summary.errors);
    } else {
      const data = art("bank_tally_comparison") ?? art("invoice_bank_comparison") ?? art("gstr2b_comparison");
      const comparison = (data?.comparison ?? {}) as { items?: Array<Record<string, any>> };
      const items = comparison.items ?? [];
      headline = [data?.bankName, data?.periodLabel, data?.period].filter(Boolean).join(" · ");
      total = items.length;
      let count = 0;
      for (const item of items) {
        const matched = item.bucket === "matched" || item.bucket === "confirmed" || item.bucket === "no_invoice_expected";
        if (matched || !OPEN_STATUS.has(item.status)) continue;
        count += 1;
        const bank = item.bank as { date?: string; narration?: string; debit?: number | null; credit?: number | null } | undefined;
        const tally = item.tally as { date?: string; ledgerName?: string; debit?: number | null; credit?: number | null } | undefined;
        const invoice = item.invoice as { invoiceNumber?: string; vendorName?: string; total?: number; invoiceDate?: string | null } | undefined;
        const books = item.books as { docDate?: string | null; total?: number } | undefined;
        const side = bank ?? tally;
        let description = "";
        let amount: number | null = null;
        let date = "";
        if (row.run_type === "gstr_2b_reconciliation") {
          description = `${item.supplierName || item.supplierGstin} · ${item.docNumber}`;
          amount = number(item.itcAtRisk) || number(item.itcUnclaimed) || number(item.books?.total ?? item.portal?.total);
          date = String(item.docDate ?? books?.docDate ?? "");
        } else if (invoice && !bank) {
          description = `${invoice.vendorName ?? "Invoice"} · ${invoice.invoiceNumber ?? ""}`;
          amount = number(invoice.total);
          date = String(invoice.invoiceDate ?? "");
        } else {
          description = [bank?.narration, tally?.ledgerName, invoice ? `${invoice.vendorName} ${invoice.invoiceNumber}` : ""].filter(Boolean).join(" · ");
          amount = number(side?.debit ?? side?.credit);
          date = String(side?.date ?? "");
        }
        open.push({
          job,
          runId: row.id,
          group: BUCKET_TITLE[String(item.bucket)] ?? String(item.bucket),
          date,
          description,
          amount,
          note: Array.isArray(item.why) ? item.why.join(". ") : "",
          decision: item.status === "needs_info" ? "Asked client" : "Not reviewed",
        });
      }
      attention = count;
    }
    runs.push({ ...base, headline, total, attention });
  }
  return { runs, open };
}

async function loadMonth(companyId: number, month: string) {
  const result = await db.execute(sql`
    SELECT wr.id, wr.run_type, wr.title, wr.status, wr.created_at, u.name AS user_name,
           (SELECT jsonb_agg(jsonb_build_object('type', ra.artifact_type, 'data', ra.json_data) ORDER BY ra.created_at)
              FROM run_artifacts ra
             WHERE ra.run_id = wr.id
               AND ra.artifact_type IN ('bank_statement', 'ecommerce_gst', 'bank_tally_comparison', 'invoice_bank_comparison', 'gstr2b_comparison')) AS artifacts
      FROM workflow_runs wr
      LEFT JOIN users u ON u.id = wr.created_by
     WHERE wr.company_id = ${companyId}
       AND (COALESCE(wr.metadata_json->>'clientId','') = '' OR wr.metadata_json->>'clientId' = ${String(companyId)})
       AND NOT EXISTS (SELECT 1 FROM run_artifacts a WHERE a.run_id = wr.id AND a.artifact_type = 'ledger_mappings')
       AND wr.run_type IN ('bank_to_tally', 'bank_tally_reconciliation', 'ecommerce_gst', 'bank_invoice_reconciliation', 'gstr_2b_reconciliation')
       AND wr.status = 'completed'
       AND wr.created_at >= ${historyCutoff().toISOString()}::timestamptz
       AND to_char(wr.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = ${month}
     ORDER BY wr.created_at DESC
     LIMIT 200
  `);
  return readRuns(result.rows as unknown as RunRow[]);
}

function monthParam(value: unknown) {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : istMonth();
}

router.get("/reports/jobs-overview", requirePermission("reports.read"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const month = monthParam(req.query.month);
  try {
    const { runs, open } = await loadMonth(companyId, month);
    res.json({
      ok: true,
      month,
      monthLabel: monthLabel(month),
      runs,
      jobs: runs.length,
      openItems: open.length,
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : "The month summary could not be loaded." });
  }
});

router.post("/reports/jobs-pack", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const month = monthParam(req.body?.month);
  const clientName = typeof req.body?.clientName === "string" && req.body.clientName.trim() ? req.body.clientName.trim().slice(0, 200) : "Client";
  try {
    const { runs, open } = await loadMonth(companyId, month);
    if (runs.length === 0) {
      res.status(404).json({ ok: false, message: `No jobs were saved for ${monthLabel(month)}. Run a job first, then come back for the pack.` });
      return;
    }
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "TallyThis";
    const styleHeader = (sheet: ExcelJS.Worksheet) => {
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      const row = sheet.getRow(1);
      row.font = { bold: true, color: { argb: "FFFFFFFF" } };
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF143E2C" } };
      row.height = 24;
    };

    const summary = workbook.addWorksheet("Summary");
    summary.columns = [{ width: 34 }, { width: 46 }];
    summary.addRow([`Month pack — ${monthLabel(month)}`]);
    summary.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF143E2C" } };
    summary.addRow([]);
    summary.addRow(["Client", clientName]);
    summary.addRow(["Jobs completed", runs.length]);
    summary.addRow(["Items still needing a decision", open.length]);
    summary.addRow([]);
    summary.addRow(["By job", "Runs"]);
    summary.getRow(summary.rowCount).font = { bold: true };
    const byJob = new Map<string, number>();
    for (const run of runs) byJob.set(run.job, (byJob.get(run.job) ?? 0) + 1);
    for (const [job, count] of byJob) summary.addRow([job, count]);
    summary.addRow([]);
    summary.addRow([
      "Built from the jobs saved in TallyThis for this client and month. Items marked for review are suggestions, not conclusions. Potential risk — needs CA review.",
    ]);

    const jobs = workbook.addWorksheet("Jobs");
    jobs.columns = [
      { header: "Date", width: 14 },
      { header: "Job", width: 20 },
      { header: "File / source", width: 40 },
      { header: "Details", width: 40 },
      { header: "Entries", width: 10 },
      { header: "Need attention", width: 16 },
      { header: "Run by", width: 24 },
    ];
    styleHeader(jobs);
    for (const run of runs) {
      jobs.addRow([new Date(run.createdAt), run.job, run.title, run.headline, run.total ?? "", run.attention ?? "", run.by]);
      jobs.getRow(jobs.rowCount).getCell(1).numFmt = "dd mmm yyyy";
    }

    const items = workbook.addWorksheet("Open items");
    items.columns = [
      { header: "Job", width: 18 },
      { header: "What", width: 34 },
      { header: "Date", width: 14 },
      { header: "Description", width: 60 },
      { header: "Amount ₹", width: 16 },
      { header: "Note", width: 70 },
      { header: "Status", width: 16 },
    ];
    styleHeader(items);
    for (const item of open) {
      const row = items.addRow([item.job, item.group, item.date, item.description, item.amount, item.note, item.decision]);
      row.getCell(5).numFmt = "#,##0.00;[Red](#,##0.00)";
      row.getCell(6).alignment = { wrapText: true, vertical: "top" };
    }
    items.autoFilter = { from: "A1", to: `G${Math.max(open.length + 1, 2)}` };

    const bytes = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="TallyThis_Month_Pack_${month}.xlsx"`);
    res.send(Buffer.from(bytes));
    void auditAction(req, "report.month_pack_exported", "report", null, { month, jobs: runs.length, open: open.length }).catch(() => undefined);
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : "The month pack could not be created." });
  }
});

export default router;
