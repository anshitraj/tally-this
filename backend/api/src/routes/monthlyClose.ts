import { resolveBooksCompanyId } from "../services/companyScope";
import { Router, type IRouter, type Request, type Response } from "express";
import { getCompanyId, requirePermission } from "../middleware/authz";
import { buildCurrentWorkflow } from "../services/workflowRecipeService";
import { getRunProgress, suggestRunName, renameRun, type WorkflowRunType } from "../services/workflowRunService";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

async function currentWorkflow(req: Request, res: Response) {
  const companyId = getCompanyId(req);
  res.json(await buildCurrentWorkflow(companyId));
}

router.get("/monthly-close/current/workflow", requirePermission("uploads.read"), currentWorkflow);
router.get("/workflow/current-month", requirePermission("uploads.read"), currentWorkflow);

// ── Workflow runs — real progress polling ────────────────────────────────────

router.get("/workflow/runs", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  // Runs are stored on the books company, so a CA sees the active client's work.
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const runTypeFilter = typeof req.query.runType === "string" ? req.query.runType : null;
  try {
    const result = runTypeFilter
      ? await db.execute(sql`
          SELECT id, company_id, month, year, run_type, title, status,
                 progress_percent, COALESCE(current_step,'') as current_step,
                 created_at, updated_at, completed_at, failed_reason, metadata_json
          FROM workflow_runs
          WHERE company_id = ${companyId} AND run_type = ${runTypeFilter}
          ORDER BY created_at DESC LIMIT 50
        `)
      : await db.execute(sql`
          SELECT id, company_id, month, year, run_type, title, status,
                 progress_percent, COALESCE(current_step,'') as current_step,
                 created_at, updated_at, completed_at, failed_reason, metadata_json
          FROM workflow_runs
          WHERE company_id = ${companyId}
          ORDER BY created_at DESC LIMIT 50
        `);
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

router.get("/workflow/runs/suggest-name", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const runType = (req.query.runType as WorkflowRunType) ?? "bank_tally_reconciliation";
  res.json({ suggestedName: await suggestRunName(companyId, runType) });
});

router.patch("/workflow/runs/:id", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const runId = String(req.params.id);
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!title) {
    res.status(400).json({ error: "title required" });
    return;
  }
  const ok = await renameRun(runId, title);
  res.json({ ok, runId, title });
});

router.get("/workflow/runs/:id/progress", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const runId = String(req.params.id);
  const progress = await getRunProgress(runId, getCompanyId(req));
  if (!progress) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(progress);
});

export default router;
