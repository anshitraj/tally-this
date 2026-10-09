import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { aiExtractionsTable, auditLogsTable, db, documentsTable, invoicesTable, uploadBatchesTable } from "@workspace/db";
import { getCompanyId, requirePermission } from "../middleware/authz";
import { getAIStatus, runAIJsonTask } from "../server/ai/providerRouter";
import { invoiceExtractionSchema, invoiceExtractionSchemaDescription } from "../server/ai/schemas/invoiceExtractionSchema";
import { extractInvoiceFields } from "../server/ai/extractInvoiceFields";
import { monthEndSummarySchema, monthEndSummarySchemaDescription } from "../server/ai/schemas/monthEndSummarySchema";
import { riskExplanationSchema, riskExplanationSchemaDescription } from "../server/ai/schemas/riskExplanationSchema";
import { bankNarrationInterpretationSchema, columnMappingSchema, ledgerSuggestionSchema, schemaDescriptions } from "../server/ai/validators";

const router: IRouter = Router();

router.get("/ai/status", requirePermission("ai.assist"), (_req, res): void => {
  res.json(getAIStatus());
});

const extractInvoiceBodySchema = z.object({
  uploadId: z.coerce.number().int().positive().optional(),
  text: z.string().optional(),
  metadata: z.unknown().optional(),
  forceRuleBased: z.boolean().optional(),
});

const editExtractionBodySchema = z.object({
  data: invoiceExtractionSchema.partial(),
});

function detectedMetadata(document: typeof documentsTable.$inferSelect | undefined) {
  const raw = document?.detectedColumns;
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function textFromDocument(document: typeof documentsTable.$inferSelect | undefined): string {
  const metadata = detectedMetadata(document);
  return typeof metadata.textPreview === "string" ? metadata.textPreview : "";
}

async function auditAIAction(input: {
  companyId: number;
  userId?: number | null;
  actorEmail?: string | null;
  action: string;
  entityId?: number | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}) {
  await db.insert(auditLogsTable).values({
    companyId: input.companyId,
    userId: input.userId ?? null,
    actorEmail: input.actorEmail ?? "system@finverify.local",
    action: input.action,
    entityType: "ai_extraction",
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
    ipAddress: input.ipAddress,
  });
}

function reviewLabel(confidence: number) {
  return confidence < 0.75 ? "Needs review" : "AI extracted — pending review";
}

function isInvoiceUploadSource(sourceType: string) {
  return ["invoice", "invoices"].includes(sourceType.toLowerCase());
}

async function loadExtraction(id: number, companyId: number) {
  const [extraction] = await db.select().from(aiExtractionsTable).where(and(
    eq(aiExtractionsTable.id, id),
    eq(aiExtractionsTable.companyId, companyId),
  )).limit(1);
  return extraction;
}

function invoiceValuesFromExtraction(input: {
  companyId: number;
  extraction: typeof aiExtractionsTable.$inferSelect;
  data: z.infer<typeof invoiceExtractionSchema>;
}) {
  const missing = [];
  if (!input.data.invoiceNumber) missing.push("invoiceNumber");
  if (!input.data.vendorName) missing.push("vendorName");
  if (!input.data.invoiceDate) missing.push("invoiceDate");
  if (input.data.totalAmount === null || input.data.totalAmount === undefined) missing.push("totalAmount");
  if (missing.length > 0) return { ok: false as const, missing };

  return {
    ok: true as const,
    values: {
      companyId: input.companyId,
      invoiceNumber: input.data.invoiceNumber!,
      vendorName: input.data.vendorName!,
      customerName: input.data.customerName ?? null,
      gstin: input.data.vendorGstin ?? input.data.customerGstin ?? null,
      date: input.data.invoiceDate!,
      amount: String(input.data.totalAmount!),
      gstAmount: input.data.gstAmount !== null && input.data.gstAmount !== undefined ? String(input.data.gstAmount) : null,
      type: "purchase",
      paymentStatus: "unpaid",
      status: "pending_reconciliation",
    },
  };
}

router.post("/ai/extract-invoice", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const body = extractInvoiceBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const companyId = getCompanyId(req);
  let upload: typeof uploadBatchesTable.$inferSelect | undefined;
  let document: typeof documentsTable.$inferSelect | undefined;
  let extractedText = body.data.text ?? "";
  let fileName = String(body.data.metadata && typeof body.data.metadata === "object" && "fileName" in body.data.metadata
    ? (body.data.metadata as { fileName?: unknown }).fileName ?? "invoice-text"
    : "invoice-text");

  if (body.data.uploadId) {
    [upload] = await db.select().from(uploadBatchesTable).where(and(
      eq(uploadBatchesTable.id, body.data.uploadId),
      eq(uploadBatchesTable.companyId, companyId),
    )).limit(1);
    if (!upload) {
      res.status(404).json({ error: "Upload not found" });
      return;
    }
    if (!isInvoiceUploadSource(upload.sourceType)) {
      res.status(422).json({
        error: "Invoice extraction can only run on invoice uploads.",
        detail: `${upload.fileName} is a ${upload.sourceType} upload. Use its parsed rows for reconciliation instead.`,
      });
      return;
    }
    [document] = await db.select().from(documentsTable).where(and(
      eq(documentsTable.uploadBatchId, upload.id),
      eq(documentsTable.companyId, companyId),
    )).limit(1);
    extractedText = textFromDocument(document);
    fileName = upload.fileName;
  }

  if (!extractedText.trim()) {
    res.status(422).json({ error: "No extracted text available. OCR required." });
    return;
  }

  const result = await extractInvoiceFields({
    uploadId: upload?.id ?? body.data.uploadId ?? null,
    companyId,
    userId: req.auth?.userId,
    extractedText,
    fileName,
  });

  const [extraction] = await db.insert(aiExtractionsTable).values({
    companyId,
    uploadId: upload?.id ?? body.data.uploadId ?? null,
    entityType: "invoice",
    entityId: null,
    provider: result.provider,
    model: result.model ?? null,
    purpose: "invoice_extraction",
    extractedJson: result.data,
    confidence: String(result.confidence),
    status: "extracted_pending_review",
    createdBy: req.auth?.userId ?? null,
  }).returning();

  await auditAIAction({
    companyId,
    userId: req.auth?.userId,
    actorEmail: req.auth?.email,
    action: "ai.invoice_extracted",
    entityId: extraction.id,
    metadata: {
      uploadId: upload?.id ?? null,
      provider: result.provider,
      model: result.model ?? null,
      confidence: result.confidence,
      usedFallback: result.usedFallback,
    },
    ipAddress: req.ip,
  });

  res.json({
    ok: result.ok,
    id: extraction.id,
    uploadId: upload?.id ?? null,
    status: "extracted_pending_review",
    label: "AI extracted — pending review",
    reviewLabel: reviewLabel(result.confidence),
    provider: result.provider,
    model: result.model ?? null,
    confidence: result.confidence,
    usedFallback: result.usedFallback,
    data: result.data,
    error: result.error,
  });
});

