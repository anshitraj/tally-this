/**
 * WorkflowRunService — creates and updates rows in the `workflow_runs` table.
 * Every major CA command (upload, import, reconcile, report) should create or
 * attach to a run. Runs give the frontend real progress to poll against.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type WorkflowRunType =
  | "upload_parse"
  | "import_records"
  | "bank_to_tally"
  | "ecommerce_gst"
  | "bank_tally_reconciliation"
  | "bank_invoice_reconciliation"
  | "bank_gateway_reconciliation"
  | "bank_payroll_reconciliation"
  | "gst_tds_review"
  | "invoice_ai_extraction"
  | "full_month_close"
  | "report_export";

export type WorkflowRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface RunStep {
  label: string;
  status: "pending" | "running" | "done" | "failed";
  percent: number;
}

const DEFAULT_STEPS: Record<WorkflowRunType, RunStep[]> = {
  upload_parse: [
    { label: "Uploading file", status: "pending", percent: 10 },
    { label: "Checking file type", status: "pending", percent: 20 },
    { label: "Saving metadata", status: "pending", percent: 30 },
    { label: "Detecting rows and columns", status: "pending", percent: 60 },
    { label: "Preparing summary", status: "pending", percent: 90 },
    { label: "Completed", status: "pending", percent: 100 },
  ],
  bank_to_tally: [
    { label: "Reading bank statement", status: "pending", percent: 15 },
    { label: "Normalizing transactions", status: "pending", percent: 45 },
    { label: "Checking totals", status: "pending", percent: 70 },
    { label: "Preparing Tally export", status: "pending", percent: 90 },
    { label: "Completed", status: "pending", percent: 100 },
  ],
  ecommerce_gst: [
    { label: "Reading marketplace file", status: "pending", percent: 20 },
    { label: "Normalizing sales", status: "pending", percent: 55 },
    { label: "Building GSTR-1 draft tabs", status: "pending", percent: 80 },
    { label: "Completed", status: "pending", percent: 100 },
  ],
  import_records: [
    { label: "Reading parsed records", status: "pending", percent: 10 },
    { label: "Mapping columns", status: "pending", percent: 30 },
    { label: "Creating records", status: "pending", percent: 60 },
    { label: "Saving evidence", status: "pending", percent: 80 },
    { label: "Updating action history", status: "pending", percent: 95 },
    { label: "Completed", status: "pending", percent: 100 },
  ],
  bank_tally_reconciliation: [
    { label: "Checking available sources", status: "pending", percent: 10 },
    { label: "Comparing amounts", status: "pending", percent: 30 },
    { label: "Matching dates", status: "pending", percent: 50 },
    { label: "Checking references", status: "pending", percent: 70 },
    { label: "Creating suggested matches", status: "pending", percent: 85 },
    { label: "Saving report", status: "pending", percent: 95 },
    { label: "Completed", status: "pending", percent: 100 },
  ],
  bank_invoice_reconciliation: [
    { label: "Checking available sources", status: "pending", percent: 10 },
    { label: "Comparing amounts", status: "pending", percent: 30 },
    { label: "Matching dates", status: "pending", percent: 50 },
    { label: "Checking references", status: "pending", percent: 70 },
    { label: "Creating suggested matches", status: "pending", percent: 85 },
    { label: "Saving report", status: "pending", percent: 95 },
    { label: "Completed", status: "pending", percent: 100 },
  ],
  bank_gateway_reconciliation: [
    { label: "Checking available sources", status: "pending", percent: 10 },
    { label: "Comparing settlement amounts", status: "pending", percent: 35 },
    { label: "Matching bank references", status: "pending", percent: 65 },
    { label: "Saving report", status: "pending", percent: 90 },
    { label: "Completed", status: "pending", percent: 100 },
  ],
  bank_payroll_reconciliation: [
    { label: "Checking available sources", status: "pending", percent: 10 },
    { label: "Matching payroll entries", status: "pending", percent: 50 },
    { label: "Saving report", status: "pending", percent: 90 },
    { label: "Completed", status: "pending", percent: 100 },
  ],
  gst_tds_review: [
    { label: "Loading GST/TDS records", status: "pending", percent: 20 },
    { label: "Generating risk flags", status: "pending", percent: 60 },
    { label: "Saving review pack", status: "pending", percent: 90 },
    { label: "Completed", status: "pending", percent: 100 },
  ],
  invoice_ai_extraction: [
    { label: "Reading invoice text", status: "pending", percent: 15 },
    { label: "Extracting invoice fields", status: "pending", percent: 50 },
    { label: "Validating structured output", status: "pending", percent: 75 },
    { label: "Saving as pending review", status: "pending", percent: 95 },
    { label: "Completed", status: "pending", percent: 100 },
  ],
  full_month_close: [
    { label: "Importing available sources", status: "pending", percent: 15 },
    { label: "Running reconciliation", status: "pending", percent: 45 },
    { label: "Generating risk flags", status: "pending", percent: 65 },
    { label: "Checking CA review items", status: "pending", percent: 80 },
    { label: "Building CA-ready pack", status: "pending", percent: 95 },
    { label: "Completed", status: "pending", percent: 100 },
  ],
  report_export: [
    { label: "Collecting reviewed items", status: "pending", percent: 20 },
    { label: "Preparing CA attention summary", status: "pending", percent: 50 },
    { label: "Building exports", status: "pending", percent: 75 },
    { label: "Saving report", status: "pending", percent: 95 },
    { label: "Completed", status: "pending", percent: 100 },
  ],
};

function runTitle(runType: WorkflowRunType, meta?: Record<string, string>): string {
  const labels: Record<WorkflowRunType, string> = {
    upload_parse: `Upload & parse${meta?.fileName ? ` — ${meta.fileName}` : ""}`,
    bank_to_tally: "Bank Statement → Tally",
    ecommerce_gst: "E-commerce GST",
    import_records: "Import records",
    bank_tally_reconciliation: "Bank + Tally reconciliation",
    bank_invoice_reconciliation: "Bank + Invoice reconciliation",
    bank_gateway_reconciliation: "Gateway settlement matching",
    bank_payroll_reconciliation: "Payroll matching",
    gst_tds_review: "GST/TDS review pack",
    invoice_ai_extraction: "Invoice AI extraction",
    full_month_close: "Full month close",
    report_export: "CA-ready report export",
  };
  return labels[runType] ?? runType;
}

/**
 * Create a new workflow run. Returns run id.
 */
