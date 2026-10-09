// DB migration: journal_entries, journal_entry_lines, gstr_2b_records, period_locks, run_signoffs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(path.join(__dir, "../../../.env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const pg = (await import("file:///E:/accountant/Asset-Manager/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js")).default;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const migrations = [
  // Journal entries — header
  `CREATE TABLE IF NOT EXISTS journal_entries (
    id              SERIAL PRIMARY KEY,
    company_id      INTEGER NOT NULL,
    run_id          TEXT,
    entry_date      TEXT NOT NULL,
    voucher_no      TEXT,
    narration       TEXT NOT NULL DEFAULT '',
    template_key    TEXT,
    total_debit     NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_credit    NUMERIC(14,2) NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'draft',
    created_by      INTEGER,
    reviewed_by     INTEGER,
    reviewed_at     TIMESTAMP,
    posted_at       TIMESTAMP,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    metadata_json   JSONB
  )`,

  // Journal entry lines — debits/credits
  `CREATE TABLE IF NOT EXISTS journal_entry_lines (
    id            SERIAL PRIMARY KEY,
    journal_id    INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_name  TEXT NOT NULL,
    description   TEXT,
    debit         NUMERIC(14,2) NOT NULL DEFAULT 0,
    credit        NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_order    INTEGER NOT NULL DEFAULT 0
  )`,

  // GSTR-2B records — supplier data downloaded from GST portal
  `CREATE TABLE IF NOT EXISTS gstr_2b_records (
    id                 SERIAL PRIMARY KEY,
    company_id         INTEGER NOT NULL,
    run_id             TEXT,
    return_period      TEXT NOT NULL,
    supplier_gstin     TEXT NOT NULL,
    supplier_name      TEXT,
    invoice_number     TEXT NOT NULL,
    invoice_date       TEXT,
    invoice_value      NUMERIC(14,2) NOT NULL DEFAULT 0,
    taxable_value      NUMERIC(14,2) NOT NULL DEFAULT 0,
    igst               NUMERIC(14,2) NOT NULL DEFAULT 0,
    cgst               NUMERIC(14,2) NOT NULL DEFAULT 0,
    sgst               NUMERIC(14,2) NOT NULL DEFAULT 0,
    cess               NUMERIC(14,2) NOT NULL DEFAULT 0,
    itc_eligible       TEXT NOT NULL DEFAULT 'eligible',
    match_status       TEXT NOT NULL DEFAULT 'unmatched',
    matched_invoice_id INTEGER,
    source_upload_id   INTEGER,
    created_at         TIMESTAMP NOT NULL DEFAULT NOW()
  )`,

  // Period locks — once a month is closed, writes are blocked
  `CREATE TABLE IF NOT EXISTS period_locks (
    id              SERIAL PRIMARY KEY,
    company_id      INTEGER NOT NULL,
    period_month    TEXT NOT NULL,
    period_year     INTEGER NOT NULL,
    locked          BOOLEAN NOT NULL DEFAULT true,
    locked_by       INTEGER,
    locked_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    locked_reason   TEXT,
    unlocked_by     INTEGER,
    unlocked_at     TIMESTAMP,
    unlock_reason   TEXT,
    UNIQUE(company_id, period_month, period_year)
  )`,

  // Run sign-offs — partner approval of work done
  `CREATE TABLE IF NOT EXISTS run_signoffs (
    id              SERIAL PRIMARY KEY,
    run_id          TEXT NOT NULL,
    company_id      INTEGER NOT NULL,
    signed_by       INTEGER NOT NULL,
    signed_role     TEXT NOT NULL DEFAULT 'reviewer',
    signature_note  TEXT,
    signed_at       TIMESTAMP NOT NULL DEFAULT NOW()
  )`,

  // Indexes
  `CREATE INDEX IF NOT EXISTS idx_journal_entries_company ON journal_entries(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_entries_run ON journal_entries(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_lines_journal ON journal_entry_lines(journal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_gstr2b_company_period ON gstr_2b_records(company_id, return_period)`,
  `CREATE INDEX IF NOT EXISTS idx_gstr2b_gstin_invno ON gstr_2b_records(supplier_gstin, invoice_number)`,
  `CREATE INDEX IF NOT EXISTS idx_period_locks_company ON period_locks(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_signoffs_run ON run_signoffs(run_id)`,
];

let ok = 0, fail = 0;
for (const sql of migrations) {
  try {
    await pool.query(sql);
    console.log("✅", sql.trim().split(/\s+/).slice(0, 6).join(" "), "...");
    ok++;
  } catch (err) {
    console.error("❌", err.message);
    fail++;
  }
}
await pool.end();
console.log(`\nDone: ${ok} ok, ${fail} failed`);
