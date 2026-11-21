/**
 * The contract every marketplace adapter implements, and the shapes shared with the engines.
 *
 * An adapter only interprets its marketplace's files: which report a table is, which column means what, and how a row
 * becomes a sale, return or credit note. GST arithmetic, duplicate detection, return matching, summaries and exports
 * are shared and know nothing about any one marketplace.
 */
import type { Paise } from "./money";
import type { SourceTable } from "./tables";

export type Capability = "file_import" | "sales" | "returns" | "credit_notes" | "settlements" | "tcs" | "fees" | "gst" | "documents" | "api_sync";

export type ReportType = "sales" | "returns" | "combined" | "invoice_details" | "ca_hsn_summary" | "unknown";

export type EventType = "sale" | "return" | "cancellation" | "credit_note" | "adjustment";

/** The standard fields an adapter maps a report's columns onto. */
export type CanonicalField =
  | "identifier" | "sellerName" | "sellerGstin" | "orderId" | "subOrderId" | "orderDate" | "documentDate" | "returnDate"
  | "hsn" | "description" | "quantity" | "returnFlag" | "gstRate" | "taxable" | "tax" | "igst" | "cgst" | "sgst" | "cess"
  | "invoiceValue" | "shippingTaxable" | "customerState" | "manifestDate" | "ecoGstin" | "financialYear" | "month"
  | "supplierId" | "documentNumber" | "documentType";

export interface Detection {
  reportType: ReportType;
  /** Index into table.rows of the header row. */
  headerIndex: number;
  headers: string[];
  /** canonical field → header text as it appears in the file */
  columnMap: Partial<Record<CanonicalField, string>>;
  missing: CanonicalField[];
  unknownColumns: string[];
  confidence: number;
}

/** A row turned into a marketplace-independent event, before it has a database id. */
export interface DraftEvent {
  sourceRow: number;
  eventType: EventType;
  sellerGstin: string | null;
  orderId: string | null;
  subOrderId: string | null;
  lineId: string | null;
  orderDate: string | null;
  documentDate: string | null;
  returnDate: string | null;
  documentNumber: string | null;
  reportPeriod: string;
  financialYear: string;
  hsn: string | null;
  description: string | null;
  quantity: string | null;
  uqc: string | null;
  taxable: Paise;
  rateMilli: number | null;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  invoiceValue: Paise;
  sourceTax: Paise | null;
  computedTax: Paise | null;
  shippingTaxable: Paise | null;
  placeOfSupply: string | null;
  supplyType: "intra" | "inter" | "unknown";
  ecoGstin: string | null;
  sourceStatus: string | null;
  raw: Record<string, string>;
  notes: string[];
  issues: DraftIssue[];
}

export type Severity = "error" | "warning" | "info";

export interface DraftIssue {
  kind: string;
  severity: Severity;
  message: string;
  details?: Record<string, unknown>;
}

export interface NormalizeContext {
  /** The GSTIN chosen for the import; rows for another GSTIN are flagged, never merged silently. */
  sellerGstin: string | null;
  /** The reporting period chosen for the import (YYYY-MM), used only when a row carries no period of its own. */
  period: string | null;
}

export interface NormalizeResult {
  events: DraftEvent[];
  /** Issues about the table as a whole (skipped total rows, unknown columns...). */
  issues: DraftIssue[];
  periods: string[];
  /** Extra data some report types carry: invoice numbers, a CA summary for comparison. */
  documents?: Array<{ subOrderId: string; type: "invoice" | "credit_note"; number: string; date: string | null }>;
  caSummary?: Array<{ hsn: string; count: number | null; taxable: Paise; igst: Paise; cgst: Paise; sgst: Paise }>;
}

export interface MarketplaceAdapter {
  id: string;
  name: string;
  capabilities: Capability[];
  /** The fields a sales or returns table must have before it can be read. */
  mandatory: CanonicalField[];
  /** Field → header names it is known by, for the column-mapping screen. */
  fieldAliases: Partial<Record<CanonicalField, string[]>>;
  detect(table: SourceTable): Detection;
  normalize(table: SourceTable, detection: Detection, ctx: NormalizeContext): NormalizeResult;
}
