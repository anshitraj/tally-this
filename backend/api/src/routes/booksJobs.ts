/**
 * Three more upload jobs, built on the same pattern as the first four:
 *   Bills → Tally      purchase bills (PDF, scan or list) become Tally Purchase vouchers
 *   Sales → GSTR-1/3B  a sales register becomes GSTR-1 tables and a GSTR-3B working
 *   Payroll            a salary sheet becomes a register, the statutory working and a Tally journal
 * Every result is saved as one workflow run so History and Reports can find it again.
 */
import { Router, type IRouter, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { auditAction, requirePermission } from "../middleware/authz";
import { resolveBooksCompanyId } from "../services/companyScope";
import { privacyGate } from "../services/privacy";
import { AI_BLOCKED_MESSAGE, AI_CONSENT_MESSAGE } from "../services/privacyPolicy";
import { MAX_UPLOAD_BYTES } from "../lib/uploadLimit";
import { advanceRun, createWorkflowRun, finishRun, saveRunArtifact, type WorkflowRunType } from "../services/workflowRunService";
import { extensionOf, isDocumentFile } from "../services/fileDetect";
import { sheetsOf, type UploadedBuffer } from "../services/gstrFiles";
import { extractBillTaxFromText, extractInvoicesFromText, readPdfText } from "../services/invoicePdf";
import { readInvoiceFiles, readBankStatementFile } from "../services/fileReaders";
import {
  billFromAi,
  billFromPdf,
  buildBillsWorkbook,
  buildPurchaseXml,
  checkBills,
  readBillsFromTable,
  type BillInput,
  type CheckedBill,
} from "../services/purchaseBills";
import { sendVouchersToTally } from "../services/tallyPush";
import { buildGstr1, readSalesRegister, type Gstr1Result } from "../services/salesRegister";
import { buildGstr3b, itcFromGstr2b, type ItcBasis, type ItcSource, type ThreeBAdjustments } from "../services/gstr3b";
import { buildReturnWorkbook } from "../services/gstReturnWorkbook";
import { buildPayrollJournal, buildPayrollWorkbook, matchSalaryPayments, readPayroll, statutoryOf, type BankCheck, type Employee, type EmployerProfile } from "../services/payroll";
import { normalizeGstin } from "../services/gstrRecon";
import { stateFromGstin } from "../services/gstStates";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 40 } });

function textBody(value: unknown) {
  return typeof value === "string" ? value : "";
}

function filesOf(req: Request, field: string): Express.Multer.File[] {
  const files = req.files;
  if (!files) return [];
  if (Array.isArray(files)) return field === "files" ? files : [];
  return files[field] ?? [];
}

/** One saved run with its artifacts. A failure to save never loses the result the person is looking at. */
async function saveRun(input: {
  companyId: number;
  userId?: number | null;
  runType: WorkflowRunType;
  clientId?: number | null;
  clientName?: string;
  title: string;
  artifacts: Array<{ type: string; title: string; json: unknown }>;
}): Promise<string | null> {
  try {
    const runId = await createWorkflowRun({
      companyId: input.companyId,
      runType: input.runType,
      createdBy: input.userId ?? null,
      clientId: input.clientId ?? input.companyId,
      meta: { customTitle: input.title, clientId: input.clientId ? String(input.clientId) : "", clientName: input.clientName ?? "" },
    });
    if (runId.startsWith("local-")) return null;
    await db
      .execute(sql`UPDATE workflow_runs SET metadata_json = ${JSON.stringify({ clientId: input.clientId ?? null, clientName: input.clientName ?? null })}::jsonb WHERE id = ${runId} AND company_id = ${input.companyId}`)
      .catch(() => undefined);
    await advanceRun(runId, 2);
    for (const artifact of input.artifacts) {
      await saveRunArtifact(runId, { artifactType: artifact.type, title: artifact.title, jsonData: artifact.json });
    }
    await finishRun(runId, "completed");
    return runId;
  } catch {
    return null;
  }
}

async function latestArtifact(companyId: number, runId: string, type: string): Promise<Record<string, any> | null> {
  try {
    const found = await db.execute(sql`
      SELECT ra.json_data
      FROM run_artifacts ra
      JOIN workflow_runs wr ON wr.id = ra.run_id
      WHERE wr.id = ${runId} AND wr.company_id = ${companyId} AND ra.artifact_type = ${type}
      ORDER BY ra.created_at DESC
      LIMIT 1
    `);
    return ((found.rows[0] as { json_data?: Record<string, any> } | undefined)?.json_data) ?? null;
  } catch {
    return null;
  }
}

// ── Client profile: the employer's name and the numbers filings need ────────

const profileSchema = z.object({
  name: z.string().trim().max(160).default(""),
  address: z.string().trim().max(300).optional(),
  pan: z.string().trim().toUpperCase().max(10).optional(),
  tan: z.string().trim().toUpperCase().max(10).optional(),
  gstin: z.string().trim().toUpperCase().max(15).optional(),
  pfCode: z.string().trim().toUpperCase().max(30).optional(),
  esiCode: z.string().trim().max(30).optional(),
  ptRegistration: z.string().trim().max(30).optional(),
  state: z.string().trim().max(60).optional(),
});

