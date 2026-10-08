import { Router, type IRouter } from "express";
import multer from "multer";
import { aiExtractionsTable, auditLogsTable, bankTransactionsTable, companiesTable, db, documentsTable, gatewaySettlementsTable, gstRecordsTable, invoicesTable, ledgerEntriesTable, payrollEntriesTable, reconciliationMatchesTable, uploadBatchesTable } from "@workspace/db";
import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import { GetUploadsResponse, CreateUploadBody } from "@workspace/api-zod";
import { parseUploadedFile, type ParsedFileResult } from "../services/fileParser";
import { getCompanyId, requirePermission } from "../middleware/authz";
import { retentionUntil, storeUploadedFile, type StoredObject } from "../services/storage";
import { logger } from "../lib/logger";
import { runAIJsonTask } from "../server/ai/providerRouter";
import { invoiceExtractionSchema, invoiceExtractionSchemaDescription } from "../server/ai/schemas/invoiceExtractionSchema";
import { ingestParsedUpload, type UploadImportSummary } from "../services/uploadIngestion";
import { runAndPersistReconciliation } from "../services/reconciliationRunner";

import { attachBooksCompany } from "../services/companyScope";

const router: IRouter = Router();
router.use(attachBooksCompany);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});

async function writeAuditLog(input: {
  action: string;
  companyId: number;
  userId?: number | null;
  actorEmail?: string | null;
  entityId?: number | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}) {
  await db.insert(auditLogsTable).values({
    companyId: input.companyId,
    userId: input.userId ?? null,
    actorEmail: input.actorEmail ?? "system@finverify.local",
    action: input.action,
    entityType: "document",
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
    ipAddress: input.ipAddress,
  });
}

function mapUpload(uploadRecord: typeof uploadBatchesTable.$inferSelect) {
  return {
    id: uploadRecord.id,
    companyId: uploadRecord.companyId ?? null,
    sourceType: uploadRecord.sourceType,
    fileName: uploadRecord.fileName,
    status: uploadRecord.status,
    uploadedAt: uploadRecord.uploadedAt.toISOString(),
    recordCount: uploadRecord.recordCount ?? null,
  };
}

function shouldRunAiExtraction(reqBody: Record<string, unknown>, sourceType: string, parsedFile: ParsedFileResult) {
  const requested = reqBody.enableAiExtraction === "true" || reqBody.enableAiExtraction === true;
  return requested && ["invoice", "invoices"].includes(sourceType) && Boolean(parsedFile.textPreview);
}

function parserForFile(file: Express.Multer.File): ParsedFileResult["parser"] {
  const extension = file.originalname.split(".").pop()?.toLowerCase();
  if (extension === "csv" || file.mimetype === "text/csv") return "csv";
  if (extension === "xlsx" || extension === "xls") return "excel";
  if (extension === "pdf" || file.mimetype === "application/pdf") return "pdf";
  return "unsupported";
}

function parsingFallback(file: Express.Multer.File, err: unknown): ParsedFileResult {
  const reason = err instanceof Error ? err.message : "Unknown parse error";
  return {
    parser: parserForFile(file),
    rowCount: 0,
    detectedColumns: [],
    status: "metadata_only",
    notes: [
      "File received and metadata captured, but parser extraction failed.",
      `Parser detail: ${reason}`,
      "Potential risk — needs CA review.",
    ],
  };
}

function extractedTextStatus(parsedFile: ParsedFileResult) {
  if (parsedFile.parser === "pdf") return parsedFile.status === "parsed" ? "text_extracted" : "extraction_failed";
  if (parsedFile.parser === "unsupported") return "not_started";
  return "not_required";
}

router.get("/uploads", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const uploads = await db.select().from(uploadBatchesTable)
    .where(and(eq(uploadBatchesTable.companyId, companyId), ne(uploadBatchesTable.status, "removed")))
    .orderBy(desc(uploadBatchesTable.uploadedAt));
  res.json(GetUploadsResponse.parse(uploads.map(mapUpload)));
});


