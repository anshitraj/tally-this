/**
 * E-commerce workspaces: marketplace report imports, the transactions read from them, review decisions, the period's
 * approval and its working papers. Every route is signed in, permission-checked and scoped to the books being worked on
 * (a CA's client only through an active link). Data arrives by report upload; nothing here talks to a marketplace.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { and, desc, eq, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import { auditLogsTable, companiesTable, db, rolePermissionsTable, usersTable } from "@workspace/db";
import { auditAction, requirePermission } from "../middleware/authz";
import { resolveBooksCompanyId } from "../services/companyScope";
import { MAX_UPLOAD_BYTES } from "../lib/uploadLimit";
import { stateName } from "../services/gstStates";
import { buildPdf, buildWorkbook, type ExportEvent, type ReportData } from "../services/marketplace/exports";
import { financialYearOf, isValidGstin, parseRate, type RoundingMode } from "../services/marketplace/gstEngine";
import { textToPaise } from "../services/marketplace/money";
import { MARKETPLACES, adapterFor, marketplaceInfo, type MarketplaceInfo } from "../services/marketplace/registry";
import { STAGES, createImportJob, deleteImport, markStaleJob, runImport, stageLabel } from "../services/marketplace/runner";
import {
  BLOCKING,
  STATUS_KINDS,
  chunk,
  classifications,
  dataVersion,
  ensureReport,
  events,
  exceptionCounts,
  exceptions,
  files,
  holdIssues,
  jobs,
  periodEvents,
  periodsOf,
  recentJobs,
  refreshStatuses,
  relinkReturns,
  releaseIssues,
  reportState,
  reports,
  reviews,
} from "../services/marketplace/store";
import { compareWithCa, gstr1Working, hsnSummary, overview, stateSummary } from "../services/marketplace/summaries";
import type { CanonicalField, EventType } from "../services/marketplace/types";

const router: IRouter = Router();
const MAX_FILES = 20;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES } });
const ACCEPTED = /\.(xlsx|xls|csv|zip)$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const FY = /^\d{4}-\d{2}$/;
const EVENT_TYPES: EventType[] = ["sale", "return", "cancellation", "credit_note", "adjustment"];

/** Passes when the person's role has any one of the permissions (a CA reviews; finance staff run). */
function requireAny(permissions: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const rows = await db.select({ p: rolePermissionsTable.permission }).from(rolePermissionsTable).where(and(
      eq(rolePermissionsTable.companyId, req.auth.companyId),
      eq(rolePermissionsTable.role, req.auth.role),
      inArray(rolePermissionsTable.permission, permissions),
      eq(rolePermissionsTable.enabled, true),
    )).limit(1);
    if (rows.length === 0) {
      await db.insert(auditLogsTable).values({ companyId: req.auth.companyId, userId: req.auth.userId, actorEmail: req.auth.email, action: "auth.permission_denied", entityType: "permission", metadata: { permission: permissions.join(" | "), role: req.auth.role, path: req.path, method: req.method }, ipAddress: req.ip });
      res.status(403).json({ error: "Permission denied", permission: permissions[0] });
      return;
    }
    next();
  };
}
const canReview = requireAny(["reconciliation.run", "ca_review.process", "reconciliation.approve"]);

interface Scope { companyId: number; info: MarketplaceInfo }

/** Resolves the books and the marketplace, or answers the request and returns null. */
async function scope(req: Request, res: Response, options: { importable?: boolean } = {}): Promise<Scope | null> {
  const info = marketplaceInfo(String(req.params.marketplace ?? "").toLowerCase());
  if (!info) {
    res.status(404).json({ ok: false, message: "That marketplace is not supported." });
    return null;
  }
  if (options.importable && !adapterFor(info.id)) {
    res.status(409).json({ ok: false, message: `${info.name} imports are not available yet.` });
    return null;
  }
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return null;
  return { companyId, info };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : Array.isArray(value) && typeof value[0] === "string" ? value[0].trim() : "";
}

function periodParam(req: Request, res: Response, fallback: string | null): string | null | undefined {
  const value = text(req.query.period) || text((req.body as Record<string, unknown> | undefined)?.period) || fallback;
  if (!value) return null;
  if (!PERIOD.test(value)) {
    res.status(400).json({ ok: false, message: "The period must look like 2026-08." });
    return undefined;
  }
  return value;
}

function roundingParam(req: Request): RoundingMode {
  return text(req.query.rounding) === "aggregate" ? "aggregate" : "line";
}

async function latestPeriod(companyId: number, marketplace: string): Promise<string | null> {
  const [row] = await db.select({ p: sql<string>`max(${events.reportPeriod})` }).from(events).where(and(eq(events.companyId, companyId), eq(events.marketplace, marketplace)));
  return row?.p ?? null;
}

function publicJob(job: typeof jobs.$inferSelect) {
  const stats = job.stats as Record<string, unknown>;
  const uploads = (stats.uploads as Array<{ name: string; size: number }> | undefined) ?? [];
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    stageLabel: stageLabel(job.stage),
    progress: job.progress,
    message: job.message,
    period: job.period,
    financialYear: job.financialYear,
    sellerGstin: job.sellerGstin,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    uploads: uploads.map(u => ({ name: u.name, size: u.size })),
    files: stats.files ?? [],
    transactions: stats.transactions ?? null,
    counted: stats.counted ?? null,
    duplicates: stats.duplicates ?? null,
    conflicts: stats.conflicts ?? 0,
    sales: stats.sales ?? null,
    returns: stats.returns ?? null,
    exceptions: stats.exceptions ?? null,
    periods: stats.periods ?? [],
    problems: stats.problems ?? [],
    needsMapping: job.status === "needs_mapping" ? stats.needsMapping ?? [] : [],
  };
}

/** The type a reviewer gave the event, else the one read from the file. */
const effectiveType = sql<string>`coalesce((SELECT r.data->>'eventType' FROM marketplace_reviews r WHERE r.event_id = e.id AND r.action IN ('classify', 'reopen') ORDER BY r.id DESC LIMIT 1), e.event_type)`;

// ---------------------------------------------------------------------------------------------------------------------
// Marketplaces and workspace

router.get("/ecommerce/marketplaces", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  const usage = await db.execute(sql`
    SELECT marketplace, count(*) FILTER (WHERE duplicate_of IS NULL)::int AS transactions, count(DISTINCT report_period)::int AS periods, max(created_at) AS last_import
    FROM marketplace_events WHERE company_id = ${companyId} GROUP BY marketplace`);
  const by = new Map((usage.rows as Array<{ marketplace: string; transactions: number; periods: number; last_import: string }>).map(r => [r.marketplace, r]));
  res.json({
    ok: true,
    marketplaces: MARKETPLACES.map(m => ({ ...m, usage: by.has(m.id) ? { transactions: by.get(m.id)!.transactions, periods: by.get(m.id)!.periods, lastImport: by.get(m.id)!.last_import } : null })),
  });
});

