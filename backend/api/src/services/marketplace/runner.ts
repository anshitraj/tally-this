/**
 * Runs a marketplace import in the background and records each stage, so the page can show what is really happening.
 *
 * The request that uploads the files only stores them and creates the job; this runner reads, normalizes, checks
 * duplicates, matches returns and prepares the period, writing `stage` and `progress` as it goes. Imports for the same
 * company and marketplace run one at a time, so duplicate detection never races itself. A failure removes whatever the
 * job had written and says what went wrong in plain words; file contents never reach the logs.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { auditLogsTable, db, usersTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import { deleteStoredObject, downloadStoredFile, storeUploadedFile } from "../storage";
import { paiseToText } from "./money";
import { attachDocuments, eventIdentity, keyEvents, prepareTables, reportLabel, type KeyedEvent } from "./pipeline";
import { adapterFor } from "./registry";
import { dependentJobs, ensureReport, events, existingIdentities, existingKeys, files, insertEvents, insertExceptions, jobs, knownTableKeys, refreshStatuses, relinkReturns, removeJobData } from "./store";
import { readReports, type UploadedReport } from "./tables";
import type { CanonicalField } from "./types";
import { rateText } from "./gstEngine";

export const STAGES = [
  { id: "queued", label: "Waiting to start", progress: 2 },
  { id: "reading", label: "Reading the reports", progress: 10 },
  { id: "normalizing", label: "Normalizing transactions", progress: 30 },
  { id: "duplicates", label: "Checking duplicates", progress: 50 },
  { id: "returns", label: "Matching sales and returns", progress: 65 },
  { id: "gst", label: "Calculating GST summaries", progress: 80 },
  { id: "report", label: "Preparing your report", progress: 92 },
  { id: "completed", label: "Done", progress: 100 },
] as const;

export interface StoredUpload { name: string; size: number; provider: string | null; bucket: string | null; key: string | null }

/** Uploads kept in memory when no file storage is configured, so a mapping or retry in the same server life still works. */
const memoryUploads = new Map<string, UploadedReport[]>();
const queues = new Map<string, Promise<void>>();
/** Jobs queued or running in this server process. */
const activeJobs = new Set<string>();

async function setStage(jobId: string, stage: (typeof STAGES)[number]["id"], extra: Partial<typeof jobs.$inferInsert> = {}) {
  const info = STAGES.find(s => s.id === stage)!;
  await db.update(jobs).set({ stage, progress: info.progress, updatedAt: new Date(), ...extra }).where(eq(jobs.id, jobId));
}

export async function createImportJob(input: { companyId: number; marketplace: string; sellerGstin: string | null; financialYear: string | null; period: string | null; userId: number | null; uploads: UploadedReport[] }) {
  const id = randomUUID();
  const stored: StoredUpload[] = [];
  for (const upload of input.uploads) {
    try {
      const object = await storeUploadedFile({ companyId: input.companyId, sourceType: `marketplace-${input.marketplace}`, file: { buffer: upload.buffer, originalname: upload.name, size: upload.buffer.length } });
      stored.push({ name: upload.name, size: upload.buffer.length, provider: object.provider, bucket: object.bucket, key: object.key });
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : "unknown", jobId: id }, "marketplace upload could not be stored; kept in memory for this import");
      stored.push({ name: upload.name, size: upload.buffer.length, provider: null, bucket: null, key: null });
    }
  }
  memoryUploads.set(id, input.uploads);
  // Imports left waiting for a column choice must not hold memory for ever; stored copies remain.
  while (memoryUploads.size > 20) memoryUploads.delete(memoryUploads.keys().next().value as string);
  await db.insert(jobs).values({
    id,
    companyId: input.companyId,
    marketplace: input.marketplace,
    sellerGstin: input.sellerGstin,
    financialYear: input.financialYear,
    period: input.period,
    status: "queued",
    stage: "queued",
    progress: 2,
    createdBy: input.userId,
    stats: { uploads: stored },
  });
  return id;
}

async function loadUploads(job: typeof jobs.$inferSelect): Promise<UploadedReport[] | null> {
  const cached = memoryUploads.get(job.id);
  if (cached) return cached;
  const stored = ((job.stats as { uploads?: StoredUpload[] }).uploads ?? []);
  const out: UploadedReport[] = [];
  for (const upload of stored) {
    if (!upload.key || !upload.provider) return null;
    const file = await downloadStoredFile({ provider: upload.provider, bucket: upload.bucket, key: upload.key });
    if (!file) return null;
    out.push({ name: upload.name, buffer: file.buffer });
  }
  return out;
}