router.post("/uploads", requirePermission("uploads.create"), upload.single("file"), async (req, res): Promise<void> => {
  const isMultipart = Boolean(req.file);
  const sourceType = String(isMultipart ? req.body.sourceType : req.body?.sourceType ?? "");
  const fileName = isMultipart ? req.file?.originalname ?? "uploaded-file" : req.body?.fileName;
  const companyId = getCompanyId(req);

  if (!sourceType || !fileName) {
    res.status(400).json({ error: "sourceType and fileName/file are required" });
    return;
  }

  let parsedFile: ParsedFileResult = {
    parser: "unsupported",
    rowCount: Number(req.body?.recordCount ?? 0),
    detectedColumns: [],
    status: "metadata_only",
    notes: ["JSON metadata upload. No file parser was run."],
  };

  await writeAuditLog({
    action: isMultipart ? "upload.file_received" : "upload.metadata_received",
    companyId,
    userId: req.auth?.userId,
    actorEmail: req.auth?.email,
    metadata: {
      fileName,
      sourceType,
      mimeType: req.file?.mimetype ?? null,
      size: req.file?.size ?? null,
    },
    ipAddress: req.ip,
  });

  let storedObject: StoredObject | null = null;
  if (req.file) {
    try {
      storedObject = await storeUploadedFile({ companyId, sourceType, file: req.file });
    } catch (err) {
      await writeAuditLog({
        action: "upload.storage_failed",
        companyId,
        userId: req.auth?.userId,
        actorEmail: req.auth?.email,
        metadata: {
          fileName,
          sourceType,
          error: err instanceof Error ? err.message : "Unknown storage error",
        },
        ipAddress: req.ip,
      });
      res.status(500).json({ error: "File storage failed", detail: err instanceof Error ? err.message : "Unknown storage error" });
      return;
    }

    // ── Python worker is the PRIMARY parser for all file types ────────────
    const pythonWorkerUrl = process.env.PYTHON_WORKER_URL;
    const fExt = (req.file.originalname.split(".").pop() ?? "").toLowerCase();
    const isCsv = fExt === "csv";
    const isExcel = fExt === "xlsx" || fExt === "xls";
    const isPdfFile = fExt === "pdf";
    let usedPythonWorker = false;

    if (pythonWorkerUrl && (isCsv || isExcel || isPdfFile)) {
      try {
        // Every source type has a specialist Python endpoint
        const sourceExtractMap: Record<string, string> = {
          bank: "bank-statement",        bank_statement: "bank-statement",    bankstatement: "bank-statement",
          tally: "tally-ledger",         tally_export: "tally-ledger",        tallyexport: "tally-ledger",
          zoho: "tally-ledger",          zoho_export: "tally-ledger",
          ledger: "tally-ledger",        ledger_entries: "tally-ledger",
          gateway: "gateway-statement",  gateway_settlement: "gateway-statement",
          gst: "gst-tds",               tds: "gst-tds",                      gst_tds: "gst-tds",
          payroll: "payroll",
          expense: "expense",            expenses: "expense",
          invoice: "invoice",            invoices: "invoice",
        };
        const normalizedSrc = sourceType.toLowerCase().replace(/-/g, "_");
        const extractEndpoint = sourceExtractMap[normalizedSrc];

        let workerEndpoint: string;
        if (extractEndpoint) {
          workerEndpoint = `/extract/${extractEndpoint}`;
        } else if (isPdfFile) {
          workerEndpoint = "/parse/pdf-table";
        } else {
          workerEndpoint = isCsv ? "/parse/csv" : "/parse/excel";
        }

        const fd = new globalThis.FormData();
        fd.append("file", new Blob([req.file.buffer as unknown as ArrayBuffer], { type: req.file.mimetype }), req.file.originalname);
        fd.append("source_type", sourceType);

        logger.info({ sourceType, file: fileName, endpoint: workerEndpoint }, "Sending to Python worker");

        const workerRes = await fetch(`${pythonWorkerUrl}${workerEndpoint}`, {
          method: "POST",
          body: fd,
          signal: AbortSignal.timeout(30_000),
        });

        if (workerRes.ok) {
          const workerData = await workerRes.json() as {
            ok: boolean; rows?: unknown[]; detected_columns?: string[];
            warnings?: string[]; errors?: string[]; metadata?: Record<string, unknown>;
            extraction_method?: string; confidence?: number;
            text?: string; page_count?: number; total_chars?: number;
          };

          if (workerData.ok && Array.isArray(workerData.rows) && workerData.rows.length > 0) {
            // Structured rows — use them directly
            parsedFile = {
              parser: isPdfFile ? "pdf" : isCsv ? "csv" : "excel",
              rowCount: workerData.rows.length,
              detectedColumns: (workerData.metadata?.detected_columns as string[]) ?? workerData.detected_columns ?? [],
              parsedRows: workerData.rows as Record<string, unknown>[],
              status: "parsed",
              notes: [
                `Python extracted ${workerData.rows.length} rows via ${workerData.extraction_method ?? "python"}.`,
                ...(workerData.warnings ?? []),
              ],
              extractionMethod: (workerData.extraction_method ?? "csv_column_match") as "generic_rules",
              extractionConfidence: workerData.confidence ?? 0.95,
            };
            usedPythonWorker = true;
          } else if (workerData.ok && workerData.text && workerData.text.length > 50) {
            // PDF text path — invoice AI flow
            parsedFile = {
              parser: "pdf",
              rowCount: 0,
              detectedColumns: [],
              status: "parsed",
              textPreview: workerData.text.slice(0, 2000),
              textLength: workerData.total_chars ?? workerData.text.length,
              pageCount: workerData.page_count,
              notes: [`Python extracted PDF text (${workerData.total_chars ?? 0} chars).`, ...(workerData.warnings ?? [])],
              extractionMethod: "pdf_text_python" as "generic_rules",
              extractionConfidence: 0.8,
            };
            usedPythonWorker = true;
          } else {
            logger.warn({ sourceType, file: fileName, endpoint: workerEndpoint,
              pyErrors: (workerData as { errors?: string[] }).errors,
              pyWarnings: (workerData as { warnings?: string[] }).warnings },
              "Python worker returned 0 rows — falling back to TypeScript parser");
          }
        } else {
          logger.warn({ sourceType, file: fileName, status: workerRes.status, endpoint: workerEndpoint },
            "Python worker non-200 — falling back to TypeScript parser");
        }
      } catch (workerErr) {
        logger.warn({ sourceType, file: fileName, err: workerErr instanceof Error ? workerErr.message : "unknown" },
          "Python worker unreachable — falling back to TypeScript parser");
      }
    }

    // TypeScript parser — only as last-resort fallback
    if (!usedPythonWorker) {
      try {
        parsedFile = await parseUploadedFile(req.file, sourceType);
      } catch (err) {
        parsedFile = parsingFallback(req.file, err);
        await writeAuditLog({
          action: "upload.parse_failed",
          companyId,
          userId: req.auth?.userId,
          actorEmail: req.auth?.email,
          metadata: { fileName, sourceType, error: err instanceof Error ? err.message : "Unknown parse error" },
          ipAddress: req.ip,
        });
      }
    }

  } else {
    const parsed = CreateUploadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    parsedFile = {
      ...parsedFile,
      rowCount: parsed.data.recordCount ?? 0,
    };
  }

  const [uploadRecord] = await db.insert(uploadBatchesTable).values({
    companyId,
    sourceType,
    fileName,
    recordCount: parsedFile.rowCount,
    status: parsedFile.status === "parsed" ? "processed" : "metadata_only",
  }).returning();

  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);

  const [document] = await db.insert(documentsTable).values({
    companyId,
    uploadBatchId: uploadRecord.id,
    fileName: uploadRecord.fileName,
    sourceType: uploadRecord.sourceType,
    mimeType: req.file?.mimetype ?? null,
    storageProvider: storedObject?.provider ?? "metadata_only",
    storageBucket: storedObject?.bucket ?? null,
    storageRegion: storedObject?.region ?? null,
    storageKey: storedObject?.key ?? null,
    storageUrl: storedObject?.url ?? null,
    sizeBytes: storedObject?.sizeBytes ?? req.file?.size ?? null,
    checksumSha256: storedObject?.checksumSha256 ?? null,
    status: parsedFile.status === "parsed" ? "parsed" : "metadata_captured",
    extractedTextStatus: extractedTextStatus(parsedFile),
    rowCount: parsedFile.rowCount,
    detectedColumns: {
      parser: parsedFile.parser,
      columns: parsedFile.detectedColumns,
      parsedRows: parsedFile.parsedRows ?? [],
      sheetNames: parsedFile.sheetNames ?? [],
      pageCount: parsedFile.pageCount ?? null,
      textPreview: parsedFile.textPreview ?? null,
      textLength: parsedFile.textLength ?? parsedFile.textPreview?.length ?? null,
      tablesDetected: parsedFile.tablesDetected ?? 0,
      notes: parsedFile.notes,
    },
    uploadedByUserId: req.auth?.userId ?? null,
    retentionUntil: retentionUntil(company?.dataRetentionDays),
  }).returning();

  await writeAuditLog({
    action: parsedFile.status === "parsed" ? "upload.parsed" : "upload.metadata_captured",
    companyId,
    userId: req.auth?.userId,
    actorEmail: req.auth?.email,
    entityId: document.id,
    metadata: {
      fileName: uploadRecord.fileName,
      sourceType: uploadRecord.sourceType,
      parser: parsedFile.parser,
      rowCount: parsedFile.rowCount,
      detectedColumns: parsedFile.detectedColumns,
      parsedRows: parsedFile.parsedRows ?? [],
      notes: parsedFile.notes,
      storageProvider: document.storageProvider,
      storageKey: document.storageKey,
      checksumSha256: document.checksumSha256,
    },
    ipAddress: req.ip,
  });

  let imported: UploadImportSummary = {
    table: null,
    inserted: 0,
    skipped: parsedFile.parsedRows?.length ?? 0,
    notes: ["No importer ran for this upload."],
  };
  let reconciliation: Awaited<ReturnType<typeof runAndPersistReconciliation>> | null = null;
  try {
    imported = await ingestParsedUpload({
      companyId,
      sourceType: uploadRecord.sourceType,
      fileName: uploadRecord.fileName,
      parsedFile,
      uploadId: uploadRecord.id,
    });
    if (imported.inserted > 0) {
      reconciliation = await runAndPersistReconciliation(companyId);
      await writeAuditLog({
        action: "upload.rows_imported",
        companyId,
        userId: req.auth?.userId,
        actorEmail: req.auth?.email,
        entityId: document.id,
        metadata: {
          fileName: uploadRecord.fileName,
          sourceType: uploadRecord.sourceType,
          table: imported.table,
          inserted: imported.inserted,
          skipped: imported.skipped,
          matchesFound: reconciliation.matchesFound,
        },
        ipAddress: req.ip,
      });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : "unknown" }, "Upload row import failed");
    imported = {
      table: imported.table,
      inserted: 0,
      skipped: parsedFile.parsedRows?.length ?? 0,
      notes: ["Rows were parsed, but importing them failed. Potential risk — needs CA review."],
    };
  }

  let aiExtraction: unknown = null;
  if (shouldRunAiExtraction(req.body as Record<string, unknown>, sourceType, parsedFile)) {
    const result = await runAIJsonTask({
      companyId,
      userId: req.auth?.userId,
      purpose: "invoice_extraction",
      schemaName: "invoice_extraction",
      schema: invoiceExtractionSchema,
      schemaDescription: invoiceExtractionSchemaDescription,
      input: {
        text: parsedFile.textPreview,
        fileName: uploadRecord.fileName,
        sourceType: uploadRecord.sourceType,
      },
      prompt: "Extract invoice fields from the uploaded text preview only. Return pending-review data, never verified data.",
    });
    aiExtraction = {
      provider: result.provider,
      model: result.model ?? null,
      confidence: result.confidence,
      status: "extracted_pending_review",
      source: result.provider === "rule_based" ? "deterministic rule" : "AI suggestion",
      data: result.data ?? null,
      error: result.error ?? null,
    };

    if (result.data) {
      try {
        await db.insert(aiExtractionsTable).values({
          companyId,
          uploadId: uploadRecord.id,
          entityType: "document",
          entityId: document.id,
          provider: result.provider,
          model: result.model ?? null,
          purpose: "invoice_extraction",
          extractedJson: result.data as Record<string, unknown>,
          confidence: String(result.confidence),
          status: "extracted_pending_review",
          createdBy: req.auth?.userId ?? null,
        });
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : "unknown" }, "AI extraction metadata write failed");
      }
    }
  }

  res.status(201).json({
    ...mapUpload(uploadRecord),
    parsing: {
      documentId: document.id,
      parser: parsedFile.parser,
      status: parsedFile.status,
      rowCount: parsedFile.rowCount,
      detectedColumns: parsedFile.detectedColumns,
      sheetNames: parsedFile.sheetNames ?? [],
      pageCount: parsedFile.pageCount ?? null,
      textPreview: parsedFile.textPreview ?? null,
      textLength: parsedFile.textLength ?? parsedFile.textPreview?.length ?? null,
      tablesDetected: parsedFile.tablesDetected ?? 0,
      notes: parsedFile.notes,
    },
    aiExtraction,
    imported,
    reconciliation,
  });
});

