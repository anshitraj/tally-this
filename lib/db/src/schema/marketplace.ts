import { pgTable, serial, text, integer, numeric, timestamp, jsonb, date, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * E-commerce reconciliation: marketplace report imports and the transactions read from them.
 * Shared by every marketplace adapter (Meesho first). Money columns are numeric(16,2), read back as strings, so no
 * amount ever passes through a floating-point number on its way to or from the database.
 */

/** One upload of one or more report files for a marketplace. Processed in the background; the page polls `stage`. */
export const marketplaceImportJobsTable = pgTable("marketplace_import_jobs", {
  id: text("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  marketplace: text("marketplace").notNull(),
  sellerGstin: text("seller_gstin"),
  financialYear: text("financial_year"),
  period: text("period"), // YYYY-MM chosen by the person importing
  status: text("status").notNull().default("queued"), // queued | running | needs_mapping | completed | failed
  stage: text("stage").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  message: text("message"),
  stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, table => [index("idx_marketplace_import_jobs_company").on(table.companyId, table.marketplace, table.createdAt)]);

/** Each file (or ZIP member, or sheet) read in an import, with what was detected and every column it carried. */
export const marketplaceSourceFilesTable = pgTable("marketplace_source_files", {
  id: serial("id").primaryKey(),
  jobId: text("job_id").notNull(),
  companyId: integer("company_id").notNull(),
  marketplace: text("marketplace").notNull(),
  fileName: text("file_name").notNull(),
  containerName: text("container_name"),
  sheetName: text("sheet_name"),
  sha256: text("sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  reportType: text("report_type").notNull(), // sales | returns | combined | invoice_details | ca_hsn_summary | unknown
  status: text("status").notNull(), // read | duplicate_file | needs_mapping | unsupported | failed
  headers: jsonb("headers").$type<string[]>().notNull().default([]),
  columnMap: jsonb("column_map").$type<Record<string, string>>().notNull().default({}),
  unknownColumns: jsonb("unknown_columns").$type<string[]>().notNull().default([]),
  rowCount: integer("row_count").notNull().default(0),
  periods: jsonb("periods").$type<string[]>().notNull().default([]),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  message: text("message"),
  storageProvider: text("storage_provider"),
  storageBucket: text("storage_bucket"),
  storageKey: text("storage_key"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, table => [
  index("idx_marketplace_source_files_job").on(table.jobId),
  index("idx_marketplace_source_files_company_sha").on(table.companyId, table.marketplace, table.sha256),
]);

/** A sale, return, credit note or adjustment, normalized from one source row. The source row itself stays in `raw`. */
export const marketplaceEventsTable = pgTable("marketplace_events", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  marketplace: text("marketplace").notNull(),
  jobId: text("job_id").notNull(),
  sourceFileId: integer("source_file_id").notNull(),
  sourceRow: integer("source_row").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  duplicateOf: integer("duplicate_of"), // an earlier event with the same identity: kept for the record, never counted
  sellerGstin: text("seller_gstin"),
  orderId: text("order_id"),
  subOrderId: text("sub_order_id"),
  lineId: text("line_id"),
  eventType: text("event_type").notNull(), // sale | return | cancellation | credit_note | adjustment
  orderDate: date("order_date"),
  documentDate: date("document_date"),
  returnDate: date("return_date"),
  documentNumber: text("document_number"),
  reportPeriod: text("report_period").notNull(), // YYYY-MM: the GST period the event belongs to
  financialYear: text("financial_year"),
  hsn: text("hsn"),
  description: text("description"),
  quantity: numeric("quantity", { precision: 14, scale: 3 }),
  uqc: text("uqc"),
  taxableValue: numeric("taxable_value", { precision: 16, scale: 2 }).notNull().default("0"),
  gstRate: numeric("gst_rate", { precision: 6, scale: 3 }),
  igst: numeric("igst", { precision: 16, scale: 2 }).notNull().default("0"),
  cgst: numeric("cgst", { precision: 16, scale: 2 }).notNull().default("0"),
  sgst: numeric("sgst", { precision: 16, scale: 2 }).notNull().default("0"),
  cess: numeric("cess", { precision: 16, scale: 2 }).notNull().default("0"),
  invoiceValue: numeric("invoice_value", { precision: 16, scale: 2 }).notNull().default("0"),
  sourceTax: numeric("source_tax", { precision: 16, scale: 2 }),
  computedTax: numeric("computed_tax", { precision: 16, scale: 2 }),
  shippingTaxable: numeric("shipping_taxable", { precision: 16, scale: 2 }),
  placeOfSupply: text("place_of_supply"), // two-digit GST state code
  supplyType: text("supply_type").notNull().default("unknown"), // intra | inter | unknown
  customerType: text("customer_type").notNull().default("B2C"),
  ecoGstin: text("eco_gstin"),
  sourceStatus: text("source_status"),
  reconStatus: text("recon_status").notNull().default("unreviewed"),
  relatedEventId: integer("related_event_id"),
  raw: jsonb("raw").$type<Record<string, string>>().notNull().default({}),
  notes: jsonb("notes").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, table => [
  index("idx_marketplace_events_period").on(table.companyId, table.marketplace, table.reportPeriod),
  index("idx_marketplace_events_key").on(table.companyId, table.marketplace, table.idempotencyKey),
  index("idx_marketplace_events_sub_order").on(table.companyId, table.marketplace, table.subOrderId),
  index("idx_marketplace_events_job").on(table.jobId),
]);

/** Something a person must look at: a missing HSN, a tax difference, an unmatched return, a duplicate. */
export const marketplaceExceptionsTable = pgTable("marketplace_exceptions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  marketplace: text("marketplace").notNull(),
  jobId: text("job_id").notNull(),
  eventId: integer("event_id"),
  period: text("period"),
  kind: text("kind").notNull(),
  severity: text("severity").notNull(), // error | warning | info
  message: text("message").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").notNull().default("open"), // open | resolved | accepted
  note: text("note"),
  resolvedBy: integer("resolved_by"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, table => [
  index("idx_marketplace_exceptions_period").on(table.companyId, table.marketplace, table.period, table.status),
  index("idx_marketplace_exceptions_event").on(table.eventId),
]);

/** The working report for one period: its status and the approval trail lives in marketplace_reviews. */
export const marketplaceReportsTable = pgTable("marketplace_reports", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  marketplace: text("marketplace").notNull(),
  period: text("period").notNull(),
  status: text("status").notNull().default("draft"), // draft | needs_review | reconciled | approved
  dataVersion: text("data_version"), // fingerprint of the events the approval was given on
  approvedBy: integer("approved_by"),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, table => [uniqueIndex("uq_marketplace_reports_period").on(table.companyId, table.marketplace, table.period)]);

/**
 * Every human decision, kept apart from the source data: a confirmed match, a changed classification, an accepted
 * difference, a note, a reopened item, a report approval. Nothing here edits a source row.
 */
export const marketplaceReviewsTable = pgTable("marketplace_reviews", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  marketplace: text("marketplace").notNull(),
  eventId: integer("event_id"),
  exceptionId: integer("exception_id"),
  reportId: integer("report_id"),
  action: text("action").notNull(),
  note: text("note"),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  actorUserId: integer("actor_user_id"),
  actorEmail: text("actor_email"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, table => [
  index("idx_marketplace_reviews_event").on(table.eventId),
  index("idx_marketplace_reviews_report").on(table.reportId),
]);

export type MarketplaceImportJob = typeof marketplaceImportJobsTable.$inferSelect;
export type MarketplaceSourceFile = typeof marketplaceSourceFilesTable.$inferSelect;
export type MarketplaceEvent = typeof marketplaceEventsTable.$inferSelect;
export type MarketplaceException = typeof marketplaceExceptionsTable.$inferSelect;
export type MarketplaceReport = typeof marketplaceReportsTable.$inferSelect;
export type MarketplaceReview = typeof marketplaceReviewsTable.$inferSelect;