router.get("/ecommerce/:marketplace/workspace", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const periods = await periodsOf(s.companyId, s.info.id);
  const period = periodParam(req, res, periods[0]?.period ?? null);
  if (period === undefined) return;
  const recent = await Promise.all((await recentJobs(s.companyId, s.info.id, 10)).map(markStaleJob));
  const gstins = await db.selectDistinct({ g: events.sellerGstin }).from(events).where(and(eq(events.companyId, s.companyId), eq(events.marketplace, s.info.id), isNotNull(events.sellerGstin)));
  const [company] = await db.select({ name: companiesTable.name, gstin: companiesTable.gstin }).from(companiesTable).where(eq(companiesTable.id, s.companyId)).limit(1);
  const byMonth = await db.execute(sql`
    SELECT e.report_period AS period,
      coalesce(sum(CASE WHEN ${effectiveType} = 'sale' THEN e.taxable_value ELSE 0 END), 0)::text AS sales,
      coalesce(sum(CASE WHEN ${effectiveType} IN ('return', 'cancellation', 'credit_note') THEN e.taxable_value ELSE 0 END), 0)::text AS returns
    FROM marketplace_events e WHERE e.company_id = ${s.companyId} AND e.marketplace = ${s.info.id} AND e.duplicate_of IS NULL
    GROUP BY e.report_period ORDER BY e.report_period`);
  let periodData = null;
  if (period) {
    const { summary } = await periodEvents(s.companyId, s.info.id, period);
    const counts = await exceptionCounts(s.companyId, s.info.id, period);
    const state = await reportState(s.companyId, s.info.id, period);
    const statuses = await db.execute(sql`SELECT recon_status AS status, count(*)::int AS n FROM marketplace_events WHERE company_id = ${s.companyId} AND marketplace = ${s.info.id} AND report_period = ${period} GROUP BY recon_status`);
    const duplicatesSkipped = await db.execute(sql`SELECT count(*)::int AS n FROM marketplace_events WHERE company_id = ${s.companyId} AND marketplace = ${s.info.id} AND report_period = ${period} AND duplicate_of IS NOT NULL`);
    periodData = {
      overview: overview(summary, period),
      exceptions: counts,
      report: state,
      statuses: statuses.rows,
      duplicates: (duplicatesSkipped.rows[0] as { n: number }).n,
      hsnCount: new Set(summary.map(e => e.hsn ?? "")).size,
      stateCount: new Set(summary.map(e => e.placeOfSupply ?? "")).size,
    };
  }
  // What this person may do here, so the page offers only those buttons. Every action is checked again on the server.
  const granted = new Set((await db.select({ p: rolePermissionsTable.permission }).from(rolePermissionsTable).where(and(
    eq(rolePermissionsTable.companyId, req.auth!.companyId),
    eq(rolePermissionsTable.role, req.auth!.role),
    eq(rolePermissionsTable.enabled, true),
  ))).map(r => r.p));
  res.json({
    ok: true,
    marketplace: s.info,
    can: {
      import: granted.has("uploads.create"),
      remove: granted.has("uploads.delete"),
      review: ["reconciliation.run", "ca_review.process", "reconciliation.approve"].some(p => granted.has(p)),
      approve: granted.has("reconciliation.approve"),
      export: granted.has("reports.export"),
    },
    company: { name: company?.name ?? "", gstin: company?.gstin ?? null },
    sellerGstins: gstins.map(g => g.g).filter(Boolean),
    periods,
    period,
    data: periodData,
    byMonth: byMonth.rows,
    jobs: recent.map(publicJob),
    stages: STAGES.map(st => ({ id: st.id, label: st.label })),
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Imports

router.post("/ecommerce/:marketplace/imports", requirePermission("uploads.create"), upload.array("files", MAX_FILES), async (req, res): Promise<void> => {
  const s = await scope(req, res, { importable: true });
  if (!s) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (text(body.privacy) === "true" || text(body.privacy) === "1") {
    res.status(400).json({ ok: false, message: "E-commerce workspaces keep imported reports so a period can be reviewed and approved. Turn off save-nothing mode to import here." });
    return;
  }
  const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (uploaded.length === 0) {
    res.status(400).json({ ok: false, message: `Choose the ${s.info.name} report files to import (XLSX, XLS, CSV or ZIP).` });
    return;
  }
  const refused = uploaded.filter(f => !ACCEPTED.test(f.originalname));
  if (refused.length > 0) {
    res.status(400).json({ ok: false, message: `${refused.map(f => f.originalname).join(", ")}: only XLSX, XLS, CSV and ZIP files can be imported. Download the reports from the ${s.info.name} Supplier Panel in Excel format.` });
    return;
  }
  const sellerGstin = text(body.sellerGstin).toUpperCase() || null;
  if (sellerGstin && !isValidGstin(sellerGstin)) {
    res.status(400).json({ ok: false, message: `${sellerGstin} is not a valid GSTIN. Check the 15 characters.` });
    return;
  }
  const period = text(body.period) || null;
  if (period && !PERIOD.test(period)) {
    res.status(400).json({ ok: false, message: "The period must look like 2026-08." });
    return;
  }
  const financialYear = text(body.financialYear) || (period ? financialYearOf(period) : null);
  if (financialYear && !FY.test(financialYear)) {
    res.status(400).json({ ok: false, message: "The financial year must look like 2026-27." });
    return;
  }
  if (period && financialYear && financialYearOf(period) !== financialYear) {
    res.status(400).json({ ok: false, message: `${period} is not in financial year ${financialYear}.` });
    return;
  }
  const jobId = await createImportJob({ companyId: s.companyId, marketplace: s.info.id, sellerGstin, financialYear, period, userId: req.auth!.userId, uploads: uploaded.map(f => ({ name: f.originalname, buffer: f.buffer })) });
  await auditAction(req, "ecommerce.import_started", "marketplace_import", null, { marketplace: s.info.id, jobId, files: uploaded.length, period });
  await runImport(jobId);
  res.status(202).json({ ok: true, jobId });
});

async function jobFor(req: Request, res: Response, s: Scope) {
  const [job] = await db.select().from(jobs).where(and(eq(jobs.id, String(req.params.jobId)), eq(jobs.companyId, s.companyId), eq(jobs.marketplace, s.info.id))).limit(1);
  if (!job) {
    res.status(404).json({ ok: false, message: "That import was not found." });
    return null;
  }
  return markStaleJob(job);
}

router.get("/ecommerce/:marketplace/imports", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const list = await Promise.all((await recentJobs(s.companyId, s.info.id, 50)).map(markStaleJob));
  res.json({ ok: true, jobs: list.map(publicJob) });
});

router.get("/ecommerce/:marketplace/imports/:jobId", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const job = await jobFor(req, res, s);
  if (!job) return;
  const fileRows = await db.select({ id: files.id, fileName: files.fileName, containerName: files.containerName, sheetName: files.sheetName, reportType: files.reportType, status: files.status, rowCount: files.rowCount, periods: files.periods, message: files.message, unknownColumns: files.unknownColumns, columnMap: files.columnMap })
    .from(files).where(eq(files.jobId, job.id)).orderBy(files.id);
  res.json({ ok: true, job: publicJob(job), files: fileRows });
});

router.post("/ecommerce/:marketplace/imports/:jobId/mapping", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const s = await scope(req, res, { importable: true });
  if (!s) return;
  const job = await jobFor(req, res, s);
  if (!job) return;
  if (job.status !== "needs_mapping") {
    res.status(409).json({ ok: false, message: "This import is not waiting for columns." });
    return;
  }
  const adapter = adapterFor(s.info.id)!;
  const raw = (req.body as { mappings?: unknown })?.mappings;
  if (!raw || typeof raw !== "object") {
    res.status(400).json({ ok: false, message: "Choose a column for each missing field." });
    return;
  }
  const waiting = ((job.stats as { needsMapping?: Array<{ key: string; headers: string[] }> }).needsMapping ?? []);
  const mappings: Record<string, Partial<Record<CanonicalField, string>>> = {};
  for (const [key, chosen] of Object.entries(raw as Record<string, unknown>)) {
    const target = waiting.find(w => w.key === key);
    if (!target || !chosen || typeof chosen !== "object") {
      res.status(400).json({ ok: false, message: "That file is not part of this import." });
      return;
    }
    const clean: Partial<Record<CanonicalField, string>> = {};
    for (const [field, column] of Object.entries(chosen as Record<string, unknown>)) {
      if (!(field in adapter.fieldAliases) || typeof column !== "string" || !column) continue;
      if (!target.headers.includes(column)) {
        res.status(400).json({ ok: false, message: `"${column}" is not a column in this file.` });
        return;
      }
      clean[field as CanonicalField] = column;
    }
    mappings[key] = clean;
  }
  await db.update(jobs).set({ status: "queued", stage: "queued", progress: 2, message: null, updatedAt: new Date() }).where(eq(jobs.id, job.id));
  await auditAction(req, "ecommerce.mapping_saved", "marketplace_import", null, { marketplace: s.info.id, jobId: job.id, files: Object.keys(mappings).length });
  await runImport(job.id, { mappings });
  res.status(202).json({ ok: true, jobId: job.id });
});

