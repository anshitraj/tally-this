// Migration: Add Tally audit tables — tally_ledgers, tally_vouchers, tally_voucher_lines, tally_fixed_assets
// Powers the Tax Audit & Ledger Scrutiny module (20 CA checks).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(path.join(__dir, "../../../.env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const pg = (await import("file:///E:/accountant/Asset-Manager/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js")).default;
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const migrations = [
  `CREATE TABLE IF NOT EXISTS tally_ledgers (
    id                SERIAL PRIMARY KEY,
    company_id        INTEGER,
    name              TEXT NOT NULL,
    "group"           TEXT NOT NULL,
    opening_balance   NUMERIC(16,2) NOT NULL DEFAULT 0,
    closing_balance   NUMERIC(16,2) NOT NULL DEFAULT 0,
    prev_year_closing NUMERIC(16,2),
    prev_year_group   TEXT,
    is_msme           BOOLEAN NOT NULL DEFAULT FALSE,
    msme_type         TEXT,
    pan               TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS tally_vouchers (
    id          SERIAL PRIMARY KEY,
    company_id  INTEGER,
    date        TEXT NOT NULL,
    type        TEXT NOT NULL,
    number      TEXT NOT NULL,
    party       TEXT,
    narration   TEXT,
    amount      NUMERIC(16,2) NOT NULL DEFAULT 0,
    mode        TEXT,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS tally_voucher_lines (
    id              SERIAL PRIMARY KEY,
    company_id      INTEGER,
    voucher_number  TEXT NOT NULL,
    ledger          TEXT NOT NULL,
    "group"         TEXT NOT NULL,
    debit           NUMERIC(16,2) NOT NULL DEFAULT 0,
    credit          NUMERIC(16,2) NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS tally_fixed_assets (
    id            SERIAL PRIMARY KEY,
    company_id    INTEGER,
    name          TEXT NOT NULL,
    block         TEXT NOT NULL,
    rate          NUMERIC(6,2) NOT NULL DEFAULT 0,
    opening_wdv   NUMERIC(16,2) NOT NULL DEFAULT 0,
    additions     NUMERIC(16,2) NOT NULL DEFAULT 0,
    addition_date TEXT,
    deletions     NUMERIC(16,2) NOT NULL DEFAULT 0,
    deletion_date TEXT,
    depreciation  NUMERIC(16,2) NOT NULL DEFAULT 0,
    closing_wdv   NUMERIC(16,2) NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS ca_client_links (
    id                SERIAL PRIMARY KEY,
    ca_user_id        INTEGER NOT NULL,
    ca_company_id     INTEGER,
    client_company_id INTEGER NOT NULL,
    client_name       TEXT,
    status            TEXT NOT NULL DEFAULT 'active',
    created_at        TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ca_client_links_user ON ca_client_links(ca_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tally_ledgers_company ON tally_ledgers(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tally_vouchers_company ON tally_vouchers(company_id)`,
  `CREATE TABLE IF NOT EXISTS tally_bills (
    id          SERIAL PRIMARY KEY,
    company_id  INTEGER,
    party       TEXT NOT NULL,
    "group"     TEXT NOT NULL,
    ref         TEXT NOT NULL,
    date        TEXT NOT NULL,
    amount      NUMERIC(16,2) NOT NULL DEFAULT 0,
    type        TEXT NOT NULL DEFAULT 'New Ref'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tally_bills_company ON tally_bills(company_id, party)`,
  `CREATE INDEX IF NOT EXISTS idx_tally_voucher_lines_company ON tally_voucher_lines(company_id, voucher_number)`,
  `CREATE INDEX IF NOT EXISTS idx_tally_fixed_assets_company ON tally_fixed_assets(company_id)`,
];

let ok = 0;
for (const m of migrations) {
  await pool.query(m);
  ok++;
}
console.log(`Tally audit tables migration complete — ${ok} statements applied.`);
await pool.end();
