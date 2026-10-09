import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  auditLogsTable,
  caReviewItemsTable,
  db,
  documentRequestsTable,
  exceptionsTable,
} from "@workspace/db";
import { auditAction, getCompanyId, requirePermission } from "../middleware/authz";

const router: IRouter = Router();

function mapException(e: typeof exceptionsTable.$inferSelect) {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    description: e.description ?? null,
    severity: e.severity,
    status: e.status,
    relatedEntityType: e.relatedEntityType ?? null,
    relatedEntityId: e.relatedEntityId ?? null,
    resolutionNote: e.resolutionNote ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

router.get("/exceptions", requirePermission("reports.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  let exceptions = await db.select().from(exceptionsTable)
    .where(eq(exceptionsTable.companyId, companyId))
    .orderBy(desc(exceptionsTable.createdAt));

  const { status, severity, type } = req.query as { status?: string; severity?: string; type?: string };
  if (status) exceptions = exceptions.filter(e => e.status === status);
  if (severity) exceptions = exceptions.filter(e => e.severity === severity);
  if (type) exceptions = exceptions.filter(e => e.type === type);

  res.json({ count: exceptions.length, exceptions: exceptions.map(mapException) });
});

router.post("/exceptions/:id/resolve", requirePermission("risks.resolve"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const companyId = getCompanyId(req);
  const note = typeof req.body?.note === "string" ? req.body.note : null;

  const [e] = await db.update(exceptionsTable)
    .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: req.auth?.userId ?? null, resolutionNote: note })
    .where(and(eq(exceptionsTable.id, id), eq(exceptionsTable.companyId, companyId)))
    .returning();

  if (!e) { res.status(404).json({ error: "Exception not found" }); return; }
  await auditAction(req, "exception.resolved", "exception", e.id, { note });
  res.json({ ok: true, exception: mapException(e) });
});

router.post("/exceptions/:id/dismiss", requirePermission("risks.resolve"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const companyId = getCompanyId(req);
  const note = typeof req.body?.note === "string" ? req.body.note : null;

  const [e] = await db.update(exceptionsTable)
    .set({ status: "dismissed", resolvedAt: new Date(), resolvedBy: req.auth?.userId ?? null, resolutionNote: note })
    .where(and(eq(exceptionsTable.id, id), eq(exceptionsTable.companyId, companyId)))
    .returning();

  if (!e) { res.status(404).json({ error: "Exception not found" }); return; }
  await auditAction(req, "exception.dismissed", "exception", e.id, { note });
  res.json({ ok: true, exception: mapException(e) });
});

router.post("/exceptions/:id/send-to-ca-review", requirePermission("ca_review.process"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const companyId = getCompanyId(req);
  const [e] = await db.select().from(exceptionsTable)
    .where(and(eq(exceptionsTable.id, id), eq(exceptionsTable.companyId, companyId)))
    .limit(1);

  if (!e) { res.status(404).json({ error: "Exception not found" }); return; }

  const [caItem] = await db.insert(caReviewItemsTable).values({
    companyId,
    exceptionId: e.id,
    entityType: e.relatedEntityType ?? "exception",
    entityId: e.relatedEntityId ?? null,
    title: e.title,
    description: e.description ?? `Exception sent from workflow. Potential risk — needs CA review.`,
    severity: e.severity,
    status: "pending",
    createdBy: req.auth?.userId ?? null,
  }).returning();

  await db.update(exceptionsTable)
    .set({ status: "sent_to_ca_review" })
    .where(and(eq(exceptionsTable.id, id), eq(exceptionsTable.companyId, companyId)));

  await auditAction(req, "exception.sent_to_ca_review", "exception", e.id, { caReviewItemId: caItem.id });
  res.json({ ok: true, caReviewItemId: caItem.id, exception: mapException({ ...e, status: "sent_to_ca_review" }) });
});

router.get("/document-requests", requirePermission("reports.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const requests = await db.select().from(documentRequestsTable)
    .where(eq(documentRequestsTable.companyId, companyId))
    .orderBy(desc(documentRequestsTable.createdAt));

  res.json({
    count: requests.length,
    requests: requests.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description ?? null,
      requiredDocumentType: r.requiredDocumentType,
      status: r.status,
      priority: r.priority,
      relatedEntityType: r.relatedEntityType ?? null,
      relatedEntityId: r.relatedEntityId ?? null,
      founderComment: r.founderComment ?? null,
      caComment: r.caComment ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

router.post("/document-requests", requirePermission("ca_review.process"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const { title, description, requiredDocumentType, relatedEntityType, relatedEntityId, priority } = req.body as {
    title?: string;
    description?: string;
    requiredDocumentType?: string;
    relatedEntityType?: string;
    relatedEntityId?: number;
    priority?: string;
  };

  if (!title) { res.status(400).json({ error: "title is required" }); return; }

  const [request] = await db.insert(documentRequestsTable).values({
    companyId,
    title,
    description: description ?? null,
    requiredDocumentType: requiredDocumentType ?? "other",
    status: "open",
    priority: priority ?? "medium",
    relatedEntityType: relatedEntityType ?? null,
    relatedEntityId: relatedEntityId ?? null,
    requestedBy: req.auth?.userId ?? null,
  }).returning();

  await auditAction(req, "document_request.created", "document_request", request.id, { title });
  res.status(201).json({ ok: true, request });
});

router.post("/document-requests/:id/resolve", requirePermission("ca_review.process"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const companyId = getCompanyId(req);
  const note = typeof req.body?.note === "string" ? req.body.note : null;

  const [request] = await db.update(documentRequestsTable)
    .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: req.auth?.userId ?? null, founderComment: note })
    .where(and(eq(documentRequestsTable.id, id), eq(documentRequestsTable.companyId, companyId)))
    .returning();

  if (!request) { res.status(404).json({ error: "Document request not found" }); return; }
  await auditAction(req, "document_request.resolved", "document_request", request.id);
  res.json({ ok: true, request });
});

export default router;
