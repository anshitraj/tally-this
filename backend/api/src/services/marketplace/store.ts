/**
 * Marketplace data in the database: import jobs, source files, events, exceptions, reports and review decisions.
 * Every query is scoped by company and marketplace. Source rows are written once and never edited: a person's decision
 * is a new row in marketplace_reviews, and figures are worked out from events plus those decisions.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  marketplaceEventsTable as events,
  marketplaceExceptionsTable as exceptions,
  marketplaceImportJobsTable as jobs,
  marketplaceReportsTable as reports,
  marketplaceReviewsTable as reviews,
  marketplaceSourceFilesTable as files,
  type MarketplaceEvent,
} from "@workspace/db";
import { parseRate, splitTax, supplyType } from "./gstEngine";
import { textToPaise } from "./money";
import { eventIdentity } from "./pipeline";
import { matchReturns } from "./returns";
import type { SummaryEvent } from "./summaries";
import type { DraftEvent } from "./types";

export const BLOCKING = ["error", "warning"];

/** Exception kinds grouped into the review statuses the transactions table filters on. */
export const STATUS_KINDS = {
  missing_info: ["missing_hsn", "invalid_hsn", "unknown_state", "unknown_rate", "missing_gstin", "missing_period", "missing_taxable", "invalid_date", "other_gstin", "invalid_gstin", "unclear_classification"],
  tax_mismatch: ["tax_mismatch", "invoice_value_mismatch", "rate_check", "b2cl_candidate"],
  return_mismatch: ["unmatched_return", "return_exceeds_sale", "credit_note_without_return", "conflicting_rows"],
};

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function insertEvents(rows: Array<typeof events.$inferInsert>): Promise<number[]> {
  const ids: number[] = [];
  for (const batch of chunk(rows, 250)) {
    const inserted = await db.insert(events).values(batch).returning({ id: events.id });
    ids.push(...inserted.map(r => r.id));
  }
  return ids;
}

export async function insertExceptions(rows: Array<typeof exceptions.$inferInsert>) {
  for (const batch of chunk(rows, 250)) await db.insert(exceptions).values(batch);
}

/** Keys already counted for this company and marketplace, so a re-import never counts an event twice. */
export async function existingKeys(companyId: number, marketplace: string, keys: string[]): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const batch of chunk([...new Set(keys)], 500)) {
    const rows = await db.select({ id: events.id, key: events.idempotencyKey }).from(events)
      .where(and(eq(events.companyId, companyId), eq(events.marketplace, marketplace), isNull(events.duplicateOf), inArray(events.idempotencyKey, batch)));
    for (const row of rows) if (!found.has(row.key)) found.set(row.key, row.id);
  }
  return found;
}

/**
 * Counted events that are the same sale or return as the given new ones (same identity) but were imported earlier, by
 * identity. The new rows with other figures are held back against them instead of being counted a second time.
 */
export async function existingIdentities(companyId: number, marketplace: string, drafts: Array<Pick<DraftEvent, "subOrderId" | "returnDate" | "sellerGstin"> & { eventType: string }>): Promise<Map<string, { id: number; taxable: string; sourceRow: number; fileName: string }>> {
  const found = new Map<string, { id: number; taxable: string; sourceRow: number; fileName: string }>();
  const wanted = new Set(drafts.map(eventIdentity).filter((v): v is string => Boolean(v)));
  const subs = [...new Set(drafts.map(d => d.subOrderId).filter((v): v is string => Boolean(v)))];
  for (const batch of chunk(subs, 500)) {
    const rows = await db.select({ id: events.id, eventType: events.eventType, subOrderId: events.subOrderId, returnDate: events.returnDate, sellerGstin: events.sellerGstin, taxable: events.taxableValue, sourceRow: events.sourceRow, fileName: files.fileName })
      .from(events).leftJoin(files, eq(files.id, events.sourceFileId))
      .where(and(eq(events.companyId, companyId), eq(events.marketplace, marketplace), isNull(events.duplicateOf), inArray(events.subOrderId, batch)))
      .orderBy(events.id);
    for (const row of rows) {
      const identity = eventIdentity(row);
      if (identity && wanted.has(identity) && !found.has(identity)) found.set(identity, { id: row.id, taxable: row.taxable, sourceRow: row.sourceRow, fileName: row.fileName ?? "an earlier file" });
    }
  }
  return found;
}