async function loadProfile(companyId: number, clientName: string): Promise<EmployerProfile> {
  const base: EmployerProfile = { name: clientName };
  try {
    const company = await db.execute(sql`SELECT name, gstin, pan FROM companies WHERE id = ${companyId} LIMIT 1`);
    const row = company.rows[0] as { name?: string; gstin?: string | null; pan?: string | null } | undefined;
    if (row) {
      base.name = clientName || row.name || "";
      if (row.gstin) base.gstin = row.gstin;
      if (row.pan) base.pan = row.pan;
    }
    const saved = await db.execute(sql`
      SELECT ra.json_data
      FROM run_artifacts ra
      JOIN workflow_runs wr ON wr.id = ra.run_id
      WHERE wr.company_id = ${companyId}
        AND ra.artifact_type = 'client_profile'
        AND (COALESCE(wr.metadata_json->>'clientId','') = '' OR wr.metadata_json->>'clientId' = ${String(companyId)})
      ORDER BY ra.created_at DESC
      LIMIT 1
    `);
    const json = (saved.rows[0] as { json_data?: { profile?: unknown } } | undefined)?.json_data?.profile;
    const parsed = profileSchema.safeParse(json);
    if (parsed.success) {
      for (const [key, value] of Object.entries(parsed.data)) {
        if (typeof value === "string" && value) (base as unknown as Record<string, string>)[key] = value;
      }
    }
  } catch {
    // The profile is a convenience; the job works without it.
  }
  return base;
}

/** The employer name the person saved for this client, if any. */
async function savedProfileName(companyId: number): Promise<string | null> {
  try {
    const saved = await db.execute(sql`
      SELECT ra.json_data
      FROM run_artifacts ra
      JOIN workflow_runs wr ON wr.id = ra.run_id
      WHERE wr.company_id = ${companyId}
        AND ra.artifact_type = 'client_profile'
        AND (COALESCE(wr.metadata_json->>'clientId','') = '' OR wr.metadata_json->>'clientId' = ${String(companyId)})
      ORDER BY ra.created_at DESC
      LIMIT 1
    `);
    const name = (saved.rows[0] as { json_data?: { profile?: { name?: unknown } } } | undefined)?.json_data?.profile?.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

router.get("/jobs/profile", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const clientName = textBody(req.query.clientName);
  const profile = await loadProfile(companyId, clientName);
  // The client's own name is the fallback, not something the person chose. Only an employer name
  // that was saved on purpose is offered back, so the file's own title is not overridden by it.
  const saved = await savedProfileName(companyId);
  res.json({ ok: true, profile: { ...profile, name: saved ?? "" } });
});

router.post("/jobs/profile", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const parsed = profileSchema.safeParse(req.body?.profile ?? {});
  if (!parsed.success) {
    res.status(422).json({ ok: false, message: "Some details are not valid. Check the PAN, TAN and GSTIN." });
    return;
  }
  const profile = parsed.data;
  const problems: string[] = [];
  if (profile.pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(profile.pan)) problems.push("PAN should look like ABCDE1234F.");
  if (profile.tan && !/^[A-Z]{4}\d{5}[A-Z]$/.test(profile.tan)) problems.push("TAN should look like ABCD12345E.");
  if (profile.gstin && !stateFromGstin(profile.gstin)) problems.push("GSTIN should be 15 characters and start with the state code.");
  if (problems.length > 0) {
    res.status(422).json({ ok: false, message: problems.join(" ") });
    return;
  }
  // Private mode keeps nothing; the page holds the details for this session only.
  if (gate.privacy) {
    res.json({ ok: true, profile, saved: false });
    return;
  }
  await saveRun({
    companyId,
    userId: req.auth?.userId,
    runType: "upload_parse",
    clientId: Number(req.body?.clientId) || null,
    clientName: textBody(req.body?.clientName),
    title: "Saved client details",
    artifacts: [{ type: "client_profile", title: "Client details", json: { profile } }],
  });
  res.json({ ok: true, profile, saved: true });
});

// ── Bills → Tally ───────────────────────────────────────────────────────────

const money = z.number().finite().min(-1e11).max(1e11);
const billSchema = z.object({
  key: z.string().max(60),
  source: z.enum(["pdf", "sheet", "ai"]),
  fileName: z.string().max(200).default(""),
  row: z.number().int().default(0),
  supplierName: z.string().max(200).default(""),
  supplierGstin: z.string().max(20).default(""),
  invoiceNumber: z.string().max(80).default(""),
  invoiceDate: z.string().nullable().default(null),
  placeOfSupply: z.string().max(80).nullable().default(null),
  taxable: money,
  igst: money,
  cgst: money,
  sgst: money,
  cess: money,
  total: money,
  reverseCharge: z.boolean().default(false),
  ledger: z.string().max(120).nullable().optional(),
  include: z.boolean().optional(),
  derived: z.boolean().optional(),
  note: z.boolean().optional(),
});

