-- Indexes for the lookups every page makes, and one account per email address.
-- Safe to run more than once. Names that already exist on the live database (idx_tally_*, idx_ca_client_links_user)
-- are kept so the live database is not given a second copy.

-- Nearly every query filters by company_id; before this, only the primary keys were indexed.
CREATE INDEX IF NOT EXISTS idx_ai_extractions_company_id ON ai_extractions (company_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_company_id ON ai_usage_logs (company_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_company_id ON audit_logs (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_company_id ON bank_transactions (company_id);
CREATE INDEX IF NOT EXISTS idx_ca_review_items_company_id ON ca_review_items (company_id);
CREATE INDEX IF NOT EXISTS idx_document_requests_company_id ON document_requests (company_id);
CREATE INDEX IF NOT EXISTS idx_documents_company_id ON documents (company_id);
CREATE INDEX IF NOT EXISTS idx_evidence_items_company_id ON evidence_items (company_id);
CREATE INDEX IF NOT EXISTS idx_exceptions_company_id ON exceptions (company_id);
CREATE INDEX IF NOT EXISTS idx_file_access_logs_company_id ON file_access_logs (company_id);
CREATE INDEX IF NOT EXISTS idx_file_uploads_company_id ON file_uploads (company_id);
CREATE INDEX IF NOT EXISTS idx_gateway_settlements_company_id ON gateway_settlements (company_id);
CREATE INDEX IF NOT EXISTS idx_gst_records_company_id ON gst_records (company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_company_id ON invoices (company_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_company_id ON ledger_entries (company_id);
CREATE INDEX IF NOT EXISTS idx_monthly_close_periods_company_id ON monthly_close_periods (company_id);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_company_id ON payroll_entries (company_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_matches_company_id ON reconciliation_matches (company_id);
CREATE INDEX IF NOT EXISTS idx_risk_flags_company_id ON risk_flags (company_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_company_id ON role_permissions (company_id);
CREATE INDEX IF NOT EXISTS idx_upload_batches_company_id ON upload_batches (company_id);
CREATE INDEX IF NOT EXISTS idx_users_company_id ON users (company_id);

CREATE INDEX IF NOT EXISTS idx_ca_client_links_user ON ca_client_links (ca_user_id);
CREATE INDEX IF NOT EXISTS idx_tally_bills_company ON tally_bills (company_id, party);
CREATE INDEX IF NOT EXISTS idx_tally_fixed_assets_company ON tally_fixed_assets (company_id);
CREATE INDEX IF NOT EXISTS idx_tally_ledgers_company ON tally_ledgers (company_id);
CREATE INDEX IF NOT EXISTS idx_tally_voucher_lines_company ON tally_voucher_lines (company_id, voucher_number);
CREATE INDEX IF NOT EXISTS idx_tally_vouchers_company ON tally_vouchers (company_id);

-- One account per email address, whatever the capitals. If two accounts already share an address this fails
-- and changes nothing (the whole file is one transaction): merge or remove the duplicate, then run it again.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));