/** Holds back a row's blocking issues (it is no longer counted) so they block nothing, remembering their severity. */
export async function holdIssues(eventId: number) {
  await db.execute(sql`UPDATE marketplace_exceptions SET details = details || jsonb_build_object('heldSeverity', severity), severity = 'info'
    WHERE event_id = ${eventId} AND status = 'open' AND severity IN ('error', 'warning') AND kind <> 'conflicting_rows'`);
}

/** Gives a row that counts again the issues it was held back with. */
export async function releaseIssues(eventId: number) {
  await db.execute(sql`UPDATE marketplace_exceptions SET severity = details->>'heldSeverity', details = details - 'heldSeverity'
    WHERE event_id = ${eventId} AND details ? 'heldSeverity'`);
}

/** Files already read for this company and marketplace, by content hash and sheet. */
export async function knownTableKeys(companyId: number, marketplace: string): Promise<Set<string>> {
  const rows = await db.select({ sha: files.sha256, sheet: files.sheetName }).from(files)
    .where(and(eq(files.companyId, companyId), eq(files.marketplace, marketplace), eq(files.status, "read")));
  return new Set(rows.map(r => `${r.sha}:${r.sheet ?? ""}`));
}

export async function removeJobData(jobId: string) {
  await db.delete(exceptions).where(eq(exceptions.jobId, jobId));
  await db.delete(events).where(eq(events.jobId, jobId));
  await db.delete(files).where(eq(files.jobId, jobId));
}

/**
 * Re-links every return to the sale it reverses, across all imported periods, and keeps the return exceptions in step:
 * a return that a later import matches has its "unmatched" exception closed automatically; one that no longer matches
 * gets one. Person-made decisions (accepted, resolved by a reviewer) are left alone.
 */
