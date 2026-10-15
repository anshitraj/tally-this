/**
 * GSTR-2B ↔ Books job.
 * Two plain uploads (the portal's GSTR-2B and the purchase register); the server reads both,
 * matches them by rule and answers with what agrees and what needs a person.
 */
import { Router, type IRouter, type Request } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { auditAction, requirePermission } from "../middleware/authz";
import { resolveBooksCompanyId } from "../services/companyScope";
import { privacyGate } from "../services/privacy";
import { MAX_UPLOAD_BYTES } from "../lib/uploadLimit";
import { advanceRun, createWorkflowRun, finishRun, saveRunArtifact } from "../services/workflowRunService";
import { applyDecision, linkItems, reconcile, type GstDoc, type ReconResult, type ReviewStatus } from "../services/gstrRecon";
import { kindOfGstFile, readPortalFile, readRegisterFile, type ColumnAssist, type UploadedBuffer } from "../services/gstrFiles";
import { AI_FIELDS } from "../services/gstrRecon";
import { runAIJsonTask } from "../server/ai/providerRouter";
import { columnMappingSchema, schemaDescriptions } from "../server/ai/validators";
import { buildGstrWorkbook, gstrWorkbookSchema } from "../services/gstrReconWorkbook";

const router: IRouter = Router();
/** Up to a year of GSTR-2B files can be compared with one purchase register. */
const MAX_PORTAL_FILES = 12;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_PORTAL_FILES + 1 } });

/** Beyond this the saved copy keeps only what needs a decision; the screen and the download still have everything. */
const SAVE_LIMIT = 30000;

function filesOf(req: Request, field: string): UploadedBuffer[] {
  const files = req.files;
  if (!files || Array.isArray(files)) return [];
  return files[field] ?? [];
}

function textBody(value: unknown) {
  return typeof value === "string" ? value : "";
}

