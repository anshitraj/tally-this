import { pgTable, serial, text, integer, numeric, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  industry: text("industry").notNull(),
  monthlyRevenueRange: text("monthly_revenue_range"),
  caEmail: text("ca_email"),
  gstin: text("gstin"),
  pan: text("pan"),
  financialYearStart: text("financial_year_start").notNull().default("April"),
  currency: text("currency").notNull().default("INR"),
  dataRetentionDays: integer("data_retention_days").notNull().default(365),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  passwordSalt: text("password_salt"),
  role: text("role").notNull().default("founder"),
  status: text("status").notNull().default("active"),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const authSessionsTable = pgTable("auth_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  companyId: integer("company_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const oauthAccountsTable = pgTable("oauth_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  companyId: integer("company_id").notNull(),
  provider: text("provider").notNull(),
  providerUserId: text("provider_user_id").notNull(),
  email: text("email").notNull(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at"),
});

export const rolePermissionsTable = pgTable("role_permissions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  role: text("role").notNull(),
  permission: text("permission").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const uploadBatchesTable = pgTable("upload_batches", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  sourceType: text("source_type").notNull(),
  fileName: text("file_name").notNull(),
  status: text("status").notNull().default("processed"),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  recordCount: integer("record_count"),
  // Optional upload session grouping — batches sharing a runId were uploaded together.
  // Null = legacy upload (no session context). Non-breaking additive field.
  runId: text("run_id"),
});

export const documentsTable = pgTable("documents", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  uploadBatchId: integer("upload_batch_id"),
  fileName: text("file_name").notNull(),
  sourceType: text("source_type").notNull(),
  mimeType: text("mime_type"),
  storageProvider: text("storage_provider").notNull().default("metadata_only"),
  storageKey: text("storage_key"),
  storageBucket: text("storage_bucket"),
  storageRegion: text("storage_region"),
  storageUrl: text("storage_url"),
  sizeBytes: integer("size_bytes"),
  checksumSha256: text("checksum_sha256"),
  status: text("status").notNull().default("metadata_captured"),
  extractedTextStatus: text("extracted_text_status").notNull().default("not_started"),
  rowCount: integer("row_count"),
  detectedColumns: jsonb("detected_columns"),
  uploadedByUserId: integer("uploaded_by_user_id"),
  retentionUntil: timestamp("retention_until"),
  deletedAt: timestamp("deleted_at"),
  deletedByUserId: integer("deleted_by_user_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const bankTransactionsTable = pgTable("bank_transactions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  date: text("date").notNull(),
  narration: text("narration").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  type: text("type").notNull(),
  source: text("source").notNull().default("bank"),
  bankName: text("bank_name"),
  reference: text("reference"),
  status: text("status").notNull().default("unverified"),
  confidenceScore: integer("confidence_score").notNull().default(0),
  matchedInvoiceId: integer("matched_invoice_id"),
  note: text("note"),
  sourceUploadId: integer("source_upload_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  invoiceNumber: text("invoice_number").notNull(),
  vendorName: text("vendor_name").notNull(),
  customerName: text("customer_name"),
  gstin: text("gstin"),
  date: text("date").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  gstAmount: numeric("gst_amount", { precision: 14, scale: 2 }),
  type: text("type").notNull().default("purchase"),
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  status: text("status").notNull().default("unverified"),
  linkedTransactionId: integer("linked_transaction_id"),
  sourceUploadId: integer("source_upload_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const ledgerEntriesTable = pgTable("ledger_entries", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  date: text("date").notNull(),
  ledgerName: text("ledger_name").notNull(),
  voucherNumber: text("voucher_number"),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  debitCredit: text("debit_credit").notNull(),
  sourceTool: text("source_tool").notNull().default("manual"),
  status: text("status").notNull().default("unmatched"),
  matchedTransactionId: integer("matched_transaction_id"),
  sourceUploadId: integer("source_upload_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const payrollEntriesTable = pgTable("payroll_entries", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  employeeName: text("employee_name").notNull(),
  month: text("month").notNull(),
  grossAmount: numeric("gross_amount", { precision: 14, scale: 2 }),
  netAmount: numeric("net_amount", { precision: 14, scale: 2 }).notNull(),
  paymentDate: text("payment_date"),
  bankReference: text("bank_reference"),
  status: text("status").notNull().default("verified"),
  sourceUploadId: integer("source_upload_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const gatewaySettlementsTable = pgTable("gateway_settlements", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  provider: text("provider").notNull(),
  settlementId: text("settlement_id").notNull(),
  grossAmount: numeric("gross_amount", { precision: 14, scale: 2 }).notNull(),
  fees: numeric("fees", { precision: 14, scale: 2 }).notNull().default("0"),
  gstOnFees: numeric("gst_on_fees", { precision: 14, scale: 2 }),
  netAmount: numeric("net_amount", { precision: 14, scale: 2 }).notNull(),
  settlementDate: text("settlement_date").notNull(),
  bankReference: text("bank_reference"),
  status: text("status").notNull().default("matched"),
  bankTransactionId: integer("bank_transaction_id"),
  sourceUploadId: integer("source_upload_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const reconciliationMatchesTable = pgTable("reconciliation_matches", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  bankTransactionId: integer("bank_transaction_id"),
  invoiceId: integer("invoice_id"),
  ledgerEntryId: integer("ledger_entry_id"),
  runId: text("run_id"),
  matchType: text("match_type").notNull(),
  confidenceScore: integer("confidence_score").notNull().default(0),
  reason: text("reason").notNull(),
  reasonJson: jsonb("reason_json"),
  evidenceJson: jsonb("evidence_json"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const riskFlagsTable = pgTable("risk_flags", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id"),
  category: text("category").notNull(),
  severity: text("severity").notNull(),
  reason: text("reason").notNull(),
  suggestedAction: text("suggested_action").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const gstRecordsTable = pgTable("gst_records", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  period: text("period").notNull(),
  sourceType: text("source_type").notNull(),
  gstin: text("gstin"),
  counterpartyName: text("counterparty_name"),
  invoiceNumber: text("invoice_number"),
  invoiceDate: text("invoice_date"),
  taxableValue: numeric("taxable_value", { precision: 14, scale: 2 }).notNull().default("0"),
  gstAmount: numeric("gst_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  matchStatus: text("match_status").notNull().default("unmatched"),
  riskStatus: text("risk_status").notNull().default("none"),
  sourceUploadId: integer("source_upload_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  userId: integer("user_id"),
  actorEmail: text("actor_email"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id"),
  metadata: jsonb("metadata"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const aiUsageLogsTable = pgTable("ai_usage_logs", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  userId: integer("user_id"),
  provider: text("provider").notNull(),
  model: text("model"),
  purpose: text("purpose").notNull(),
  success: boolean("success").notNull().default(false),
  latencyMs: integer("latency_ms").notNull().default(0),
  tokenEstimate: integer("token_estimate"),
  usedFallback: boolean("used_fallback").notNull().default(false),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const aiExtractionsTable = pgTable("ai_extractions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  uploadId: integer("upload_id"),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id"),
  provider: text("provider").notNull(),
  model: text("model"),
  purpose: text("purpose").notNull(),
  extractedJson: jsonb("extracted_json").notNull(),
  confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull().default("0"),
  status: text("status").notNull().default("extracted_pending_review"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const aiProviderSettingsTable = pgTable("ai_provider_settings", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  geminiModel: text("gemini_model"),
  geminiFallbackModel: text("gemini_fallback_model"),
  nvidiaModel: text("nvidia_model"),
  openrouterModel: text("openrouter_model"),
  openrouterEnabled: boolean("openrouter_enabled").notNull().default(false),
  providerOrder: jsonb("provider_order"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const fileUploadsTable = pgTable("file_uploads", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  userId: integer("user_id"),
  sourceType: text("source_type").notNull(),
  originalFileName: text("original_file_name").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  r2Key: text("r2_key"),
  encrypted: boolean("encrypted").notNull().default(true),
  encryptionVersion: text("encryption_version").notNull().default("r2-managed"),
  status: text("status").notNull().default("stored"),
  parsedRowCount: integer("parsed_row_count"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const fileAccessLogsTable = pgTable("file_access_logs", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  userId: integer("user_id"),
  fileUploadId: integer("file_upload_id"),
  r2Key: text("r2_key"),
  action: text("action").notNull(),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const caReviewItemsTable = pgTable("ca_review_items", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  monthlyClosePeriodId: integer("monthly_close_period_id"),
  exceptionId: integer("exception_id"),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id"),
  title: text("title").notNull(),
  description: text("description"),
  severity: text("severity").notNull().default("medium"),
  status: text("status").notNull().default("pending"),
  assignedTo: integer("assigned_to"),
  founderNote: text("founder_note"),
  caNote: text("ca_note"),
  requestedDocumentsJson: jsonb("requested_documents_json"),
  evidenceJson: jsonb("evidence_json"),
  createdBy: integer("created_by"),
  resolvedBy: integer("resolved_by"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const monthlyClosePeriodsTable = pgTable("monthly_close_periods", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  month: integer("month").notNull(),
  year: integer("year").notNull(),
  status: text("status").notNull().default("open"),
  verificationScore: integer("verification_score").notNull().default(0),
  verifiedAmount: numeric("verified_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  unverifiedAmount: numeric("unverified_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  missingDocumentsCount: integer("missing_documents_count").notNull().default(0),
  riskFlagsCount: integer("risk_flags_count").notNull().default(0),
  caReviewItemsCount: integer("ca_review_items_count").notNull().default(0),
  uploadedSourcesJson: jsonb("uploaded_sources_json"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const evidenceItemsTable = pgTable("evidence_items", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  uploadId: integer("upload_id"),
  sourceType: text("source_type"),
  sourceFileName: text("source_file_name"),
  sourcePage: integer("source_page"),
  sourceRowNumber: integer("source_row_number"),
  sourceTextSnippet: text("source_text_snippet"),
  sourceJson: jsonb("source_json"),
  confidence: numeric("confidence", { precision: 5, scale: 4 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const documentRequestsTable = pgTable("document_requests", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  monthlyClosePeriodId: integer("monthly_close_period_id"),
  requestedBy: integer("requested_by"),
  assignedTo: integer("assigned_to"),
  relatedEntityType: text("related_entity_type"),
  relatedEntityId: integer("related_entity_id"),
  title: text("title").notNull(),
  description: text("description"),
  requiredDocumentType: text("required_document_type").notNull().default("other"),
  status: text("status").notNull().default("open"),
  priority: text("priority").notNull().default("medium"),
  dueDate: timestamp("due_date"),
  uploadedFileId: integer("uploaded_file_id"),
  caComment: text("ca_comment"),
  founderComment: text("founder_comment"),
  resolvedBy: integer("resolved_by"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const exceptionsTable = pgTable("exceptions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  monthlyClosePeriodId: integer("monthly_close_period_id"),
  type: text("type").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  severity: text("severity").notNull().default("medium"),
  status: text("status").notNull().default("open"),
  relatedEntityType: text("related_entity_type"),
  relatedEntityId: integer("related_entity_id"),
  assignedTo: integer("assigned_to"),
  createdBy: integer("created_by"),
  resolvedBy: integer("resolved_by"),
  resolvedAt: timestamp("resolved_at"),
  resolutionNote: text("resolution_note"),
  evidenceJson: jsonb("evidence_json"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUploadBatchSchema = createInsertSchema(uploadBatchesTable).omit({ id: true, uploadedAt: true });
export const insertCompanySchema = createInsertSchema(companiesTable).omit({ id: true, createdAt: true });
export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export const insertAuthSessionSchema = createInsertSchema(authSessionsTable).omit({ id: true, createdAt: true });
export const insertOauthAccountSchema = createInsertSchema(oauthAccountsTable).omit({ id: true, createdAt: true });
export const insertRolePermissionSchema = createInsertSchema(rolePermissionsTable).omit({ id: true, createdAt: true });
export const insertDocumentSchema = createInsertSchema(documentsTable).omit({ id: true, createdAt: true });
export const insertBankTransactionSchema = createInsertSchema(bankTransactionsTable).omit({ id: true, createdAt: true });
export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({ id: true, createdAt: true });
export const insertLedgerEntrySchema = createInsertSchema(ledgerEntriesTable).omit({ id: true, createdAt: true });
export const insertPayrollEntrySchema = createInsertSchema(payrollEntriesTable).omit({ id: true, createdAt: true });
export const insertGatewaySettlementSchema = createInsertSchema(gatewaySettlementsTable).omit({ id: true, createdAt: true });
export const insertReconciliationMatchSchema = createInsertSchema(reconciliationMatchesTable).omit({ id: true, createdAt: true });
export const insertRiskFlagSchema = createInsertSchema(riskFlagsTable).omit({ id: true, createdAt: true });
export const insertCaReviewItemSchema = createInsertSchema(caReviewItemsTable).omit({ id: true, createdAt: true });
export const insertGstRecordSchema = createInsertSchema(gstRecordsTable).omit({ id: true, createdAt: true });
export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({ id: true, createdAt: true });
export const insertAiUsageLogSchema = createInsertSchema(aiUsageLogsTable).omit({ id: true, createdAt: true });
export const insertAiExtractionSchema = createInsertSchema(aiExtractionsTable).omit({ id: true, createdAt: true });
export const insertAiProviderSettingSchema = createInsertSchema(aiProviderSettingsTable).omit({ id: true, createdAt: true });
export const insertFileUploadSchema = createInsertSchema(fileUploadsTable).omit({ id: true, createdAt: true });
export const insertFileAccessLogSchema = createInsertSchema(fileAccessLogsTable).omit({ id: true, createdAt: true });
export const insertMonthlyClosePeriodSchema = createInsertSchema(monthlyClosePeriodsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertEvidenceItemSchema = createInsertSchema(evidenceItemsTable).omit({ id: true, createdAt: true });
export const insertDocumentRequestSchema = createInsertSchema(documentRequestsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertExceptionSchema = createInsertSchema(exceptionsTable).omit({ id: true, createdAt: true, updatedAt: true });

export type UploadBatch = typeof uploadBatchesTable.$inferSelect;
export type Company = typeof companiesTable.$inferSelect;
export type User = typeof usersTable.$inferSelect;
export type AuthSession = typeof authSessionsTable.$inferSelect;
export type OauthAccount = typeof oauthAccountsTable.$inferSelect;
export type RolePermission = typeof rolePermissionsTable.$inferSelect;
export type Document = typeof documentsTable.$inferSelect;
export type BankTransaction = typeof bankTransactionsTable.$inferSelect;
export type Invoice = typeof invoicesTable.$inferSelect;
export type LedgerEntry = typeof ledgerEntriesTable.$inferSelect;
export type PayrollEntry = typeof payrollEntriesTable.$inferSelect;
export type GatewaySettlement = typeof gatewaySettlementsTable.$inferSelect;
export type ReconciliationMatch = typeof reconciliationMatchesTable.$inferSelect;
export type RiskFlag = typeof riskFlagsTable.$inferSelect;
export type CaReviewItem = typeof caReviewItemsTable.$inferSelect;
export type GstRecord = typeof gstRecordsTable.$inferSelect;
export type AuditLog = typeof auditLogsTable.$inferSelect;
export type AiUsageLog = typeof aiUsageLogsTable.$inferSelect;
export type AiExtraction = typeof aiExtractionsTable.$inferSelect;
export type AiProviderSetting = typeof aiProviderSettingsTable.$inferSelect;
export type FileUpload = typeof fileUploadsTable.$inferSelect;
export type FileAccessLog = typeof fileAccessLogsTable.$inferSelect;
export type MonthlyClosePeriod = typeof monthlyClosePeriodsTable.$inferSelect;
export type EvidenceItem = typeof evidenceItemsTable.$inferSelect;
export type DocumentRequest = typeof documentRequestsTable.$inferSelect;
export type Exception = typeof exceptionsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Tally Audit / Ledger Scrutiny — masters & vouchers for the Tax Audit module
// ---------------------------------------------------------------------------
export const tallyLedgersTable = pgTable("tally_ledgers", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  name: text("name").notNull(),
  group: text("group").notNull(),                 // Tally parent group, e.g. "Sundry Debtors"
  openingBalance: numeric("opening_balance", { precision: 16, scale: 2 }).notNull().default("0"), // signed +Dr/-Cr
  closingBalance: numeric("closing_balance", { precision: 16, scale: 2 }).notNull().default("0"),
  prevYearClosing: numeric("prev_year_closing", { precision: 16, scale: 2 }),
  prevYearGroup: text("prev_year_group"),
  isMsme: boolean("is_msme").notNull().default(false),
  msmeType: text("msme_type"),                    // Micro | Small | Medium
  pan: text("pan"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tallyVouchersTable = pgTable("tally_vouchers", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  date: text("date").notNull(),                   // ISO yyyy-mm-dd
  type: text("type").notNull(),                   // Purchase | Sales | Receipt | Payment | Journal | Contra | Debit Note | Credit Note
  number: text("number").notNull(),
  party: text("party"),
  narration: text("narration"),
  amount: numeric("amount", { precision: 16, scale: 2 }).notNull().default("0"),
  mode: text("mode"),                             // Cash | Bank | Journal
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tallyVoucherLinesTable = pgTable("tally_voucher_lines", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  voucherNumber: text("voucher_number").notNull(),
  ledger: text("ledger").notNull(),
  group: text("group").notNull(),
  debit: numeric("debit", { precision: 16, scale: 2 }).notNull().default("0"),
  credit: numeric("credit", { precision: 16, scale: 2 }).notNull().default("0"),
});

export const tallyFixedAssetsTable = pgTable("tally_fixed_assets", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  name: text("name").notNull(),
  block: text("block").notNull(),
  rate: numeric("rate", { precision: 6, scale: 2 }).notNull().default("0"),
  openingWdv: numeric("opening_wdv", { precision: 16, scale: 2 }).notNull().default("0"),
  additions: numeric("additions", { precision: 16, scale: 2 }).notNull().default("0"),
  additionDate: text("addition_date"),
  deletions: numeric("deletions", { precision: 16, scale: 2 }).notNull().default("0"),
  deletionDate: text("deletion_date"),
  depreciation: numeric("depreciation", { precision: 16, scale: 2 }).notNull().default("0"),
  closingWdv: numeric("closing_wdv", { precision: 16, scale: 2 }).notNull().default("0"),
});

// CA practice — links a CA user to the client companies they audit.
export const caClientLinksTable = pgTable("ca_client_links", {
  id: serial("id").primaryKey(),
  caUserId: integer("ca_user_id").notNull(),
  caCompanyId: integer("ca_company_id"),          // the CA's own firm workspace
  clientCompanyId: integer("client_company_id").notNull(),
  clientName: text("client_name"),
  status: text("status").notNull().default("active"), // active | archived
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type CaClientLink = typeof caClientLinksTable.$inferSelect;

export const tallyBillsTable = pgTable("tally_bills", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  party: text("party").notNull(),
  group: text("group").notNull(),
  ref: text("ref").notNull(),                     // bill reference / invoice no.
  date: text("date").notNull(),                   // ISO yyyy-mm-dd original bill date
  amount: numeric("amount", { precision: 16, scale: 2 }).notNull().default("0"),
  type: text("type").notNull().default("New Ref"), // New Ref | Agst Ref | Advance | On Account
});

export type TallyLedger = typeof tallyLedgersTable.$inferSelect;
export type TallyBill = typeof tallyBillsTable.$inferSelect;
export type TallyVoucher = typeof tallyVouchersTable.$inferSelect;
export type TallyVoucherLine = typeof tallyVoucherLinesTable.$inferSelect;
export type TallyFixedAsset = typeof tallyFixedAssetsTable.$inferSelect;
