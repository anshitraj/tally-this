/**
 * Tax Audit & Ledger Scrutiny — HTTP routes.
 * Pure check logic lives in services/taxAuditEngine.ts (unit-testable).
 *
 * Data source priority:
 *   1. Real imported Tally data in tally_ledgers / tally_vouchers / tally_voucher_lines
 *   2. Embedded demo dataset when those tables are empty / missing
 *      — so the dashboards always render with meaningful numbers.
 */
import { Router, type IRouter } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { db, ledgerEntriesTable, tallyLedgersTable, tallyVouchersTable, tallyVoucherLinesTable, tallyBillsTable } from "@workspace/db";
import { sql, eq, and, inArray } from "drizzle-orm";
import { requirePermission, auditAction } from "../middleware/authz";
import { resolveBooksCompanyId } from "../services/companyScope";
import { buildChecks, FY_END } from "../services/taxAuditEngine";
import { loadData } from "../services/taxAuditData";
import { runAndPersistReconciliation } from "../services/reconciliationRunner";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const PYTHON_WORKER_URL = process.env.PYTHON_WORKER_URL ?? "http://localhost:8091";

interface NormalizedLedger { name: string; group: string; opening_balance: number; closing_balance: number; prev_year_closing: number | null; prev_year_group: string | null; is_msme: boolean; msme_type: string | null; pan: string | null }
interface NormalizedVoucher { date: string; type: string; number: string; party: string | null; narration: string | null; amount: number; mode: string | null }
interface NormalizedLine { voucher_number: string; ledger: string; group: string; debit: number; credit: number }
interface NormalizedBill { party: string; group: string; ref: string; date: string; amount: number; type: string }
interface TallyParseResult { ok: boolean; warnings?: string[]; errors?: string[]; ledgers: NormalizedLedger[]; vouchers: NormalizedVoucher[]; voucher_lines: NormalizedLine[]; bills?: NormalizedBill[]; counts?: Record<string, number> }
type TallyLedgerEntrySource = "tally_xml_import" | "tally_connector";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Replace a company's tally_* rows with freshly parsed data. Shared by file import and the live connector. */
async function writeTallyData(companyId: number, parsed: TallyParseResult): Promise<Record<string, number>> {
  await db.delete(tallyVoucherLinesTable).where(eq(tallyVoucherLinesTable.companyId, companyId));
  await db.delete(tallyVouchersTable).where(eq(tallyVouchersTable.companyId, companyId));
  await db.delete(tallyLedgersTable).where(eq(tallyLedgersTable.companyId, companyId));
  await db.delete(tallyBillsTable).where(eq(tallyBillsTable.companyId, companyId));

  for (const batch of chunk(parsed.ledgers, 500)) {
    await db.insert(tallyLedgersTable).values(batch.map(l => ({
      companyId, name: l.name, group: l.group,
      openingBalance: String(l.opening_balance), closingBalance: String(l.closing_balance),
      prevYearClosing: l.prev_year_closing != null ? String(l.prev_year_closing) : null,
      prevYearGroup: l.prev_year_group, isMsme: l.is_msme, msmeType: l.msme_type, pan: l.pan,
    })));
  }
  for (const batch of chunk(parsed.vouchers, 500)) {
    await db.insert(tallyVouchersTable).values(batch.map(v => ({
      companyId, date: v.date, type: v.type, number: v.number,
      party: v.party, narration: v.narration, amount: String(v.amount), mode: v.mode,
    })));
  }
  for (const batch of chunk(parsed.voucher_lines, 500)) {
    await db.insert(tallyVoucherLinesTable).values(batch.map(l => ({
      companyId, voucherNumber: l.voucher_number, ledger: l.ledger, group: l.group,
      debit: String(l.debit), credit: String(l.credit),
    })));
  }
  for (const batch of chunk(parsed.bills ?? [], 500)) {
    await db.insert(tallyBillsTable).values(batch.map(b => ({
      companyId, party: b.party, group: b.group, ref: b.ref, date: b.date, amount: String(b.amount), type: b.type,
    })));
  }
  return parsed.counts ?? { ledgers: parsed.ledgers.length, vouchers: parsed.vouchers.length, voucher_lines: parsed.voucher_lines.length };
}