router.post(
  "/jobs/gstr-2b/compare",
  requirePermission("uploads.create"),
  upload.fields([
    { name: "gstr2b", maxCount: MAX_PORTAL_FILES },
    { name: "books", maxCount: 1 },
  ]),
  async (req, res): Promise<void> => {
    const companyId = await resolveBooksCompanyId(req, res);
    if (companyId == null) return;
    const gate = await privacyGate(req, res);
    if (!gate) return;

    let portalFiles = filesOf(req, "gstr2b");
    let booksFile = filesOf(req, "books")[0];
    if (portalFiles.length === 0 || !booksFile) {
      res.status(400).json({ ok: false, message: "Upload both files: GSTR-2B from the GST portal, and your purchase register." });
      return;
    }
    // The two files can arrive the wrong way round; that is put right without asking.
    if (portalFiles.length === 1 && kindOfGstFile(portalFiles[0]) === "register" && kindOfGstFile(booksFile) === "portal") {
      [portalFiles, booksFile] = [[booksFile], portalFiles[0]];
    }
    const portalFile = portalFiles[0];

    let result: ReconResult;
    let portalCount = 0;
    let booksCount = 0;
    try {
      const notes: string[] = [];
      const docs: GstDoc[] = [];
      const periods: string[] = [];
      let recipient: string | null = null;
      const seen = new Set<string>();
      let repeated = 0;
      for (const file of portalFiles) {
        const portal = readPortalFile(file);
        if (portal.period) periods.push(portal.period);
        if (portal.recipientGstin) {
          if (recipient && recipient !== portal.recipientGstin) {
            throw new Error(`These GSTR-2B files belong to different GSTINs (${recipient} and ${portal.recipientGstin}). Compare one GSTIN at a time.`);
          }
          recipient = portal.recipientGstin;
        }
        notes.push(...portal.notes.map(note => (portalFiles.length > 1 ? `${file.originalname}: ${note}` : note)));
        for (const doc of portal.docs) {
          // The same GSTR-2B uploaded twice must not double every amount.
          const signature = [doc.gstin, doc.kind, doc.docKey, doc.docDate, doc.taxable, doc.igst, doc.cgst, doc.sgst, doc.cess].join("|");
          if (portalFiles.length > 1 && seen.has(signature)) {
            repeated += 1;
            continue;
          }
          seen.add(signature);
          docs.push(doc);
        }
      }
      if (repeated > 0) notes.push(`${repeated} ${repeated === 1 ? "document appears" : "documents appear"} in more than one GSTR-2B file and ${repeated === 1 ? "was" : "were"} counted once.`);
      // Only used when the headings are not recognised. In Incognito it needs the person's consent.
      const assist: ColumnAssist | undefined =
        gate.privacy && !gate.allowAi
          ? undefined
          : async columns => {
              const answer = await runAIJsonTask({
                companyId,
                userId: req.auth?.userId,
                purpose: "column_mapping",
                schemaName: "column_mapping",
                schema: columnMappingSchema,
                schemaDescription: schemaDescriptions.column_mapping,
                input: {
                  sourceType: "tally",
                  task: "Columns of a purchase register that will be compared with GSTR-2B.",
                  allowedFields: AI_FIELDS,
                  columns: columns.map(column => ({
                    column: column.header,
                    shareLookingLikeGstin: column.gstin,
                    shareLookingLikeDate: column.date,
                    shareLookingLikeAmount: column.amount,
                    shareLookingLikeText: column.text,
                  })),
                },
                prompt:
                  "For each column give mappedField as exactly one of allowedFields, or null when none fits. Use only the column names provided. Several columns may be igst, cgst, sgst or cess. Never invent a column.",
              });
              // The rule-based fallback has no opinion about headings; it is not a suggestion.
              if (!answer.ok || answer.provider === "rule_based" || !answer.data) return [];
              return answer.data.mappings.map(mapping => ({ originalColumn: mapping.originalColumn, mappedField: mapping.mappedField, confidence: mapping.confidence }));
            };
      const register = await readRegisterFile(booksFile, assist);
      portalCount = docs.length;
      booksCount = register.docs.length;
      result = reconcile(docs, register.docs, {
        periods,
        recipientGstin: recipient,
        notes: [...notes, ...register.notes],
      });
    } catch (error) {
      res.status(422).json({ ok: false, message: error instanceof Error ? error.message : "These files could not be read." });
      return;
    }

    let runId: string | null = null;
    if (!gate.privacy) {
      try {
        const attention = result.items.filter(item => item.bucket !== "matched");
        const saved = result.items.length > SAVE_LIMIT ? attention : result.items;
        const clientId = Number(req.body?.clientId) || null;
        runId = await createWorkflowRun({
          companyId,
          runType: "gstr_2b_reconciliation",
          createdBy: req.auth?.userId ?? null,
          clientId: clientId ?? companyId,
          meta: { customTitle: `GSTR-2B ↔ Books — ${portalFiles.length > 1 ? `${portalFiles.length} months` : portalFile.originalname}`, clientId: clientId ? String(clientId) : "", clientName: textBody(req.body?.clientName) },
        });
        if (!runId.startsWith("local-")) {
          await db
            .execute(sql`UPDATE workflow_runs SET metadata_json = ${JSON.stringify({ clientId, clientName: textBody(req.body?.clientName) || null })}::jsonb WHERE id = ${runId} AND company_id = ${companyId}`)
            .catch(() => undefined);
        }
        await advanceRun(runId, 2);
        await saveRunArtifact(runId, {
          artifactType: "gstr2b_comparison",
          title: "GSTR-2B ↔ Books",
          jsonData: {
            period: result.period,
            periods: result.periods,
            recipientGstin: result.recipientGstin,
            comparison: { items: saved, counts: result.counts },
            totals: result.totals,
            byHead: result.byHead,
            suppliers: result.suppliers,
            vendors: result.vendors,
            notes: result.notes,
            truncated: saved.length < result.items.length,
            files: { portal: portalFiles.map(file => file.originalname).join(", "), books: booksFile.originalname },
          },
        });
        await finishRun(runId, "completed");
        await auditAction(req, "job.gstr2b_compared", "workflow_run", null, { runId, counts: result.counts });
      } catch {
        // The comparison itself is done; failing to save it must not lose the result on screen.
        runId = null;
      }
    }

    res.json({
      ok: true,
      privacy: gate.privacy,
      runId,
      period: result.period,
      periods: result.periods,
      recipientGstin: result.recipientGstin,
      files: { portal: portalFiles.map(file => file.originalname).join(", "), books: booksFile.originalname },
      portalCount,
      booksCount,
      counts: result.counts,
      totals: result.totals,
      byHead: result.byHead,
      suppliers: result.suppliers,
      vendors: result.vendors,
      notes: result.notes,
      items: result.items,
    });
  },
);

