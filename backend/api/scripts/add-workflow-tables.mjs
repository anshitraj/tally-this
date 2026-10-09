// Migration: Add workflow_runs, run_sources, run_artifacts, action_history tables
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
  // workflow_runs — every major action belongs to a run, enabling isolation
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    company_id        INTEGER NOT NULL,
    month             TEXT NOT NULL DEFAULT '',
    year              INTEGER NOT NULL DEFAULT 0,
    run_type          TEXT NOT NULL,
    title             TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'queued',
    progress_percent  INTEGER NOT NULL DEFAULT 0,
    current_step      TEXT,
    steps_json        JSONB,
    created_by        INTEGER,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMP,
    failed_reason     TEXT,
    metadata_json     JSONB
  )`,

  // run_sources — which upload files belong to this run
  `CREATE TABLE IF NOT EXISTS run_sources (
    id          SERIAL PRIMARY KEY,
    run_id      TEXT NOT NULL,
    upload_id   INTEGER,
    source_type TEXT NOT NULL,
    file_name   TEXT NOT NULL DEFAULT '',
    row_count   INTEGER,
    page_count  INTEGER,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
  )`,

  // run_artifacts — outputs saved under a run (reports, summaries, exports)
  `CREATE TABLE IF NOT EXISTS run_artifacts (
    id            SERIAL PRIMARY KEY,
    run_id        TEXT NOT NULL,
    artifact_type TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    storage_key   TEXT,
    json_data     JSONB,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  )`,

  // action_history — explicit user-facing workflow event log (separate from audit_logs)
  `CREATE TABLE IF NOT EXISTS action_history (
    id            SERIAL PRIMARY KEY,
    company_id    INTEGER NOT NULL,
    month         TEXT,
    year          INTEGER,
    run_id        TEXT,
    user_id       INTEGER,
    action        TEXT NOT NULL,
    message       TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'success',
    metadata_json JSONB,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  )`,

  // Indexes for fast per-company/per-run lookups
  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_company_id ON workflow_runs(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_run_sources_run_id ON run_sources(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_run_artifacts_run_id ON run_artifacts(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_action_history_company_id ON action_history(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_action_history_run_id ON action_history(run_id)`,
];

let ok = 0;
let fail = 0;
for (const sql of migrations) {
  try {
    await pool.query(sql);
    const label = sql.trim().split(/\s+/).slice(0, 6).join(" ");
    console.log(`✅ ${label}...`);
    ok++;
  } catch (err) {
    console.error(`❌ ${err.message}`);
    fail++;
  }
}

await pool.end();
console.log(`\nDone: ${ok} ok, ${fail} failed`);
