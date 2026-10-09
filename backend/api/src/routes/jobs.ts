/**
 * Job APIs for the four accounting automations.
 * Each accepts plain file uploads; the server works out the file type, the bank,
 * and the marketplace. Each successful command stores one workflow run and its artifacts.
 * Results are read back only for that run and company.
 */
import { Router, type IRouter, type Request } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requirePermission, auditAction } from "../middleware/authz";
import { resolveBooksCompanyId } from "../services/companyScope";
import { parseBankStatement, unifyParties, type BankStatementSummary, type NormalizedBankTxn } from "../services/bankStatement";
import { buildTallyVoucherXml, LEDGER_OPTIONS, suggestLedger, type LedgerMapping } from "../services/tallyVoucherXml";
import { applyDecision, compareBankWithTally, parseTallyLedgerCsv, type ReviewStatus } from "../services/statementCompare";
import { buildGstDraftJson, mergeEcommercePacks, normalizeMarketplaceCsv, salesToCsv, type EcommercePack, type MarketplacePlatform } from "../services/ecommerceGst";
import { compareInvoicesWithBank, parseInvoiceCsv, type InvoiceRow } from "../services/invoiceVerify";
import { advanceRun, createWorkflowRun, finishRun, saveRunArtifact, type WorkflowRunType } from "../services/workflowRunService";
import { detectFileKind, detectMarketplace, readBankStatementFile, readInvoiceFiles, sheetToCsvText, type UploadedFile } from "../services/fileReaders";
import type { StatementCheck } from "../services/statementCheck";
import { privacyGate, type PrivacyGate } from "../services/privacy";
import { AI_BLOCKED_MESSAGE, AI_CONSENT_MESSAGE, historyCutoff, historyMonths, outsideWindowMessage } from "../services/privacyPolicy";
import { aiLedgerPicks, groupLedgers } from "../services/ledgerSuggest";
import { supportEmail } from "../lib/brand";
import { BANK_NAMES } from "../services/bankDirectory";
import { bankWorkbookSchema, buildBankToTallyWorkbook } from "../services/bankToTallyWorkbook";
import { ecommerceWorkbookSchema, buildEcommerceWorkbook } from "../services/ecommerceWorkbook";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });

const PLATFORMS = new Set(["amazon", "flipkart", "meesho", "myntra", "jiomart", "generic"]);

function textBody(value: unknown) {
  return typeof value === "string" ? value : "";
}

function filesOf(req: Request, field: string): UploadedFile[] {
  const files = req.files;
  if (!files) return [];
  if (Array.isArray(files)) return field === "files" ? files : [];
  return files[field] ?? [];
}

async function rememberRun(input: {
  companyId: number;
  userId?: number;
  runType: WorkflowRunType;
  clientId?: number | null;
  clientName?: string;
  title: string;
  artifactType: string;
  artifactTitle: string;
  jsonData: unknown;
}) {
  const runId = await createWorkflowRun({
    companyId: input.companyId,
    runType: input.runType,
    createdBy: input.userId ?? null,
    clientId: input.clientId ?? input.companyId,
    meta: {
      customTitle: input.title,
      clientId: input.clientId ? String(input.clientId) : "",
      clientName: input.clientName ?? "",
    },
  });
  if (!runId.startsWith("local-")) {
    await db.execute(sql`
      UPDATE workflow_runs
      SET metadata_json = ${JSON.stringify({ clientId: input.clientId ?? null, clientName: input.clientName ?? null })}::jsonb
      WHERE id = ${runId} AND company_id = ${input.companyId}
    `).catch(() => undefined);
  }
  await advanceRun(runId, 2);
  await saveRunArtifact(runId, {
    artifactType: input.artifactType,
    title: input.artifactTitle,
    jsonData: input.jsonData,
  });
  await finishRun(runId, "completed");
  return runId;
}