export async function relinkReturns(companyId: number, marketplace: string): Promise<{ matched: number; unmatched: number }> {
  const rows = await db.select({ id: events.id, type: events.eventType, sub: events.subOrderId, period: events.reportPeriod, qty: events.quantity, taxable: events.taxableValue, jobId: events.jobId, related: events.relatedEventId })
    .from(events).where(and(eq(events.companyId, companyId), eq(events.marketplace, marketplace), isNull(events.duplicateOf)));
  const sales = rows.filter(r => r.type === "sale").map(r => ({ id: r.id, subOrderId: r.sub, period: r.period, quantity: Number(r.qty ?? 0), taxable: textToPaise(r.taxable) }));
  const rets = rows.filter(r => r.type === "return" || r.type === "cancellation").map(r => ({ id: r.id, subOrderId: r.sub, period: r.period, quantity: Number(r.qty ?? 0), taxable: textToPaise(r.taxable) }));
  const results = matchReturns(rets, sales);
  const byId = new Map(rows.map(r => [r.id, r]));

  const autoKinds = ["unmatched_return", "return_exceeds_sale", "cross_period_return"];
  const existing = rets.length === 0 ? [] : await db.select({ id: exceptions.id, eventId: exceptions.eventId, kind: exceptions.kind, status: exceptions.status, resolvedBy: exceptions.resolvedBy })
    .from(exceptions).where(and(eq(exceptions.companyId, companyId), eq(exceptions.marketplace, marketplace), inArray(exceptions.kind, autoKinds)));
  const existingBy = new Map(existing.map(e => [`${e.eventId}|${e.kind}`, e]));
  const toInsert: Array<typeof exceptions.$inferInsert> = [];
  const closeIds: number[] = [];
  let matched = 0;
  let unmatched = 0;
  const links: Array<[number, number | null]> = [];

  for (const result of results) {
    const row = byId.get(result.returnId);
    if (!row) continue;
    const want = new Set<string>();
    const saleId = result.status === "unmatched" ? null : result.saleId;
    if (row.related !== saleId) links.push([row.id, saleId]);
    if (result.status === "unmatched") {
      unmatched += 1;
      want.add("unmatched_return");
      if (!existingBy.has(`${row.id}|unmatched_return`)) {
        toInsert.push({ companyId, marketplace, jobId: row.jobId, eventId: row.id, period: row.period, kind: "unmatched_return", severity: "warning", message: `No sale was found for sub-order ${row.sub}. The return is kept and still reduces ${row.period}; import the month of the original sale to match it.`, details: {} });
      }
    } else {
      matched += 1;
      if (result.status === "exceeds_sale") {
        want.add("return_exceeds_sale");
        if (!existingBy.has(`${row.id}|return_exceeds_sale`)) {
          toInsert.push({ companyId, marketplace, jobId: row.jobId, eventId: row.id, period: row.period, kind: "return_exceeds_sale", severity: "warning", message: `Returns against sub-order ${row.sub} add up to more than its sale.`, details: { returned: result.returnedTaxable, sold: result.saleTaxable, saleEventId: result.saleId } });
        }
      }
      if (result.crossPeriod) {
        want.add("cross_period_return");
        if (!existingBy.has(`${row.id}|cross_period_return`)) {
          toInsert.push({ companyId, marketplace, jobId: row.jobId, eventId: row.id, period: row.period, kind: "cross_period_return", severity: "info", message: `Returned in ${row.period}; sold in ${result.salePeriod}. The return reduces ${row.period}, the month it was reported.`, details: { salePeriod: result.salePeriod, saleEventId: result.saleId } });
        }
      }
    }
    for (const kind of autoKinds) {
      const prior = existingBy.get(`${row.id}|${kind}`);
      if (prior && prior.status === "open" && !want.has(kind)) closeIds.push(prior.id);
    }
  }
  for (const batch of chunk(links, 500)) {
    const values = sql.join(batch.map(([id, sale]) => sql`(${id}::int, ${sale}::int)`), sql`, `);
    await db.execute(sql`UPDATE marketplace_events AS e SET related_event_id = v.sale FROM (VALUES ${values}) AS v(id, sale) WHERE e.id = v.id AND e.company_id = ${companyId}`);
  }
  await insertExceptions(toInsert);
  for (const batch of chunk(closeIds, 500)) {
    await db.update(exceptions).set({ status: "resolved", note: "Closed automatically: a later import matched this return.", resolvedAt: new Date() }).where(inArray(exceptions.id, batch));
  }
  return { matched, unmatched };
}

