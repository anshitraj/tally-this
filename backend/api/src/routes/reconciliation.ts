import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  aiExtractionsTable,
  bankTransactionsTable,
  caReviewItemsTable,
  db,
  gatewaySettlementsTable,
  gstRecordsTable,
  invoicesTable,
  ledgerEntriesTable,
  payrollEntriesTable,
  reconciliationMatchesTable,
} from "@workspace/db";
import {
  ApproveMatchResponse,
  GetReconciliationMatchesResponse,
  RejectMatchResponse,
  RunReconciliationResponse,
} from "@workspace/api-zod";
import { auditAction, getCompanyId, requirePermission } from "../middleware/authz";
import { runAndPersistReconciliation } from "../services/reconciliationRunner";

import { attachBooksCompany } from "../services/companyScope";

const router: IRouter = Router();
router.use(attachBooksCompany);

const mapMatch = (
  m: typeof reconciliationMatchesTable.$inferSelect,
  txn?: typeof bankTransactionsTable.$inferSelect | null,
  inv?: typeof invoicesTable.$inferSelect | null,
) => ({
  id: m.id,
  bankTransactionId: m.bankTransactionId ?? null,
  invoiceId: m.invoiceId ?? null,
  ledgerEntryId: m.ledgerEntryId ?? null,
  matchType: m.matchType,
  confidenceScore: m.confidenceScore,
  reason: m.reason,
  status: m.status,
  createdAt: m.createdAt.toISOString(),
  bankTransaction: txn ? {
    id: txn.id,
    date: txn.date,
    narration: txn.narration,
    amount: parseFloat(txn.amount as string),
    type: txn.type,
    source: txn.source,
    bankName: txn.bankName ?? null,
    reference: txn.reference ?? null,
    status: txn.status,
    confidenceScore: txn.confidenceScore,
    matchedInvoiceId: txn.matchedInvoiceId ?? null,
    note: txn.note ?? null,
  } : undefined,
  invoice: inv ? {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    vendorName: inv.vendorName,
    customerName: inv.customerName ?? null,
    gstin: inv.gstin ?? null,
    date: inv.date,
    amount: parseFloat(inv.amount as string),
    gstAmount: inv.gstAmount ? parseFloat(inv.gstAmount as string) : null,
    type: inv.type,
    paymentStatus: inv.paymentStatus,
    status: inv.status,
    linkedTransactionId: inv.linkedTransactionId ?? null,
  } : undefined,
});

router.get("/reconciliation", requirePermission("reconciliation.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const matches = await db.select().from(reconciliationMatchesTable)
    .where(eq(reconciliationMatchesTable.companyId, companyId))
    .orderBy(desc(reconciliationMatchesTable.createdAt));
  const txns = await db.select().from(bankTransactionsTable).where(eq(bankTransactionsTable.companyId, companyId));
  const invoices = await db.select().from(invoicesTable).where(eq(invoicesTable.companyId, companyId));
  const txnMap = Object.fromEntries(txns.map(t => [t.id, t]));
  const invMap = Object.fromEntries(invoices.map(i => [i.id, i]));

  let filtered = matches;
  const { status, runId } = req.query as { status?: string; runId?: string };
  if (status) filtered = filtered.filter(m => m.status === status);
  if (runId) {
    // Filter matches whose bankTransaction OR invoice OR ledger belongs to this run's uploads
    const runUploadsRes = await db.execute(sql`
      SELECT rs.upload_id
      FROM run_sources rs
      JOIN workflow_runs wr ON wr.id = rs.run_id
      WHERE rs.run_id = ${runId} AND wr.company_id = ${companyId}
    `);
    const runUploadIds = new Set<number>(
      (runUploadsRes.rows as { upload_id: number | null }[])
        .map(r => r.upload_id).filter((v): v is number => typeof v === "number"),
    );
    if (runUploadIds.size > 0) {
      const txnInRun = new Set(txns.filter(t => t.sourceUploadId && runUploadIds.has(t.sourceUploadId)).map(t => t.id));
      const invInRun = new Set(invoices.filter(i => i.sourceUploadId && runUploadIds.has(i.sourceUploadId)).map(i => i.id));
      filtered = filtered.filter(m =>
        (m.bankTransactionId && txnInRun.has(m.bankTransactionId)) ||
        (m.invoiceId && invInRun.has(m.invoiceId))
      );
    } else {
      filtered = [];
    }
  }

  res.json(GetReconciliationMatchesResponse.parse(
    filtered.map(m => mapMatch(
      m,
      m.bankTransactionId ? txnMap[m.bankTransactionId] : null,
      m.invoiceId ? invMap[m.invoiceId] : null,
    )),
  ));
});

