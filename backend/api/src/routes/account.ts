/**
 * What the signed-in person's plan includes. The pages use this to show or lock paid features.
 */
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, auditLogsTable, companiesTable, usersTable } from "@workspace/db";
import { requireAuth, requirePermission } from "../middleware/authz";
import { planFor } from "../services/privacy";
import { historyMonths, planIsActive, privacyAvailable } from "../services/privacyPolicy";
import { supportEmail } from "../lib/brand";

const router: IRouter = Router();

router.get("/account/plan", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const info = await planFor(req.auth!.companyId);
  res.json({
    ok: true,
    plan: planIsActive(info) ? info.plan : "free",
    planUntil: info.until ? info.until.toISOString() : null,
    privacyAvailable: privacyAvailable(info),
    historyMonths: historyMonths(),
    supportEmail: supportEmail(),
  });
});

/** Name and firm, asked right after a new account is made (email or Google/GitHub). */
router.post("/account/profile", requireAuth, async (req, res): Promise<void> => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
  const companyName = typeof req.body?.companyName === "string" ? req.body.companyName.trim().slice(0, 160) : "";
  if (!name) {
    res.status(400).json({ ok: false, error: "Enter your name." });
    return;
  }
  const auth = req.auth!;
  // Only the person who owns the workspace may rename it.
  if (companyName && !["founder", "admin"].includes(auth.role)) {
    res.status(403).json({ ok: false, error: "Only the workspace owner can change the firm name." });
    return;
  }
  await db.update(usersTable).set({ name }).where(eq(usersTable.id, auth.userId));
  if (companyName) await db.update(companiesTable).set({ name: companyName }).where(eq(companiesTable.id, auth.companyId));
  await db.insert(auditLogsTable).values({
    companyId: auth.companyId,
    userId: auth.userId,
    actorEmail: auth.email,
    action: "account.profile_updated",
    entityType: "user",
    entityId: auth.userId,
    metadata: { companyRenamed: Boolean(companyName) },
    ipAddress: req.ip,
  });
  res.json({ ok: true, name, companyName: companyName || null });
});

export default router;
