# FinVerify OS Migration Route Ownership

Last audited: 2026-06-02

This map tracks the Strangler-style Go + Python migration. "TypeScript fallback" means the React app reaches the Go gateway first, but Go proxies the route to the existing Express API. Do not retire a fallback route until the Go/Python route has passed frontend contract, backend integration, and manual workflow tests.

## Ownership Summary

| Route | Current owner | Target owner | Frontend caller file(s) | Request payload | Response payload | Migration status | Test status | Notes |
|---|---|---|---|---|---|---|---|---|
| `GET /api/health` | Go | Go | `src/components/app/HealthWidget.tsx` | None | Aggregate service health: Go, TypeScript fallback, Python worker, DB, latency | Migrated | Partially tested manually | Go probe currently can time out on slow TypeScript health even when `:8080` responds directly. |
| `GET /api/healthz` | Go | Go | Generated client `healthCheck`, occasional direct health checks | None | Same aggregate service health | Migrated | Not fully contract-tested | Go owns route; TypeScript fallback also has a healthz implementation. |
| `GET /api/uploads` | TypeScript fallback | Go | `src/pages/app/uploads.tsx`, `src/components/uploads/CurrentUploadedFiles.tsx`, generated client | Optional `runId` query | `UploadBatch[]` | Not migrated | Fallback only | Must preserve upload list filtering and removed-upload hiding. |
| `POST /api/uploads` | TypeScript fallback, with Python CSV/Excel delegation | Go + Python | `src/pages/app/uploads.tsx`, generated client | Multipart file, `sourceType`, optional AI/extraction flags | `UploadBatch` plus parse/import metadata in current TS response | Not migrated | Fallback only | TypeScript stores metadata, calls `fileParser.ts`, may delegate CSV/Excel to Python first. |
| `POST /api/uploads/:id/parse` | Not implemented as explicit route | Go + Python | No current direct caller found | Upload id, optional run id | Parse summary, run id, warnings | Missing route | Not tested | Current app uses upload create/reparse/reprocess instead. Add only after contract is defined. |
| `POST /api/uploads/:id/reparse` | TypeScript fallback | Go + Python | No current direct caller found in app pages | URL id | Updated upload/document parse metadata | Not migrated | Fallback only | Current TS route re-downloads stored file and reparses using `fileParser.ts`. |
| `POST /api/uploads/:id/reprocess` | TypeScript fallback | Go + Python | `src/components/uploads/CurrentUploadedFiles.tsx` | URL id | PDF/table reprocess result with rows/notes | Not migrated | Fallback only | Existing frontend uses `reprocess`, not `parse`. Keep alias behavior clear. |
| `POST /api/uploads/import-selected-sources` | TypeScript fallback | Go | `src/components/uploads/SmartNextStepPanel.tsx` | `{ sourceTypes: string[], recipeId?, runId?, month? }` | Import counts, skipped counts, errors, `runId` | Not migrated | Fallback only | TS creates workflow run and imports all matching selected parsed uploads, not strict run-scoped yet. |
| `POST /api/uploads/import-all-parsed` | TypeScript fallback | Go | `src/components/uploads/SmartNextStepPanel.tsx` | Optional workflow metadata | Import counts, skipped counts, errors, `runId` | Not migrated | Fallback only | Used for full-month-close action. Must avoid mixing old unrelated uploads after migration. |
| `GET /api/monthly-close/current/workflow` | TypeScript fallback | Go | `src/components/uploads/SmartNextStepPanel.tsx` | None | Workflow recommendation, sources, counts, action history | Not migrated | Fallback only | Go does not yet own the current-month recipe summary. |
| `GET /api/workflow/current-month` | TypeScript fallback | Go | No current direct caller found | None | Same as current workflow summary | Not migrated | Fallback only | Alias for compatibility. |
| `GET /api/workflow/runs` | Go | Go | No current direct caller found | Optional auth/company context | `WorkflowRun[]` | Migrated skeleton | Not fully tested | Go owns list route when DB is configured. |
| `GET /api/workflow/runs/:id` | Go | Go | No current direct caller found | URL run id | Workflow run detail with `sources` and `artifacts` arrays when tables exist | Migrated skeleton | Go build passed; runtime auth/DB not fully tested | Added in Go. Sources/artifacts degrade to empty arrays if those tables are absent. |
| `GET /api/workflow/runs/:id/progress` | Go | Go | `src/components/workflow/AgentProgressPanel.tsx` | URL run id | `{ runId, status, progressPercent, currentStep, steps }` | Migrated skeleton | Go build passed; runtime auth/DB not fully tested | Go response shape matches frontend progress panel; status/progress are normalized to frontend-safe values. |
| `GET /api/action-history` | Go, with audit-log fallback | Go | `src/components/workflow/ActionHistory.tsx`, `SmartNextStepPanel.tsx` invalidates query | Optional `limit` query | Action items with `id`, `label`, `description`, `actorEmail`, `createdAt`, metadata | Migrated skeleton | Go build passed; runtime auth/DB not fully tested | Go prefers `action_history` if populated, then falls back to `audit_logs` to preserve current UI behavior. |
| `POST /api/reconciliation/preflight` | TypeScript fallback | Go | `src/components/uploads/SmartNextStepPanel.tsx` | `{ recipeId }` | `{ canRun, blockers, warnings, availableSources, matchingOptions, estimatedOutputPage }` | Not migrated | Fallback only | Recipe-specific blockers exist in TS and must be preserved. |
| `POST /api/reconciliation/run` | TypeScript fallback | Go | `src/components/uploads/SmartNextStepPanel.tsx`, `src/pages/app/reconciliation.tsx`, generated client | Optional `{ recipeId, options }` | Run result, `matchesFound`, message, `runId` | Not migrated | Fallback only | TS currently calls shared deterministic matching; Go must preserve rule-first behavior. |
| `GET /api/reconciliation` | TypeScript fallback | Go | `src/pages/app/reconciliation.tsx`, generated client | Optional `status`, `runId` query | `ReconciliationMatch[]` | Not migrated | Fallback only | TS attempts run filtering through `run_sources`; table may not exist in older DBs. |
| `POST /api/reconciliation/matches/:id/approve` | Missing alias | Go | No current direct caller found | URL id | Updated match | Missing route | Not tested | Frontend currently calls `/api/reconciliation/:id/approve`. Add alias only with compatibility tests. |
| `POST /api/reconciliation/:id/approve` | TypeScript fallback | Go | `src/pages/app/reconciliation.tsx`, generated client | URL id | Updated match | Not migrated | Fallback only | Existing canonical route in frontend today. |
| `POST /api/reconciliation/matches/:id/reject` | Missing alias | Go | No current direct caller found | URL id | Updated match | Missing route | Not tested | Frontend currently calls `/api/reconciliation/:id/reject`. |
| `POST /api/reconciliation/:id/reject` | TypeScript fallback | Go | `src/pages/app/reconciliation.tsx`, generated client | URL id | Updated match | Not migrated | Fallback only | Existing canonical route in frontend today. |
| `POST /api/reconciliation/matches/:id/needs-info` | Missing alias | Go | No current direct caller found | URL id, optional note | Updated match | Missing route | Not tested | Frontend currently calls `/api/reconciliation/:id/needs-info`. |
| `POST /api/reconciliation/:id/needs-info` | TypeScript fallback | Go | `src/pages/app/reconciliation.tsx` | URL id, optional note | Updated match | Not migrated | Fallback only | Uses status `needs_info`. |
| `POST /api/reconciliation/:id/send-to-ca` | TypeScript fallback | Go | `src/pages/app/reconciliation.tsx` | URL id, optional note | `{ ok, caReviewItemId, matchId }` | Not migrated | Fallback only | Target route name in brief is `send-to-ca-review`; keep frontend alias. |
| `POST /api/invoices/extract-batch` | TypeScript fallback, AI optional | Go orchestrator + Python extraction where applicable | `src/components/uploads/SmartNextStepPanel.tsx` | None | `{ processed, skipped, message }` | Not migrated | Fallback only | Must keep AI optional and schema-validated. |
| `GET /api/invoices/extractions/pending` | TypeScript fallback | Go | `src/components/invoices/InvoiceExtractionReviewPanel.tsx` | None | Pending extraction review items | Not migrated | Fallback only | Review UI depends on current shape. |
| `POST /api/invoices/extractions/bulk-action` | TypeScript fallback | Go | `src/components/invoices/InvoiceExtractionReviewPanel.tsx` | Bulk action body | Bulk action result | Not migrated | Fallback only | Keep review semantics: AI extracted, pending review. |
| `POST /api/gst-tds-review/generate` | TypeScript fallback | Go | `src/components/uploads/SmartNextStepPanel.tsx` | None | GST/TDS review result | Not migrated | Fallback only | Must use "Potential risk - needs CA review" language when using ASCII docs; UI copy should preserve product wording. |
| `GET /api/payroll` | TypeScript fallback | Go | `src/pages/app/payroll.tsx`, generated client | None | `PayrollEntry[]` | Not migrated | Fallback only | Read route remains TS. |
| `POST /api/payroll/match` | TypeScript fallback | Go | `src/components/uploads/SmartNextStepPanel.tsx` | None | Payroll match result, exceptions | Not migrated | Fallback only | Deterministic matching only. |
| `GET /api/gateway-settlements` | TypeScript fallback | Go | `src/pages/app/gateway-settlements.tsx`, generated client | None | `GatewaySettlement[]` | Not migrated | Fallback only | Read route remains TS. |
| `POST /api/gateway-settlements/match` | TypeScript fallback | Go | `src/components/uploads/SmartNextStepPanel.tsx` | None | Gateway match result, exceptions | Not migrated | Fallback only | Deterministic matching only. |
| `GET /api/reports/summary` | TypeScript fallback | Go | `src/pages/app/reports.tsx`, generated client | None | Report summary | Not migrated | Fallback only | Used by reports page. |
| `GET /api/reports/export-csv` | TypeScript fallback | Go | `src/pages/app/reports.tsx`, generated client | `type`, optional `store` query | CSV/export result | Not migrated | Fallback only | Keep response compatible with generated client. |
| `POST /api/reports/export-ca-pack` | TypeScript fallback | Go | `src/pages/app/reports.tsx`, `src/pages/app/reconciliation.tsx` | Optional format/body | CA pack export result or PDF payload metadata | Not migrated | Fallback only | Target for Go report orchestration. |
| `GET /api/ca-review` | TypeScript fallback | Go | `src/pages/app/ca-review.tsx`, generated client | None | `CaReviewItem[]` | Not migrated | Fallback only | Reports route file owns this in TS. |
| `POST /api/ca-review/:id/action` | TypeScript fallback | Go | `src/pages/app/ca-review.tsx`, generated client | `{ action, note? }` | Updated CA review item | Not migrated | Fallback only | Keep CA review language careful; no certainty claims. |
| `GET /api/document-requests` | TypeScript fallback | Go | No current direct caller found | None | Document request items | Not migrated | Fallback only | TS route lives in `exceptions.ts`. |
| `POST /api/document-requests` | TypeScript fallback | Go | No current direct caller found | Request details | Created document request | Not migrated | Fallback only | Used by future CA review/request-document flows. |
| `POST /api/document-requests/:id/resolve` | TypeScript fallback | Go | No current direct caller found | URL id | Resolved request | Not migrated | Fallback only | Used by future request closeout. |