router.post("/ecommerce/:marketplace/imports/:jobId/retry", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  const s = await scope(req, res, { importable: true });
  if (!s) return;
  const job = await jobFor(req, res, s);
  if (!job) return;
  if (job.status === "running" || job.status === "queued") {
    res.status(409).json({ ok: false, message: "This import is still running." });
    return;
  }
  await db.update(jobs).set({ status: "queued", stage: "queued", progress: 2, message: null, updatedAt: new Date() }).where(eq(jobs.id, job.id));
  await auditAction(req, "ecommerce.import_retried", "marketplace_import", null, { marketplace: s.info.id, jobId: job.id });
  await runImport(job.id);
  res.status(202).json({ ok: true, jobId: job.id });
});

router.delete("/ecommerce/:marketplace/imports/:jobId", requirePermission("uploads.delete"), async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const job = await jobFor(req, res, s);
  if (!job) return;
  if (job.status === "running") {
    res.status(409).json({ ok: false, message: "Wait for this import to finish before removing it." });
    return;
  }
  const periods = ((job.stats as { periods?: string[] }).periods ?? []);
  const reread = await deleteImport(job);
  await auditAction(req, "ecommerce.import_deleted", "marketplace_import", null, { marketplace: s.info.id, jobId: job.id, periods, reread: reread.length });
  res.json({ ok: true, reread });
});

// ---------------------------------------------------------------------------------------------------------------------
// Transactions

const SORTS: Record<string, SQL> = {
  date: sql`coalesce(e.return_date, e.order_date)`,
  taxable: sql`e.taxable_value`,
  hsn: sql`e.hsn`,
  state: sql`e.place_of_supply`,
  status: sql`e.recon_status`,
  id: sql`e.id`,
};

const ATTENTION = ["missing_info", "tax_mismatch", "return_mismatch", "unmatched"];

function transactionFilters(req: Request, s: Scope, period: string): SQL[] {
  const where: SQL[] = [sql`e.company_id = ${s.companyId}`, sql`e.marketplace = ${s.info.id}`, sql`e.report_period = ${period}`];
  const status = text(req.query.status);
  if (status === "duplicate") where.push(sql`e.duplicate_of IS NOT NULL`);
  else if (status === "conflict") where.push(sql`e.recon_status = 'conflict'`);
  // Rows held back against another with different figures need attention although they are not counted.
  else if (status === "attention") where.push(sql`(e.recon_status = 'conflict' OR (e.duplicate_of IS NULL AND e.recon_status IN (${sql.join(ATTENTION.map(v => sql`${v}`), sql`, `)})))`);
  else {
    if (status !== "all") where.push(sql`e.duplicate_of IS NULL`);
    if (status && status !== "all") where.push(sql`e.recon_status = ${status}`);
  }
  const type = text(req.query.type);
  if (type === "reduction") where.push(sql`${effectiveType} IN ('return', 'cancellation', 'credit_note')`);
  else if (EVENT_TYPES.includes(type as EventType)) where.push(sql`${effectiveType} = ${type}`);
  const hsn = text(req.query.hsn);
  if (hsn) where.push(sql`e.hsn = ${hsn}`);
  const state = text(req.query.state);
  if (state) where.push(sql`e.place_of_supply = ${state}`);
  const search = text(req.query.search).slice(0, 80);
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    where.push(sql`(e.order_id ILIKE ${like} OR e.sub_order_id ILIKE ${like} OR e.document_number ILIKE ${like} OR e.hsn ILIKE ${like})`);
  }
  return where;
}