/** Recomputes each event's review status from its exceptions and decisions. One statement, scoped to the marketplace. */
export async function refreshStatuses(companyId: number, marketplace: string) {
  const list = (kinds: string[]) => sql.join(kinds.map(k => sql`${k}`), sql`, `);
  await db.execute(sql`
    UPDATE marketplace_events e SET recon_status = CASE
      WHEN e.duplicate_of IS NOT NULL AND EXISTS (SELECT 1 FROM marketplace_exceptions x WHERE x.event_id = e.id AND x.status = 'open' AND x.kind = 'conflicting_rows') THEN 'conflict'
      WHEN e.duplicate_of IS NOT NULL THEN 'duplicate'
      WHEN EXISTS (SELECT 1 FROM marketplace_exceptions x WHERE x.event_id = e.id AND x.status = 'open' AND x.kind IN (${list(STATUS_KINDS.missing_info)})) THEN 'missing_info'
      WHEN EXISTS (SELECT 1 FROM marketplace_exceptions x WHERE x.event_id = e.id AND x.status = 'open' AND x.kind IN (${list(STATUS_KINDS.tax_mismatch)})) THEN 'tax_mismatch'
      WHEN EXISTS (SELECT 1 FROM marketplace_exceptions x WHERE x.event_id = e.id AND x.status = 'open' AND x.kind IN (${list(STATUS_KINDS.return_mismatch)})) THEN 'return_mismatch'
      WHEN EXISTS (SELECT 1 FROM marketplace_reviews r WHERE r.event_id = e.id AND r.action IN ('confirm', 'classify', 'correct', 'accept_difference')
          AND NOT EXISTS (SELECT 1 FROM marketplace_reviews later WHERE later.event_id = e.id AND later.action = 'reopen' AND later.id > r.id))
        OR EXISTS (SELECT 1 FROM marketplace_exceptions x WHERE x.event_id = e.id AND x.status IN ('resolved', 'accepted') AND x.resolved_by IS NOT NULL) THEN 'reviewed'
      WHEN e.event_type <> 'sale' AND e.related_event_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM marketplace_exceptions x WHERE x.event_id = e.id AND x.kind = 'cross_period_return') THEN 'cross_period'
      WHEN e.event_type <> 'sale' AND e.related_event_id IS NOT NULL THEN 'matched'
      WHEN e.event_type IN ('return', 'cancellation') THEN 'unmatched'
      ELSE 'ok'
    END
    WHERE e.company_id = ${companyId} AND e.marketplace = ${marketplace}
  `);
}

/** What a reviewer changed on an event: its type, and details the file had missing or wrong. The file is never edited. */
export interface Override {
  eventType?: string;
  hsn?: string;
  placeOfSupply?: string;
}

/** Review actions that carry an event's whole override (each one repeats the earlier changes), and the one that clears it. */
export const OVERRIDE_ACTIONS = ["classify", "correct", "reopen"];

/** Each event's current override: the latest classify or correct decision, unless the event was reopened after it. */
export async function overridesFor(eventIds: number[]): Promise<Map<number, Override>> {
  const map = new Map<number, Override>();
  for (const batch of chunk(eventIds, 1000)) {
    const rows = await db.select({ eventId: reviews.eventId, data: reviews.data, action: reviews.action }).from(reviews)
      .where(and(inArray(reviews.eventId, batch), inArray(reviews.action, OVERRIDE_ACTIONS))).orderBy(reviews.id);
    for (const row of rows) {
      if (!row.eventId) continue;
      if (row.action === "reopen") {
        map.delete(row.eventId);
        continue;
      }
      const data = row.data as Override;
      const next: Override = {};
      if (data.eventType) next.eventType = data.eventType;
      if (data.hsn) next.hsn = data.hsn;
      if (data.placeOfSupply) next.placeOfSupply = data.placeOfSupply;
      map.set(row.eventId, next);
    }
  }
  return map;
}

/** The latest classification a reviewer gave each event, unless the event was reopened after it. */
export async function classifications(eventIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const [id, o] of await overridesFor(eventIds)) if (o.eventType) out.set(id, o.eventType);
  return out;
}

/**
 * An event as the summaries see it, with a reviewer's override applied. A corrected customer State changes whether the
 * tax is IGST or CGST + SGST; the amount of tax stays what the report says.
 */