const ledgerName = z.string().trim().min(1).max(120);
const billsRequestSchema = z.object({
  clientName: z.string().trim().min(1).max(160),
  tallyCompany: z.string().trim().max(200).optional(),
  recipientGstin: z.string().max(20).optional(),
  bills: z.array(billSchema).min(1).max(5000),
  purchaseLedger: ledgerName.default("Purchase"),
  igstLedger: ledgerName.default("Input IGST"),
  cgstLedger: ledgerName.default("Input CGST"),
  sgstLedger: ledgerName.default("Input SGST"),
  cessLedger: ledgerName.default("Input Cess"),
  roundOffLedger: ledgerName.default("Round Off"),
  partyLedgers: z.record(z.string().max(60), z.string().trim().max(120)).default({}),
  createParties: z.boolean().default(true),
  billWise: z.boolean().default(true),
  numbering: z.enum(["auto", "series"]).default("auto"),
  prefix: z.string().max(12).optional(),
  startAt: z.number().int().min(1).max(9_999_999).optional(),
  runId: z.string().max(80).optional(),
});

function cleanBills(bills: z.infer<typeof billSchema>[]): BillInput[] {
  return bills.map(bill => ({ ...bill, supplierGstin: normalizeGstin(bill.supplierGstin), ledger: bill.ledger ?? null }));
}

router.post("/jobs/bills/read", requirePermission("uploads.create"), upload.array("files", 40), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const files = filesOf(req, "files");
  if (files.length === 0) {
    res.status(400).json({ ok: false, message: "Upload purchase bills: invoice PDFs, photos, or a purchase list as Excel or CSV." });
    return;
  }
  const clientName = textBody(req.body?.clientName);
  const profile = await loadProfile(companyId, clientName);
  const recipientGstin = normalizeGstin(textBody(req.body?.recipientGstin)) || normalizeGstin(profile.gstin ?? "");

  const bills: BillInput[] = [];
  const notes: string[] = [];
  const unreadable: Array<{ fileName: string; reason: string }> = [];
  const counts = { pdf: 0, sheet: 0, ai: 0 };
  const leftover: Express.Multer.File[] = [];

  for (const file of files) {
    const ext = extensionOf(file.originalname);
    if (!isDocumentFile(file)) {
      let best: ReturnType<typeof readBillsFromTable> | null = null;
      let failure = "";
      try {
        const buffer: UploadedBuffer = { originalname: file.originalname, buffer: file.buffer };
        for (const sheet of sheetsOf(buffer)) {
          if (sheet.table.length < 2) continue;
          try {
            const read = readBillsFromTable(sheet.table, file.originalname);
            if (!best || read.bills.length > best.bills.length) best = read;
          } catch (error) {
            failure = failure || (error instanceof Error ? error.message : "");
          }
        }
      } catch {
        failure = "This file could not be opened. Save it as .xlsx or CSV and try again.";
      }
      if (best) {
        bills.push(...best.bills);
        notes.push(...best.notes.map(note => `${file.originalname}: ${note}`));
        counts.sheet += best.bills.length;
      } else {
        unreadable.push({ fileName: file.originalname, reason: failure || "No purchase bills were found in this file." });
      }
      continue;
    }
    if (ext === "pdf" || file.mimetype === "application/pdf") {
      const text = await readPdfText(file.buffer);
      if (text.status === "locked") {
        unreadable.push({ fileName: file.originalname, reason: "This PDF is password protected. Remove the password and upload it again." });
        continue;
      }
      if (text.status === "ok") {
        const rows = extractInvoicesFromText(text.text);
        if (rows.length === 1) {
          bills.push(billFromPdf(rows[0], extractBillTaxFromText(text.text), file.originalname, recipientGstin || null));
          counts.pdf += 1;
          continue;
        }
      }
    }
    leftover.push(file);
  }

  // Scans, photos and PDFs the rules could not read go to the AI reader, with the person's consent.
  for (const file of leftover) {
    const read = await readInvoiceFiles([file], { companyId, userId: req.auth?.userId ?? null, privacy: gate.privacy, allowAi: gate.allowAi });
    if (read.needsAiConsent) {
      res.status(422).json({ ok: false, needsAiConsent: true, message: AI_CONSENT_MESSAGE });
      return;
    }
    if (read.aiBlocked) {
      unreadable.push({ fileName: file.originalname, reason: AI_BLOCKED_MESSAGE });
      continue;
    }
    if (read.rows.length === 0) {
      unreadable.push({
        fileName: file.originalname,
        reason: read.aiUnavailable
          ? "This looks like a scan or photo, which needs the AI reader. It is not switched on here. Upload the invoice PDF from your supplier's software, or a purchase list."
          : "No invoice could be read from this file. It may hold several invoices; upload one invoice per file or a purchase list.",
      });
      continue;
    }
    for (const row of read.rows) bills.push(billFromAi(row, file.originalname, recipientGstin || null));
    counts.ai += read.rows.length;
  }

  if (bills.length === 0) {
    res.status(422).json({ ok: false, message: unreadable.length > 0 ? `${unreadable[0].fileName}: ${unreadable[0].reason}` : "No purchase bills were found.", unreadable });
    return;
  }
  const checked = checkBills(
    bills.map((bill, index) => ({ ...bill, key: `${bill.key}-${index}` })),
    { recipientGstin: recipientGstin || null },
  );
  // A repeated bill is left out by default so the first copy is not posted twice.
  const result = checked.map(bill => (bill.duplicateOf ? { ...bill, include: false } : bill));
  const rechecked = checkBills(result, { recipientGstin: recipientGstin || null });

  let runId: string | null = null;
  if (!gate.privacy) {
    runId = await saveRun({
      companyId,
      userId: req.auth?.userId,
      runType: "bills_to_tally",
      clientId: Number(req.body?.clientId) || null,
      clientName,
      title: `Bills → Tally — ${files.length === 1 ? files[0].originalname : `${files.length} files`}`,
      artifacts: [{ type: "purchase_bills", title: "Purchase bills", json: { bills: rechecked, counts, notes, unreadable, recipientGstin: recipientGstin || null, files: files.map(file => file.originalname) } }],
    });
    await auditAction(req, "job.bills_read", "workflow_run", null, { runId, bills: rechecked.length, counts });
  }
  res.json({ ok: true, privacy: gate.privacy, runId, bills: rechecked, counts, notes, unreadable, recipientGstin: recipientGstin || null });
});