router.get("/ecommerce/:marketplace/transactions", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const period = periodParam(req, res, await latestPeriod(s.companyId, s.info.id));
  if (period === undefined) return;
  if (!period) {
    res.json({ ok: true, period: null, total: 0, page: 1, pageSize: 50, rows: [] });
    return;
  }
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = Math.min(200, Math.max(10, Math.floor(Number(req.query.pageSize) || 50)));
  const sort = SORTS[text(req.query.sort)] ?? SORTS.date;
  const dir = text(req.query.dir) === "asc" ? sql`ASC` : sql`DESC`;
  const where = sql.join(transactionFilters(req, s, period), sql` AND `);
  const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM marketplace_events e WHERE ${where}`)).rows as Array<{ n: number }>;
  const rows = await db.execute(sql`
    SELECT e.id, ${effectiveType} AS "eventType", e.event_type AS "sourceType", e.order_id AS "orderId", e.sub_order_id AS "subOrderId",
      e.order_date AS "orderDate", e.return_date AS "returnDate", e.document_number AS "documentNumber", e.hsn, e.description,
      e.quantity, e.taxable_value AS taxable, e.gst_rate AS rate, e.igst, e.cgst, e.sgst, e.cess, e.invoice_value AS "invoiceValue",
      e.source_tax AS "sourceTax", e.computed_tax AS "computedTax", e.place_of_supply AS "placeOfSupply", e.supply_type AS "supplyType",
      e.recon_status AS status, e.duplicate_of AS "duplicateOf", e.related_event_id AS "relatedEventId", e.source_row AS "sourceRow",
      f.file_name AS "fileName", f.sheet_name AS "sheetName",
      (SELECT count(*)::int FROM marketplace_exceptions x WHERE x.event_id = e.id AND x.status = 'open' AND x.severity IN ('error', 'warning')) AS "openExceptions"
    FROM marketplace_events e LEFT JOIN marketplace_source_files f ON f.id = e.source_file_id
    WHERE ${where}
    ORDER BY ${sort} ${dir} NULLS LAST, e.id ${dir}
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
  res.json({
    ok: true,
    period,
    total: n,
    page,
    pageSize,
    rows: (rows.rows as Array<Record<string, unknown>>).map(r => ({ ...r, posName: r.placeOfSupply ? stateName(String(r.placeOfSupply)) : null })),
  });
});

router.get("/ecommerce/:marketplace/transactions/:id", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const id = Number(req.params.id);
  const [event] = Number.isInteger(id) ? await db.select().from(events).where(and(eq(events.id, id), eq(events.companyId, s.companyId), eq(events.marketplace, s.info.id))).limit(1) : [];
  if (!event) {
    res.status(404).json({ ok: false, message: "That transaction was not found." });
    return;
  }
  const [file] = await db.select({ fileName: files.fileName, containerName: files.containerName, sheetName: files.sheetName, reportType: files.reportType, createdAt: files.createdAt }).from(files).where(eq(files.id, event.sourceFileId)).limit(1);
  const exceptionRows = await db.select().from(exceptions).where(and(eq(exceptions.eventId, event.id), eq(exceptions.companyId, s.companyId))).orderBy(exceptions.id);
  const reviewRows = await db.select().from(reviews).where(and(eq(reviews.eventId, event.id), eq(reviews.companyId, s.companyId))).orderBy(desc(reviews.id));
  const relatedIds = [event.relatedEventId, event.duplicateOf].filter((v): v is number => v != null);
  const linked = await db.select({ id: events.id, eventType: events.eventType, reportPeriod: events.reportPeriod, taxable: events.taxableValue, quantity: events.quantity, orderDate: events.orderDate, returnDate: events.returnDate, duplicateOf: events.duplicateOf, relatedEventId: events.relatedEventId })
    .from(events).where(and(eq(events.companyId, s.companyId), eq(events.marketplace, s.info.id), sql`(${events.id} IN (${sql.join([...relatedIds, -1].map(v => sql`${v}`), sql`, `)}) OR ${events.relatedEventId} = ${event.id} OR ${events.duplicateOf} = ${event.id})`))
    .orderBy(events.id);
  const overrides = await classifications([event.id]);
  res.json({
    ok: true,
    event: { ...event, eventType: overrides.get(event.id) ?? event.eventType, sourceType: event.eventType, taxable: event.taxableValue, rate: event.gstRate, status: event.reconStatus, posName: event.placeOfSupply ? stateName(event.placeOfSupply) : null },
    file: file ?? null,
    exceptions: exceptionRows,
    reviews: reviewRows.map(r => ({ id: r.id, action: r.action, note: r.note, data: r.data, actor: r.actorEmail, at: r.createdAt })),
    linked: linked.filter(l => l.id !== event.id),
  });
});