async function rememberedMappings(companyId: number, clientId: string): Promise<LedgerMapping[]> {
  try {
    const result = await db.execute(sql`
      SELECT ra.json_data
      FROM run_artifacts ra
      JOIN workflow_runs wr ON wr.id = ra.run_id
      WHERE wr.company_id = ${companyId}
        AND ra.artifact_type = 'ledger_mappings'
        AND (COALESCE(wr.metadata_json->>'clientId','') = '' OR wr.metadata_json->>'clientId' = ${String(companyId)})
        AND (${clientId} = '' OR wr.metadata_json->>'clientId' = ${clientId})
      ORDER BY ra.created_at DESC
      LIMIT 1
    `);
    const row = result.rows[0] as { json_data?: { mappings?: LedgerMapping[] } } | undefined;
    return row?.json_data?.mappings ?? [];
  } catch {
    return [];
  }
}

/** Bank side of a job: an uploaded file (any format) or pasted CSV text. */
async function bankFromRequest(req: Request, field: string, textField: string, gate: PrivacyGate): Promise<{
  summary: BankStatementSummary | null;
  message: string;
  needsPassword?: boolean;
  wrongPassword?: boolean;
  needsAiConsent?: boolean;
  source?: string;
  check?: StatementCheck;
}> {
  const file = filesOf(req, field)[0] ?? (field === "file" ? req.file : undefined);
  if (file) {
    const read = await readBankStatementFile(file, {
      password: textBody(req.body?.password) || undefined,
      companyId: req.booksCompanyId ?? null,
      userId: req.auth?.userId ?? null,
      privacy: gate.privacy,
      allowAi: gate.allowAi,
    });
    return {
      summary: read.ok ? read.summary : null,
      message: read.message,
      needsPassword: read.needsPassword,
      wrongPassword: read.wrongPassword,
      needsAiConsent: read.needsAiConsent,
      source: read.source,
      check: read.check,
    };
  }
  const text = textBody(req.body?.[textField]);
  if (!text.trim()) return { summary: null, message: "Upload a bank statement." };
  const summary = parseBankStatement(text, textBody(req.body?.bankFileName) || "bank.csv");
  return { summary: summary.transactions.length > 0 ? summary : null, message: summary.message, source: "sheet" };
}

function reviewCount(txns: NormalizedBankTxn[]) {
  return txns.filter(txn => txn.confidence < 0.9).length;
}

// ── Detect: drop any file on Home and get sent to the right job ────────────

router.post("/jobs/detect", requirePermission("uploads.read"), upload.array("files", 20), async (req, res): Promise<void> => {
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const files = filesOf(req, "files");
  if (files.length === 0) {
    res.status(400).json({ ok: false, message: "Choose a file." });
    return;
  }
  const detected = files.map(file => ({ fileName: file.originalname, ...detectFileKind(file) }));
  const kinds = new Set(detected.map(item => item.kind));
  let job: string | null = null;
  if (kinds.has("bank_statement") && kinds.has("tally_export")) job = "bank-tally";
  else if (kinds.has("bank_statement") && (kinds.has("invoice_register") || kinds.has("invoice_document"))) job = "invoice-bank";
  else if (kinds.has("marketplace_report")) job = "ecommerce-gst";
  else if (kinds.has("tally_export")) job = "bank-tally";
  else if (kinds.has("invoice_register") || kinds.has("invoice_document")) job = "invoice-bank";
  else if (kinds.has("bank_statement")) job = "bank-to-tally";
  res.json({ ok: true, files: detected, job });
});

// ── Bank Statement → Tally ─────────────────────────────────────────────────