async function writeLedgerEntriesFromTally(companyId: number, parsed: TallyParseResult, sourceTool: TallyLedgerEntrySource): Promise<number> {
  await db.delete(ledgerEntriesTable).where(and(
    eq(ledgerEntriesTable.companyId, companyId),
    inArray(ledgerEntriesTable.sourceTool, ["tally_xml_import", "tally_connector"]),
  ));

  const voucherByNumber = new Map(parsed.vouchers.map(v => [v.number, v]));
  const rows = parsed.voucher_lines.flatMap(line => {
    const amount = Math.abs(line.debit || line.credit || 0);
    if (amount === 0) return [];
    const voucher = voucherByNumber.get(line.voucher_number);
    if (!voucher?.date || !line.ledger) return [];
    return [{
      companyId,
      date: voucher.date,
      ledgerName: line.ledger,
      voucherNumber: line.voucher_number,
      amount: amount.toFixed(2),
      debitCredit: line.debit > 0 ? "debit" : "credit",
      sourceTool,
      status: "unmatched",
      sourceUploadId: null,
    }];
  });

  for (const batch of chunk(rows, 500)) {
    await db.insert(ledgerEntriesTable).values(batch);
  }

  return rows.length;
}

const resolveCompanyId = resolveBooksCompanyId;

router.get("/tax-audit", requirePermission("reports.read"), async (req, res): Promise<void> => {
  try {
    const companyId = await resolveCompanyId(req, res);
    if (companyId == null) return;
    const { ledgers, vouchers, assets, bills, source } = await loadData(companyId);
    const checks = buildChecks(ledgers, vouchers, assets, bills);
    const summary = checks.map(c => ({ id: c.id, clause: c.clause, title: c.title, category: c.category, severity: c.severity, count: c.rows.length, description: c.description }));
    const stats = {
      flagged: summary.filter(s => s.count > 0 && s.severity !== "info").length,
      total: summary.length,
      highSeverity: summary.filter(s => s.severity === "high" && s.count > 0).length,
    };
    res.json({ ok: true, source, fyEnd: FY_END, summary, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "tax_audit_failed" });
  }
});

router.get("/tax-audit/:checkId", requirePermission("reports.read"), async (req, res): Promise<void> => {
  try {
    const companyId = await resolveCompanyId(req, res);
    if (companyId == null) return;
    const { ledgers, vouchers, assets, bills, source } = await loadData(companyId);
    const checks = buildChecks(ledgers, vouchers, assets, bills);
    const check = checks.find(c => c.id === req.params.checkId);
    if (!check) { res.status(404).json({ ok: false, error: "check_not_found" }); return; }
    res.json({ ok: true, source, check });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "tax_audit_failed" });
  }
});

/**
 * Import a Tally XML export: forward to the Python worker for parsing, then
 * replace this company's tally_* rows. After import, GET /api/tax-audit reads
 * real data (source:"tally").
 */