router.post("/ecommerce/:marketplace/transactions/:id/review", canReview, async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const id = Number(req.params.id);
  const [event] = Number.isInteger(id) ? await db.select().from(events).where(and(eq(events.id, id), eq(events.companyId, s.companyId), eq(events.marketplace, s.info.id))).limit(1) : [];
  if (!event) {
    res.status(404).json({ ok: false, message: "That transaction was not found." });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = text(body.action);
  const note = text(body.note).slice(0, 2000) || null;
  const actor = { companyId: s.companyId, marketplace: s.info.id, eventId: event.id, actorUserId: req.auth!.userId, actorEmail: req.auth!.email };
  const open = await db.select().from(exceptions).where(and(eq(exceptions.eventId, event.id), eq(exceptions.status, "open")));
  const now = new Date();

  if (event.duplicateOf != null && !["note", "use_instead", "keep_earlier"].includes(action)) {
    res.status(409).json({ ok: false, message: "This row repeats another one and is not counted. Review the original instead." });
    return;
  }
  if (action === "use_instead" || action === "keep_earlier") {
    const conflict = open.find(x => x.kind === "conflicting_rows");
    if (!conflict || event.duplicateOf == null) {
      res.status(409).json({ ok: false, message: "This row is not held back against another one." });
      return;
    }
    if (!note) {
      res.status(400).json({ ok: false, message: "Add a note saying which figures are right and why." });
      return;
    }
    const replaced = event.duplicateOf;
    if (action === "keep_earlier") {
      await db.insert(reviews).values({ ...actor, action: "keep_earlier", note, data: { kept: replaced } });
      await db.update(exceptions).set({ status: "resolved", note, resolvedBy: req.auth!.userId, resolvedAt: now }).where(eq(exceptions.id, conflict.id));
    } else {
      // This row counts from now on; the row it was held against (and exact repeats of that row) point here instead.
      await db.update(events).set({ duplicateOf: null }).where(eq(events.id, event.id));
      await db.update(events).set({ duplicateOf: event.id }).where(and(eq(events.companyId, s.companyId), eq(events.marketplace, s.info.id), ne(events.id, event.id), or(eq(events.id, replaced), eq(events.duplicateOf, replaced))));
      await holdIssues(replaced);
      await releaseIssues(event.id);
      await db.update(exceptions).set({ status: "resolved", note, resolvedBy: req.auth!.userId, resolvedAt: now }).where(eq(exceptions.id, conflict.id));
      const [old] = await db.select({ period: events.reportPeriod, taxable: events.taxableValue, jobId: events.jobId, sub: events.subOrderId }).from(events).where(eq(events.id, replaced)).limit(1);
      // The replaced row keeps a closed record of the choice; reopening it and choosing that row again reverses it.
      await db.insert(exceptions).values({ companyId: s.companyId, marketplace: s.info.id, jobId: old.jobId, eventId: replaced, period: old.period, kind: "conflicting_rows", severity: "warning", status: "resolved", note: `Replaced by event ${event.id}: ${note}`, resolvedBy: req.auth!.userId, resolvedAt: now, message: `Sub-order ${old.sub} has other figures in event ${event.id} (taxable ${event.taxableValue}), which a reviewer chose to count instead of this row (taxable ${old.taxable}).`, details: { duplicateOf: event.id } });
      await db.insert(reviews).values({ ...actor, action: "use_instead", note, data: { replaced } });
      await relinkReturns(s.companyId, s.info.id);
    }
  } else if (action === "confirm") {
    const blocking = open.filter(x => BLOCKING.includes(x.severity));
    if (blocking.some(x => STATUS_KINDS.tax_mismatch.includes(x.kind)) && !note) {
      res.status(400).json({ ok: false, message: "Add a note saying why the tax difference is acceptable." });
      return;
    }
    await db.insert(reviews).values({ ...actor, action: "confirm", note, data: { closed: open.map(x => x.id) } });
    if (open.length > 0) await db.update(exceptions).set({ status: "resolved", note: note ?? "Confirmed by reviewer.", resolvedBy: req.auth!.userId, resolvedAt: now }).where(inArray(exceptions.id, open.map(x => x.id)));
  } else if (action === "classify") {
    const type = text(body.eventType) as EventType;
    if (!EVENT_TYPES.includes(type)) {
      res.status(400).json({ ok: false, message: "Choose sale, return, cancellation, credit note or adjustment." });
      return;
    }
    if (!note) {
      res.status(400).json({ ok: false, message: "Add a note saying why the classification changes." });
      return;
    }
    await db.insert(reviews).values({ ...actor, action: "classify", note, data: { eventType: type, from: event.eventType } });
    const unclear = open.filter(x => x.kind === "unclear_classification");
    if (unclear.length > 0) await db.update(exceptions).set({ status: "resolved", note, resolvedBy: req.auth!.userId, resolvedAt: now }).where(inArray(exceptions.id, unclear.map(x => x.id)));
  } else if (action === "accept_difference") {
    if (!note) {
      res.status(400).json({ ok: false, message: "Add a note saying why the difference is accepted." });
      return;
    }
    const differences = open.filter(x => STATUS_KINDS.tax_mismatch.includes(x.kind));
    if (differences.length === 0) {
      res.status(409).json({ ok: false, message: "There is no open difference on this transaction." });
      return;
    }
    await db.insert(reviews).values({ ...actor, action: "accept_difference", note, data: { accepted: differences.map(x => x.id) } });
    await db.update(exceptions).set({ status: "accepted", note, resolvedBy: req.auth!.userId, resolvedAt: now }).where(inArray(exceptions.id, differences.map(x => x.id)));
  } else if (action === "note") {
    if (!note) {
      res.status(400).json({ ok: false, message: "Write the note first." });
      return;
    }
    await db.insert(reviews).values({ ...actor, action: "note", note, data: {} });
  } else if (action === "reopen") {
    const closed = await db.select({ id: exceptions.id }).from(exceptions).where(and(eq(exceptions.eventId, event.id), inArray(exceptions.status, ["resolved", "accepted"]), isNotNull(exceptions.resolvedBy)));
    await db.insert(reviews).values({ ...actor, action: "reopen", note, data: { reopened: closed.map(x => x.id) } });
    if (closed.length > 0) await db.update(exceptions).set({ status: "open", note: null, resolvedBy: null, resolvedAt: null }).where(inArray(exceptions.id, closed.map(x => x.id)));
  } else {
    res.status(400).json({ ok: false, message: "Unknown review action." });
    return;
  }
  await refreshStatuses(s.companyId, s.info.id);
  await auditAction(req, "ecommerce.review", "marketplace_event", event.id, { marketplace: s.info.id, action, period: event.reportPeriod });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// Exceptions

router.get("/ecommerce/:marketplace/exceptions", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const period = periodParam(req, res, await latestPeriod(s.companyId, s.info.id));
  if (period === undefined) return;
  if (!period) {
    res.json({ ok: true, total: 0, rows: [], kinds: [] });
    return;
  }
  const where: SQL[] = [sql`x.company_id = ${s.companyId}`, sql`x.marketplace = ${s.info.id}`, sql`x.period = ${period}`];
  const status = text(req.query.status) || "open";
  if (status !== "all") where.push(sql`x.status = ${status}`);
  const severity = text(req.query.severity);
  if (severity === "blocking") where.push(sql`x.severity IN ('error', 'warning')`);
  else if (severity) where.push(sql`x.severity = ${severity}`);
  const kind = text(req.query.kind);
  if (kind) where.push(sql`x.kind = ${kind}`);
  const search = text(req.query.search).slice(0, 80);
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    where.push(sql`(x.message ILIKE ${like} OR e.sub_order_id ILIKE ${like})`);
  }
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = Math.min(200, Math.max(10, Math.floor(Number(req.query.pageSize) || 50)));
  const clause = sql.join(where, sql` AND `);
  const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM marketplace_exceptions x LEFT JOIN marketplace_events e ON e.id = x.event_id WHERE ${clause}`)).rows as Array<{ n: number }>;
  const rows = await db.execute(sql`
    SELECT x.id, x.event_id AS "eventId", x.kind, x.severity, x.status, x.message, x.details, x.note, x.resolved_at AS "resolvedAt", x.created_at AS "createdAt",
      e.sub_order_id AS "subOrderId", e.taxable_value AS taxable, e.event_type AS "eventType"
    FROM marketplace_exceptions x LEFT JOIN marketplace_events e ON e.id = x.event_id
    WHERE ${clause}
    ORDER BY CASE x.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, x.id
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
  const kinds = await db.execute(sql`SELECT kind, severity, count(*) FILTER (WHERE status = 'open')::int AS open, count(*)::int AS total FROM marketplace_exceptions WHERE company_id = ${s.companyId} AND marketplace = ${s.info.id} AND period = ${period} GROUP BY kind, severity ORDER BY open DESC, kind`);
  res.json({ ok: true, period, total: n, page, pageSize, rows: rows.rows, kinds: kinds.rows });
});