// ── DELETE /uploads/:id — remove from active workflow ────────────────────────
// Without ?force=true: only removes if no imported rows exist (safe delete)
// With ?force=true: cascade-deletes all imported rows for this upload
router.delete("/uploads/:id", requirePermission("uploads.delete"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const companyId = getCompanyId(req);
  const force = req.query.force === "true";

  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid upload id" });
    return;
  }

  try {
  const [batch] = await db.select().from(uploadBatchesTable)
    .where(and(eq(uploadBatchesTable.id, id), eq(uploadBatchesTable.companyId, companyId)))
    .limit(1);

  if (!batch) {
    res.status(404).json({ error: "Upload not found" });
    return;
  }

  // Check if rows were imported for this upload
  const [txnCount, invCount, ledgerCount, payrollCount, gatewayCount, gstCount] = await Promise.all([
    db.select({ id: bankTransactionsTable.id }).from(bankTransactionsTable)
      .where(and(eq(bankTransactionsTable.companyId, companyId), eq(bankTransactionsTable.sourceUploadId, id))),
    db.select({ id: invoicesTable.id }).from(invoicesTable)
      .where(and(eq(invoicesTable.companyId, companyId), eq(invoicesTable.sourceUploadId, id))),
    db.select({ id: ledgerEntriesTable.id }).from(ledgerEntriesTable)
      .where(and(eq(ledgerEntriesTable.companyId, companyId), eq(ledgerEntriesTable.sourceUploadId, id))),
    db.select({ id: payrollEntriesTable.id }).from(payrollEntriesTable)
      .where(and(eq(payrollEntriesTable.companyId, companyId), eq(payrollEntriesTable.sourceUploadId, id))),
    db.select({ id: gatewaySettlementsTable.id }).from(gatewaySettlementsTable)
      .where(and(eq(gatewaySettlementsTable.companyId, companyId), eq(gatewaySettlementsTable.sourceUploadId, id))),
    db.select({ id: gstRecordsTable.id }).from(gstRecordsTable)
      .where(and(eq(gstRecordsTable.companyId, companyId), eq(gstRecordsTable.sourceUploadId, id))),
  ]);

  const totalImported = txnCount.length + invCount.length + ledgerCount.length + payrollCount.length + gatewayCount.length + gstCount.length;

  if (totalImported > 0 && !force) {
    res.status(409).json({
      error: `This upload has ${totalImported} imported rows. Confirm cascade deletion to remove it.`,
      requiresForce: true,
      importedRows: totalImported,
    });
    return;
  }

  if (force && totalImported > 0) {
    // Cascade delete imported rows
    const txnIds = txnCount.map(t => t.id);
    const invIds = invCount.map(i => i.id);
    const ledgerIds = ledgerCount.map(l => l.id);
    const matchConditions = [
      txnIds.length ? inArray(reconciliationMatchesTable.bankTransactionId, txnIds) : undefined,
      invIds.length ? inArray(reconciliationMatchesTable.invoiceId, invIds) : undefined,
      ledgerIds.length ? inArray(reconciliationMatchesTable.ledgerEntryId, ledgerIds) : undefined,
    ].filter(Boolean);

    // Remove reconciliation matches tied to these rows first
    if (matchConditions.length > 0) {
      await db.delete(reconciliationMatchesTable)
        .where(and(
          eq(reconciliationMatchesTable.companyId, companyId),
          matchConditions.length === 1 ? matchConditions[0] : or(...matchConditions),
        ));
    }

    // Delete the imported rows
    if (txnCount.length) await db.delete(bankTransactionsTable).where(and(eq(bankTransactionsTable.companyId, companyId), eq(bankTransactionsTable.sourceUploadId, id)));
    if (invCount.length) await db.delete(invoicesTable).where(and(eq(invoicesTable.companyId, companyId), eq(invoicesTable.sourceUploadId, id)));
    if (ledgerCount.length) await db.delete(ledgerEntriesTable).where(and(eq(ledgerEntriesTable.companyId, companyId), eq(ledgerEntriesTable.sourceUploadId, id)));
    if (payrollCount.length) await db.delete(payrollEntriesTable).where(and(eq(payrollEntriesTable.companyId, companyId), eq(payrollEntriesTable.sourceUploadId, id)));
    if (gatewayCount.length) await db.delete(gatewaySettlementsTable).where(and(eq(gatewaySettlementsTable.companyId, companyId), eq(gatewaySettlementsTable.sourceUploadId, id)));
    if (gstCount.length) await db.delete(gstRecordsTable).where(and(eq(gstRecordsTable.companyId, companyId), eq(gstRecordsTable.sourceUploadId, id)));
  }

  // Mark batch as removed (soft-delete — keeps audit history)
  await db.update(uploadBatchesTable)
    .set({ status: "removed" })
    .where(and(eq(uploadBatchesTable.id, id), eq(uploadBatchesTable.companyId, companyId)));

  await writeAuditLog({
    action: force ? "upload.force_removed" : "upload.removed",
    companyId,
    userId: req.auth?.userId,
    actorEmail: req.auth?.email,
    entityId: id,
    metadata: { fileName: batch.fileName, sourceType: batch.sourceType, cascadeDeleted: totalImported, force },
    ipAddress: req.ip,
  });

  res.json({ ok: true, id, cascadeDeleted: totalImported });
  } catch (err) {
    logger.error({
      err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      uploadId: id,
      companyId,
      force,
    }, "Upload removal failed");
    res.status(500).json({
      error: "Could not remove upload",
      detail: "The upload could not be removed. Check the API logs for the exact database error.",
    });
  }
});