router.post("/jobs/bank-statement/normalize", requirePermission("uploads.create"), upload.single("file"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const fileName = req.file?.originalname || textBody(req.body?.fileName) || "statement.csv";
  const bank = await bankFromRequest(req, "file", "text", gate);
  if (!bank.summary) {
    res.status(422).json({ ok: false, message: bank.message, needsPassword: bank.needsPassword ?? false, wrongPassword: bank.wrongPassword ?? false, needsAiConsent: bank.needsAiConsent ?? false });
    return;
  }
  const summary = bank.summary;
  const clientId = Number(req.body?.clientId) || null;
  const clientName = textBody(req.body?.clientName);
  // Privacy mode reads no remembered choices and saves nothing.
  const remembered = gate.privacy ? [] : await rememberedMappings(companyId, clientId ? String(clientId) : "");
  const ledgerGroups = groupLedgers(unifyParties(summary.transactions), remembered);
  const runId = gate.privacy ? null : await rememberRun({
    companyId,
    userId: req.auth?.userId,
    runType: "bank_to_tally",
    clientId,
    clientName,
    title: `Bank Statement → Tally — ${fileName}`,
    artifactType: "bank_statement",
    artifactTitle: fileName,
    jsonData: { ...summary, source: bank.source, check: bank.check, ledgerGroups },
  });
  if (!gate.privacy) await auditAction(req, "job.bank_statement_parsed", "workflow_run", null, { runId, fileName, rows: summary.transactions.length, clientId, source: bank.source });
  res.json({
    ok: true,
    privacy: gate.privacy,
    runId,
    ...summary,
    source: bank.source,
    check: bank.check ?? null,
    reviewCount: reviewCount(summary.transactions),
    bankOptions: BANK_NAMES,
    ledgerGroups,
    ledgerOptions: LEDGER_OPTIONS,
    progress: { runId, status: "completed", progressPercent: 100, currentStep: "Ready", steps: ["Upload", "Read", "Check", "Ready"] },
  });
});

router.post("/jobs/bank-to-tally/xml", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const transactions = Array.isArray(req.body?.transactions) ? req.body.transactions as NormalizedBankTxn[] : [];
  const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings as LedgerMapping[] : [];
  const result = buildTallyVoucherXml({
    companyName: textBody(req.body?.clientName) || "Client",
    bankLedger: textBody(req.body?.bankLedger) || "Bank Account",
    transactions,
    mappings,
    createLedgers: req.body?.createLedgers !== false,
    bankGroup: req.body?.bankGroup === "Current Assets" ? "Current Assets" : "Bank Accounts",
  });
  if (!result.ok || !result.xml) {
    res.status(422).json({ ok: false, errors: result.errors, message: "Tally XML was not created because validation failed." });
    return;
  }
  const runId = gate.privacy ? "" : textBody(req.body?.runId);
  if (runId && !runId.startsWith("local-")) {
    const saved = await saveRunArtifact(runId, {
      artifactType: "tally_xml",
      title: result.fileName ?? "tally.xml",
      jsonData: { voucherCount: result.voucherCount, xml: result.xml },
      companyId,
    });
    if (!saved) {
      res.status(404).json({ ok: false, message: "Run not found for this client." });
      return;
    }
  }
  if (!gate.privacy) await auditAction(req, "job.tally_xml_generated", "workflow_run", null, { runId, voucherCount: result.voucherCount, companyId });
  res.json({ ok: true, xml: result.xml, fileName: result.fileName, voucherCount: result.voucherCount, message: `Tally file is ready. ${result.voucherCount} vouchers checked and balanced.` });
});

router.post("/jobs/bank-to-tally/excel", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const parsed = bankWorkbookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, message: "The Excel file could not be created. Review the transactions and try again." });
    return;
  }
  try {
    const workbook = buildBankToTallyWorkbook(parsed.data);
    const bytes = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="TallyThis_Bank_Transactions.xlsx"');
    res.send(Buffer.from(bytes));
    if (!gate.privacy) void auditAction(req, "job.bank_excel_generated", "workflow_run", null, { companyId, rows: parsed.data.rows.length });
  } catch {
    res.status(500).json({ ok: false, message: "The Excel file could not be created. Try again." });
  }
});

// AI ledger picks for parties the rules could not place. Called by the page after results show.
router.post("/jobs/ledger-suggestions", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  // Party names never go to AI in privacy mode.
  if (gate.privacy) {
    res.json({ ok: true, picks: [] });
    return;
  }
  const parties = (Array.isArray(req.body?.parties) ? req.body.parties : [])
    .filter((party: unknown): party is { key: string; direction?: string; sample?: string } => typeof (party as { key?: unknown })?.key === "string")
    .map((party: { key: string; direction?: string; sample?: string }) => ({
      key: party.key.slice(0, 120),
      direction: party.direction === "in" || party.direction === "out" ? party.direction : "both" as const,
      sample: textBody(party.sample).slice(0, 200),
    }));
  const picks = await aiLedgerPicks(parties, { companyId, userId: req.auth?.userId ?? null });
  res.json({ ok: true, picks });
});