/**
 * One decision for every open item of one kind in a month (say, 200 returns whose sales are in a month not imported),
 * with one note. Each item gets its own decision record. A choice between two rows' figures is never made in bulk.
 */
router.post("/ecommerce/:marketplace/exceptions/bulk", canReview, async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const period = text(body.period);
  const kind = text(body.kind);
  const action = text(body.action);
  const note = text(body.note).slice(0, 2000);
  if (!PERIOD.test(period) || !kind) {
    res.status(400).json({ ok: false, message: "Choose the month and the kind of item." });
    return;
  }
  if (action !== "accept" && action !== "resolve") {
    res.status(400).json({ ok: false, message: "Unknown action." });
    return;
  }
  if (!note) {
    res.status(400).json({ ok: false, message: "Add a note that applies to every one of these items." });
    return;
  }
  if (kind === "conflicting_rows") {
    res.status(400).json({ ok: false, message: "Rows with different figures need a choice one at a time." });
    return;
  }
  const items = await db.select({ id: exceptions.id, eventId: exceptions.eventId }).from(exceptions)
    .where(and(eq(exceptions.companyId, s.companyId), eq(exceptions.marketplace, s.info.id), eq(exceptions.period, period), eq(exceptions.kind, kind), eq(exceptions.status, "open"), inArray(exceptions.severity, BLOCKING)));
  if (items.length === 0) {
    res.status(409).json({ ok: false, message: "There are no open items of that kind in this month." });
    return;
  }
  const now = new Date();
  for (const batch of chunk(items, 500)) {
    await db.update(exceptions).set({ status: action === "accept" ? "accepted" : "resolved", note, resolvedBy: req.auth!.userId, resolvedAt: now }).where(inArray(exceptions.id, batch.map(i => i.id)));
    await db.insert(reviews).values(batch.map(i => ({ companyId: s.companyId, marketplace: s.info.id, eventId: i.eventId, exceptionId: i.id, action: `exception_${action}`, note, data: { kind, bulk: true }, actorUserId: req.auth!.userId, actorEmail: req.auth!.email })));
  }
  await refreshStatuses(s.companyId, s.info.id);
  await auditAction(req, "ecommerce.exception_updated", "marketplace_exception", null, { marketplace: s.info.id, action, kind, period, count: items.length, bulk: true });
  res.json({ ok: true, count: items.length });
});

router.post("/ecommerce/:marketplace/exceptions/:id", canReview, async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const id = Number(req.params.id);
  const [item] = Number.isInteger(id) ? await db.select().from(exceptions).where(and(eq(exceptions.id, id), eq(exceptions.companyId, s.companyId), eq(exceptions.marketplace, s.info.id))).limit(1) : [];
  if (!item) {
    res.status(404).json({ ok: false, message: "That item was not found." });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = text(body.action);
  const note = text(body.note).slice(0, 2000) || null;
  if ((action === "resolve" || action === "accept") && item.status !== "open") {
    res.status(409).json({ ok: false, message: "This item is already closed. Reopen it first." });
    return;
  }
  if (action === "accept" && !note) {
    res.status(400).json({ ok: false, message: "Add a note saying why this is accepted." });
    return;
  }
  if (action === "resolve" || action === "accept") {
    await db.update(exceptions).set({ status: action === "resolve" ? "resolved" : "accepted", note: note ?? "Resolved by reviewer.", resolvedBy: req.auth!.userId, resolvedAt: new Date() }).where(eq(exceptions.id, item.id));
  } else if (action === "reopen") {
    if (item.status === "open") {
      res.status(409).json({ ok: false, message: "This item is already open." });
      return;
    }
    await db.update(exceptions).set({ status: "open", note: null, resolvedBy: null, resolvedAt: null }).where(eq(exceptions.id, item.id));
  } else {
    res.status(400).json({ ok: false, message: "Unknown action." });
    return;
  }
  await db.insert(reviews).values({ companyId: s.companyId, marketplace: s.info.id, eventId: item.eventId, exceptionId: item.id, action: `exception_${action}`, note, data: { kind: item.kind }, actorUserId: req.auth!.userId, actorEmail: req.auth!.email });
  await refreshStatuses(s.companyId, s.info.id);
  await auditAction(req, "ecommerce.exception_updated", "marketplace_exception", item.id, { marketplace: s.info.id, action, kind: item.kind, period: item.period });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// Summaries, report status and approval

async function caSummaryFor(companyId: number, marketplace: string, period: string) {
  const rows = await db.select({ details: files.details, fileName: files.fileName, createdAt: files.createdAt }).from(files)
    .where(and(eq(files.companyId, companyId), eq(files.marketplace, marketplace), eq(files.reportType, "ca_hsn_summary"))).orderBy(desc(files.id));
  const match = rows.find(r => (r.details as { period?: string | null }).period === period);
  if (!match) return null;
  const ca = (match.details as { caSummary?: Array<{ hsn: string; count: number | null; taxable: number; igst: number; cgst: number; sgst: number }> }).caSummary ?? [];
  return { fileName: match.fileName, rows: ca };
}

router.get("/ecommerce/:marketplace/summary", requirePermission("reports.read"), async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const period = periodParam(req, res, await latestPeriod(s.companyId, s.info.id));
  if (period === undefined) return;
  if (!period) {
    res.json({ ok: true, period: null });
    return;
  }
  const rounding = roundingParam(req);
  const { summary } = await periodEvents(s.companyId, s.info.id, period);
  const hsn = hsnSummary(summary, rounding);
  const ca = await caSummaryFor(s.companyId, s.info.id, period);
  res.json({
    ok: true,
    period,
    rounding,
    overview: overview(summary, period),
    hsn,
    states: stateSummary(summary, rounding),
    gstr1: gstr1Working(summary, period, rounding),
    ca: ca ? { fileName: ca.fileName, rows: compareWithCa(ca.rows, hsn) } : null,
  });
});

async function reportHistory(companyId: number, marketplace: string, reportId: number | null) {
  if (reportId == null) return [];
  const rows = await db.select().from(reviews).where(and(eq(reviews.companyId, companyId), eq(reviews.marketplace, marketplace), eq(reviews.reportId, reportId))).orderBy(desc(reviews.id));
  return rows.map(r => ({ id: r.id, action: r.action, note: r.note, actor: r.actorEmail, at: r.createdAt }));
}

router.get("/ecommerce/:marketplace/report", requirePermission("reports.read"), async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const period = periodParam(req, res, await latestPeriod(s.companyId, s.info.id));
  if (period === undefined) return;
  if (!period) {
    res.json({ ok: true, period: null, state: null, history: [] });
    return;
  }
  const state = await reportState(s.companyId, s.info.id, period);
  let approver: string | null = null;
  if (state.approvedBy) {
    const [u] = await db.select({ email: usersTable.email, name: usersTable.name }).from(usersTable).where(eq(usersTable.id, state.approvedBy)).limit(1);
    approver = u ? u.name || u.email : null;
  }
  res.json({ ok: true, period, state: { ...state, approver }, history: await reportHistory(s.companyId, s.info.id, state.id) });
});

