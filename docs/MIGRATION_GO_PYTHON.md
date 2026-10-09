# FinVerify OS — Go + Python Migration Plan

**Strategy**: Strangler Fig — keep TypeScript backend alive, add Go gateway and Python worker beside it, migrate routes gradually only after parity tests pass. Never delete a TypeScript route until its replacement is verified.

---

## Job routes added on TypeScript

These stay on the TypeScript API until a Go handler is compared against them:

- `POST /api/jobs/bank-statement/normalize`
- `POST /api/jobs/bank-to-tally/xml`
- `POST /api/jobs/bank-tally/compare`
- `POST /api/jobs/runs/:id/decision`
- `POST /api/jobs/runs/:id/report`
- `POST /api/jobs/ecommerce/normalize`
- `POST /api/jobs/ecommerce/gst-json`
- `POST /api/jobs/invoice-bank/compare`

Go already lists workflow runs and progress when `DATABASE_URL` is set, and proxies these job routes to TypeScript.

Python adds `POST /extract/marketplace`. Bank CSV/PDF parsing still falls back to TypeScript when the worker is not running.

---

## Runtime / Port Map

| Service | Language | Port | Status |
|---|---|---|---|
| React/Vite frontend | TypeScript | 5173 | ✅ unchanged |
| TypeScript API fallback | Node/Express | 8080 | ✅ running |
| Go API gateway | Go | 8090 | 🔲 skeleton ready, not running |
| Python extraction worker | Python/FastAPI | 8091 | 🔲 skeleton ready, not running |

Env vars:
```
TYPESCRIPT_API_URL=http://localhost:8080
GO_API_PORT=8090
PYTHON_WORKER_URL=http://localhost:8091
```

---

## Current TypeScript Routes (full inventory)