router.post("/jobs/gstr-2b/runs/:id/decision", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const runId = String(req.params.id);
  const key = textBody(req.body?.key);
  const status = textBody(req.body?.status) as ReviewStatus;
  if (!key || !["suggested", "approved", "rejected", "needs_info"].includes(status)) {
    res.status(400).json({ ok: false, message: "A review decision needs an item and a status." });
    return;
  }
  try {
    const found = await db.execute(sql`
      SELECT ra.id, ra.json_data
      FROM run_artifacts ra
      JOIN workflow_runs wr ON wr.id = ra.run_id
      WHERE wr.id = ${runId} AND wr.company_id = ${companyId} AND ra.artifact_type = 'gstr2b_comparison'
      ORDER BY ra.created_at DESC
      LIMIT 1
    `);
    const row = found.rows[0] as { id: number; json_data: { comparison?: { items: Parameters<typeof applyDecision>[0] } } } | undefined;
    if (!row?.json_data?.comparison) {
      res.status(404).json({ ok: false, message: "This run has no reconciliation to review." });
      return;
    }
    const items = applyDecision(row.json_data.comparison.items, key, status);
    const next = { ...row.json_data, comparison: { ...row.json_data.comparison, items } };
    await db.execute(sql`UPDATE run_artifacts SET json_data = ${JSON.stringify(next)}::jsonb WHERE id = ${row.id}`);
    await auditAction(req, "job.match_decision", "workflow_run", null, { runId, key, status });
    res.json({ ok: true, runId });
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : "The decision could not be saved." });
  }
});

/**
 * Pairs a document that is only in the books with one that is only in GSTR-2B, because the
 * person says they are the same invoice. A saved run is updated; an Incognito run sends its items.
 */
