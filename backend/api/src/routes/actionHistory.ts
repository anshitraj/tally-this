import { Router, type IRouter } from "express";
import { getCompanyId, requirePermission } from "../middleware/authz";
import { getActionHistory } from "../services/workflowRecipeService";

const router: IRouter = Router();

router.get("/action-history", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const limit = Math.min(Number(req.query.limit ?? 30) || 30, 100);
  res.json(await getActionHistory(getCompanyId(req), limit));
});

export default router;