### Auth
- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/demo`
- `POST /api/auth/logout`
- `GET  /api/auth/me`
- `GET  /api/auth/providers`
- `GET  /api/auth/google` / `/api/auth/google/callback`
- `GET  /api/auth/github` / `/api/auth/github/callback`

### Company / Workspace
- `GET  /api/company`
- `GET  /api/users`
- `GET  /api/roles`
- `POST /api/roles/backfill`

### Uploads
- `GET  /api/uploads`
- `POST /api/uploads`
- `DELETE /api/uploads/:id`
- `GET  /api/uploads/:id/details`
- `POST /api/uploads/:id/reprocess`
- `POST /api/uploads/:id/reparse`
- `POST /api/uploads/import-all-parsed`
- `POST /api/uploads/import-selected-sources`
- `GET  /api/uploads/files/:key`

### Workflow
- `GET  /api/monthly-close/current/workflow`
- `GET  /api/workflow/current-month` (alias)

### Reconciliation
- `GET  /api/reconciliation`
- `GET  /api/reconciliation/run` (GET alias)
- `POST /api/reconciliation/run`
- `POST /api/reconciliation/preflight`
- `POST /api/reconciliation/finalize`
- `POST /api/reconciliation/:id/approve`
- `POST /api/reconciliation/:id/reject`
- `POST /api/reconciliation/:id/needs-info`
- `POST /api/reconciliation/:id/send-to-ca`
- `POST /api/reconciliation/approve` (body-id alias)
- `POST /api/reconciliation/reject` (body-id alias)

### Financial Records
- `GET  /api/transactions`
- `PATCH /api/transactions/:id/status`
- `GET  /api/invoices`
- `POST /api/invoices`
- `GET  /api/invoices/extractions/pending`
- `POST /api/invoices/extract-batch`
- `POST /api/invoices/extractions/bulk-action`
- `GET  /api/ledger`
- `GET  /api/ledger-entries` (alias)
- `GET  /api/ledger/summary`
- `GET  /api/payroll`
- `POST /api/payroll/match`
- `GET  /api/gateway-settlements`
- `POST /api/gateway-settlements/match`
- `GET  /api/gst-records`
- `POST /api/gst-tds-review/generate`

### Risk / Exceptions / CA
- `GET  /api/risks`
- `PATCH /api/risks/:id/status`
- `GET  /api/exceptions`
- `POST /api/exceptions/:id/resolve`
- `POST /api/exceptions/:id/dismiss`
- `POST /api/exceptions/:id/send-to-ca-review`
- `GET  /api/ca-review`
- `POST /api/ca-review/:id/action`
- `GET  /api/document-requests`
- `POST /api/document-requests`
- `POST /api/document-requests/:id/resolve`

### AI
- `GET  /api/ai/status`
- `POST /api/ai/extract-invoice`
- `PATCH /api/ai/extractions/:id/edit`
- `POST /api/ai/extractions/:id/accept`
- `POST /api/ai/extractions/:id/reject`
- `POST /api/ai/extract-invoice-text`
- `POST /api/ai/interpret-bank-narration`
- `POST /api/ai/suggest-ledger`
- `POST /api/ai/explain-risk`
- `POST /api/ai/month-end-summary`
- `POST /api/ai/suggest-column-mapping`

### Reports
- `GET  /api/reports/summary`
- `GET  /api/reports/export-csv`
- `POST /api/reports/export-ca-pack`

### Documents / Storage
- `GET  /api/documents`
- `DELETE /api/documents/:id`

### Platform
- `GET  /api/overview`
- `GET  /api/action-history`
- `GET  /api/audit-logs`
- `GET  /api/security/posture`

### Health
- `GET  /api/health`
- `GET  /api/healthz`

### Dev / Demo
- `POST /api/auth/demo`
- `POST /api/demo/seed`
- `POST /api/dev/test-ai`
- `POST /api/dev/test-ai-extraction`

---

## Phase 1 — DONE: Contract Discovery

Status: **Complete**
- All 70+ TypeScript routes inventoried above.
- Frontend API calls catalogued.
- Schema tables documented below.

---

## Phase 2 — DB Tables (workflow run isolation)

Tables to add via SQL migration (not Drizzle push to avoid conflicts):

### `workflow_runs`
```sql
CREATE TABLE IF NOT EXISTS workflow_runs (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id  INTEGER NOT NULL REFERENCES companies(id),
  month       TEXT NOT NULL,
  year        INTEGER NOT NULL,
  run_type    TEXT NOT NULL,  -- bank_tally_reconciliation | bank_invoice_reconciliation | gst_tds_review | full_month_close | ...
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued', -- queued | running | completed | failed | cancelled
  progress_percent INTEGER NOT NULL DEFAULT 0,
  current_step     TEXT,
  steps_json       JSONB,
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  failed_reason TEXT,
  metadata_json JSONB
);
```

### `run_sources`
```sql
CREATE TABLE IF NOT EXISTS run_sources (
  id          SERIAL PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES workflow_runs(id),
  upload_id   INTEGER REFERENCES upload_batches(id),
  source_type TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  row_count   INTEGER,
  page_count  INTEGER,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | parsed | imported | failed
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### `run_artifacts`
```sql
CREATE TABLE IF NOT EXISTS run_artifacts (
  id            SERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES workflow_runs(id),
  artifact_type TEXT NOT NULL,  -- reconciliation_report | gst_review_pack | ca_pack | import_summary | ...
  title         TEXT NOT NULL,
  storage_key   TEXT,
  json_data     JSONB,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### Upgrade `action_history`
Current audit_logs table covers this. Add explicit action_history view/table:
```sql
CREATE TABLE IF NOT EXISTS action_history (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL,
  month       TEXT,
  year        INTEGER,
  run_id      TEXT REFERENCES workflow_runs(id),
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'success',
  metadata_json JSONB,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
```

---

## Route Migration Plan

### Migrated to Go (Phase 4+)
| Route | Go Status | Notes |
|---|---|---|
| `GET /api/health` | 🔲 skeleton | Shows all service statuses |
| `GET /api/workflow/runs` | 🔲 skeleton | workflow_runs table |
| `GET /api/workflow/runs/:id` | 🔲 skeleton | run detail |
| `GET /api/workflow/runs/:id/progress` | 🔲 skeleton | polling progress |
| `GET /api/action-history` | 🔲 proxy → TS | |
| `POST /api/uploads/:id/parse` | 🔲 skeleton | calls Python worker |
| `POST /api/uploads/import-selected-sources` | 🔲 proxy → TS then migrate | |
| `POST /api/reconciliation/preflight` | 🔲 proxy → TS then migrate | |
| `POST /api/reconciliation/run` | 🔲 proxy → TS then migrate | |
| `POST /api/reports/export-ca-pack` | 🔲 proxy → TS then migrate | |

### Stays in TypeScript (fallback, proxy from Go)
All other routes proxied from Go → TypeScript until verified.

### Planned for Python Worker
| Endpoint | Python Status |
|---|---|
| `POST /parse/csv` | 🔲 skeleton |
| `POST /parse/excel` | 🔲 skeleton |
| `POST /parse/pdf-text` | 🔲 skeleton |
| `POST /parse/pdf-table` | 🔲 skeleton |
| `POST /extract/bank-statement` | 🔲 skeleton |
| `POST /extract/tally-ledger` | 🔲 skeleton |
| `POST /extract/gateway-statement` | 🔲 skeleton |
| `POST /extract/invoice` | 🔲 skeleton |
| `POST /extract/gst-tds` | 🔲 skeleton |
| `POST /extract/payroll` | 🔲 skeleton |

---

## Run Commands

```bash
# TypeScript fallback (current, working)
cd E:\accountant\Asset-Manager
PORT=8080 node backend/api/dist/index.mjs

# Frontend dev
pnpm --filter @workspace/finverify-os run dev

# Python worker (after pip install)
cd backend/worker
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8091

# Go API (after go install)
cd backend/gateway
go run ./cmd/api

# All at once (future docker-compose)
docker-compose up
```

---

## Known Bugs Being Fixed in TypeScript (Parallel to Migration)

1. **CSV blank fields** — `value()` now has 2-pass substring match. Fixed in `uploadIngestion.ts`.
2. **Excel header row detection** — Scans first 20 rows for financial-keyword score. Fixed in `fileParser.ts`.
3. **PDF extraction** — Hybrid 3-stage pipeline (bank patterns → generic rules → AI Gemini). Fixed in `pdfTableExtractor.ts`.
4. **Reconciliation matches not returned** — `importedSet` and `importedRows` fixed in workflow recipe service.
5. **PDF blocked for non-invoice sources** — Hard reject at upload route with actionable message.

---

## Known Limitations

- Go service: skeleton only, not running yet (Go not installed on this machine).
- Python worker: skeleton only, FastAPI/uvicorn not installed yet.
- Run isolation (workflow_runs table): DB migration script created, NOT applied yet.
- Progress polling: not yet wired to frontend — frontend still uses mock animation.
- Go proxy to TypeScript: wired in code but not tested end-to-end.
- SSE not implemented — polling only.
- `run_id` on financial rows not added to all tables yet.
- CA review queue not yet linked to run_id.