router.post("/ai/extractions/:id/accept", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid extraction id" });
    return;
  }

  const companyId = getCompanyId(req);
  const extraction = await loadExtraction(id, companyId);
  if (!extraction) {
    res.status(404).json({ error: "Extraction not found" });
    return;
  }

  const parsed = invoiceExtractionSchema.safeParse(extraction.extractedJson);
  if (!parsed.success) {
    res.status(422).json({ error: "Extraction JSON is invalid", detail: parsed.error.message });
    return;
  }

  const invoiceValues = invoiceValuesFromExtraction({ companyId, extraction, data: parsed.data });
  if (!invoiceValues.ok) {
    res.status(422).json({
      error: "Cannot accept extraction until required fields are present.",
      missingFields: invoiceValues.missing,
    });
    return;
  }

  const [invoice] = await db.insert(invoicesTable).values(invoiceValues.values).returning();
  const [updated] = await db.update(aiExtractionsTable)
    .set({ status: "accepted", entityId: invoice.id })
    .where(and(eq(aiExtractionsTable.id, id), eq(aiExtractionsTable.companyId, companyId)))
    .returning();

  await auditAIAction({
    companyId,
    userId: req.auth?.userId,
    actorEmail: req.auth?.email,
    action: "ai.invoice_extraction_accepted",
    entityId: updated.id,
    metadata: { invoiceId: invoice.id, uploadId: extraction.uploadId ?? null },
    ipAddress: req.ip,
  });

  res.json({
    status: "accepted",
    label: "Accepted for reconciliation",
    extraction: updated,
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      vendorName: invoice.vendorName,
      date: invoice.date,
      amount: parseFloat(invoice.amount as string),
      gstAmount: invoice.gstAmount ? parseFloat(invoice.gstAmount as string) : null,
      status: invoice.status,
    },
  });
});