router.post("/ecommerce/:marketplace/report/approve", requirePermission("reconciliation.approve"), async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const period = periodParam(req, res, null);
  if (period === undefined) return;
  if (!period) {
    res.status(400).json({ ok: false, message: "Choose the period to approve." });
    return;
  }
  const state = await reportState(s.companyId, s.info.id, period);
  if (state.status === "draft") {
    res.status(409).json({ ok: false, message: "There is nothing imported for this period yet." });
    return;
  }
  if (state.status === "approved") {
    res.status(409).json({ ok: false, message: "This period is already approved." });
    return;
  }
  if (state.openBlocking > 0) {
    res.status(409).json({ ok: false, message: `${state.openBlocking} item(s) still need review. Resolve or accept them before approving.` });
    return;
  }
  const note = text((req.body as Record<string, unknown>)?.note).slice(0, 2000) || null;
  const reportId = await ensureReport(s.companyId, s.info.id, period);
  const version = await dataVersion(s.companyId, s.info.id, period);
  await db.update(reports).set({ status: "approved", dataVersion: version, approvedBy: req.auth!.userId, approvedAt: new Date(), updatedAt: new Date() }).where(eq(reports.id, reportId));
  await db.insert(reviews).values({ companyId: s.companyId, marketplace: s.info.id, reportId, action: "approve", note, data: { dataVersion: version }, actorUserId: req.auth!.userId, actorEmail: req.auth!.email });
  await auditAction(req, "ecommerce.report_approved", "marketplace_report", reportId, { marketplace: s.info.id, period });
  res.json({ ok: true });
});

