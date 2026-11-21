/**
 * The pure part of an import: detect each table, read its rows through the adapter, give every event its identity and
 * find duplicates inside the upload. No database here, so the whole path is unit-tested and repeatable: the same files
 * always give the same events, keys and issues.
 */
import { createHash } from "node:crypto";
import { applyMapping } from "./columns";
import type { SourceTable } from "./tables";
import type { CanonicalField, Detection, DraftEvent, DraftIssue, MarketplaceAdapter, NormalizeContext, NormalizeResult } from "./types";

export type FileStatus = "read" | "duplicate_file" | "needs_mapping" | "unsupported";

export interface PreparedTable {
  key: string;
  table: SourceTable;
  detection: Detection;
  status: FileStatus;
  message: string | null;
  result: NormalizeResult | null;
}

export function tableKey(table: SourceTable): string {
  return `${table.sha256}:${table.sheetName ?? ""}`;
}

const LABELS: Record<string, string> = {
  sales: "sales report",
  returns: "sales-return report",
  combined: "sales and returns working sheet",
  invoice_details: "tax invoice details",
  ca_hsn_summary: "CA's HSN summary (for comparison only)",
  unknown: "not a recognised report",
};

export function reportLabel(type: string): string {
  return LABELS[type] ?? type;
}

export function prepareTables(
  adapter: MarketplaceAdapter,
  tables: SourceTable[],
  ctx: NormalizeContext,
  options: { mappings?: Record<string, Partial<Record<CanonicalField, string>>>; knownTableKeys?: Set<string> } = {},
): PreparedTable[] {
  const seen = new Set<string>();
  return tables.map(table => {
    const key = tableKey(table);
    let detection = adapter.detect(table);
    const chosen = options.mappings?.[key];
    if (chosen) detection = applyMapping(detection, chosen, adapter.mandatory);
    if (options.knownTableKeys?.has(key) || seen.has(key)) {
      return { key, table, detection, status: "duplicate_file" as const, message: "This exact file was imported before; it was not read again.", result: null };
    }
    seen.add(key);
    if (detection.reportType === "unknown") {
      return { key, table, detection, status: "unsupported" as const, message: `Not a recognised ${adapter.name} report: no sub-order and taxable value columns were found.`, result: null };
    }
    if (detection.missing.length > 0) {
      return { key, table, detection, status: "needs_mapping" as const, message: `Some required columns were not found: ${detection.missing.join(", ")}. Choose which column holds each.`, result: null };
    }
    return { key, table, detection, status: "read" as const, message: null, result: adapter.normalize(table, detection, ctx) };
  });
}

/**
 * The identity of an event: the marketplace, the seller, what happened, to which sub-order, in which period, on which
 * date, and for how much. The same sale in a September file and in an August–September file gets the same key, so it is
 * counted once; two different items of one order, or a sale and its later return, get different keys.
 */
export function eventKey(marketplace: string, event: DraftEvent): string {
  const parts = [
    marketplace,
    event.sellerGstin ?? "",
    event.eventType,
    event.subOrderId ?? "",
    event.reportPeriod,
    event.orderDate ?? "",
    event.returnDate ?? "",
    event.quantity ?? "",
    String(event.taxable),
    String(event.rateMilli ?? ""),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40);
}

export interface KeyedEvent {
  tableKey: string;
  event: DraftEvent;
  key: string;
  /** Index of the event in this upload this one repeats (same key) or contradicts (same identity, other figures). */
  duplicateOfIndex: number | null;
  /** True when this row is the same sale or return as another with different figures: held back, not counted. */
  conflict: boolean;
}

/**
 * What makes two rows the same event even when their figures differ: a sub-order is sold once, and returned once on a
 * given date. Without a sub-order there is no identity to compare.
 */
export function eventIdentity(event: { eventType: string; subOrderId: string | null; returnDate: string | null; sellerGstin: string | null }): string | null {
  if (!event.subOrderId) return null;
  return event.eventType === "sale"
    ? `${event.sellerGstin ?? ""}|sale|${event.subOrderId}`
    : `${event.sellerGstin ?? ""}|${event.eventType}|${event.subOrderId}|${event.returnDate ?? ""}`;
}

/**
 * Keys every event and finds repeats within the upload. An exact repeat is a duplicate. The same sale (or the same
 * return) with different figures is a conflict: the first row counts, the later one is held back with a warning, and a
 * reviewer chooses. Counting both would double the sale; dropping one silently would hide the difference.
 */
export function keyEvents(marketplace: string, prepared: PreparedTable[]): { events: KeyedEvent[]; issues: Array<DraftIssue & { eventIndex: number }> } {
  const events: KeyedEvent[] = [];
  const firstByKey = new Map<string, number>();
  const firstByIdentity = new Map<string, number>();
  const issues: Array<DraftIssue & { eventIndex: number }> = [];
  for (const item of prepared) {
    if (item.status !== "read" || !item.result) continue;
    for (const event of item.result.events) {
      const key = eventKey(marketplace, event);
      const index = events.length;
      const repeat = firstByKey.get(key);
      if (repeat != null) {
        events.push({ tableKey: item.key, event, key, duplicateOfIndex: repeat, conflict: false });
        continue;
      }
      firstByKey.set(key, index);
      const identity = eventIdentity(event);
      const first = identity ? firstByIdentity.get(identity) : undefined;
      if (identity && first != null) {
        const other = events[first].event;
        events.push({ tableKey: item.key, event, key, duplicateOfIndex: first, conflict: true });
        issues.push({
          eventIndex: index,
          kind: "conflicting_rows",
          severity: "warning",
          message: `Sub-order ${event.subOrderId} has two ${event.eventType} rows with different figures (row ${other.sourceRow}: taxable ${(other.taxable / 100).toFixed(2)}; row ${event.sourceRow}: ${(event.taxable / 100).toFixed(2)}). Only the first is counted until you choose.`,
          details: { otherRow: other.sourceRow, otherTaxable: other.taxable, taxable: event.taxable },
        });
        continue;
      }
      if (identity) firstByIdentity.set(identity, index);
      events.push({ tableKey: item.key, event, key, duplicateOfIndex: null, conflict: false });
    }
  }
  return { events, issues };
}

/** Invoice and credit-note numbers from Tax_invoice_details, attached to the events they belong to. */
export function attachDocuments(events: KeyedEvent[], prepared: PreparedTable[]): number {
  const documents = new Map<string, { number: string; date: string | null }>();
  for (const item of prepared) {
    for (const doc of item.result?.documents ?? []) documents.set(`${doc.type}|${doc.subOrderId}`, { number: doc.number, date: doc.date });
  }
  let attached = 0;
  for (const { event } of events) {
    const type = event.eventType === "sale" ? "invoice" : "credit_note";
    const doc = documents.get(`${type}|${event.subOrderId}`);
    if (doc) {
      event.documentNumber = doc.number;
      event.documentDate = doc.date;
      attached += 1;
    }
  }
  return attached;
}