router.get("/jobs/ledger-mappings", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  if (gate.privacy) {
    res.json({ mappings: [] });
    return;
  }
  const clientId = typeof req.query.clientId === "string" ? req.query.clientId : "";
  res.json({ mappings: await rememberedMappings(companyId, clientId) });
});

router.post("/jobs/ledger-mappings", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  if (gate.privacy) {
    res.json({ ok: true, skipped: true, mappings: [] });
    return;
  }
  const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
  const runId = await rememberRun({
    companyId,
    userId: req.auth?.userId,
    runType: "bank_to_tally",
    clientId: Number(req.body?.clientId) || null,
    clientName: textBody(req.body?.clientName),
    title: "Saved ledger choices",
    artifactType: "ledger_mappings",
    artifactTitle: "Client ledger choices",
    jsonData: { mappings },
  });
  res.json({ ok: true, runId, mappings });
});

// ── Bank ↔ Tally ───────────────────────────────────────────────────────────

router.post(
  "/jobs/bank-tally/compare",
  requirePermission("uploads.create"),
  upload.fields([{ name: "bank", maxCount: 1 }, { name: "tally", maxCount: 1 }]),
  async (req, res): Promise<void> => {
    const companyId = await resolveBooksCompanyId(req, res);
    if (companyId == null) return;
    const gate = await privacyGate(req, res);
    if (!gate) return;
    const tallyFile = filesOf(req, "tally")[0];
    const tallyText = tallyFile ? sheetToCsvText(tallyFile) : textBody(req.body?.tallyText);
    const bankFileName = filesOf(req, "bank")[0]?.originalname || textBody(req.body?.bankFileName) || "bank";
    if (!tallyText.trim()) {
      res.status(400).json({ ok: false, message: "Upload the Tally export (Excel or CSV)." });
      return;
    }
    const bank = await bankFromRequest(req, "bank", "bankText", gate);
    if (!bank.summary) {
      res.status(422).json({ ok: false, message: bank.message, needsPassword: bank.needsPassword ?? false, wrongPassword: bank.wrongPassword ?? false, needsAiConsent: bank.needsAiConsent ?? false });
      return;
    }
    const tally = parseTallyLedgerCsv(tallyText);
    if (tally.length === 0) {
      res.status(422).json({ ok: false, message: "No entries were found in the Tally export. Export the bank ledger from Tally as Excel and try again." });
      return;
    }
    const comparison = compareBankWithTally(bank.summary.transactions, tally);
    const runId = gate.privacy ? null : await rememberRun({
      companyId,
      userId: req.auth?.userId,
      runType: "bank_tally_reconciliation",
      clientId: Number(req.body?.clientId) || null,
      clientName: textBody(req.body?.clientName),
      title: `Bank ↔ Tally — ${bankFileName}`,
      artifactType: "bank_tally_comparison",
      artifactTitle: "Bank ↔ Tally comparison",
      jsonData: { comparison, bankName: bank.summary.bankName, periodLabel: bank.summary.periodLabel },
    });
    if (!gate.privacy) await auditAction(req, "job.bank_tally_compared", "workflow_run", null, { runId, counts: comparison.counts });
    res.json({
      ok: true,
      privacy: gate.privacy,
      runId,
      bank: { bankName: bank.summary.bankName, periodLabel: bank.summary.periodLabel, count: bank.summary.transactions.length, source: bank.source, check: bank.check ?? null },
      comparison,
      progress: { progressPercent: 100, currentStep: "Review attention items", status: "completed" },
    });
  },
);