router.post("/jobs/bills/check", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const parsed = z.object({ bills: z.array(billSchema).min(1).max(5000), recipientGstin: z.string().max(20).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, message: "The bills could not be checked." });
    return;
  }
  res.json({ ok: true, bills: checkBills(cleanBills(parsed.data.bills), { recipientGstin: normalizeGstin(parsed.data.recipientGstin ?? "") || null }) });
});

function billsOutput(body: unknown) {
  const parsed = billsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false as const, message: `The bills could not be prepared: ${parsed.error.issues[0]?.path.join(".") || "request"} ${parsed.error.issues[0]?.message ?? ""}`.trim() };
  }
  const config = parsed.data;
  const checked = checkBills(cleanBills(config.bills), { recipientGstin: normalizeGstin(config.recipientGstin ?? "") || null });
  const built = buildPurchaseXml(checked, {
    clientName: config.clientName,
    tallyCompany: config.tallyCompany,
    purchaseLedger: config.purchaseLedger,
    igstLedger: config.igstLedger,
    cgstLedger: config.cgstLedger,
    sgstLedger: config.sgstLedger,
    cessLedger: config.cessLedger,
    roundOffLedger: config.roundOffLedger,
    partyLedgers: config.partyLedgers,
    createParties: config.createParties,
    billWise: config.billWise,
    numbering: config.numbering,
    prefix: config.prefix,
    startAt: config.startAt,
  });
  return { ok: true as const, config, checked, built };
}

router.post("/jobs/bills/xml", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const output = billsOutput(req.body);
  if (!output.ok) {
    res.status(422).json({ ok: false, message: output.message });
    return;
  }
  const { built, config, checked } = output;
  if (!built.ok || !built.xml) {
    res.status(422).json({ ok: false, errors: built.errors, bills: checked, message: "The Tally file was not created because some bills need attention." });
    return;
  }
  if (!gate.privacy && config.runId && !config.runId.startsWith("local-")) {
    await saveRunArtifact(config.runId, {
      artifactType: "tally_xml",
      title: built.fileName ?? "purchase-vouchers.xml",
      jsonData: { voucherCount: built.voucherCount, vouchers: built.vouchers, xml: built.xml },
      companyId,
    });
    await auditAction(req, "job.bills_xml_generated", "workflow_run", null, { runId: config.runId, voucherCount: built.voucherCount });
  }
  res.json({
    ok: true,
    xml: built.xml,
    mastersXml: built.mastersXml,
    fileName: built.fileName,
    voucherCount: built.voucherCount,
    vouchers: built.vouchers,
    message: `Tally file is ready. ${built.voucherCount} purchase ${built.voucherCount === 1 ? "voucher" : "vouchers"} checked and balanced.`,
  });
});

router.post("/jobs/bills/send", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const output = billsOutput(req.body);
  if (!output.ok) {
    res.status(422).json({ ok: false, message: output.message });
    return;
  }
  const { built, config } = output;
  if (!built.ok || !built.xml || !built.voucherCount) {
    res.status(422).json({ ok: false, errors: built.errors, message: "Nothing was sent to Tally because the bills did not pass the checks." });
    return;
  }
  if (!config.tallyCompany) {
    res.status(422).json({ ok: false, message: "Choose the Tally company first." });
    return;
  }
  let sent: Awaited<ReturnType<typeof sendVouchersToTally>>;
  try {
    sent = await sendVouchersToTally({ mastersXml: config.createParties ? built.mastersXml : undefined, vouchersXml: built.xml, expected: built.voucherCount });
  } catch {
    res.status(502).json({ ok: false, message: "Tally did not confirm the import. Open the Purchase Register in Tally to see whether the bills arrived before sending again." });
    return;
  }
  if (!gate.privacy && config.runId && !config.runId.startsWith("local-")) {
    await saveRunArtifact(config.runId, { artifactType: "tally_push", title: `Sent to Tally — ${config.tallyCompany}`, jsonData: { ...sent, tallyCompany: config.tallyCompany, kind: "purchase" }, companyId });
    await auditAction(req, "job.bills_tally_push", "workflow_run", null, { runId: config.runId, expected: sent.expected, created: sent.created });
  }
  res.json({
    ...sent,
    tallyCompany: config.tallyCompany,
    message: sent.ok
      ? `${sent.created} purchase ${sent.created === 1 ? "voucher" : "vouchers"} created in Tally.`
      : `${sent.created} of ${sent.expected} vouchers were created. Check Tally's messages below and the Purchase Register before sending again.`,
  });
});