export async function createWorkflowRun(input: {
  companyId: number;
  runType: WorkflowRunType;
  month?: string;
  year?: number;
  createdBy?: number | null;
  clientId?: number | null;
  meta?: Record<string, string>;
}): Promise<string> {
  const steps = DEFAULT_STEPS[input.runType] ?? [];
  const now = new Date();
  const month = input.month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const year = input.year ?? now.getFullYear();

  // Auto-suggest title with sequence: "{recipe} #N"
  let title = input.meta?.customTitle ?? runTitle(input.runType, input.meta);
  if (!input.meta?.customTitle) {
    try {
      const count = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM workflow_runs
        WHERE company_id = ${input.companyId} AND run_type = ${input.runType}
      `);
      const n = (count.rows[0] as { n: number })?.n ?? 0;
      title = `${runTitle(input.runType, input.meta)} #${n + 1}`;
    } catch { /* table absent — keep default */ }
  }

  try {
    const result = await db.execute(sql`
      INSERT INTO workflow_runs (company_id, client_id, month, year, run_type, title, status, progress_percent, current_step, steps_json, created_by, created_at, updated_at)
      VALUES (
        ${input.companyId}, ${input.clientId ?? input.companyId}, ${month}, ${year}, ${input.runType},
        ${title},
        'running', 0,
        ${steps[0]?.label ?? "Starting"},
        ${JSON.stringify(steps)}::jsonb,
        ${input.createdBy ?? null},
        NOW(), NOW()
      )
      RETURNING id
    `);
    const id = (result.rows[0] as { id: string }).id;
    return id;
  } catch {
    return `local-${Date.now()}`;
  }
}

/**
 * Suggest a default name for the next run of a given type.
 * "{recipe} #N" where N is the next sequence number for this company+type.
 */