router.post("/jobs/runs/:id/decision", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const runId = String(req.params.id);
  const key = textBody(req.body?.key);
  const status = textBody(req.body?.status) as ReviewStatus;
  const allowed: ReviewStatus[] = ["suggested", "approved", "rejected", "needs_info", "document_requested", "resolved"];
  if (!key || !allowed.includes(status)) {
    res.status(400).json({ ok: false, message: "A review decision needs an item and a status." });
    return;
  }
  try {
    const result = await db.execute(sql`
      SELECT ra.id, ra.json_data
      FROM run_artifacts ra
      JOIN workflow_runs wr ON wr.id = ra.run_id
      WHERE wr.id = ${runId} AND wr.company_id = ${companyId}
        AND (COALESCE(wr.metadata_json->>'clientId','') = '' OR wr.metadata_json->>'clientId' = ${String(companyId)})
        AND ra.artifact_type IN ('bank_tally_comparison', 'invoice_bank_comparison')
      ORDER BY ra.created_at DESC
      LIMIT 1
    `);
    const row = result.rows[0] as { id: number; json_data: { comparison?: { items: Parameters<typeof applyDecision>[0]; counts?: unknown } } } | undefined;
    if (!row?.json_data?.comparison) {
      res.status(404).json({ ok: false, message: "This run has no comparison to review." });
      return;
    }
    const items = applyDecision(row.json_data.comparison.items, key, status);
    const next = { ...row.json_data, comparison: { ...row.json_data.comparison, items } };
    await db.execute(sql`UPDATE run_artifacts SET json_data = ${JSON.stringify(next)}::jsonb WHERE id = ${row.id}`);
    await auditAction(req, "job.match_decision", "workflow_run", null, { runId, key, status });
    res.json({ ok: true, runId, items });
  } catch (err) {
    res.status(500).json({ ok: false, message: err instanceof Error ? err.message : "Could not save the decision." });
  }
});

// ── History: everything the workspace has run, newest first ────────────────

router.get("/jobs/history", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const type = typeof req.query.type === "string" ? req.query.type.slice(0, 60) : "";
  const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const pattern = `%${search.replace(/[\\%_]/g, match => `\\${match}`)}%`;
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const months = historyMonths();
  const cutoff = historyCutoff(months).toISOString();
  try {
    const result = await db.execute(sql`
      SELECT wr.id, wr.run_type, wr.title, wr.status, wr.month, wr.created_at,
             u.name AS user_name, u.email AS user_email,
             (SELECT COALESCE(jsonb_agg(DISTINCT ra.artifact_type), '[]'::jsonb) FROM run_artifacts ra WHERE ra.run_id = wr.id) AS artifact_types,
             (SELECT jsonb_build_object(
                'bankName', ra.json_data->>'bankName',
                'periodLabel', ra.json_data->>'periodLabel',
                'rows', jsonb_array_length(COALESCE(ra.json_data->'transactions', '[]'::jsonb)),
                'verified', ra.json_data->'check'->'verified',
                'counts', ra.json_data->'comparison'->'counts',
                'entries', jsonb_array_length(COALESCE(ra.json_data->'comparison'->'items', '[]'::jsonb)),
                'matched', (SELECT count(*) FROM jsonb_array_elements(COALESCE(ra.json_data->'comparison'->'items', '[]'::jsonb)) item WHERE item->>'bucket' IN ('matched', 'confirmed')),
                'summary', ra.json_data->'summary',
                'platform', ra.json_data->>'platform')
              FROM run_artifacts ra
              WHERE ra.run_id = wr.id AND ra.artifact_type IN ('bank_statement', 'bank_tally_comparison', 'invoice_bank_comparison', 'ecommerce_gst')
              ORDER BY ra.created_at ASC LIMIT 1) AS info
      FROM workflow_runs wr
      LEFT JOIN users u ON u.id = wr.created_by
      WHERE wr.company_id = ${companyId}
        AND (COALESCE(wr.metadata_json->>'clientId','') = '' OR wr.metadata_json->>'clientId' = ${String(companyId)})
        AND NOT EXISTS (SELECT 1 FROM run_artifacts a WHERE a.run_id = wr.id AND a.artifact_type = 'ledger_mappings')
        AND wr.created_at >= ${cutoff}::timestamptz
        AND (${type} = '' OR wr.run_type = ${type}
             OR (${type} = 'other' AND wr.run_type NOT IN ('bank_to_tally', 'bank_tally_reconciliation', 'ecommerce_gst', 'bank_invoice_reconciliation')))
        AND (${search} = '' OR wr.title ILIKE ${pattern})
      ORDER BY wr.created_at DESC
      LIMIT ${limit + 1} OFFSET ${offset}
    `);
    const rows = result.rows as unknown[];
    // Older items stay in the database; the person is told how many are waiting.
    let olderCount = 0;
    if (offset === 0) {
      const older = await db.execute(sql`
        SELECT count(*)::int AS n FROM workflow_runs wr
        WHERE wr.company_id = ${companyId}
          AND (COALESCE(wr.metadata_json->>'clientId','') = '' OR wr.metadata_json->>'clientId' = ${String(companyId)})
          AND NOT EXISTS (SELECT 1 FROM run_artifacts a WHERE a.run_id = wr.id AND a.artifact_type = 'ledger_mappings')
          AND wr.created_at < ${cutoff}::timestamptz
      `);
      olderCount = Number((older.rows[0] as { n?: number } | undefined)?.n ?? 0);
    }
    res.json({ ok: true, runs: rows.slice(0, limit), hasMore: rows.length > limit, windowMonths: months, olderCount, supportEmail: supportEmail() });
  } catch (err) {
    res.status(500).json({ ok: false, message: err instanceof Error ? err.message : "History could not be loaded." });
  }
});