async function runReconciliation(req: Request, res: Response): Promise<void> {
  const companyId = getCompanyId(req);
  const recipeId = typeof req.body?.recipeId === "string" ? req.body.recipeId : null;
  const customTitle = typeof req.body?.reportName === "string" ? req.body.reportName.trim() : null;

  const runTypeMap: Record<string, import("../services/workflowRunService").WorkflowRunType> = {
    BANK_TALLY_RECONCILIATION: "bank_tally_reconciliation",
    BANK_INVOICE_RECONCILIATION: "bank_invoice_reconciliation",
    BANK_GATEWAY_RECONCILIATION: "bank_gateway_reconciliation",
    BANK_PAYROLL_RECONCILIATION: "bank_payroll_reconciliation",
    GST_TDS_REVIEW: "gst_tds_review",
    FULL_MONTH_CLOSE: "full_month_close",
  };
  const { createWorkflowRun, finishRun, saveRunArtifact } = await import("../services/workflowRunService");
  const runType = runTypeMap[recipeId ?? ""] ?? "bank_tally_reconciliation";
  const runId = await createWorkflowRun({
    companyId,
    runType,
    createdBy: req.auth?.userId ?? null,
    meta: customTitle ? { customTitle } : undefined,
  });

  const result = await runAndPersistReconciliation(companyId, runId);

  const message = recipeId === "BANK_TALLY_RECONCILIATION"
    ? `Ledger reconciliation report saved. Found ${result.matchesFound} new rule-based matches.`
    : `Reconciliation complete. Found ${result.matchesFound} new rule-based matches.`;

  await saveRunArtifact(runId, {
    artifactType: "reconciliation_report",
    title: message,
    jsonData: { ...result, recipeId },
    companyId,
  });
  await finishRun(runId, "completed");
  await auditAction(req, "reconciliation.run", "reconciliation", null, { matchesFound: result.matchesFound, recipeId, runId });

  res.json(RunReconciliationResponse.parse({ ...result, message, runId }));
}

async function approveMatch(req: Request, res: Response): Promise<void> {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [m] = await db.update(reconciliationMatchesTable)
    .set({ status: "approved" })
    .where(and(eq(reconciliationMatchesTable.id, id), eq(reconciliationMatchesTable.companyId, getCompanyId(req))))
    .returning();

  if (!m) {
    res.status(404).json({ error: "Match not found" });
    return;
  }

  if (m.bankTransactionId) {
    await db.update(bankTransactionsTable)
      .set({ status: "verified" })
      .where(and(eq(bankTransactionsTable.id, m.bankTransactionId), eq(bankTransactionsTable.companyId, getCompanyId(req))));
  }

  await auditAction(req, "reconciliation.approved", "reconciliation", m.id);
  res.json(ApproveMatchResponse.parse(mapMatch(m)));
}

async function needsInfoMatch(req: Request, res: Response): Promise<void> {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [m] = await db.update(reconciliationMatchesTable)
    .set({ status: "needs_info" })
    .where(and(eq(reconciliationMatchesTable.id, id), eq(reconciliationMatchesTable.companyId, getCompanyId(req))))
    .returning();

  if (!m) {
    res.status(404).json({ error: "Match not found" });
    return;
  }

  await auditAction(req, "reconciliation.needs_info", "reconciliation", m.id, {
    note: typeof req.body?.note === "string" ? req.body.note : undefined,
  });
  res.json(ApproveMatchResponse.parse(mapMatch(m)));
}

async function rejectMatch(req: Request, res: Response): Promise<void> {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [m] = await db.update(reconciliationMatchesTable)
    .set({ status: "rejected" })
    .where(and(eq(reconciliationMatchesTable.id, id), eq(reconciliationMatchesTable.companyId, getCompanyId(req))))
    .returning();

  if (!m) {
    res.status(404).json({ error: "Match not found" });
    return;
  }

  await auditAction(req, "reconciliation.rejected", "reconciliation", m.id);
  res.json(RejectMatchResponse.parse(mapMatch(m)));
}

