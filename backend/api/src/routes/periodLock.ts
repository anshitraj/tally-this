/**
 * Period locking + partner sign-off.
 * Once a month is locked, writes (new uploads/imports/JEs/recons) are blocked.
 * Sign-off audit-trails who reviewed and approved.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getCompanyId, requirePermission } from "../middleware/authz";

const router: IRouter = Router();

router.get("/periods/locks", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  try {
    const result = await db.execute(sql`
      SELECT id, period_month, period_year, locked, locked_by, locked_at, locked_reason,
             unlocked_by, unlocked_at, unlock_reason
      FROM period_locks WHERE company_id = ${companyId}
      ORDER BY period_year DESC, period_month DESC LIMIT 50`);
    res.json(result.rows);
  } catch { res.json([]); }
});

router.get("/periods/:month/lock-status", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const periodStr = String(req.params.month); // "2026-05"
  const [yr, mo] = periodStr.split("-");
  if (!yr || !mo) { res.status(400).json({ error: "month=YYYY-MM" }); return; }
  try {
    const result = await db.execute(sql`
      SELECT * FROM period_locks WHERE company_id = ${companyId}
        AND period_month = ${mo} AND period_year = ${parseInt(yr, 10)} LIMIT 1`);
    const row = result.rows[0];
    res.json({
      locked: row ? (row as { locked: boolean }).locked : false,
      record: row ?? null,
    });
  } catch { res.json({ locked: false, record: null }); }
});

router.post("/periods/:month/lock", requirePermission("settings.manage_company"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const periodStr = String(req.params.month);
  const [yr, mo] = periodStr.split("-");
  if (!yr || !mo) { res.status(400).json({ error: "month=YYYY-MM" }); return; }
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Monthly close locked by CA";

  try {
    await db.execute(sql`
      INSERT INTO period_locks (company_id, period_month, period_year, locked, locked_by, locked_reason)
      VALUES (${companyId}, ${mo}, ${parseInt(yr, 10)}, true, ${req.auth?.userId ?? null}, ${reason})
      ON CONFLICT (company_id, period_month, period_year) DO UPDATE
        SET locked = true, locked_by = EXCLUDED.locked_by, locked_at = NOW(),
            locked_reason = EXCLUDED.locked_reason, unlocked_at = NULL, unlock_reason = NULL`);
    res.json({ ok: true, period: periodStr, locked: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Lock failed" });
  }
});

router.post("/periods/:month/unlock", requirePermission("settings.manage_company"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const periodStr = String(req.params.month);
  const [yr, mo] = periodStr.split("-");
  if (!yr || !mo) { res.status(400).json({ error: "month=YYYY-MM" }); return; }
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
  if (!reason || reason.length < 5) {
    res.status(400).json({ error: "Unlock requires a reason (audit trail). Min 5 chars." });
    return;
  }

  await db.execute(sql`
    UPDATE period_locks SET locked = false, unlocked_by = ${req.auth?.userId ?? null},
                            unlocked_at = NOW(), unlock_reason = ${reason}
    WHERE company_id = ${companyId} AND period_month = ${mo} AND period_year = ${parseInt(yr, 10)}`);
  res.json({ ok: true, period: periodStr, locked: false });
});

// ── Sign-off endpoints (run-level partner review)
router.post("/workflow/runs/:id/signoff", requirePermission("ca_review.process"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const runId = String(req.params.id);
  const note = typeof req.body?.note === "string" ? req.body.note : null;
  const role = typeof req.body?.role === "string" ? req.body.role : "reviewer";

  try {
    await db.execute(sql`
      INSERT INTO run_signoffs (run_id, company_id, signed_by, signed_role, signature_note, signed_at)
      VALUES (${runId}, ${companyId}, ${req.auth?.userId ?? 0}, ${role}, ${note}, NOW())`);
    res.json({ ok: true, runId, signedBy: req.auth?.email, role });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Sign-off failed" });
  }
});

router.get("/workflow/runs/:id/signoffs", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const runId = String(req.params.id);
  try {
    const result = await db.execute(sql`
      SELECT s.id, s.signed_role, s.signature_note, s.signed_at, u.email AS signed_by_email, u.name AS signed_by_name
      FROM run_signoffs s LEFT JOIN users u ON u.id = s.signed_by
      WHERE s.run_id = ${runId} ORDER BY s.signed_at DESC`);
    res.json(result.rows);
  } catch { res.json([]); }
});

export default router;
