# FinVerify OS — Final Architecture

## Service Topology

```
┌────────────────┐   :5173                  ┌─────────────────┐
│  React/Vite    │──────────────────────────│  Go API Gateway │  :8090
│  Frontend      │   /api/* (Vite proxy)    │  (PRIMARY)      │
└────────────────┘                          └────────┬────────┘
                                                     │
                              ┌──────────────────────┼──────────────────────┐
                              │                                             │
                              ▼ Migrated routes        ▼ Fallback proxy ▼ Worker calls
                  ┌─────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
                  │ Go-native routes    │  │ TypeScript API     │  │ Python Worker      │
                  │ - /api/health       │  │ (FALLBACK ONLY)    │  │ (EXTRACTION ONLY)  │
                  │ - /api/workflow/runs│  │ All other routes   │  │ Parse + extract    │
                  │                     │  │ :8080              │  │ :8091              │
                  └─────────────────────┘  └────────────────────┘  └────────────────────┘
                                                     │                       │
                                                     ▼                       │
                                            ┌────────────────┐               │
                                            │  Neon Postgres │◀──────────────┘
                                            │  (source       │
                                            │   of truth)    │
                                            └────────────────┘
```

## Migration State — Honest

| Layer | Status | Notes |
|---|---|---|
| **Frontend → Go** | ✅ primary | Vite dev proxy `:5173 → :8090`. Production: nginx in `frontend/Dockerfile` proxies `/api/` → `http://go-api:8090` |
| **Go gateway** | ✅ live | `backend/gateway/` — `chi` router + `httputil.ReverseProxy` with cancel-error suppression |
| **Python worker** | ✅ live, primary parser | TypeScript `POST /api/uploads` calls Python `/extract/{source}` first; falls back to TS in-process parser if worker unreachable |
| **TypeScript API** | ✅ fallback only | All routes still exist (Go proxies to TS). Internally still does ingest + DB writes + AI extraction. **NOT removed.** |
| **Postgres (Neon)** | ✅ source of truth | `workflow_runs`, `run_sources`, `run_artifacts`, `action_history` tables live |

## Routes by service

### Go-native (no TS round-trip)
- `GET /api/health` — aggregate health of all 3 services
- `GET /api/workflow/runs` — list workflow runs (via Go DB)
- `GET /api/workflow/runs/:id/progress` — poll progress
- `GET /api/workflow/runs/suggest-name?runType=...` — auto-suggest "{recipe} #N"
- `PATCH /api/workflow/runs/:id` — rename workspace

### Proxied via Go → TS (transparent)
All ~70 other routes. Frontend never knows the difference.

### Python worker (CSV/Excel/PDF parsing)
- `POST /parse/csv`, `/parse/excel`, `/parse/pdf-text`, `/parse/pdf-table`
- `POST /extract/bank-statement`, `/extract/tally-ledger`, `/extract/gateway-statement`, `/extract/invoice`, `/extract/gst-tds`, `/extract/payroll`, `/extract/expense`

## How frontend reaches Go

`vite.config.ts`:
```ts
server: { proxy: { "/api": "http://localhost:8090" } }
```

Production: `frontend/Dockerfile` ships nginx with:
```
location /api/ { proxy_pass http://go-api:8090; }
```

## Run commands

```bash
# Python worker (port 8091)
cd backend/worker
python3 -m uvicorn app.main:app --port 8091

# TypeScript API fallback (port 8080)
PORT=8080 PYTHON_WORKER_URL=http://localhost:8091 \
  node backend/api/dist/index.mjs

# Go gateway (port 8090) — frontend talks to this
cd backend/gateway
GO_API_PORT=8090 \
TYPESCRIPT_API_URL=http://localhost:8080 \
PYTHON_WORKER_URL=http://localhost:8091 \
  ./api-go.exe

# Frontend dev (port 5173)
pnpm --filter @workspace/finverify-os run dev
```

Or all at once: `docker-compose up`.

## Workspace folders (NEW)

Every "Generate Report" creates a `workflow_runs` row with a user-named title.
- Default name: `{Recipe Title} #N` (e.g. "Bank + Tally reconciliation #3")
- Custom name: user edits in modal before clicking Generate
- Active workspace badge in app shell top bar
- Reconciliation / Ledger Match / Reports pages filter by active workspace
- Selection persisted in `localStorage`

No more "all data jumbled together" — each run is its own folder.