router.post("/ai/extractions/:id/reject", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid extraction id" });
    return;
  }

  const companyId = getCompanyId(req);
  const [updated] = await db.update(aiExtractionsTable)
    .set({ status: "rejected" })
    .where(and(eq(aiExtractionsTable.id, id), eq(aiExtractionsTable.companyId, companyId)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Extraction not found" });
    return;
  }
  await auditAIAction({
    companyId,
    userId: req.auth?.userId,
    actorEmail: req.auth?.email,
    action: "ai.invoice_extraction_rejected",
    entityId: updated.id,
    metadata: { uploadId: updated.uploadId ?? null },
    ipAddress: req.ip,
  });
  res.json({ status: "rejected", extraction: updated });
});

router.patch("/ai/extractions/:id/edit", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid extraction id" });
    return;
  }

  const body = editExtractionBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const companyId = getCompanyId(req);
  const extraction = await loadExtraction(id, companyId);
  if (!extraction) {
    res.status(404).json({ error: "Extraction not found" });
    return;
  }
  const current = invoiceExtractionSchema.safeParse(extraction.extractedJson);
  if (!current.success) {
    res.status(422).json({ error: "Existing extraction JSON is invalid", detail: current.error.message });
    return;
  }
  const merged = invoiceExtractionSchema.parse({ ...current.data, ...body.data.data });
  const [updated] = await db.update(aiExtractionsTable)
    .set({
      extractedJson: merged,
      confidence: String(merged.confidence),
      status: "edited_by_user",
    })
    .where(and(eq(aiExtractionsTable.id, id), eq(aiExtractionsTable.companyId, companyId)))
    .returning();

  await auditAIAction({
    companyId,
    userId: req.auth?.userId,
    actorEmail: req.auth?.email,
    action: "ai.invoice_extraction_edited",
    entityId: updated.id,
    metadata: { uploadId: updated.uploadId ?? null },
    ipAddress: req.ip,
  });
  res.json({
    status: "edited_by_user",
    label: "AI extracted — pending review",
    id: updated.id,
    data: merged,
    confidence: merged.confidence,
  });
});

router.post("/invoices/extract-batch", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);

  const uploadBatches = await db.select().from(uploadBatchesTable).where(and(
    eq(uploadBatchesTable.companyId, companyId),
  ));
  const invoiceUploads = uploadBatches.filter(u => isInvoiceUploadSource(u.sourceType));
  const invoiceUploadIds = invoiceUploads.map(u => u.id);

  if (invoiceUploadIds.length === 0) {
    res.json({ ok: true, processed: 0, skipped: 0, errors: [], message: "No invoice uploads found." });
    return;
  }

  const docs = await db.select().from(documentsTable).where(and(
    eq(documentsTable.companyId, companyId),
    eq(documentsTable.extractedTextStatus, "text_extracted"),
  ));
  const invoiceDocs = docs.filter(d => invoiceUploadIds.includes(d.uploadBatchId ?? -1));

  const existingExtractions = await db.select({ uploadId: aiExtractionsTable.uploadId }).from(aiExtractionsTable).where(
    eq(aiExtractionsTable.companyId, companyId)
  );
  const alreadyExtractedUploadIds = new Set(existingExtractions.map(e => e.uploadId).filter(Boolean));

  const docsToProcess = invoiceDocs.filter(d => !alreadyExtractedUploadIds.has(d.uploadBatchId ?? -1));

  let processed = 0;
  let skipped = invoiceDocs.length - docsToProcess.length;
  const errors: string[] = [];
  const results: unknown[] = [];

  for (const doc of docsToProcess) {
    const metadata = (doc.detectedColumns ?? {}) as Record<string, unknown>;
    const extractedText = typeof metadata.textPreview === "string" ? metadata.textPreview : "";

    if (!extractedText.trim()) {
      skipped++;
      continue;
    }

    try {
      const result = await extractInvoiceFields({
        uploadId: doc.uploadBatchId,
        companyId,
        userId: req.auth?.userId,
        extractedText,
        fileName: doc.fileName,
      });

      const [extraction] = await db.insert(aiExtractionsTable).values({
        companyId,
        uploadId: doc.uploadBatchId,
        entityType: "invoice",
        entityId: null,
        provider: result.provider,
        model: result.model ?? null,
        purpose: "invoice_extraction",
        extractedJson: result.data,
        confidence: String(result.confidence),
        status: "extracted_pending_review",
        createdBy: req.auth?.userId ?? null,
      }).returning();

      await auditAIAction({
        companyId,
        userId: req.auth?.userId,
        actorEmail: req.auth?.email,
        action: "ai.invoice_extraction_batch",
        entityId: extraction.id,
        metadata: { uploadId: doc.uploadBatchId, provider: result.provider, confidence: result.confidence },
        ipAddress: req.ip,
      });

      processed++;
      results.push({
        extractionId: extraction.id,
        uploadId: doc.uploadBatchId,
        fileName: doc.fileName,
        provider: result.provider,
        confidence: result.confidence,
        status: "extracted_pending_review",
        label: "AI extracted — pending review",
      });
    } catch (err) {
      errors.push(`${doc.fileName}: ${err instanceof Error ? err.message : "extraction failed"}`);
    }
  }

  res.json({
    ok: true,
    processed,
    skipped,
    errors,
    results,
    message: processed > 0
      ? `${processed} invoice${processed > 1 ? "s" : ""} extracted — pending review. Results are AI suggestions only.`
      : "No new invoice PDFs to extract.",
  });
});