router.get("/jobs/history/:id", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const runId = String(req.params.id);
  try {
    const run = await db.execute(sql`
      SELECT wr.id, wr.run_type, wr.title, wr.status, wr.month, wr.created_at, wr.completed_at, wr.failed_reason,
             u.name AS user_name, u.email AS user_email,
             (wr.created_at < ${historyCutoff().toISOString()}::timestamptz) AS outside_window
      FROM workflow_runs wr LEFT JOIN users u ON u.id = wr.created_by
      WHERE wr.id = ${runId} AND wr.company_id = ${companyId}
        AND (COALESCE(wr.metadata_json->>'clientId','') = '' OR wr.metadata_json->>'clientId' = ${String(companyId)})
      LIMIT 1
    `);
    if (run.rows.length === 0) {
      res.status(404).json({ ok: false, message: "This item was not found in this workspace." });
      return;
    }
    if ((run.rows[0] as { outside_window?: boolean }).outside_window) {
      res.status(403).json({ ok: false, code: "outside_window", message: outsideWindowMessage() });
      return;
    }
    const artifacts = await db.execute(sql`
      SELECT id, artifact_type, title, json_data, created_at FROM run_artifacts WHERE run_id = ${runId} ORDER BY created_at ASC
    `);
    res.json({ ok: true, run: run.rows[0], artifacts: artifacts.rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: err instanceof Error ? err.message : "History could not be loaded." });
  }
});

router.get("/jobs/runs/:id", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const runId = String(req.params.id);
  try {
    const result = await db.execute(sql`
      SELECT wr.id, wr.title, wr.run_type, wr.status, wr.metadata_json, ra.artifact_type, ra.title AS artifact_title, ra.json_data
      FROM workflow_runs wr
      LEFT JOIN run_artifacts ra ON ra.run_id = wr.id
      WHERE wr.id = ${runId} AND wr.company_id = ${companyId}
        AND (COALESCE(wr.metadata_json->>'clientId','') = '' OR wr.metadata_json->>'clientId' = ${String(companyId)})
        AND wr.created_at >= ${historyCutoff().toISOString()}::timestamptz
      ORDER BY ra.created_at ASC
    `);
    if (result.rows.length === 0) {
      res.status(404).json({ ok: false, message: "Run not found for this workspace." });
      return;
    }
    res.json({ ok: true, runId, artifacts: result.rows });
  } catch {
    res.status(404).json({ ok: false, message: "Run storage is unavailable." });
  }
});