export function toSummaryEvent(e: MarketplaceEvent, override?: Override): SummaryEvent {
  const tax = textToPaise(e.sourceTax ?? e.computedTax ?? "0");
  const cess = textToPaise(e.cess);
  let kind = ((e.supplyType as SummaryEvent["supplyType"]) ?? "unknown") as SummaryEvent["supplyType"];
  let igst = textToPaise(e.igst);
  let cgst = textToPaise(e.cgst);
  let sgst = textToPaise(e.sgst);
  const pos = override?.placeOfSupply ?? e.placeOfSupply;
  if (override?.placeOfSupply && override.placeOfSupply !== e.placeOfSupply) {
    kind = supplyType(e.sellerGstin, pos);
    const split = kind === "unknown" ? { igst: 0, cgst: 0, sgst: 0 } : splitTax(tax - cess, kind);
    igst = split.igst;
    cgst = split.cgst;
    sgst = split.sgst;
  }
  return {
    id: e.id,
    eventType: override?.eventType ?? e.eventType,
    sellerGstin: e.sellerGstin,
    orderId: e.orderId,
    subOrderId: e.subOrderId,
    reportPeriod: e.reportPeriod,
    hsn: override?.hsn ?? e.hsn,
    description: e.description,
    uqc: e.uqc,
    quantity: Number(e.quantity ?? 0),
    taxable: textToPaise(e.taxableValue),
    rateMilli: e.gstRate == null ? null : parseRate(e.gstRate),
    igst,
    cgst,
    sgst,
    cess,
    invoiceValue: textToPaise(e.invoiceValue),
    placeOfSupply: pos,
    supplyType: kind,
    ecoGstin: e.ecoGstin,
    documentNumber: e.documentNumber,
    unsplitTax: kind === "unknown" ? tax : 0,
  };
}

/** Counted (non-duplicate) events of a period with reviewers' classifications and corrections applied. */
export async function periodEvents(companyId: number, marketplace: string, period: string): Promise<{ rows: MarketplaceEvent[]; summary: SummaryEvent[]; overrides: Map<number, Override> }> {
  const rows = await db.select().from(events)
    .where(and(eq(events.companyId, companyId), eq(events.marketplace, marketplace), eq(events.reportPeriod, period), isNull(events.duplicateOf)))
    .orderBy(events.id);
  const overrides = await overridesFor(rows.map(r => r.id));
  return { rows, summary: rows.map(r => toSummaryEvent(r, overrides.get(r.id))), overrides };
}

export async function periodsOf(companyId: number, marketplace: string) {
  const result = await db.execute(sql`
    SELECT report_period AS period,
           count(*) FILTER (WHERE duplicate_of IS NULL)::int AS events,
           count(*) FILTER (WHERE duplicate_of IS NULL AND event_type = 'sale')::int AS sales,
           count(*) FILTER (WHERE duplicate_of IS NULL AND event_type <> 'sale')::int AS reductions
    FROM marketplace_events WHERE company_id = ${companyId} AND marketplace = ${marketplace}
    GROUP BY report_period ORDER BY report_period DESC`);
  return result.rows as Array<{ period: string; events: number; sales: number; reductions: number }>;
}

export async function exceptionCounts(companyId: number, marketplace: string, period: string) {
  const result = await db.execute(sql`
    SELECT severity, status, count(*)::int AS n FROM marketplace_exceptions
    WHERE company_id = ${companyId} AND marketplace = ${marketplace} AND period = ${period}
    GROUP BY severity, status`);
  const rows = result.rows as Array<{ severity: string; status: string; n: number }>;
  const open = rows.filter(r => r.status === "open");
  return {
    openBlocking: open.filter(r => BLOCKING.includes(r.severity)).reduce((s, r) => s + r.n, 0),
    openInfo: open.filter(r => r.severity === "info").reduce((s, r) => s + r.n, 0),
    resolved: rows.filter(r => r.status !== "open").reduce((s, r) => s + r.n, 0),
    byStatus: rows,
  };
}

/** A fingerprint of everything an approval rests on: the events, decisions and exception states of the period. */
export async function dataVersion(companyId: number, marketplace: string, period: string): Promise<string> {
  const result = await db.execute(sql`
    SELECT
      (SELECT coalesce(string_agg(id::text || ':' || idempotency_key, ',' ORDER BY id), '') FROM marketplace_events
        WHERE company_id = ${companyId} AND marketplace = ${marketplace} AND report_period = ${period} AND duplicate_of IS NULL) AS events,
      (SELECT coalesce(string_agg(id::text || ':' || status, ',' ORDER BY id), '') FROM marketplace_exceptions
        WHERE company_id = ${companyId} AND marketplace = ${marketplace} AND period = ${period} AND severity IN ('error', 'warning')) AS exceptions,
      (SELECT coalesce(max(r.id), 0) FROM marketplace_reviews r JOIN marketplace_events e ON e.id = r.event_id
        WHERE e.company_id = ${companyId} AND e.marketplace = ${marketplace} AND e.report_period = ${period} AND r.action IN ('classify', 'correct', 'reopen')) AS classified`);
  const row = result.rows[0] as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify(row)).digest("hex").slice(0, 32);
}