router.get("/invoices/extractions/pending", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const extractions = await db.select().from(aiExtractionsTable).where(and(
    eq(aiExtractionsTable.companyId, companyId),
    eq(aiExtractionsTable.status, "extracted_pending_review"),
  ));

  const uploadIds = extractions.map(e => e.uploadId).filter(Boolean) as number[];
  const batches = uploadIds.length > 0
    ? await db.select().from(uploadBatchesTable).where(and(eq(uploadBatchesTable.companyId, companyId)))
    : [];
  const batchMap = Object.fromEntries(batches.map(b => [b.id, b]));

  res.json({
    count: extractions.length,
    extractions: extractions.map(e => ({
      id: e.id,
      uploadId: e.uploadId ?? null,
      fileName: e.uploadId ? (batchMap[e.uploadId]?.fileName ?? null) : null,
      provider: e.provider,
      model: e.model ?? null,
      confidence: parseFloat(String(e.confidence)),
      status: e.status,
      label: "AI extracted — pending review",
      data: e.extractedJson,
      createdAt: e.createdAt.toISOString(),
    })),
  });
});

router.post("/invoices/extractions/bulk-action", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const { action, ids } = req.body as { action: "accept" | "reject" | "send_to_ca"; ids: number[] };

  if (!["accept", "reject", "send_to_ca"].includes(action) || !Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "action must be accept|reject|send_to_ca and ids must be a non-empty array" });
    return;
  }

  const results: { id: number; status: string }[] = [];
  const errors: string[] = [];

  for (const id of ids) {
    try {
      if (action === "accept") {
        const extraction = await loadExtraction(id, companyId);
        if (!extraction) { errors.push(`${id}: not found`); continue; }
        const parsed = invoiceExtractionSchema.safeParse(extraction.extractedJson);
        if (!parsed.success) { errors.push(`${id}: invalid JSON`); continue; }
        const invoiceValues = invoiceValuesFromExtraction({ companyId, extraction, data: parsed.data });
        if (!invoiceValues.ok) { errors.push(`${id}: missing fields ${invoiceValues.missing.join(",")}`); continue; }
        const [invoice] = await db.insert(invoicesTable).values(invoiceValues.values).returning();
        await db.update(aiExtractionsTable).set({ status: "accepted", entityId: invoice.id }).where(and(eq(aiExtractionsTable.id, id), eq(aiExtractionsTable.companyId, companyId)));
        results.push({ id, status: "accepted" });
      } else if (action === "reject") {
        await db.update(aiExtractionsTable).set({ status: "rejected" }).where(and(eq(aiExtractionsTable.id, id), eq(aiExtractionsTable.companyId, companyId)));
        results.push({ id, status: "rejected" });
      } else if (action === "send_to_ca") {
        await db.update(aiExtractionsTable).set({ status: "sent_to_ca_review" }).where(and(eq(aiExtractionsTable.id, id), eq(aiExtractionsTable.companyId, companyId)));
        results.push({ id, status: "sent_to_ca_review" });
      }
    } catch (err) {
      errors.push(`${id}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  await auditAIAction({
    companyId,
    userId: req.auth?.userId,
    actorEmail: req.auth?.email,
    action: `ai.bulk_extraction_${action}`,
    metadata: { ids, results, errors },
    ipAddress: req.ip,
  });

  res.json({ ok: true, action, results, errors });
});

router.post("/dev/test-ai-extraction", async (_req, res): Promise<void> => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const result = await extractInvoiceFields({
    companyId: 1,
    userId: null,
    uploadId: null,
    fileName: "dev-sample-invoice.txt",
    extractedText: "INVOICE No INV-2026-001 dated 2026-05-27 vendor ABC Services GSTIN 27ABCDE1234F1Z5 amount 118000 GST 18000 total 118000",
  });
  res.json({
    status: getAIStatus(),
    expected: ["invoiceNumber", "invoiceDate", "vendorName", "vendorGstin", "totalAmount"],
    result,
  });
});

router.post("/ai/extract-invoice-text", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const result = await runAIJsonTask({
    companyId: getCompanyId(req),
    userId: req.auth?.userId,
    purpose: "invoice_extraction",
    schemaName: "invoice_extraction",
    schema: invoiceExtractionSchema,
    schemaDescription: invoiceExtractionSchemaDescription,
    input: { text: req.body?.text ?? "", metadata: req.body?.metadata ?? null },
    prompt: "Extract invoice fields only when they are explicitly supported by the text. Store as extracted_pending_review, never verified.",
  });
  res.json({
    mode: result.provider === "rule_based" ? "rule-based" : "AI-assisted",
    status: "extracted_pending_review",
    reviewLabel: "Pending review",
    source: result.provider === "rule_based" ? "deterministic rule" : "AI suggestion",
    ...result,
  });
});

router.post("/ai/interpret-bank-narration", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const result = await runAIJsonTask({
    companyId: getCompanyId(req),
    userId: req.auth?.userId,
    purpose: "bank_narration_interpretation",
    schemaName: "bank_narration_interpretation",
    schema: bankNarrationInterpretationSchema,
    schemaDescription: schemaDescriptions.bank_narration_interpretation,
    input: { narration: req.body?.narration ?? "", amount: req.body?.amount ?? null, date: req.body?.date ?? null },
    prompt: "Interpret narration conservatively. Do not create matches or mark the transaction as verified.",
  });
  res.json(result);
});

router.post("/ai/suggest-ledger", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const result = await runAIJsonTask({
    companyId: getCompanyId(req),
    userId: req.auth?.userId,
    purpose: "ledger_suggestion",
    schemaName: "ledger_suggestion",
    schema: ledgerSuggestionSchema,
    schemaDescription: schemaDescriptions.ledger_suggestion,
    input: req.body ?? {},
    prompt: "Suggest a ledger only from provided transaction, invoice, or narration data. This is not a posting decision.",
  });
  res.json(result);
});

router.post("/ai/explain-risk", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const result = await runAIJsonTask({
    companyId: getCompanyId(req),
    userId: req.auth?.userId,
    purpose: "risk_explanation",
    schemaName: "risk_explanation",
    schema: riskExplanationSchema,
    schemaDescription: riskExplanationSchemaDescription,
    input: req.body ?? {},
    prompt: "Explain the deterministic risk flag in CA-friendly language. Use the exact phrase Potential risk — needs CA review.",
  });
  res.json(result);
});

router.post("/ai/month-end-summary", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const result = await runAIJsonTask({
    companyId: getCompanyId(req),
    userId: req.auth?.userId,
    purpose: "month_end_summary",
    schemaName: "month_end_summary",
    schema: monthEndSummarySchema,
    schemaDescription: monthEndSummarySchemaDescription,
    input: req.body ?? {},
    prompt: "Summarize deterministic month-end verification status only. Do not claim readiness beyond provided checks.",
  });
  res.json(result);
});

router.post("/ai/suggest-column-mapping", requirePermission("ai.assist"), async (req, res): Promise<void> => {
  const result = await runAIJsonTask({
    companyId: getCompanyId(req),
    userId: req.auth?.userId,
    purpose: "column_mapping",
    schemaName: "column_mapping",
    schema: columnMappingSchema,
    schemaDescription: schemaDescriptions.column_mapping,
    input: req.body ?? {},
    prompt: "Suggest mappings only for provided column names. Unknown columns must stay unmapped.",
  });
  res.json(result);
});

router.post("/dev/test-ai", async (_req, res): Promise<void> => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const result = await runAIJsonTask({
    purpose: "risk_explanation",
    schemaName: "dev_risk_explanation",
    schema: riskExplanationSchema,
    schemaDescription: riskExplanationSchemaDescription,
    input: {
      category: "Missing invoice",
      severity: "medium",
      detail: "One bank debit has no linked invoice in sample data.",
    },
    prompt: "Return a tiny valid JSON response for provider and fallback validation. Do not include real finance data.",
  });
  res.json({
    status: getAIStatus(),
    jsonValidation: result.ok ? "ok" : "error",
    fallbackChain: result.usedFallback || result.provider === "rule_based" ? "fallback_used" : "primary_used",
    result,
  });
});

export default router;
