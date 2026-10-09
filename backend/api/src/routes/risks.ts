import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { riskFlagsTable, gstRecordsTable, exceptionsTable, auditLogsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { GetRiskFlagsResponse, UpdateRiskStatusParams, UpdateRiskStatusBody, UpdateRiskStatusResponse } from "@workspace/api-zod";
import { auditAction, getCompanyId, requirePermission } from "../middleware/authz";
import { queryCache } from "../lib/queryCache";

const router: IRouter = Router();

const mapRisk = (r: typeof riskFlagsTable.$inferSelect) => ({
  id: r.id,
  entityType: r.entityType,
  entityId: r.entityId ?? null,
  category: r.category,
  severity: r.severity,
  reason: r.reason,
  suggestedAction: r.suggestedAction,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
});

router.get("/risks", requirePermission("risks.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const { severity, category, status } = req.query as { severity?: string; category?: string; status?: string };
  // Cache base risk list for 30s; filters applied in-memory on the cached data
  let risks = await queryCache.get(`company:${companyId}:risks`, 30, () =>
    db.select().from(riskFlagsTable).where(eq(riskFlagsTable.companyId, companyId)).orderBy(desc(riskFlagsTable.createdAt))
  );
  if (severity) risks = risks.filter(r => r.severity === severity);
  if (category) risks = risks.filter(r => r.category === category);
  if (status)   risks = risks.filter(r => r.status === status);
  res.json(GetRiskFlagsResponse.parse(risks.map(mapRisk)));
});

router.patch("/risks/:id/status", requirePermission("risks.resolve"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = UpdateRiskStatusBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [r] = await db.update(riskFlagsTable)
    .set({ status: parsed.data.status })
    .where(and(eq(riskFlagsTable.id, id), eq(riskFlagsTable.companyId, getCompanyId(req))))
    .returning();

  if (!r) { res.status(404).json({ error: "Risk not found" }); return; }
  await auditAction(req, "risk.status_updated", "risk", r.id, { status: r.status });
  // Invalidate the risk cache for this company after a status change
  queryCache.invalidate(`company:${getCompanyId(req)}:risks`);
  queryCache.invalidate(`company:${getCompanyId(req)}:overview`);
  res.json(UpdateRiskStatusResponse.parse(mapRisk(r)));
});

router.post("/gst-tds-review/generate", requirePermission("risks.resolve"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);

  const gstRecords = await db.select().from(gstRecordsTable).where(eq(gstRecordsTable.companyId, companyId));

  if (gstRecords.length === 0) {
    res.json({ ok: true, flagsCreated: 0, exceptionsCreated: 0, message: "No GST/TDS records found. Upload and import GST/TDS files first." });
    return;
  }

  const unmatchedRecords = gstRecords.filter(r => r.matchStatus === "unmatched");
  const riskRecords = gstRecords.filter(r => r.riskStatus !== "none");

  let flagsCreated = 0;
  let exceptionsCreated = 0;

  for (const record of unmatchedRecords) {
    const existing = await db.select({ id: riskFlagsTable.id }).from(riskFlagsTable)
      .where(and(eq(riskFlagsTable.companyId, companyId), eq(riskFlagsTable.entityType, "gst_record"), eq(riskFlagsTable.entityId, record.id)))
      .limit(1);

    if (existing.length > 0) continue;

    await db.insert(riskFlagsTable).values({
      companyId,
      entityType: "gst_record",
      entityId: record.id,
      category: "gst_mismatch",
      severity: "medium",
      reason: `GST record for invoice ${record.invoiceNumber ?? record.period} is unmatched. Potential risk — needs CA review.`,
      suggestedAction: "Verify with counterparty GSTIN and match against uploaded invoices. Send to CA review if unresolved.",
      status: "open",
    });
    flagsCreated++;
  }

  for (const record of unmatchedRecords.slice(0, 20)) {
    const existingExc = await db.select({ id: exceptionsTable.id }).from(exceptionsTable)
      .where(and(eq(exceptionsTable.companyId, companyId), eq(exceptionsTable.type, "gst_unmatched"), eq(exceptionsTable.relatedEntityId, record.id)))
      .limit(1);

    if (existingExc.length > 0) continue;

    await db.insert(exceptionsTable).values({
      companyId,
      type: "gst_unmatched",
      title: `Unmatched GST record — ${record.invoiceNumber ?? record.period}`,
      description: `GST record from ${record.period} for ${record.counterpartyName ?? "unknown counterparty"} could not be matched. Potential risk — needs CA review.`,
      severity: "medium",
      status: "open",
      relatedEntityType: "gst_record",
      relatedEntityId: record.id,
      createdBy: req.auth?.userId ?? null,
    });
    exceptionsCreated++;
  }

  await db.insert(auditLogsTable).values({
    companyId,
    userId: req.auth?.userId ?? null,
    actorEmail: req.auth?.email ?? "system@finverify.local",
    action: "gst_tds_review.generated",
    entityType: "gst_record",
    metadata: { flagsCreated, exceptionsCreated, totalRecords: gstRecords.length, unmatchedCount: unmatchedRecords.length },
    ipAddress: req.ip,
  });

  res.json({
    ok: true,
    flagsCreated,
    exceptionsCreated,
    totalRecords: gstRecords.length,
    unmatchedRecords: unmatchedRecords.length,
    message: flagsCreated > 0
      ? `Generated ${flagsCreated} GST risk flags and ${exceptionsCreated} exceptions. All items require CA review.`
      : "GST/TDS review pack generated. No new risk flags.",
    disclaimer: "Potential risk — needs CA review. These flags are indicative only.",
  });
});

export default router;