router.post("/jobs/bills/excel", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const parsed = z.object({ clientName: z.string().max(160).default("Client"), bills: z.array(billSchema).min(1).max(5000), recipientGstin: z.string().max(20).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, message: "The Excel file could not be created." });
    return;
  }
  try {
    const checked = checkBills(cleanBills(parsed.data.bills), { recipientGstin: normalizeGstin(parsed.data.recipientGstin ?? "") || null });
    const workbook = buildBillsWorkbook({ clientName: parsed.data.clientName, bills: checked, vouchers: [] });
    const bytes = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="TallyThis_Purchase_Bills.xlsx"');
    res.send(Buffer.from(bytes));
  } catch {
    res.status(500).json({ ok: false, message: "The Excel file could not be created. Try again." });
  }
});

// ── Sales register → GSTR-1 and GSTR-3B ─────────────────────────────────────

/** GSTR-2B ↔ Books results of this client, newest first. */
async function itcRunsFor(companyId: number): Promise<Array<{ runId: string; title: string; createdAt: string; source: ItcSource }>> {
  try {
    const found = await db.execute(sql`
      SELECT wr.id, wr.title, wr.created_at, ra.json_data
      FROM run_artifacts ra
      JOIN workflow_runs wr ON wr.id = ra.run_id
      WHERE wr.company_id = ${companyId}
        AND ra.artifact_type = 'gstr2b_comparison'
        AND (COALESCE(wr.metadata_json->>'clientId','') = '' OR wr.metadata_json->>'clientId' = ${String(companyId)})
      ORDER BY ra.created_at DESC
      LIMIT 12
    `);
    const out: Array<{ runId: string; title: string; createdAt: string; source: ItcSource }> = [];
    for (const row of found.rows as Array<{ id: string; title: string; created_at: string; json_data: unknown }>) {
      const source = itcFromGstr2b(row.json_data, row.id);
      if (source) out.push({ runId: row.id, title: row.title, createdAt: String(row.created_at), source });
    }
    return out;
  } catch {
    return [];
  }
}

const adjustmentSchema = z
  .object({
    rcm: z.object({ taxable: z.number().default(0), igst: z.number().default(0), cgst: z.number().default(0), sgst: z.number().default(0), cess: z.number().default(0) }).partial().optional(),
    reversal: z.object({ igst: z.number().default(0), cgst: z.number().default(0), sgst: z.number().default(0), cess: z.number().default(0) }).partial().optional(),
    additional: z.object({ igst: z.number().default(0), cgst: z.number().default(0), sgst: z.number().default(0), cess: z.number().default(0) }).partial().optional(),
  })
  .default({});

/** Rupees from the page, as paise. */
function adjustmentsInPaise(input: z.infer<typeof adjustmentSchema>): ThreeBAdjustments {
  const heads = (value?: Partial<Record<"igst" | "cgst" | "sgst" | "cess" | "taxable", number>>) => ({
    igst: Math.round((value?.igst ?? 0) * 100),
    cgst: Math.round((value?.cgst ?? 0) * 100),
    sgst: Math.round((value?.sgst ?? 0) * 100),
    cess: Math.round((value?.cess ?? 0) * 100),
  });
  return {
    rcm: { ...heads(input.rcm), taxable: Math.round((input.rcm?.taxable ?? 0) * 100) },
    reversal: heads(input.reversal),
    additional: heads(input.additional),
  };
}

