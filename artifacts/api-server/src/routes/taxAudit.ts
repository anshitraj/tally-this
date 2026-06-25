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
import { db, tallyLedgersTable, tallyVouchersTable, tallyVoucherLinesTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { getCompanyId, requirePermission, auditAction } from "../middleware/authz";
import {
  buildChecks, FY_END,
  DEMO_LEDGERS, DEMO_VOUCHERS, DEMO_ASSETS,
  type Ledger, type Voucher, type VoucherLine, type VoucherType, type AssetRow,
} from "../services/taxAuditEngine";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const PYTHON_WORKER_URL = process.env.PYTHON_WORKER_URL ?? "http://localhost:8091";

interface NormalizedLedger { name: string; group: string; opening_balance: number; closing_balance: number; prev_year_closing: number | null; prev_year_group: string | null; is_msme: boolean; msme_type: string | null; pan: string | null }
interface NormalizedVoucher { date: string; type: string; number: string; party: string | null; narration: string | null; amount: number; mode: string | null }
interface NormalizedLine { voucher_number: string; ledger: string; group: string; debit: number; credit: number }
interface TallyParseResult { ok: boolean; warnings?: string[]; errors?: string[]; ledgers: NormalizedLedger[]; vouchers: NormalizedVoucher[]; voucher_lines: NormalizedLine[]; counts?: Record<string, number> }

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadData(companyId: number): Promise<{ ledgers: Ledger[]; vouchers: Voucher[]; assets: AssetRow[]; source: "tally" | "demo" }> {
  try {
    const led = await db.execute(sql`SELECT name, "group", opening_balance, closing_balance, prev_year_closing, prev_year_group, is_msme, msme_type, pan FROM tally_ledgers WHERE company_id = ${companyId}`);
    if (led.rows && led.rows.length > 0) {
      const vch = await db.execute(sql`SELECT date, type, number, party, narration, amount, mode FROM tally_vouchers WHERE company_id = ${companyId} ORDER BY date`);
      const lines = await db.execute(sql`SELECT voucher_number, ledger, "group", debit, credit FROM tally_voucher_lines WHERE company_id = ${companyId}`);
      const linesByVoucher = new Map<string, VoucherLine[]>();
      for (const l of lines.rows as Record<string, unknown>[]) {
        const key = String(l.voucher_number);
        const arr = linesByVoucher.get(key) ?? [];
        arr.push({ ledger: String(l.ledger), group: String(l.group), debit: Number(l.debit), credit: Number(l.credit) });
        linesByVoucher.set(key, arr);
      }
      const ledgers: Ledger[] = (led.rows as Record<string, unknown>[]).map(r => ({
        name: String(r.name), group: String(r.group),
        openingBalance: Number(r.opening_balance), closingBalance: Number(r.closing_balance),
        prevYearClosing: r.prev_year_closing != null ? Number(r.prev_year_closing) : undefined,
        prevYearGroup: r.prev_year_group != null ? String(r.prev_year_group) : undefined,
        isMsme: Boolean(r.is_msme), msmeType: (r.msme_type as Ledger["msmeType"]) ?? null, pan: (r.pan as string) ?? null,
      }));
      const vouchers: Voucher[] = (vch.rows as Record<string, unknown>[]).map(r => ({
        date: String(r.date), type: r.type as VoucherType, number: String(r.number),
        party: r.party ? String(r.party) : undefined, narration: r.narration ? String(r.narration) : undefined,
        amount: Number(r.amount), mode: (r.mode as Voucher["mode"]) ?? undefined,
        lines: linesByVoucher.get(String(r.number)) ?? [],
      }));
      let assets = DEMO_ASSETS;
      try {
        const a = await db.execute(sql`SELECT name, block, rate, opening_wdv, additions, addition_date, deletions, deletion_date, depreciation, closing_wdv FROM tally_fixed_assets WHERE company_id = ${companyId}`);
        if (a.rows && a.rows.length > 0) {
          assets = (a.rows as Record<string, unknown>[]).map(r => ({
            name: String(r.name), block: String(r.block), rate: Number(r.rate),
            openingWdv: Number(r.opening_wdv), additions: Number(r.additions), additionDate: r.addition_date ? String(r.addition_date) : undefined,
            deletions: Number(r.deletions), deletionDate: r.deletion_date ? String(r.deletion_date) : undefined,
            depreciation: Number(r.depreciation), closingWdv: Number(r.closing_wdv),
          }));
        }
      } catch { /* assets table optional */ }
      return { ledgers, vouchers, assets, source: "tally" };
    }
  } catch { /* tables missing — fall through to demo */ }
  return { ledgers: DEMO_LEDGERS, vouchers: DEMO_VOUCHERS, assets: DEMO_ASSETS, source: "demo" };
}

router.get("/tax-audit", requirePermission("reports.read"), async (req, res): Promise<void> => {
  try {
    const companyId = getCompanyId(req);
    const { ledgers, vouchers, assets, source } = await loadData(companyId);
    const checks = buildChecks(ledgers, vouchers, assets);
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
    const companyId = getCompanyId(req);
    const { ledgers, vouchers, assets, source } = await loadData(companyId);
    const checks = buildChecks(ledgers, vouchers, assets);
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
  const companyId = getCompanyId(req);
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

  // 2. Replace existing rows for this company
  await db.delete(tallyVoucherLinesTable).where(eq(tallyVoucherLinesTable.companyId, companyId));
  await db.delete(tallyVouchersTable).where(eq(tallyVouchersTable.companyId, companyId));
  await db.delete(tallyLedgersTable).where(eq(tallyLedgersTable.companyId, companyId));

  // 3. Insert normalized data (chunked to stay under Postgres param limits)
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

  await auditAction(req, "tax_audit.import", "tally_import", null, {
    fileName: file.originalname, ...parsed.counts,
  });

  res.json({ ok: true, source: "tally", counts: parsed.counts ?? { ledgers: parsed.ledgers.length, vouchers: parsed.vouchers.length, voucher_lines: parsed.voucher_lines.length }, warnings: parsed.warnings });
});

/** Clear imported Tally data for this company — reverts the cockpit to demo data. */
router.delete("/tax-audit/import", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  await db.delete(tallyVoucherLinesTable).where(eq(tallyVoucherLinesTable.companyId, companyId));
  await db.delete(tallyVouchersTable).where(eq(tallyVouchersTable.companyId, companyId));
  await db.delete(tallyLedgersTable).where(eq(tallyLedgersTable.companyId, companyId));
  await auditAction(req, "tax_audit.import_clear", "tally_import", null, {});
  res.json({ ok: true, source: "demo" });
});

export default router;