// ── GET /uploads/:id/details — full details for the details modal ─────────────
router.get("/uploads/:id/details", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const companyId = getCompanyId(req);

  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid upload id" });
    return;
  }

  const [batch] = await db.select().from(uploadBatchesTable)
    .where(and(eq(uploadBatchesTable.id, id), eq(uploadBatchesTable.companyId, companyId)))
    .limit(1);

  if (!batch) {
    res.status(404).json({ error: "Upload not found" });
    return;
  }

  const [doc] = await db.select().from(documentsTable)
    .where(and(eq(documentsTable.uploadBatchId, id), eq(documentsTable.companyId, companyId)))
    .limit(1);

  const aiExtractions = await db.select().from(aiExtractionsTable)
    .where(and(eq(aiExtractionsTable.uploadId, id), eq(aiExtractionsTable.companyId, companyId)))
    .orderBy(desc(aiExtractionsTable.createdAt));

  const detectedColumnsRaw = doc?.detectedColumns as Record<string, unknown> | null;

  res.json({
    id: batch.id,
    fileName: batch.fileName,
    sourceType: batch.sourceType,
    status: batch.status,
    uploadedAt: batch.uploadedAt.toISOString(),
    recordCount: batch.recordCount ?? null,
    document: doc ? {
      id: doc.id,
      mimeType: doc.mimeType ?? null,
      sizeBytes: doc.sizeBytes ?? null,
      rowCount: doc.rowCount ?? null,
      detectedColumns: Array.isArray(detectedColumnsRaw?.columns) ? detectedColumnsRaw.columns : [],
      parser: detectedColumnsRaw?.parser ?? null,
      extractionMethod: detectedColumnsRaw?.extractionMethod ?? null,
      extractionConfidence: detectedColumnsRaw?.extractionConfidence ?? null,
      notes: Array.isArray(detectedColumnsRaw?.notes) ? detectedColumnsRaw.notes : [],
      extractedTextStatus: doc.extractedTextStatus ?? "not_started",
      storageProvider: doc.storageProvider,
    } : null,
    aiExtractions: aiExtractions.map(e => ({
      id: e.id,
      provider: e.provider,
      model: e.model ?? null,
      status: e.status,
      confidence: e.confidence,
      purpose: e.purpose,
      data: e.extractedJson ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
  });
});

// ── POST /uploads/:id/reprocess — re-parse with Python then TS fallback ───────
router.post("/uploads/:id/reprocess", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const companyId = getCompanyId(req);

  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid upload id" });
    return;
  }

  const [batch] = await db.select().from(uploadBatchesTable)
    .where(and(eq(uploadBatchesTable.id, id), eq(uploadBatchesTable.companyId, companyId)))
    .limit(1);

  if (!batch) {
    res.status(404).json({ error: "Upload not found" });
    return;
  }

  const [doc] = await db.select().from(documentsTable)
    .where(and(eq(documentsTable.uploadBatchId, id), eq(documentsTable.companyId, companyId)))
    .limit(1);

  if (!doc?.storageUrl && !doc?.storageKey) {
    res.status(422).json({ error: "No stored file found for this upload. Re-upload the file to reprocess." });
    return;
  }

  // For reprocess we call the Python worker directly via URL if available
  const pythonWorkerUrl = process.env.PYTHON_WORKER_URL;
  let rowsExtracted = 0;
  let method = "unavailable";
  let confidence = 0;

  if (pythonWorkerUrl && doc.storageUrl) {
    try {
      const sourceExtractMap: Record<string, string> = {
        bank: "bank-statement", bank_statement: "bank-statement",
        tally: "tally-ledger", zoho: "tally-ledger", ledger: "tally-ledger",
        gateway: "gateway-statement",
        gst: "gst-tds", tds: "gst-tds",
        payroll: "payroll",
        expense: "expense", expenses: "expense",
        invoice: "invoice", invoices: "invoice",
      };
      const extractEndpoint = sourceExtractMap[batch.sourceType.toLowerCase()] ?? "csv";
      const endpoint = `/extract/${extractEndpoint}`;

      const fileRes = await fetch(doc.storageUrl, { signal: AbortSignal.timeout(10_000) });
      if (fileRes.ok) {
        const blob = await fileRes.blob();
        const fd = new globalThis.FormData();
        fd.append("file", blob, batch.fileName);
        fd.append("source_type", batch.sourceType);

        const workerRes = await fetch(`${pythonWorkerUrl}${endpoint}`, {
          method: "POST", body: fd, signal: AbortSignal.timeout(30_000),
        });
        if (workerRes.ok) {
          const data = await workerRes.json() as { ok: boolean; rows?: unknown[]; extraction_method?: string; confidence?: number };
          if (data.ok && Array.isArray(data.rows) && data.rows.length > 0) {
            rowsExtracted = data.rows.length;
            method = data.extraction_method ?? "python";
            confidence = data.confidence ?? 0.95;
            // Update document with new row count
            await db.update(documentsTable)
              .set({ rowCount: rowsExtracted, status: "parsed" })
              .where(eq(documentsTable.id, doc.id));
            await db.update(uploadBatchesTable)
              .set({ recordCount: rowsExtracted, status: "processed" })
              .where(eq(uploadBatchesTable.id, id));
          }
        }
      }
    } catch { /* Python unavailable — return what we have */ }
  }

  await writeAuditLog({
    action: "upload.reprocessed",
    companyId,
    userId: req.auth?.userId,
    actorEmail: req.auth?.email,
    entityId: id,
    metadata: { fileName: batch.fileName, sourceType: batch.sourceType, method, rowsExtracted },
    ipAddress: req.ip,
  });

  res.json({ ok: true, method, rowsExtracted, inserted: 0, confidence });
});

export default router;