router.post("/jobs/runs/:id/report", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const runId = String(req.params.id);
  const draft = req.body?.final !== true;
  try {
    const result = await db.execute(sql`
      SELECT ra.json_data
      FROM run_artifacts ra
      JOIN workflow_runs wr ON wr.id = ra.run_id
      WHERE wr.id = ${runId} AND wr.company_id = ${companyId}
        AND (COALESCE(wr.metadata_json->>'clientId','') = '' OR wr.metadata_json->>'clientId' = ${String(companyId)})
        AND ra.artifact_type = 'bank_tally_comparison'
      ORDER BY ra.created_at DESC LIMIT 1
    `);
    const row = result.rows[0] as { json_data?: { comparison?: { counts: Record<string, number>; items: Array<{ key: string; bucket: string; status: string; confidence: number; why: string[] }> } } } | undefined;
    const comparison = row?.json_data?.comparison;
    if (!comparison) {
      res.status(404).json({ ok: false, message: "No comparison exists for this run." });
      return;
    }
    const report = {
      schema: "finverify.reconciliation.report.v1",
      runId,
      kind: draft ? "draft" : "final",
      generatedAt: new Date().toISOString(),
      counts: comparison.counts,
      approved: comparison.items.filter(item => item.status === "approved"),
      pending: comparison.items.filter(item => item.status === "suggested" || item.status === "needs_info"),
      rejected: comparison.items.filter(item => item.status === "rejected"),
      note: "This report contains only this run. Potential risk — needs CA review.",
    };
    const saved = await saveRunArtifact(runId, { artifactType: draft ? "draft_report" : "final_report", title: draft ? "Draft reconciliation report" : "Final reconciliation report", jsonData: report, companyId });
    if (!saved) {
      res.status(404).json({ ok: false, message: "Run not found for this client." });
      return;
    }
    await auditAction(req, draft ? "job.draft_report" : "job.final_report", "workflow_run", null, { runId });
    res.json({ ok: true, report });
  } catch (err) {
    res.status(500).json({ ok: false, message: err instanceof Error ? err.message : "Report failed." });
  }
});

// ── E-commerce GST ─────────────────────────────────────────────────────────

router.post("/jobs/ecommerce/normalize", requirePermission("uploads.create"), upload.array("files", 20), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const chosen = textBody(req.body?.platform).toLowerCase();
  if (chosen && chosen !== "auto" && !PLATFORMS.has(chosen)) {
    res.status(400).json({ ok: false, message: "Choose Amazon, Flipkart, Meesho, Myntra, JioMart, or Other." });
    return;
  }
  const files = filesOf(req, "files");
  const inputs = files.length > 0
    ? files.map(file => ({ fileName: file.originalname, text: sheetToCsvText(file) }))
    : [{ fileName: textBody(req.body?.fileName) || "marketplace.csv", text: textBody(req.body?.text) }];
  const packs: EcommercePack[] = inputs.map(input => {
    const platform = (chosen && chosen !== "auto" ? chosen : detectMarketplace(input.fileName, input.text)) as MarketplacePlatform;
    return normalizeMarketplaceCsv(input.text, platform, input.fileName);
  });
  const pack = packs.length === 1 ? packs[0] : mergeEcommercePacks(packs);
  if (pack.sales.length === 0) {
    res.status(422).json({ ok: false, ...pack });
    return;
  }
  const runId = gate.privacy ? null : await rememberRun({
    companyId,
    userId: req.auth?.userId,
    runType: "ecommerce_gst",
    clientId: Number(req.body?.clientId) || null,
    clientName: textBody(req.body?.clientName),
    title: `E-commerce GST — ${pack.platform}`,
    artifactType: "ecommerce_gst",
    artifactTitle: `${pack.platform} sales`,
    jsonData: pack,
  });
  if (!gate.privacy) await auditAction(req, "job.ecommerce_normalized", "workflow_run", null, { runId, platform: pack.platform, rows: pack.sales.length, files: inputs.length });
  res.json({ ok: true, privacy: gate.privacy, runId, ...pack, files: inputs.map(input => input.fileName), progress: { progressPercent: 100, currentStep: "Review GSTR-1 draft", status: "completed" } });
});

router.post("/jobs/ecommerce/gst-json", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const platform = (textBody(req.body?.platform).toLowerCase() || "generic") as MarketplacePlatform;
  const pack = req.body?.pack ?? normalizeMarketplaceCsv(textBody(req.body?.text), platform, "marketplace.csv");
  const built = buildGstDraftJson(pack);
  if (!built.ok) {
    res.status(422).json({ ok: false, errors: built.errors, message: "GST JSON was not created because validation failed. This is not a GST portal check." });
    return;
  }
  res.json({ ok: true, json: built.json, message: "Draft GST JSON is ready for CA review. It has not been validated on the GST portal." });
});