router.post("/jobs/gstr-2b/link", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const booksKey = textBody(req.body?.booksKey);
  const portalKey = textBody(req.body?.portalKey);
  const runId = textBody(req.body?.runId);
  if (!booksKey || !portalKey) {
    res.status(400).json({ ok: false, message: "Choose the document in your books and the one in GSTR-2B." });
    return;
  }
  try {
    let artifactId: number | null = null;
    let saved: Record<string, any> | null = null;
    let result: Pick<ReconResult, "items" | "counts" | "byHead"> | null = null;
    if (runId) {
      const found = await db.execute(sql`
        SELECT ra.id, ra.json_data
        FROM run_artifacts ra
        JOIN workflow_runs wr ON wr.id = ra.run_id
        WHERE wr.id = ${runId} AND wr.company_id = ${companyId} AND ra.artifact_type = 'gstr2b_comparison'
        ORDER BY ra.created_at DESC
        LIMIT 1
      `);
      const row = found.rows[0] as { id: number; json_data: Record<string, any> } | undefined;
      if (!row?.json_data?.comparison?.items || !row.json_data.byHead) {
        res.status(404).json({ ok: false, message: "This saved result was not found." });
        return;
      }
      artifactId = row.id;
      saved = row.json_data;
      result = { items: saved.comparison.items, counts: saved.comparison.counts, byHead: saved.byHead };
    } else if (Array.isArray(req.body?.items) && req.body?.counts && req.body?.byHead) {
      result = { items: req.body.items, counts: req.body.counts, byHead: req.body.byHead };
    }
    if (!result) {
      res.status(400).json({ ok: false, message: "There is no result to update. Run the comparison again." });
      return;
    }
    const linked = linkItems(result, booksKey, portalKey);
    if (!linked.ok) {
      res.status(422).json({ ok: false, message: linked.message });
      return;
    }
    if (artifactId != null && saved) {
      const next = {
        ...saved,
        comparison: { ...saved.comparison, items: linked.items, counts: linked.summary.counts },
        totals: linked.summary.totals,
        byHead: linked.summary.byHead,
        suppliers: linked.summary.suppliers,
        vendors: linked.summary.vendors,
      };
      await db.execute(sql`UPDATE run_artifacts SET json_data = ${JSON.stringify(next)}::jsonb WHERE id = ${artifactId}`);
      await auditAction(req, "job.gstr2b_linked", "workflow_run", null, { runId, booksKey, portalKey });
    }
    const merged = linked.items.find(item => item.key === `l-${booksKey}-${portalKey}`);
    res.json({ ok: true, removed: [booksKey, portalKey], merged, summary: linked.summary });
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : "The documents could not be linked." });
  }
});

router.post("/jobs/gstr-2b/excel", requirePermission("reports.export"), async (req, res): Promise<void> => {
  let payload: unknown = req.body;
  // A large result is read back from the saved run instead of being sent up again.
  if (typeof req.body?.runId === "string" && !Array.isArray(req.body?.items)) {
    const companyId = await resolveBooksCompanyId(req, res);
    if (companyId == null) return;
    try {
      const found = await db.execute(sql`
        SELECT ra.json_data
        FROM run_artifacts ra
        JOIN workflow_runs wr ON wr.id = ra.run_id
        WHERE wr.id = ${req.body.runId} AND wr.company_id = ${companyId} AND ra.artifact_type = 'gstr2b_comparison'
        ORDER BY ra.created_at DESC
        LIMIT 1
      `);
      const saved = (found.rows[0] as { json_data?: Record<string, unknown> } | undefined)?.json_data;
      const comparison = saved?.comparison as { items?: unknown; counts?: unknown } | undefined;
      if (!saved || !comparison?.items) {
        res.status(404).json({ ok: false, message: "That saved result was not found." });
        return;
      }
      payload = {
        clientName: textBody(req.body?.clientName) || "Client",
        period: saved.period,
        recipientGstin: saved.recipientGstin,
        periods: saved.periods,
        items: comparison.items,
        counts: comparison.counts,
        totals: saved.totals,
        byHead: saved.byHead,
        suppliers: saved.suppliers,
        vendors: saved.vendors,
        notes: saved.notes,
      };
    } catch {
      res.status(500).json({ ok: false, message: "The saved result could not be opened. Try again." });
      return;
    }
  }
  const parsed = gstrWorkbookSchema.safeParse(payload);
  if (!parsed.success) {
    res.status(422).json({ ok: false, message: "The Excel file could not be created from this result. Run the comparison again." });
    return;
  }
  try {
    const workbook = buildGstrWorkbook(parsed.data, req.auth?.email ?? "Accounts team");
    const bytes = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="TallyThis_GSTR2B_Reconciliation.xlsx"');
    res.send(Buffer.from(bytes));
    void auditAction(req, "job.gstr2b_excel_generated", "workflow_run", null, { documents: parsed.data.items.length }).catch(() => undefined);
  } catch {
    res.status(500).json({ ok: false, message: "The Excel file could not be created. Try again." });
  }
});

export default router;