export async function suggestRunName(companyId: number, runType: WorkflowRunType): Promise<string> {
  try {
    const count = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM workflow_runs
      WHERE company_id = ${companyId} AND run_type = ${runType}
    `);
    const n = (count.rows[0] as { n: number })?.n ?? 0;
    return `${runTitle(runType)} #${n + 1}`;
  } catch {
    return runTitle(runType);
  }
}

/**
 * Rename an existing run.
 */
export async function renameRun(runId: string, title: string): Promise<boolean> {
  if (runId.startsWith("local-")) return false;
  try {
    await db.execute(sql`UPDATE workflow_runs SET title = ${title}, updated_at = NOW() WHERE id = ${runId}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Advance run to a given step index. Marks step as done, sets next as running.
 */
export async function advanceRun(runId: string, stepIndex: number): Promise<void> {
  if (runId.startsWith("local-")) return;
  try {
    await db.execute(sql`
      UPDATE workflow_runs
      SET
        progress_percent = (steps_json->${stepIndex}->>'percent')::int,
        current_step = COALESCE(steps_json->${stepIndex + 1}->>'label', steps_json->${stepIndex}->>'label'),
        updated_at = NOW()
      WHERE id = ${runId}
    `);
  } catch { /* non-fatal */ }
}

/**
 * Mark run complete or failed.
 */
export async function finishRun(runId: string, status: "completed" | "failed", failedReason?: string): Promise<void> {
  if (runId.startsWith("local-")) return;
  try {
    await db.execute(sql`
      UPDATE workflow_runs
      SET
        status = ${status},
        progress_percent = ${status === "completed" ? 100 : 0},
        current_step = ${status === "completed" ? "Completed" : "Failed"},
        completed_at = NOW(),
        failed_reason = ${failedReason ?? null},
        updated_at = NOW()
      WHERE id = ${runId}
    `);
  } catch { /* non-fatal */ }
}

/**
 * Save a run artifact (report, import summary, etc.) under a run.
 */
export async function saveRunArtifact(runId: string, input: {
  artifactType: string;
  title: string;
  storageKey?: string | null;
  jsonData?: unknown;
  companyId?: number;
}): Promise<boolean> {
  if (runId.startsWith("local-")) return false;
  try {
    if (input.companyId != null) {
      const owned = await db.execute(sql`
        SELECT 1 FROM workflow_runs WHERE id = ${runId} AND company_id = ${input.companyId} LIMIT 1
      `);
      if (!owned.rows?.length) return false;
    }
    await db.execute(sql`
      INSERT INTO run_artifacts (run_id, artifact_type, title, storage_key, json_data, created_at)
      VALUES (${runId}, ${input.artifactType}, ${input.title}, ${input.storageKey ?? null}, ${JSON.stringify(input.jsonData ?? {})}::jsonb, NOW())
    `);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get run progress for polling.
 */
export async function getRunProgress(runId: string, companyId?: number): Promise<{
  runId: string;
  status: string;
  progressPercent: number;
  currentStep: string;
  steps: RunStep[];
  resultLink?: string | null;
  error?: string | null;
} | null> {
  if (runId.startsWith("local-")) return null;
  try {
    const result = companyId == null
      ? await db.execute(sql`
      SELECT id, status, progress_percent, COALESCE(current_step, '') as current_step, steps_json, failed_reason
      FROM workflow_runs WHERE id = ${runId} LIMIT 1
    `)
      : await db.execute(sql`
      SELECT id, status, progress_percent, COALESCE(current_step, '') as current_step, steps_json, failed_reason
      FROM workflow_runs WHERE id = ${runId} AND company_id = ${companyId} LIMIT 1
    `);
    const row = result.rows[0] as {
      id: string; status: string; progress_percent: number; current_step: string; steps_json: unknown; failed_reason?: string | null;
    } | undefined;
    if (!row) return null;
    return {
      runId: row.id,
      status: row.status,
      progressPercent: row.progress_percent,
      currentStep: row.current_step,
      steps: Array.isArray(row.steps_json) ? row.steps_json as RunStep[] : [],
      resultLink: null,
      error: row.failed_reason ?? null,
    };
  } catch {
    return null;
  }
}