router.post("/jobs/gst-sales/read", requirePermission("uploads.create"), upload.single("register"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const file = req.file;
  if (!file) {
    res.status(400).json({ ok: false, message: "Upload the sales register as Excel or CSV. In TallyPrime: Display More Reports → Account Books → Sales Register → Export." });
    return;
  }
  if (isDocumentFile(file) || /\.(xml|html?)$/i.test(file.originalname)) {
    res.status(422).json({ ok: false, message: "Upload the sales register as Excel or CSV. In TallyPrime: Display More Reports → Account Books → Sales Register → Export → Excel." });
    return;
  }
  const clientName = textBody(req.body?.clientName);
  const profile = await loadProfile(companyId, clientName);
  const sellerGstin = normalizeGstin(textBody(req.body?.sellerGstin)) || normalizeGstin(profile.gstin ?? "") || null;
  const limit = Number(req.body?.b2clLimit);
  let best: ReturnType<typeof readSalesRegister> | null = null;
  let failure = "";
  try {
    for (const sheet of sheetsOf({ originalname: file.originalname, buffer: file.buffer })) {
      if (sheet.table.length < 2) continue;
      try {
        const read = readSalesRegister(sheet.table, { sellerGstin });
        if (!best || read.docs.length > best.docs.length) best = read;
      } catch (error) {
        failure = failure || (error instanceof Error ? error.message : "");
      }
    }
  } catch {
    failure = "This file could not be opened. Save it as .xlsx or CSV and try again.";
  }
  if (!best) {
    res.status(422).json({ ok: false, message: failure || "No sales were found in this file." });
    return;
  }
  const gstr1 = buildGstr1(best, { b2clLimitRupees: Number.isFinite(limit) && limit > 0 ? limit : undefined });
  const itcRuns = gate.privacy ? [] : await itcRunsFor(companyId);
  const chosen = itcRuns.find(run => run.source.period === gstr1.period) ?? itcRuns[0] ?? null;
  const threeB = buildGstr3b(gstr1, chosen?.source ?? null, "matched");

  let runId: string | null = null;
  if (!gate.privacy) {
    runId = await saveRun({
      companyId,
      userId: req.auth?.userId,
      runType: "gst_sales_register",
      clientId: Number(req.body?.clientId) || null,
      clientName,
      title: `Sales → GSTR-1 — ${file.originalname}${gstr1.period ? ` (${gstr1.period})` : ""}`,
      artifacts: [{ type: "gstr1_working", title: "GSTR-1 working", json: { gstr1, file: file.originalname, itcRunId: chosen?.runId ?? null } }],
    });
    await auditAction(req, "job.gst_sales_read", "workflow_run", null, { runId, documents: gstr1.counts.documents, period: gstr1.period });
  }
  res.json({
    ok: true,
    privacy: gate.privacy,
    runId,
    file: file.originalname,
    gstr1,
    threeB,
    itcRuns: itcRuns.map(run => ({ runId: run.runId, title: run.title, createdAt: run.createdAt, period: run.source.period })),
    itcRunId: chosen?.runId ?? null,
  });
});

async function gstr1For(req: Request, companyId: number): Promise<Gstr1Result | null> {
  const runId = textBody(req.body?.runId);
  if (runId && !runId.startsWith("local-")) {
    const saved = await latestArtifact(companyId, runId, "gstr1_working");
    if (saved?.gstr1?.totals) return saved.gstr1 as Gstr1Result;
  }
  const given = req.body?.gstr1;
  if (given && typeof given === "object" && given.totals && typeof given.totals.b2b?.taxable === "number") return given as Gstr1Result;
  return null;
}

router.post("/jobs/gst-sales/3b", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gstr1 = await gstr1For(req, companyId);
  if (!gstr1) {
    res.status(404).json({ ok: false, message: "This result is no longer available. Upload the sales register again." });
    return;
  }
  const adjustments = adjustmentSchema.safeParse(req.body?.adjustments ?? {});
  if (!adjustments.success) {
    res.status(422).json({ ok: false, message: "An adjustment is not a valid amount." });
    return;
  }
  const basis: ItcBasis = req.body?.basis === "portal" ? "portal" : "matched";
  const itcRunId = textBody(req.body?.itcRunId);
  let source: ItcSource | null = null;
  if (itcRunId && itcRunId !== "none") {
    const saved = await latestArtifact(companyId, itcRunId, "gstr2b_comparison");
    source = itcFromGstr2b(saved, itcRunId);
  }
  res.json({ ok: true, threeB: buildGstr3b(gstr1, source, basis, adjustmentsInPaise(adjustments.data)) });
});

router.post("/jobs/gst-sales/excel", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gstr1 = await gstr1For(req, companyId);
  if (!gstr1) {
    res.status(404).json({ ok: false, message: "This result is no longer available. Upload the sales register again." });
    return;
  }
  const adjustments = adjustmentSchema.safeParse(req.body?.adjustments ?? {});
  const basis: ItcBasis = req.body?.basis === "portal" ? "portal" : "matched";
  const itcRunId = textBody(req.body?.itcRunId);
  let source: ItcSource | null = null;
  if (itcRunId && itcRunId !== "none") source = itcFromGstr2b(await latestArtifact(companyId, itcRunId, "gstr2b_comparison"), itcRunId);
  try {
    const threeB = buildGstr3b(gstr1, source, basis, adjustments.success ? adjustmentsInPaise(adjustments.data) : {});
    const workbook = buildReturnWorkbook({ clientName: textBody(req.body?.clientName) || "Client", gstr1, threeB });
    const bytes = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="TallyThis_GSTR1_3B_Working.xlsx"');
    res.send(Buffer.from(bytes));
    void auditAction(req, "job.gst_sales_excel", "workflow_run", null, { documents: gstr1.counts.documents }).catch(() => undefined);
  } catch {
    res.status(500).json({ ok: false, message: "The Excel file could not be created. Try again." });
  }
});

// ── Payroll ─────────────────────────────────────────────────────────────────

const employeeSchema = z.object({
  row: z.number().int(),
  code: z.string().max(40).default(""),
  name: z.string().max(160),
  designation: z.string().max(80).default(""),
  uan: z.string().max(20).default(""),
  esicNumber: z.string().max(30).default(""),
  pan: z.string().max(12).default(""),
  account: z.string().max(40).default(""),
  ifsc: z.string().max(15).default(""),
  paidDays: z.number().nullable().default(null),
  basic: z.number().int(),
  pfWage: z.number().int(),
  earnings: z.array(z.object({ head: z.string().max(80), amount: z.number().int() })).max(60),
  gross: z.number().int(),
  pf: z.number().int(),
  esi: z.number().int(),
  pt: z.number().int(),
  tds: z.number().int(),
  otherDeductions: z.array(z.object({ head: z.string().max(80), amount: z.number().int() })).max(40),
  deductions: z.number().int(),
  net: z.number().int(),
  employerPf: z.number().int().nullable().default(null),
  employerEsi: z.number().int().nullable().default(null),
  flags: z.array(z.string().max(300)).max(40).default([]),
  blocked: z.boolean().default(false),
});