router.post("/reconciliation/preflight", requirePermission("reconciliation.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const recipeId = String(req.body?.recipeId ?? "FULL_MONTH_CLOSE");
  const [txns, invoices, ledger, payroll, gateway, gst, pending] = await Promise.all([
    db.select({ id: bankTransactionsTable.id }).from(bankTransactionsTable).where(eq(bankTransactionsTable.companyId, companyId)),
    db.select({ id: invoicesTable.id, status: invoicesTable.status }).from(invoicesTable).where(eq(invoicesTable.companyId, companyId)),
    db.select({ id: ledgerEntriesTable.id }).from(ledgerEntriesTable).where(eq(ledgerEntriesTable.companyId, companyId)),
    db.select({ id: payrollEntriesTable.id }).from(payrollEntriesTable).where(eq(payrollEntriesTable.companyId, companyId)),
    db.select({ id: gatewaySettlementsTable.id }).from(gatewaySettlementsTable).where(eq(gatewaySettlementsTable.companyId, companyId)),
    db.select({ id: gstRecordsTable.id }).from(gstRecordsTable).where(eq(gstRecordsTable.companyId, companyId)),
    db.select({ id: aiExtractionsTable.id }).from(aiExtractionsTable).where(and(eq(aiExtractionsTable.companyId, companyId), eq(aiExtractionsTable.status, "extracted_pending_review"))),
  ]);

  const acceptedInvoices = invoices.filter(i => i.status === "pending_reconciliation").length;
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (recipeId === "GST_TDS_REVIEW") {
    if (gst.length === 0) blockers.push("No GST/TDS records imported. Import GST/TDS data first.");
  } else if (recipeId === "BANK_TALLY_RECONCILIATION") {
    if (txns.length === 0) blockers.push("No bank transactions imported. Upload and import a bank statement first.");
    if (ledger.length === 0) blockers.push("No ledger entries imported. Upload and import a Tally or Zoho export first.");
  } else if (recipeId === "BANK_INVOICE_RECONCILIATION") {
    if (txns.length === 0) blockers.push("No bank transactions imported. Upload and import a bank statement first.");
    if (acceptedInvoices === 0) blockers.push("No accepted invoice records found. Import invoices or accept AI extracted invoice results first.");
  } else if (recipeId === "BANK_GATEWAY_RECONCILIATION") {
    if (txns.length === 0) blockers.push("No bank transactions imported. Upload and import a bank statement first.");
    if (gateway.length === 0) blockers.push("No gateway settlements imported. Upload and import a gateway settlement export first.");
  } else if (recipeId === "BANK_PAYROLL_RECONCILIATION") {
    if (txns.length === 0) blockers.push("No bank transactions imported. Upload and import a bank statement first.");
    if (payroll.length === 0) blockers.push("No payroll entries imported. Upload and import payroll records first.");
  } else {
    if (txns.length === 0) blockers.push("No bank transactions imported. Upload and import a bank statement first.");
    if (invoices.length === 0 && ledger.length === 0) blockers.push("No invoices or ledger entries found. Import invoice or Tally/Zoho files first.");
  }

  if (pending.length > 0) warnings.push(`${pending.length} invoice extraction${pending.length > 1 ? "s" : ""} are pending review. Consider reviewing before reconciliation.`);
  if (recipeId === "FULL_MONTH_CLOSE" && gst.length === 0) warnings.push("No GST/TDS records imported. GST/TDS review will be skipped.");
  if (recipeId === "FULL_MONTH_CLOSE" && payroll.length === 0) warnings.push("No payroll entries imported. Payroll matching will be skipped.");
  if (recipeId === "FULL_MONTH_CLOSE" && gateway.length === 0) warnings.push("No gateway settlements imported. Gateway matching will be skipped.");

  const optionAllowed = (ids: string[]) => ids.includes(recipeId);
  res.json({
    canRun: blockers.length === 0,
    blockers,
    warnings,
    availableSources: {
      bankTransactions: txns.length,
      acceptedInvoices,
      pendingInvoiceExtractions: pending.length,
      ledgerEntries: ledger.length,
      payrollEntries: payroll.length,
      gatewaySettlements: gateway.length,
      gstRecords: gst.length,
    },
    matchingOptions: [
      { id: "bank_to_invoices", label: "Bank transactions to invoices", enabled: txns.length > 0 && invoices.length > 0 && optionAllowed(["BANK_INVOICE_RECONCILIATION", "FULL_MONTH_CLOSE"]), defaultChecked: optionAllowed(["BANK_INVOICE_RECONCILIATION", "FULL_MONTH_CLOSE"]) },
      { id: "bank_to_ledger", label: "Bank transactions to ledger entries", enabled: txns.length > 0 && ledger.length > 0 && optionAllowed(["BANK_TALLY_RECONCILIATION", "FULL_MONTH_CLOSE"]), defaultChecked: optionAllowed(["BANK_TALLY_RECONCILIATION", "FULL_MONTH_CLOSE"]) },
      { id: "bank_to_payroll", label: "Bank transactions to payroll", enabled: txns.length > 0 && payroll.length > 0 && optionAllowed(["BANK_PAYROLL_RECONCILIATION", "FULL_MONTH_CLOSE"]), defaultChecked: recipeId === "BANK_PAYROLL_RECONCILIATION" },
      { id: "bank_to_gateway", label: "Bank credits to gateway settlements", enabled: txns.length > 0 && gateway.length > 0 && optionAllowed(["BANK_GATEWAY_RECONCILIATION", "FULL_MONTH_CLOSE"]), defaultChecked: recipeId === "BANK_GATEWAY_RECONCILIATION" },
      { id: "duplicates", label: "Duplicate invoice detection", enabled: invoices.length > 0, defaultChecked: true },
      { id: "missing_documents", label: "Missing document detection", enabled: txns.length > 0, defaultChecked: true },
    ],
    estimatedOutputPage: recipeId === "BANK_TALLY_RECONCILIATION"
      ? "/app/ledger-match"
      : recipeId === "BANK_GATEWAY_RECONCILIATION"
        ? "/app/gateway-settlements"
        : recipeId === "BANK_PAYROLL_RECONCILIATION"
          ? "/app/payroll"
          : "/app/reconciliation",
  });
});