router.post("/tax-audit/import", requirePermission("uploads.create"), upload.single("file"), async (req, res): Promise<void> => {
  const companyId = await resolveCompanyId(req, res);
  if (companyId == null) return;
  const file = req.file;
  if (!file) { res.status(400).json({ ok: false, error: "No file uploaded" }); return; }

  // 1. Parse via Python worker
  let parsed: TallyParseResult;
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || "application/xml" }), file.originalname);
    form.append("company_id", String(companyId));
    const r = await fetch(`${PYTHON_WORKER_URL}/parse/tally`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) { res.status(502).json({ ok: false, error: `Parser returned ${r.status}` }); return; }
    parsed = await r.json() as TallyParseResult;
  } catch {
    res.status(502).json({ ok: false, error: "Extraction worker unavailable. Start the Python worker and retry." });
    return;
  }

  if (!parsed.ok || (parsed.ledgers.length === 0 && parsed.vouchers.length === 0)) {
    res.status(422).json({ ok: false, error: "No ledgers or vouchers found in file.", warnings: parsed.warnings, errors: parsed.errors });
    return;
  }

  const counts = await writeTallyData(companyId, parsed);
  const ledgerEntries = await writeLedgerEntriesFromTally(companyId, parsed, "tally_xml_import");
  const reconciliation = await runAndPersistReconciliation(companyId);
  await auditAction(req, "tax_audit.import", "tally_import", null, { fileName: file.originalname, ...counts, ledgerEntries, matchesFound: reconciliation.matchesFound });
  res.json({ ok: true, source: "tally", counts: { ...counts, ledgerEntries }, reconciliation, warnings: parsed.warnings });
});

/**
 * Live Tally Connector — pull a Day Book straight from a running Tally gateway
 * (no manual export). Forwards connection details to the worker, then ingests.
 */
router.post("/tax-audit/connector/sync", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveCompanyId(req, res);
  if (companyId == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const company = typeof b.company === "string" ? b.company.trim() : "";
  if (!company) { res.status(400).json({ ok: false, error: "Tally company name is required" }); return; }
  const payload = {
    host: typeof b.host === "string" && b.host ? b.host : "localhost",
    port: Number(b.port) || 9000,
    company,
    from_date: typeof b.fromDate === "string" ? b.fromDate : "",
    to_date: typeof b.toDate === "string" ? b.toDate : "",
    report: typeof b.report === "string" && b.report ? b.report : "Day Book",
  };

  let parsed: TallyParseResult;
  try {
    const r = await fetch(`${PYTHON_WORKER_URL}/connector/tally-fetch`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(70_000),
    });
    parsed = await r.json() as TallyParseResult;
  } catch {
    res.status(502).json({ ok: false, error: "Extraction worker unavailable. Start the Python worker and retry." });
    return;
  }

  if (!parsed.ok) {
    res.status(422).json({ ok: false, error: (parsed.errors && parsed.errors[0]) || "Tally returned no data.", warnings: parsed.warnings });
    return;
  }

  const counts = await writeTallyData(companyId, parsed);
  const ledgerEntries = await writeLedgerEntriesFromTally(companyId, parsed, "tally_connector");
  const reconciliation = await runAndPersistReconciliation(companyId);
  await auditAction(req, "tax_audit.connector_sync", "tally_import", null, { host: payload.host, company, ...counts, ledgerEntries, matchesFound: reconciliation.matchesFound });
  res.json({ ok: true, source: "tally", counts: { ...counts, ledgerEntries }, reconciliation });
});

/**
 * Evidence pack — a CA-ready .xlsx with a cover sheet plus one worksheet per
 * audit check (the working papers an auditor attaches to the file).
 */
const XL_BRAND = "143E2C";
const XL_HEADER_FILL: ExcelJS.FillPattern = { type: "pattern", pattern: "solid", fgColor: { argb: XL_BRAND } };
const XL_HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
const SEV_COLOR: Record<string, string> = { high: "FFDC2626", medium: "FFF97F06", low: "FF2563EB", info: "FF6B7280" };

function safeSheetName(idx: number, title: string): string {
  const clean = title.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim();
  return `${String(idx).padStart(2, "0")} ${clean}`.slice(0, 31);
}