## Python Worker Ownership

Python currently exposes parsing/extraction endpoints, including `/parse/csv`, `/parse/excel`, `/parse/pdf-text`, `/parse/pdf-table`, and source-specific `/extract/*` routes. Active upload parsing still enters through TypeScript, which tries Python first for CSV/Excel and falls back to TypeScript parsers if Python fails. Target ownership is Python for extraction and normalization, with Go handling request auth, DB writes, run progress, and orchestration.

## DB Migration Notes

The migration brief requires `workflow_runs`, `run_sources`, `run_artifacts`, and `action_history`.

Current checked-in state after this migration slice:

- `workflow_runs`, `run_sources`, `run_artifacts`, and `action_history` are created by `lib/db/migrations/0002_workflow_tables.sql`, applied with `pnpm --filter @workspace/db run migrate` (the one migration path; see [DEPLOYMENT.md](DEPLOYMENT.md)). The older `scripts/migrate-workflow-runs.sql` and the root `migrate.py` that reads it are superseded; `migrate.py` reads a `.env` file, which on this project has held the production address, so do not run it.
- `run_sources` and `run_artifacts` are still written from TypeScript fallback import/reconciliation flows until those routes move to Go.
- Go `/api/action-history` can read the dedicated `action_history` table but falls back to `audit_logs` because current TypeScript flows still write audit logs.
- Status naming is normalized toward `queued`/`running`/`completed`/`failed`/`cancelled`; Go maps older `pending`/`complete` rows for frontend compatibility.

## Safe Retirement Rule

A route can be marked `safe_to_disable_typescript_fallback = true` only after:

- The Go/Python implementation is the actual handler behind the Go gateway.
- The frontend caller receives the same contract it already expects, or the frontend has been intentionally updated.
- Backend integration tests cover success and failure paths.
- A manual upload/import/reconciliation/report flow passes with the May 2026 bank and Tally test files.
- Unmigrated routes still proxy cleanly to TypeScript fallback.