// GET /reconciliation/runs — list all reconciliation run folders with match counts
router.get("/reconciliation/runs", requirePermission("reconciliation.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);

  // Fetch all workflow runs that are reconciliation types
  const reconciliationRunTypes = [
    "bank_tally_reconciliation", "bank_invoice_reconciliation",
    "bank_gateway_reconciliation", "bank_payroll_reconciliation",
    "gst_tds_review", "full_month_close",
  ];

  const runsRes = await db.execute(sql`
    SELECT id, title, run_type, status, created_at, completed_at
    FROM workflow_runs
    WHERE company_id = ${companyId}
      AND run_type = ANY(ARRAY[${sql.raw(reconciliationRunTypes.map(t => `'${t}'`).join(","))}])
    ORDER BY created_at DESC
    LIMIT 50
  `);
  const runs = runsRes.rows as { id: string; title: string | null; run_type: string; status: string; created_at: string; completed_at: string | null }[];

  if (runs.length === 0) {
    res.json([]);
    return;
  }

  // For each run compute matchCount by looking at run_sources → upload_ids → transactions/invoices → matches
  const allTxns = await db.select({ id: bankTransactionsTable.id, uploadId: bankTransactionsTable.sourceUploadId })
    .from(bankTransactionsTable).where(eq(bankTransactionsTable.companyId, companyId));
  const allInvoices = await db.select({ id: invoicesTable.id, uploadId: invoicesTable.sourceUploadId })
    .from(invoicesTable).where(eq(invoicesTable.companyId, companyId));
  const allMatches = await db.select()
    .from(reconciliationMatchesTable).where(eq(reconciliationMatchesTable.companyId, companyId));

  const txnByUpload = new Map<number, Set<number>>();
  for (const t of allTxns) {
    if (!t.uploadId) continue;
    if (!txnByUpload.has(t.uploadId)) txnByUpload.set(t.uploadId, new Set());
    txnByUpload.get(t.uploadId)!.add(t.id);
  }
  const invByUpload = new Map<number, Set<number>>();
  for (const i of allInvoices) {
    if (!i.uploadId) continue;
    if (!invByUpload.has(i.uploadId)) invByUpload.set(i.uploadId, new Set());
    invByUpload.get(i.uploadId)!.add(i.id);
  }

  const folders = await Promise.all(runs.map(async (run, idx) => {
    // Get uploads linked to this run via run_sources
    let matchCount = 0;
    let sourceFiles: string[] = [];
    let sourceTypes: string[] = [];
    try {
      const sourcesRes = await db.execute(sql`
        SELECT upload_id, source_type, file_name FROM run_sources WHERE run_id = ${run.id}
      `);
      const sources = sourcesRes.rows as { upload_id: number; source_type: string; file_name: string }[];
      sourceFiles = [...new Set(sources.map(s => s.file_name).filter(Boolean))];
      sourceTypes = [...new Set(sources.map(s => s.source_type).filter(Boolean))];

      const uploadIds = new Set(sources.map(s => s.upload_id).filter(Boolean));
      if (uploadIds.size > 0) {
        const txnIdsInRun = new Set<number>();
        const invIdsInRun = new Set<number>();
        for (const uid of uploadIds) {
          txnByUpload.get(uid)?.forEach(id => txnIdsInRun.add(id));
          invByUpload.get(uid)?.forEach(id => invIdsInRun.add(id));
        }
        matchCount = allMatches.filter(m =>
          (m.bankTransactionId && txnIdsInRun.has(m.bankTransactionId)) ||
          (m.invoiceId && invIdsInRun.has(m.invoiceId))
        ).length;
      }
    } catch { /* run_sources table may not exist yet */ }

    const runNum = runs.length - idx;
    const typeLabel = run.run_type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    return {
      runId: run.id,
      // Prefer the user-named title; fall back to numbered default
      name: run.title || `Reconciliation ${runNum}`,
      title: typeLabel,
      runType: run.run_type,
      status: run.status,
      createdAt: run.created_at,
      completedAt: run.completed_at ?? null,
      matchCount,
      sourceFiles,
      sourceTypes,
    };
  }));

  res.json(folders);
});

