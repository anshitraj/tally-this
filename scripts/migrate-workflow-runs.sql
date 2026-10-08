-- FinVerify OS: workflow run tables
-- Safe to run more than once. Uses IF NOT EXISTS and non-destructive ALTERs.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workflow_runs (
    id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    company_id       INTEGER NOT NULL,
    month            TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM'),
    year             INTEGER NOT NULL DEFAULT extract(year from now())::int,
    run_type         TEXT NOT NULL DEFAULT 'reconciliation',
    title            TEXT NOT NULL DEFAULT 'Workflow Run',
    status           TEXT NOT NULL DEFAULT 'queued',
    progress_percent INTEGER NOT NULL DEFAULT 0,
    current_step     TEXT,
    steps_json       JSONB DEFAULT '[]'::jsonb,
    created_by       INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ,
    failed_reason    TEXT,
    metadata_json    JSONB DEFAULT '{}'::jsonb
);

ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS created_by INTEGER;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS metadata_json JSONB DEFAULT '{}'::jsonb;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS client_id INTEGER;
ALTER TABLE workflow_runs ALTER COLUMN status SET DEFAULT 'queued';

UPDATE workflow_runs SET status = 'queued' WHERE status = 'pending';
UPDATE workflow_runs SET status = 'completed' WHERE status = 'complete';
UPDATE workflow_runs SET progress_percent = 0 WHERE progress_percent < 0;
UPDATE workflow_runs SET progress_percent = 100 WHERE progress_percent > 100;

ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_status_check
    CHECK (status IN ('queued','running','completed','failed','cancelled'));

ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_progress_percent_check;
ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_progress_percent_check
    CHECK (progress_percent BETWEEN 0 AND 100);

CREATE INDEX IF NOT EXISTS workflow_runs_company_id_idx
    ON workflow_runs (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_sources (
    id          SERIAL PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    upload_id   INTEGER,
    source_type TEXT NOT NULL,
    file_name   TEXT NOT NULL,
    row_count   INTEGER,
    page_count  INTEGER,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_sources_run_id_idx
    ON run_sources (run_id, created_at ASC);

CREATE INDEX IF NOT EXISTS run_sources_upload_id_idx
    ON run_sources (upload_id);

CREATE TABLE IF NOT EXISTS run_artifacts (
    id            SERIAL PRIMARY KEY,
    run_id        TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL,
    title         TEXT NOT NULL,
    storage_key   TEXT,
    json_data     JSONB DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_artifacts_run_id_idx
    ON run_artifacts (run_id, created_at ASC);

ALTER TABLE reconciliation_matches
    ADD COLUMN IF NOT EXISTS run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS reconciliation_matches_run_id_idx
    ON reconciliation_matches (run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS action_history (
    id            SERIAL PRIMARY KEY,
    company_id    INTEGER NOT NULL,
    month         TEXT,
    year          INTEGER,
    run_id        TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    user_id       INTEGER,
    action        TEXT NOT NULL,
    message       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'success',
    metadata_json JSONB DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_history_company_id_idx
    ON action_history (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS action_history_run_id_idx
    ON action_history (run_id, created_at DESC);

CREATE OR REPLACE FUNCTION update_workflow_runs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_runs_updated_at_trigger ON workflow_runs;
CREATE TRIGGER workflow_runs_updated_at_trigger
    BEFORE UPDATE ON workflow_runs
    FOR EACH ROW EXECUTE FUNCTION update_workflow_runs_updated_at();