export interface ReportState {
  id: number | null;
  status: "draft" | "needs_review" | "reconciled" | "approved";
  openBlocking: number;
  approvedBy: number | null;
  approvedAt: Date | null;
  approvalOutdated: boolean;
}

/**
 * The period's report status, worked out every time: "approved" only while the data is exactly what was approved;
 * otherwise "needs_review" while anything blocking is open, "reconciled" when nothing is, "draft" when there is no data.
 * It is never shown as reconciled while a warning or error is still open.
 */
export async function reportState(companyId: number, marketplace: string, period: string): Promise<ReportState> {
  const [row] = await db.select().from(reports).where(and(eq(reports.companyId, companyId), eq(reports.marketplace, marketplace), eq(reports.period, period))).limit(1);
  const counts = await exceptionCounts(companyId, marketplace, period);
  const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM marketplace_events WHERE company_id = ${companyId} AND marketplace = ${marketplace} AND report_period = ${period} AND duplicate_of IS NULL`)).rows as Array<{ n: number }>;
  const base: ReportState = { id: row?.id ?? null, status: n === 0 ? "draft" : counts.openBlocking > 0 ? "needs_review" : "reconciled", openBlocking: counts.openBlocking, approvedBy: null, approvedAt: null, approvalOutdated: false };
  if (row?.status === "approved" && row.dataVersion) {
    if (row.dataVersion === (await dataVersion(companyId, marketplace, period)) && counts.openBlocking === 0) {
      return { ...base, status: "approved", approvedBy: row.approvedBy, approvedAt: row.approvedAt };
    }
    return { ...base, approvalOutdated: true };
  }
  return base;
}

export async function ensureReport(companyId: number, marketplace: string, period: string): Promise<number> {
  await db.insert(reports).values({ companyId, marketplace, period }).onConflictDoNothing();
  const [row] = await db.select({ id: reports.id }).from(reports).where(and(eq(reports.companyId, companyId), eq(reports.marketplace, marketplace), eq(reports.period, period))).limit(1);
  return row.id;
}

/**
 * Other imports that lean on this one: rows recorded as duplicates of its rows, or files skipped because this import had
 * already read them. When this import is removed they must be read again, or those rows would count nowhere.
 */
export async function dependentJobs(companyId: number, marketplace: string, jobId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT d.job_id AS id FROM marketplace_events d JOIN marketplace_events o ON o.id = d.duplicate_of
      WHERE d.company_id = ${companyId} AND d.marketplace = ${marketplace} AND o.job_id = ${jobId} AND d.job_id <> ${jobId}
    UNION
    SELECT DISTINCT f.job_id AS id FROM marketplace_source_files f JOIN marketplace_source_files o
      ON o.sha256 = f.sha256 AND coalesce(o.sheet_name, '') = coalesce(f.sheet_name, '') AND o.company_id = f.company_id AND o.marketplace = f.marketplace
      WHERE f.company_id = ${companyId} AND f.marketplace = ${marketplace} AND f.status = 'duplicate_file' AND o.status = 'read' AND o.job_id = ${jobId} AND f.job_id <> ${jobId}`);
  return (result.rows as Array<{ id: string }>).map(r => r.id);
}

export async function recentJobs(companyId: number, marketplace: string, limit = 20) {
  return db.select().from(jobs).where(and(eq(jobs.companyId, companyId), eq(jobs.marketplace, marketplace))).orderBy(desc(jobs.createdAt)).limit(limit);
}

export { events, exceptions, files, jobs, reports, reviews };