router.post("/ecommerce/:marketplace/report/reopen", requirePermission("reconciliation.approve"), async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const period = periodParam(req, res, null);
  if (period === undefined) return;
  if (!period) {
    res.status(400).json({ ok: false, message: "Choose the period to reopen." });
    return;
  }
  const note = text((req.body as Record<string, unknown>)?.note).slice(0, 2000);
  if (!note) {
    res.status(400).json({ ok: false, message: "Add a note saying why the approval is withdrawn." });
    return;
  }
  const [row] = await db.select().from(reports).where(and(eq(reports.companyId, s.companyId), eq(reports.marketplace, s.info.id), eq(reports.period, period))).limit(1);
  if (!row || row.status !== "approved") {
    res.status(409).json({ ok: false, message: "This period is not approved." });
    return;
  }
  await db.update(reports).set({ status: "draft", dataVersion: null, approvedBy: null, approvedAt: null, updatedAt: new Date() }).where(eq(reports.id, row.id));
  await db.insert(reviews).values({ companyId: s.companyId, marketplace: s.info.id, reportId: row.id, action: "reopen_report", note, data: {}, actorUserId: req.auth!.userId, actorEmail: req.auth!.email });
  await auditAction(req, "ecommerce.report_reopened", "marketplace_report", row.id, { marketplace: s.info.id, period });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// Exports

function csvCell(value: unknown): string {
  if (value == null) return "";
  let out = value instanceof Date ? value.toISOString() : String(value);
  // A spreadsheet must never run a formula from a source file.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(out) && !/^-?\d+(\.\d+)?$/.test(out)) out = `'${out}`;
  return /[",\n\r]/.test(out) ? `"${out.replace(/"/g, '""')}"` : out;
}

function csv(header: string[], rows: unknown[][]): string {
  return `﻿${[header, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

async function reportData(s: Scope, period: string, rounding: RoundingMode): Promise<ReportData> {
  const all = await db.select().from(events).where(and(eq(events.companyId, s.companyId), eq(events.marketplace, s.info.id), eq(events.reportPeriod, period))).orderBy(events.id);
  const overrides = await classifications(all.map(e => e.id));
  const counted = all.filter(e => e.duplicateOf == null);
  const { summary } = await periodEvents(s.companyId, s.info.id, period);
  const fileRows = await db.select().from(files).where(and(eq(files.companyId, s.companyId), eq(files.marketplace, s.info.id), inArray(files.jobId, db.selectDistinct({ j: events.jobId }).from(events).where(and(eq(events.companyId, s.companyId), eq(events.marketplace, s.info.id), eq(events.reportPeriod, period)))))).orderBy(files.id);
  const fileById = new Map(fileRows.map(f => [f.id, f]));
  const exceptionRows = await db.select().from(exceptions).where(and(eq(exceptions.companyId, s.companyId), eq(exceptions.marketplace, s.info.id), eq(exceptions.period, period))).orderBy(exceptions.id);
  const eventById = new Map(all.map(e => [e.id, e]));
  const reviewRows = await db.select().from(reviews).where(and(eq(reviews.companyId, s.companyId), eq(reviews.marketplace, s.info.id))).orderBy(reviews.id);
  const state = await reportState(s.companyId, s.info.id, period);
  const periodReviews = reviewRows.filter(r => (r.eventId != null && eventById.has(r.eventId)) || (r.reportId != null && r.reportId === state.id) || (r.exceptionId != null && exceptionRows.some(x => x.id === r.exceptionId)));
  const [company] = await db.select({ name: companiesTable.name, gstin: companiesTable.gstin }).from(companiesTable).where(eq(companiesTable.id, s.companyId)).limit(1);
  let approver: string | null = null;
  if (state.approvedBy) {
    const [u] = await db.select({ email: usersTable.email, name: usersTable.name }).from(usersTable).where(eq(usersTable.id, state.approvedBy)).limit(1);
    approver = u ? u.name || u.email : null;
  }
  const gstins = [...new Set(counted.map(e => e.sellerGstin).filter((g): g is string => Boolean(g)))];
  const exportEvents: ExportEvent[] = all.map(e => {
    const f = fileById.get(e.sourceFileId);
    return {
      id: e.id,
      eventType: overrides.get(e.id) ?? e.eventType,
      orderId: e.orderId,
      subOrderId: e.subOrderId,
      orderDate: e.orderDate,
      returnDate: e.returnDate,
      documentNumber: e.documentNumber,
      reportPeriod: e.reportPeriod,
      hsn: e.hsn,
      quantity: Number(e.quantity ?? 0),
      taxable: textToPaise(e.taxableValue),
      rateMilli: e.gstRate == null ? null : parseRate(e.gstRate),
      igst: textToPaise(e.igst),
      cgst: textToPaise(e.cgst),
      sgst: textToPaise(e.sgst),
      cess: textToPaise(e.cess),
      invoiceValue: textToPaise(e.invoiceValue),
      sourceTax: e.sourceTax == null ? null : textToPaise(e.sourceTax),
      computedTax: e.computedTax == null ? null : textToPaise(e.computedTax),
      placeOfSupply: e.placeOfSupply,
      supplyType: e.supplyType,
      ecoGstin: e.ecoGstin,
      status: e.reconStatus,
      duplicateOf: e.duplicateOf,
      relatedEventId: e.relatedEventId,
      fileName: f?.fileName ?? "",
      sheetName: f?.sheetName ?? null,
      sourceRow: e.sourceRow,
      raw: e.raw,
      notes: [...e.notes, ...(overrides.has(e.id) ? [`Classified by reviewer as ${overrides.get(e.id)} (was ${e.eventType}).`] : [])],
    };
  });
  return {
    companyName: company?.name ?? "",
    marketplaceName: s.info.name,
    sellerGstin: gstins.length === 1 ? gstins[0] : gstins.length > 1 ? gstins.join(", ") : company?.gstin ?? null,
    period,
    financialYear: financialYearOf(period),
    status: state.status === "needs_review" ? "Needs review" : state.status === "reconciled" ? "Reconciled" : state.status === "approved" ? "Approved" : "Draft",
    approvedBy: approver,
    approvedAt: state.approvedAt ? new Date(state.approvedAt).toISOString() : null,
    generatedAt: new Date(),
    rounding,
    overview: overview(summary, period),
    hsn: hsnSummary(summary, rounding),
    states: stateSummary(summary, rounding),
    gstr1: gstr1Working(summary, period, rounding),
    exceptions: exceptionRows.map(x => {
      const e = x.eventId ? eventById.get(x.eventId) : undefined;
      const f = e ? fileById.get(e.sourceFileId) : undefined;
      return { id: x.id, eventId: x.eventId, kind: x.kind, severity: x.severity, status: x.status, message: x.message, note: x.note, sourceRef: f && e ? `${f.fileName}${f.sheetName ? ` / ${f.sheetName}` : ""} row ${e.sourceRow}` : "" };
    }),
    events: exportEvents,
    reviews: periodReviews.map(r => ({ at: r.createdAt.toISOString(), actor: r.actorEmail, action: r.action, target: r.reportId ? `report ${period}` : r.exceptionId ? `item ${r.exceptionId}` : `event ${r.eventId}`, note: r.note })),
    files: fileRows.map(f => ({ fileName: f.fileName, containerName: f.containerName, sheetName: f.sheetName, sha256: f.sha256, reportType: f.reportType, status: f.status, rowCount: f.rowCount, periods: f.periods, columnMap: f.columnMap, unknownColumns: f.unknownColumns, importedAt: f.createdAt.toISOString() })),
    openBlocking: state.openBlocking,
  };
}

router.get("/ecommerce/:marketplace/export", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const s = await scope(req, res);
  if (!s) return;
  const period = periodParam(req, res, null);
  if (period === undefined) return;
  if (!period) {
    res.status(400).json({ ok: false, message: "Choose the period to download." });
    return;
  }
  const format = text(req.query.format) || "xlsx";
  const rounding = roundingParam(req);
  const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM marketplace_events WHERE company_id = ${s.companyId} AND marketplace = ${s.info.id} AND report_period = ${period}`)).rows as Array<{ n: number }>;
  if (n === 0) {
    res.status(404).json({ ok: false, message: "There is nothing imported for this period yet." });
    return;
  }
  const base = `${s.info.name}-${period}`;
  if (format === "xlsx" || format === "pdf") {
    const data = await reportData(s, period, rounding);
    const buffer = format === "xlsx" ? await buildWorkbook(data) : await buildPdf(data);
    res.setHeader("Content-Type", format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${base}-reconciliation.${format}"`);
    await auditAction(req, "ecommerce.export", "marketplace_report", null, { marketplace: s.info.id, period, format, status: data.status });
    res.send(buffer);
    return;
  }
  if (format === "transactions_csv") {
    const all = await db.select().from(events).where(and(eq(events.companyId, s.companyId), eq(events.marketplace, s.info.id), eq(events.reportPeriod, period))).orderBy(events.id);
    const overrides = await classifications(all.map(e => e.id));
    const body = csv(
      ["Event ID", "Type", "Order", "Sub-order", "Order date", "Return date", "Document no.", "Period", "HSN", "Qty", "Rate %", "Taxable value", "IGST", "CGST", "SGST/UTGST", "Cess", "Invoice value", "Tax in report", "Tax recalculated", "Place of supply", "Supply", "Operator GSTIN", "Status", "Duplicate of", "Matched to"],
      all.map(e => [e.id, overrides.get(e.id) ?? e.eventType, e.orderId, e.subOrderId, e.orderDate, e.returnDate, e.documentNumber, e.reportPeriod, e.hsn, e.quantity, e.gstRate, e.taxableValue, e.igst, e.cgst, e.sgst, e.cess, e.invoiceValue, e.sourceTax, e.computedTax, e.placeOfSupply, e.supplyType, e.ecoGstin, e.reconStatus, e.duplicateOf, e.relatedEventId]),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${base}-transactions.csv"`);
    await auditAction(req, "ecommerce.export", "marketplace_report", null, { marketplace: s.info.id, period, format });
    res.send(body);
    return;
  }
  if (format === "exceptions_csv") {
    const rows = await db.select({ x: exceptions, sub: events.subOrderId }).from(exceptions).leftJoin(events, eq(events.id, exceptions.eventId))
      .where(and(eq(exceptions.companyId, s.companyId), eq(exceptions.marketplace, s.info.id), eq(exceptions.period, period))).orderBy(exceptions.id);
    const body = csv(["ID", "Severity", "Kind", "Status", "Event", "Sub-order", "What needs a look", "Reviewer note"], rows.map(r => [r.x.id, r.x.severity, r.x.kind, r.x.status, r.x.eventId, r.sub, r.x.message, r.x.note]));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${base}-exceptions.csv"`);
    await auditAction(req, "ecommerce.export", "marketplace_report", null, { marketplace: s.info.id, period, format });
    res.send(body);
    return;
  }
  res.status(400).json({ ok: false, message: "Choose xlsx, pdf, transactions_csv or exceptions_csv." });
});

export default router;