router.post("/jobs/ecommerce/csv", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const sales = Array.isArray(req.body?.sales) ? req.body.sales : [];
  res.json({ ok: true, csv: salesToCsv(sales), message: "Accounting summary CSV is ready." });
});

router.post("/jobs/ecommerce/excel", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const parsed = ecommerceWorkbookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, message: "The Excel summary could not be created. Check the marketplace data and try again." });
    return;
  }
  try {
    const workbook = buildEcommerceWorkbook(parsed.data);
    const bytes = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="TallyThis_Ecommerce_Summary.xlsx"');
    res.send(Buffer.from(bytes));
    if (!gate.privacy) void auditAction(req, "job.ecommerce_excel_generated", "workflow_run", null, { companyId, rows: parsed.data.sales.length });
  } catch {
    res.status(500).json({ ok: false, message: "The Excel summary could not be created. Try again." });
  }
});

// ── Invoice ↔ Bank ─────────────────────────────────────────────────────────

router.post(
  "/jobs/invoice-bank/compare",
  requirePermission("uploads.create"),
  upload.fields([{ name: "bank", maxCount: 1 }, { name: "invoices", maxCount: 20 }]),
  async (req, res): Promise<void> => {
    const companyId = await resolveBooksCompanyId(req, res);
    if (companyId == null) return;
    const gate = await privacyGate(req, res);
    if (!gate) return;
    const bank = await bankFromRequest(req, "bank", "bankText", gate);
    if (!bank.summary) {
      res.status(422).json({ ok: false, message: bank.message, needsPassword: bank.needsPassword ?? false, wrongPassword: bank.wrongPassword ?? false, needsAiConsent: bank.needsAiConsent ?? false });
      return;
    }
    const invoiceFiles = filesOf(req, "invoices");
    let invoices: InvoiceRow[];
    let aiRead = 0;
    let unreadable: string[] = [];
    if (invoiceFiles.length > 0) {
      const read = await readInvoiceFiles(invoiceFiles, { companyId, userId: req.auth?.userId ?? null, privacy: gate.privacy, allowAi: gate.allowAi });
      if (read.needsAiConsent) {
        res.status(422).json({ ok: false, needsAiConsent: true, message: AI_CONSENT_MESSAGE });
        return;
      }
      if (read.aiBlocked) {
        res.status(422).json({ ok: false, message: AI_BLOCKED_MESSAGE });
        return;
      }
      invoices = read.rows;
      aiRead = read.aiRead;
      unreadable = read.failed;
    } else {
      invoices = parseInvoiceCsv(textBody(req.body?.invoiceText));
    }
    if (invoices.length === 0) {
      res.status(422).json({
        ok: false,
        message: unreadable.length > 0
          ? `No invoices could be read from ${unreadable.join(", ")}. Upload an invoice list (Excel/CSV) or clear invoice PDFs.`
          : "Upload invoices: an invoice list (Excel/CSV) or the invoice PDFs.",
      });
      return;
    }
    const comparison = compareInvoicesWithBank(bank.summary.transactions, invoices);
    const runId = gate.privacy ? null : await rememberRun({
      companyId,
      userId: req.auth?.userId,
      runType: "bank_invoice_reconciliation",
      clientId: Number(req.body?.clientId) || null,
      clientName: textBody(req.body?.clientName),
      title: "Invoice ↔ Bank",
      artifactType: "invoice_bank_comparison",
      artifactTitle: "Invoice ↔ Bank",
      jsonData: { comparison, aiRead, unreadable, label: "Suggested matches need review. AI extracted values stay pending review." },
    });
    if (!gate.privacy) await auditAction(req, "job.invoice_bank_compared", "workflow_run", null, { runId, invoices: invoices.length, bank: bank.summary.transactions.length, aiRead });
    res.json({ ok: true, privacy: gate.privacy, runId, comparison, invoiceCount: invoices.length, bankCount: bank.summary.transactions.length, aiRead, unreadable, progress: { progressPercent: 100, currentStep: "Review matches", status: "completed" } });
  },
);

router.get("/jobs/suggest-ledger", requirePermission("uploads.read"), (req, res): void => {
  const narration = typeof req.query.narration === "string" ? req.query.narration : "";
  res.json({ ledgerName: suggestLedger(narration) });
});

export default router;