function monthOrNull(value: unknown) {
  const text = textBody(value);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? text : null;
}

router.post(
  "/jobs/payroll/read",
  requirePermission("uploads.create"),
  upload.fields([{ name: "sheet", maxCount: 1 }, { name: "bank", maxCount: 1 }]),
  async (req, res): Promise<void> => {
    const companyId = await resolveBooksCompanyId(req, res);
    if (companyId == null) return;
    const gate = await privacyGate(req, res);
    if (!gate) return;
    const sheetFile = filesOf(req, "sheet")[0];
    if (!sheetFile) {
      res.status(400).json({ ok: false, message: "Upload the salary sheet as Excel or CSV." });
      return;
    }
    if (isDocumentFile(sheetFile)) {
      res.status(422).json({ ok: false, message: "Upload the salary sheet as Excel or CSV. A PDF or photo of a payslip cannot be read here." });
      return;
    }
    const clientName = textBody(req.body?.clientName);
    const stored = await loadProfile(companyId, clientName);
    let override: Partial<EmployerProfile> = {};
    try {
      const parsed = profileSchema.partial().safeParse(JSON.parse(textBody(req.body?.employer) || "{}"));
      if (parsed.success) override = parsed.data;
    } catch {
      // An unreadable override is ignored; the stored details are used.
    }
    let best: ReturnType<typeof readPayroll> | null = null;
    let failure = "";
    try {
      for (const sheet of sheetsOf({ originalname: sheetFile.originalname, buffer: sheetFile.buffer })) {
        if (sheet.table.length < 2) continue;
        try {
          const read = readPayroll(sheet.table, { employerFallback: stored.name });
          if (!best || read.employees.length > best.employees.length) best = read;
        } catch (error) {
          failure = failure || (error instanceof Error ? error.message : "");
        }
      }
    } catch {
      failure = "This file could not be opened. Save it as .xlsx or CSV and try again.";
    }
    if (!best) {
      res.status(422).json({ ok: false, message: failure || "No employees were found in this file." });
      return;
    }
    const month = monthOrNull(req.body?.month) ?? best.month;
    // The employer's name: what the person typed, else the file's title, else the saved client.
    const employer: EmployerProfile = {
      ...stored,
      ...Object.fromEntries(Object.entries(override).filter(([, value]) => typeof value === "string" && value !== "")),
      name: (override.name || best.employer || stored.name || clientName).trim(),
    };
    const statutory = statutoryOf(best.employees);

    let bank: BankCheck | null = null;
    let bankMessage = "";
    const bankFile = filesOf(req, "bank")[0];
    if (bankFile) {
      const read = await readBankStatementFile(bankFile, {
        password: textBody(req.body?.password) || undefined,
        companyId,
        userId: req.auth?.userId ?? null,
        privacy: gate.privacy,
        allowAi: gate.allowAi,
      });
      if (read.ok && read.summary) bank = matchSalaryPayments(best.employees, read.summary.transactions, month);
      else if (read.needsPassword) {
        res.status(422).json({ ok: false, needsPassword: true, wrongPassword: read.wrongPassword ?? false, message: read.message });
        return;
      } else bankMessage = read.message;
    }

    let runId: string | null = null;
    if (!gate.privacy) {
      runId = await saveRun({
        companyId,
        userId: req.auth?.userId,
        runType: "payroll_register",
        clientId: Number(req.body?.clientId) || null,
        clientName,
        title: `Payroll — ${employer.name || sheetFile.originalname}${month ? ` (${month})` : ""}`,
        artifacts: [{ type: "payroll_register", title: "Payroll register", json: { employer, month, employees: best.employees, statutory, bank, notes: best.notes, file: sheetFile.originalname } }],
      });
      await auditAction(req, "job.payroll_read", "workflow_run", null, { runId, employees: best.employees.length, month });
    }
    res.json({
      ok: true,
      privacy: gate.privacy,
      runId,
      file: sheetFile.originalname,
      employer,
      month,
      employees: best.employees,
      statutory,
      bank,
      bankMessage,
      notes: best.notes,
    });
  },
);

const journalSchema = z.object({
  employer: profileSchema,
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  employees: z.array(employeeSchema).min(1).max(20000),
  tallyCompany: z.string().trim().max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  salaryExpense: ledgerName.default("Salary Expenses"),
  salaryPayable: ledgerName.default("Salary Payable"),
  pfPayable: ledgerName.default("PF Payable"),
  esiPayable: ledgerName.default("ESI Payable"),
  ptPayable: ledgerName.default("Professional Tax Payable"),
  tdsPayable: ledgerName.default("TDS Payable"),
  otherDeductionLedger: ledgerName.default("Employee Advances"),
  employerPfExpense: ledgerName.default("Employer PF Contribution"),
  employerEsiExpense: ledgerName.default("Employer ESI Contribution"),
  runId: z.string().max(80).optional(),
});

