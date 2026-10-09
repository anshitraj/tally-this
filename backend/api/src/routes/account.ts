/**
 * What the signed-in person's plan includes. The pages use this to show or lock paid features.
 */
import { Router, type IRouter } from "express";
import { requirePermission } from "../middleware/authz";
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

export default router;