/** Runs `work` after everything already queued for this company and marketplace, so writes never interleave. */
export function inLane<T>(companyId: number, marketplace: string, work: () => Promise<T>): Promise<T> {
  const lane = `${companyId}:${marketplace}`;
  const previous = queues.get(lane) ?? Promise.resolve();
  const result = previous.then(work);
  const settled = result.then(() => undefined, () => undefined);
  queues.set(lane, settled);
  void settled.then(() => {
    if (queues.get(lane) === settled) queues.delete(lane);
  });
  return result;
}

/** Queues a run and returns at once; the page follows it through the job's stage. */
export async function runImport(jobId: string, options: { mappings?: Record<string, Partial<Record<CanonicalField, string>>> } = {}) {
  const [job] = await db.select({ companyId: jobs.companyId, marketplace: jobs.marketplace }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return;
  activeJobs.add(jobId);
  void inLane(job.companyId, job.marketplace, () => processJob(jobId, options)).catch(() => undefined).finally(() => activeJobs.delete(jobId));
}

/** Resolves once nothing is queued for this company and marketplace (used by tests). */
export async function laneIdle(companyId: number, marketplace: string) {
  const lane = `${companyId}:${marketplace}`;
  while (queues.has(lane)) await queues.get(lane);
}

/**
 * Removes an import: its rows, exceptions and stored files. Imports that only skipped rows because this one had them are
 * read again, so nothing that was in them stops counting. Returns the ids of the imports that were queued again.
 */
export async function deleteImport(job: typeof jobs.$inferSelect): Promise<string[]> {
  return inLane(job.companyId, job.marketplace, async () => {
    const dependents = await dependentJobs(job.companyId, job.marketplace, job.id);
    await removeJobData(job.id);
    for (const upload of ((job.stats as { uploads?: StoredUpload[] }).uploads ?? [])) {
      if (!upload.key || !upload.provider) continue;
      try {
        await deleteStoredObject({ provider: upload.provider, bucket: upload.bucket, key: upload.key });
      } catch {
        logger.warn({ jobId: job.id }, "a stored marketplace upload could not be removed");
      }
    }
    memoryUploads.delete(job.id);
    await db.delete(jobs).where(eq(jobs.id, job.id));
    await relinkReturns(job.companyId, job.marketplace);
    await refreshStatuses(job.companyId, job.marketplace);
    for (const id of dependents) {
      await db.update(jobs).set({ status: "queued", stage: "queued", progress: 2, message: "Read again because an import it overlapped was removed.", updatedAt: new Date() }).where(eq(jobs.id, id));
    }
    return dependents;
  }).then(async dependents => {
    for (const id of dependents) await runImport(id);
    return dependents;
  });
}

/** Forgets uploads kept in memory (tests and shutdown). */
export function clearMemoryUploads() {
  memoryUploads.clear();
}

async function processJob(jobId: string, options: { mappings?: Record<string, Partial<Record<CanonicalField, string>>> }) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return;
  const adapter = adapterFor(job.marketplace);
  if (!adapter) {
    await db.update(jobs).set({ status: "failed", message: "This marketplace cannot import files yet.", updatedAt: new Date() }).where(eq(jobs.id, jobId));
    return;
  }
  try {
    await removeJobData(jobId);
    await setStage(jobId, "reading", { status: "running", message: null });
    const uploads = await loadUploads(job);
    if (!uploads) throw new UserFacingError("The uploaded files are no longer available. Upload them again.");
    const { tables, problems } = readReports(uploads);

    await setStage(jobId, "normalizing");
    const ctx = { sellerGstin: job.sellerGstin, period: job.period };
    const mappings = { ...((job.stats as { mappings?: Record<string, Partial<Record<CanonicalField, string>>> }).mappings ?? {}), ...(options.mappings ?? {}) };
    const prepared = prepareTables(adapter, tables, ctx, { mappings, knownTableKeys: await knownTableKeys(job.companyId, job.marketplace) });

    // Record every file and sheet with what was found in it.
    const fileIds = new Map<string, number>();
    for (const item of prepared) {
      const [row] = await db.insert(files).values({
        jobId,
        companyId: job.companyId,
        marketplace: job.marketplace,
        fileName: item.table.fileName,
        containerName: item.table.containerName,
        sheetName: item.table.sheetName,
        sha256: item.table.sha256,
        sizeBytes: item.table.sizeBytes,
        reportType: item.detection.reportType,
        status: item.status,
        headers: item.detection.headers,
        columnMap: item.detection.columnMap as Record<string, string>,
        unknownColumns: item.detection.unknownColumns,
        rowCount: item.result?.events.length ?? 0,
        periods: item.result?.periods ?? [],
        details: {
          key: item.key,
          label: reportLabel(item.detection.reportType),
          missing: item.detection.missing,
          documents: item.result?.documents?.length ?? 0,
          caSummary: item.result?.caSummary ?? null,
          period: job.period,
        },
        message: item.message,
      }).returning({ id: files.id });
      fileIds.set(item.key, row.id);
    }

    const waiting = prepared.filter(p => p.status === "needs_mapping");
    if (waiting.length > 0) {
      await db.update(jobs).set({
        status: "needs_mapping",
        stage: "normalizing",
        progress: 30,
        message: `${waiting.length} file(s) need their columns chosen before anything is imported.`,
        stats: { ...(job.stats as object), mappings, problems, needsMapping: waiting.map(p => ({ key: p.key, fileName: p.table.fileName, sheetName: p.table.sheetName, headers: p.detection.headers, missing: p.detection.missing, columnMap: p.detection.columnMap, aliases: Object.fromEntries(p.detection.missing.map(f => [f, adapter.fieldAliases[f] ?? []])) })) },
        updatedAt: new Date(),
      }).where(eq(jobs.id, jobId));
      return;
    }

    await setStage(jobId, "duplicates");
    const { events: keyed, issues: batchIssues } = keyEvents(job.marketplace, prepared);
    const attached = attachDocuments(keyed, prepared);
    const earlier = await existingKeys(job.companyId, job.marketplace, keyed.map(k => k.key));
    // The same sale or return already imported with other figures: the earlier row keeps counting, this one is held back.
    const isNew = (k: KeyedEvent) => k.duplicateOfIndex == null && !earlier.has(k.key);
    const clashes = await existingIdentities(job.companyId, job.marketplace, keyed.filter(isNew).map(k => k.event));
    const clashOf = (k: KeyedEvent) => {
      if (!isNew(k)) return undefined;
      const identity = eventIdentity(k.event);
      return identity ? clashes.get(identity) : undefined;
    };

    // Events first (without the in-upload duplicate links), then link duplicates to the ids they repeat.
    const rows = keyed.map(k => {
      const e = k.event;
      return {
        companyId: job.companyId,
        marketplace: job.marketplace,
        jobId,
        sourceFileId: fileIds.get(k.tableKey)!,
        sourceRow: e.sourceRow,
        idempotencyKey: k.key,
        duplicateOf: earlier.get(k.key) ?? clashOf(k)?.id ?? null,
        sellerGstin: e.sellerGstin,
        orderId: e.orderId,
        subOrderId: e.subOrderId,
        lineId: e.lineId,
        eventType: e.eventType,
        orderDate: e.orderDate,
        documentDate: e.documentDate,
        returnDate: e.returnDate,
        documentNumber: e.documentNumber,
        reportPeriod: e.reportPeriod,
        financialYear: e.financialYear,
        hsn: e.hsn,
        description: e.description,
        quantity: e.quantity,
        uqc: e.uqc,
        taxableValue: paiseToText(e.taxable),
        gstRate: e.rateMilli == null ? null : rateText(e.rateMilli),
        igst: paiseToText(e.igst),
        cgst: paiseToText(e.cgst),
        sgst: paiseToText(e.sgst),
        cess: paiseToText(e.cess),
        invoiceValue: paiseToText(e.invoiceValue),
        sourceTax: e.sourceTax == null ? null : paiseToText(e.sourceTax),
        computedTax: e.computedTax == null ? null : paiseToText(e.computedTax),
        shippingTaxable: e.shippingTaxable == null ? null : paiseToText(e.shippingTaxable),
        placeOfSupply: e.placeOfSupply,
        supplyType: e.supplyType,
        ecoGstin: e.ecoGstin,
        sourceStatus: e.sourceStatus,
        raw: e.raw,
        notes: e.notes,
      };
    });
    const ids = await insertEvents(rows);
    const inUpload: Array<[number, number]> = [];
    keyed.forEach((k, i) => {
      if (k.duplicateOfIndex != null && !earlier.has(k.key)) inUpload.push([ids[i], ids[k.duplicateOfIndex]]);
    });
    for (const [id, of] of inUpload) await db.update(events).set({ duplicateOf: of }).where(eq(events.id, id));

    // Exceptions: every row issue, every file-level note, every file that could not be read, and every duplicate.
    const exceptionRows: Array<typeof import("@workspace/db").marketplaceExceptionsTable.$inferInsert> = [];
    keyed.forEach((k, i) => {
      const base = { companyId: job.companyId, marketplace: job.marketplace, jobId, eventId: ids[i], period: k.event.reportPeriod };
      const exactRepeat = earlier.has(k.key) || (k.duplicateOfIndex != null && !k.conflict);
      if (exactRepeat) {
        const of = earlier.get(k.key) ?? ids[k.duplicateOfIndex!];
        exceptionRows.push({ ...base, kind: "duplicate", severity: "info", message: `Same ${k.event.eventType} as event ${of} (sub-order ${k.event.subOrderId}); kept for the record and not counted.`, details: { duplicateOf: of } });
        return;
      }
      const clash = clashOf(k);
      if (clash) {
        exceptionRows.push({
          ...base,
          kind: "conflicting_rows",
          severity: "warning",
          message: `Sub-order ${k.event.subOrderId} was already imported with different figures (${clash.fileName} row ${clash.sourceRow}: taxable ${clash.taxable}; this file: ${paiseToText(k.event.taxable)}). The earlier row is counted until you choose.`,
          details: { duplicateOf: clash.id, otherTaxable: clash.taxable, taxable: paiseToText(k.event.taxable) },
        });
      }
      // A held-back row's own issues are kept for the record but block nothing while it is not counted.
      const held = k.conflict || Boolean(clash);
      for (const issue of k.event.issues) {
        const blocking = issue.severity !== "info";
        exceptionRows.push({ ...base, kind: issue.kind, severity: held && blocking ? "info" : issue.severity, message: issue.message, details: { ...(issue.details ?? {}), ...(held && blocking ? { heldSeverity: issue.severity } : {}) } });
      }
    });
    for (const issue of batchIssues) {
      const k = keyed[issue.eventIndex];
      exceptionRows.push({ companyId: job.companyId, marketplace: job.marketplace, jobId, eventId: ids[issue.eventIndex], period: k.event.reportPeriod, kind: issue.kind, severity: issue.severity, message: issue.message, details: issue.details ?? {} });
    }
    for (const item of prepared) {
      for (const issue of item.result?.issues ?? []) {
        exceptionRows.push({ companyId: job.companyId, marketplace: job.marketplace, jobId, eventId: null, period: job.period, kind: issue.kind, severity: issue.severity, message: `${item.table.fileName}: ${issue.message}`, details: issue.details ?? {} });
      }
      if (item.status === "duplicate_file") exceptionRows.push({ companyId: job.companyId, marketplace: job.marketplace, jobId, eventId: null, period: job.period, kind: "duplicate_file", severity: "info", message: `${item.table.fileName}${item.table.sheetName ? ` (${item.table.sheetName})` : ""} was imported before and was not read again.`, details: {} });
      if (item.status === "unsupported") exceptionRows.push({ companyId: job.companyId, marketplace: job.marketplace, jobId, eventId: null, period: job.period, kind: "unsupported_file", severity: "warning", message: `${item.table.fileName}${item.table.sheetName ? ` (${item.table.sheetName})` : ""}: ${item.message}`, details: { headers: item.detection.headers.slice(0, 30) } });
    }
    for (const problem of problems) exceptionRows.push({ companyId: job.companyId, marketplace: job.marketplace, jobId, eventId: null, period: job.period, kind: "unreadable_file", severity: "warning", message: `${problem.fileName}: ${problem.message}`, details: {} });
    const periods = [...new Set(keyed.map(k => k.event.reportPeriod))].sort();
    if (job.period && periods.some(p => p !== job.period)) {
      exceptionRows.push({ companyId: job.companyId, marketplace: job.marketplace, jobId, eventId: null, period: job.period, kind: "mixed_periods", severity: "info", message: `These files hold ${periods.join(", ")}. Each transaction is kept in its own month; only ${job.period} is shown until you pick another.`, details: { periods } });
    }
    await insertExceptions(exceptionRows);

    // Invoice numbers uploaded later still reach events imported earlier.
    const documents = prepared.flatMap(p => p.result?.documents ?? []);
    for (const doc of documents) {
      await db.update(events).set({ documentNumber: doc.number, documentDate: doc.date })
        .where(and(eq(events.companyId, job.companyId), eq(events.marketplace, job.marketplace), eq(events.subOrderId, doc.subOrderId), doc.type === "invoice" ? eq(events.eventType, "sale") : inArray(events.eventType, ["return", "cancellation", "credit_note"])));
    }

    await setStage(jobId, "returns");
    const matched = await relinkReturns(job.companyId, job.marketplace);

    await setStage(jobId, "gst");
    await refreshStatuses(job.companyId, job.marketplace);

    await setStage(jobId, "report");
    for (const period of periods) await ensureReport(job.companyId, job.marketplace, period);

    const counted = keyed.filter(k => isNew(k) && !clashOf(k));
    const conflicts = keyed.filter(k => k.conflict || clashOf(k)).length;
    const stats = {
      ...(job.stats as object),
      mappings,
      problems,
      files: prepared.map(p => ({ fileName: p.table.fileName, sheetName: p.table.sheetName, reportType: p.detection.reportType, label: reportLabel(p.detection.reportType), status: p.status, rows: p.result?.events.length ?? 0, periods: p.result?.periods ?? [] })),
      transactions: keyed.length,
      counted: counted.length,
      duplicates: keyed.length - counted.length - conflicts,
      conflicts,
      sales: counted.filter(k => k.event.eventType === "sale").length,
      returns: counted.filter(k => k.event.eventType !== "sale").length,
      exceptions: exceptionRows.filter(e => e.severity !== "info").length,
      documentsAttached: attached + documents.length,
      returnsMatched: matched.matched,
      returnsUnmatched: matched.unmatched,
      periods,
    };
    await db.update(jobs).set({ status: "completed", stage: "completed", progress: 100, stats, completedAt: new Date(), updatedAt: new Date(), message: null }).where(eq(jobs.id, jobId));
    const [actor] = job.createdBy ? await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, job.createdBy)).limit(1) : [];
    await db.insert(auditLogsTable).values({ companyId: job.companyId, userId: job.createdBy, actorEmail: actor?.email ?? null, action: "ecommerce.import_completed", entityType: "marketplace_import", metadata: { marketplace: job.marketplace, jobId, transactions: keyed.length, counted: counted.length, duplicates: keyed.length - counted.length, periods } });
    memoryUploads.delete(jobId);
  } catch (error) {
    const message = error instanceof UserFacingError ? error.message : "The import could not be finished. Nothing from it was kept; try again, and contact support if it fails again.";
    logger.error({ jobId, err: error instanceof Error ? error.message : "unknown" }, "marketplace import failed");
    try {
      await removeJobData(jobId);
    } catch {
      // The job row still says what happened; leftover rows are removed on the next retry.
    }
    await db.update(jobs).set({ status: "failed", message, updatedAt: new Date() }).where(eq(jobs.id, jobId));
  }
}

export class UserFacingError extends Error {}

/**
 * A job this server is not running and that has said nothing for two minutes stopped with an earlier server process (a
 * restart or deploy); it is marked failed so it can be retried. One that has said nothing for fifteen minutes is stale
 * whoever runs it.
 */
export async function markStaleJob(job: typeof jobs.$inferSelect) {
  const quiet = Date.now() - new Date(job.updatedAt).getTime();
  if ((job.status === "running" || job.status === "queued") && ((!activeJobs.has(job.id) && quiet > 2 * 60 * 1000) || quiet > 15 * 60 * 1000)) {
    await db.update(jobs).set({ status: "failed", message: "The import stopped before it finished (the server restarted). Retry it.", updatedAt: new Date() }).where(eq(jobs.id, job.id));
    return { ...job, status: "failed", message: "The import stopped before it finished (the server restarted). Retry it." };
  }
  return job;
}

export function stageLabel(stage: string) {
  return STAGES.find(s => s.id === stage)?.label ?? stage;
}