router.post("/jobs/payroll/journal", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const parsed = journalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, message: "The salary entry could not be prepared. Check the month and the ledger names." });
    return;
  }
  const config = parsed.data;
  const employees = config.employees as Employee[];
  const statutory = statutoryOf(employees);
  const journal = buildPayrollJournal(statutory, employees, {
    clientName: config.employer.name || "Client",
    tallyCompany: config.tallyCompany,
    date: config.date,
    month: config.month,
    salaryExpense: config.salaryExpense,
    salaryPayable: config.salaryPayable,
    pfPayable: config.pfPayable,
    esiPayable: config.esiPayable,
    ptPayable: config.ptPayable,
    tdsPayable: config.tdsPayable,
    otherDeductionLedger: config.otherDeductionLedger,
    employerPfExpense: config.employerPfExpense,
    employerEsiExpense: config.employerEsiExpense,
  });
  if (!journal.ok || !journal.xml) {
    res.status(422).json({ ok: false, errors: journal.errors, message: journal.errors[0] ?? "The salary entry did not pass the checks." });
    return;
  }
  if (!gate.privacy && config.runId && !config.runId.startsWith("local-")) {
    await saveRunArtifact(config.runId, { artifactType: "tally_xml", title: journal.fileName ?? "salary-journal.xml", jsonData: { lines: journal.lines, xml: journal.xml }, companyId });
    await auditAction(req, "job.payroll_journal_generated", "workflow_run", null, { runId: config.runId, month: config.month });
  }
  res.json({ ok: true, xml: journal.xml, mastersXml: journal.mastersXml, fileName: journal.fileName, lines: journal.lines, message: "Salary journal for Tally is ready. It balances to the paise." });
});

router.post("/jobs/payroll/send", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const gate = await privacyGate(req, res);
  if (!gate) return;
  const parsed = journalSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.tallyCompany) {
    res.status(422).json({ ok: false, message: parsed.success ? "Choose the Tally company first." : "The salary entry could not be prepared. Check the month and the ledger names." });
    return;
  }
  const config = parsed.data;
  const employees = config.employees as Employee[];
  const journal = buildPayrollJournal(statutoryOf(employees), employees, {
    clientName: config.employer.name || "Client",
    tallyCompany: config.tallyCompany,
    date: config.date,
    month: config.month,
    salaryExpense: config.salaryExpense,
    salaryPayable: config.salaryPayable,
    pfPayable: config.pfPayable,
    esiPayable: config.esiPayable,
    ptPayable: config.ptPayable,
    tdsPayable: config.tdsPayable,
    otherDeductionLedger: config.otherDeductionLedger,
    employerPfExpense: config.employerPfExpense,
    employerEsiExpense: config.employerEsiExpense,
  });
  if (!journal.ok || !journal.xml) {
    res.status(422).json({ ok: false, errors: journal.errors, message: "Nothing was sent to Tally because the entry did not pass the checks." });
    return;
  }
  let sent: Awaited<ReturnType<typeof sendVouchersToTally>>;
  try {
    sent = await sendVouchersToTally({ mastersXml: journal.mastersXml, vouchersXml: journal.xml, expected: 1 });
  } catch {
    res.status(502).json({ ok: false, message: "Tally did not confirm the import. Open the Day Book in Tally to see whether the entry arrived before sending again." });
    return;
  }
  if (!gate.privacy && config.runId && !config.runId.startsWith("local-")) {
    await saveRunArtifact(config.runId, { artifactType: "tally_push", title: `Sent to Tally — ${config.tallyCompany}`, jsonData: { ...sent, tallyCompany: config.tallyCompany, kind: "salary_journal", month: config.month }, companyId });
    await auditAction(req, "job.payroll_tally_push", "workflow_run", null, { runId: config.runId, created: sent.created, month: config.month });
  }
  res.json({
    ...sent,
    tallyCompany: config.tallyCompany,
    message: sent.ok ? "Salary entry created in Tally." : "Tally did not accept the salary entry. Check Tally's messages below and the Day Book before sending again.",
  });
});

router.post("/jobs/payroll/excel", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const parsed = z
    .object({
      employer: profileSchema,
      month: z.string().max(10).nullable().default(null),
      employees: z.array(employeeSchema).min(1).max(20000),
      bank: z.unknown().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, message: "The Excel file could not be created." });
    return;
  }
  try {
    const employees = parsed.data.employees as Employee[];
    const workbook = buildPayrollWorkbook({
      employer: parsed.data.employer,
      month: parsed.data.month,
      employees,
      statutory: statutoryOf(employees),
      bank: (parsed.data.bank as BankCheck | undefined) ?? null,
    });
    const bytes = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="TallyThis_Payroll_Register.xlsx"');
    res.send(Buffer.from(bytes));
  } catch {
    res.status(500).json({ ok: false, message: "The Excel file could not be created. Try again." });
  }
});

export type { CheckedBill };
export default router;