router.post("/tax-audit/evidence-pack", requirePermission("reports.read"), async (req, res): Promise<void> => {
  try {
    const companyId = await resolveCompanyId(req, res);
    if (companyId == null) return;
    const { ledgers, vouchers, assets, bills, source } = await loadData(companyId);
    const checks = buildChecks(ledgers, vouchers, assets, bills);

    const companyRes = await db.execute(sql`SELECT name FROM companies WHERE id = ${companyId} LIMIT 1`);
    const company = (companyRes.rows[0] as { name: string } | undefined)?.name ?? "Company";

    const wb = new ExcelJS.Workbook();
    wb.creator = "TallyThis";
    wb.created = new Date();

    // Cover sheet
    const cover = wb.addWorksheet("Summary");
    cover.columns = [{ width: 6 }, { width: 40 }, { width: 16 }, { width: 12 }, { width: 14 }];
    const title = cover.addRow(["", "TallyThis — Tax Audit Working Papers"]);
    title.font = { bold: true, size: 14, color: { argb: XL_BRAND } };
    title.height = 26;
    cover.addRow([]);
    cover.addRow(["", "Company", company]);
    cover.addRow(["", "FY ending", FY_END]);
    cover.addRow(["", "Data source", source === "tally" ? "Imported Tally data" : "Demo data"]);
    cover.addRow(["", "Generated on", new Date().toLocaleString("en-IN")]);
    cover.addRow([]);
    const hdr = cover.addRow(["#", "Check", "Clause", "Severity", "Flagged"]);
    hdr.eachCell(c => { c.fill = XL_HEADER_FILL; c.font = XL_HEADER_FONT; });
    checks.forEach((c, i) => {
      const row = cover.addRow([i + 1, c.title, c.clause, c.severity.toUpperCase(), c.rows.length]);
      row.getCell(4).font = { bold: true, color: { argb: SEV_COLOR[c.severity] ?? SEV_COLOR.info } };
    });

    // One sheet per check
    checks.forEach((c, i) => {
      const ws = wb.addWorksheet(safeSheetName(i + 1, c.title));
      const t = ws.addRow([`${c.clause} — ${c.title}`]);
      t.font = { bold: true, size: 12, color: { argb: XL_BRAND } };
      ws.addRow([c.description]);
      ws.addRow([]);
      ws.columns = c.columns.map(col => ({ width: col.numeric ? 18 : 26 }));
      const headerRow = ws.addRow(c.columns.map(col => col.label));
      headerRow.eachCell(cell => { cell.fill = XL_HEADER_FILL; cell.font = XL_HEADER_FONT; cell.alignment = { horizontal: "center" }; });
      if (c.rows.length === 0) {
        ws.addRow(["No exceptions — check passed."]);
      } else {
        c.rows.forEach(r => {
          const row = ws.addRow(c.columns.map(col => r[col.key] ?? ""));
          c.columns.forEach((col, ci) => {
            if (col.numeric) { const cell = row.getCell(ci + 1); cell.numFmt = "#,##0.00"; cell.alignment = { horizontal: "right" }; }
          });
        });
      }
      if (c.notes?.length) { ws.addRow([]); c.notes.forEach(n => ws.addRow([`Note: ${n}`])); }
    });

    await auditAction(req, "tax_audit.evidence_pack", "tally_import", null, { checks: checks.length, source });

    const filename = `TallyThis_Tax_Audit_${company.replace(/\s+/g, "_")}_${FY_END}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "evidence_pack_failed" });
  }
});

/** Clear imported Tally data for this company — reverts the cockpit to demo data. */
router.delete("/tax-audit/import", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveCompanyId(req, res);
  if (companyId == null) return;
  await db.delete(tallyVoucherLinesTable).where(eq(tallyVoucherLinesTable.companyId, companyId));
  await db.delete(tallyVouchersTable).where(eq(tallyVouchersTable.companyId, companyId));
  await db.delete(tallyLedgersTable).where(eq(tallyLedgersTable.companyId, companyId));
  await db.delete(tallyBillsTable).where(eq(tallyBillsTable.companyId, companyId));
  await db.delete(ledgerEntriesTable).where(and(
    eq(ledgerEntriesTable.companyId, companyId),
    inArray(ledgerEntriesTable.sourceTool, ["tally_xml_import", "tally_connector"]),
  ));
  await auditAction(req, "tax_audit.import_clear", "tally_import", null, {});
  res.json({ ok: true, source: "demo" });
});

export default router;