router.post("/reconciliation/run", requirePermission("reconciliation.run"), runReconciliation);
router.get("/reconciliation/run", requirePermission("reconciliation.run"), runReconciliation);
router.post("/reconciliation/:id/approve", requirePermission("reconciliation.approve"), approveMatch);
router.post("/reconciliation/:id/reject", requirePermission("reconciliation.reject"), rejectMatch);
router.post("/reconciliation/:id/needs-info", requirePermission("reconciliation.approve"), needsInfoMatch);
router.post("/reconciliation/:id/send-to-ca", requirePermission("reconciliation.approve"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [match] = await db.select().from(reconciliationMatchesTable)
    .where(and(eq(reconciliationMatchesTable.id, id), eq(reconciliationMatchesTable.companyId, companyId)))
    .limit(1);
  if (!match) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  const [item] = await db.insert(caReviewItemsTable).values({
    companyId,
    entityType: "reconciliation_match",
    entityId: match.id,
    title: `Reconciliation match #${match.id} needs CA review`,
    description: match.reason,
    severity: match.confidenceScore < 60 ? "high" : "medium",
    status: "pending",
    founderNote: typeof req.body?.note === "string" ? req.body.note : null,
    createdBy: req.auth?.userId ?? null,
  }).returning();
  await db.update(reconciliationMatchesTable)
    .set({ status: "needs_info" })
    .where(and(eq(reconciliationMatchesTable.id, id), eq(reconciliationMatchesTable.companyId, companyId)));
  await auditAction(req, "reconciliation.sent_to_ca", "reconciliation", match.id, { caReviewItemId: item.id });
  res.json({ ok: true, caReviewItemId: item.id, matchId: id });
});
router.post("/reconciliation/finalize", requirePermission("reconciliation.approve"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const all = await db.select().from(reconciliationMatchesTable).where(eq(reconciliationMatchesTable.companyId, companyId));
  const pending = all.filter(m => m.status === "pending").length;
  const approved = all.filter(m => m.status === "approved").length;
  const rejected = all.filter(m => m.status === "rejected").length;
  const needsInfo = all.filter(m => m.status === "needs_info").length;
  await auditAction(req, "reconciliation.finalized", "reconciliation", null, { approved, rejected, needsInfo, pending });
  res.json({
    ok: pending === 0,
    approved,
    rejected,
    needsInfo,
    pending,
    message: pending === 0
      ? "CA-ready pack generated. All suggested matches were reviewed."
      : `${pending} match${pending === 1 ? "" : "es"} still pending review. Finalize after every match is marked.`,
  });
});
router.post("/reconciliation/approve", requirePermission("reconciliation.approve"), (req, res) => {
  (req.params as Record<string, string>).id = String(req.body?.id ?? req.query.id ?? "");
  void approveMatch(req, res);
});
router.post("/reconciliation/reject", requirePermission("reconciliation.reject"), (req, res) => {
  (req.params as Record<string, string>).id = String(req.body?.id ?? req.query.id ?? "");
  void rejectMatch(req, res);
});

export default router;
