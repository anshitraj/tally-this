# TallyThis

Deployment: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. Frontend source is in
**`frontend/`** (Vercel Root Directory); Railway services are in **`backend/api/`**,
**`backend/gateway/`** and **`backend/worker/`**. Shared Neon database schema and
API types remain in `lib/`. Set `BACKEND_ORIGIN` in Vercel to connect the public
Railway gateway. Existing Vercel projects must update their old Root Directory.

Support: [contact@tallythis.xyz](mailto:contact@tallythis.xyz). Website domain is pending confirmation (`tally.xyz` versus `tallythis.xyz`); no production DNS or mail service has been provisioned by these code changes.

Production launch requirements and the code audit are in [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md). Brand changes preserve the existing package names, database schemas and browser storage keys for compatibility.

TallyThis is accounting automation for CAs, accountants, and finance teams.

> Upload. Verify. Export.

Upload a bank statement, Tally export, marketplace report, invoice register, or invoice PDFs. TallyThis works out what the file is (bank, marketplace, file type), normalizes it, shows only what needs a person, and exports Tally XML, CSV, Excel working copies, or a draft GST JSON. Most choices are pick-from-a-list; an unlisted statement bank can be entered manually. It does not file returns and it does not replace a CA.

## What you use first

- Bank Statement → Tally
- Bank ↔ Tally
- E-commerce GST
- Invoice ↔ Bank
- Clients, Reports, Activity, Settings
- Advanced keeps the older upload center, tax audit, payroll, gateway, and CA review screens

Workflow details: [`docs/PRODUCT_WORKFLOWS.md`](docs/PRODUCT_WORKFLOWS.md). Service split: [`docs/MIGRATION_GO_PYTHON.md`](docs/MIGRATION_GO_PYTHON.md).

Public Repotic workflow comparison and remaining gaps: [`docs/REPOTIC_COMPARISON.md`](docs/REPOTIC_COMPARISON.md).

## Interface and product walkthroughs

The landing page and workspace share a forest green and white visual system, a custom TallyThis wordmark and T/check symbol, and responsive layouts. The main navigation shows Clients, Bank → Tally, Bank ↔ Tally, E-commerce GST, Invoice ↔ Bank, Reports and Activity. The logo opens the workspace home; History, Settings and specialist pages remain under Advanced. Reports links directly to saved job outputs, offers a CA review PDF, and keeps individual reports under More options.

Landing and sign-in animations are **illustrative sample walkthroughs**, implemented as local UI timelines with typing, row checks, review choices and export states. They do not run parsers, upload sample files or create accounting records. They pause offscreen or in background tabs, have pause/replay controls, and show a static completed illustration when reduced motion is requested. Real file uploads continue into the existing accounting jobs, including files selected before sign-in.

Bank logos identify uploaded statement sources, not bank connections or partnerships. Asset sources are recorded in [`public/brands/SOURCES.md`](frontend/public/brands/SOURCES.md).

UI regression checks (with browser-only API fixtures; the running frontend defaults to port 21950):

```powershell
$env:BASE_URL = 'http://localhost:21950'
pnpm --filter @workspace/finverify-os exec playwright test e2e/refresh.spec.ts --output=../../tmp/ui-refresh-tests
```

## Current Implementation

- Frontend: React, TypeScript, Vite, TailwindCSS, shadcn-style components, Framer Motion, Lucide icons, Recharts, wouter.
- Backend: Node.js, Express, TypeScript, Drizzle ORM.
- Database: PostgreSQL through `DATABASE_URL`.
- Workspace: pnpm monorepo with generated API/Zod packages.
- Matching: rules-first service in `backend/api/src/services/matchingEngine.ts`.
- Platform data store: companies, users/roles, document metadata, GST/TDS records, audit logs, finance records, reconciliation matches, and risk flags.
- New workspaces are database-backed and start empty until users upload or import records.

## System Architecture

The canonical high-level architecture is documented in [`ARCHITECTURE.md`](./ARCHITECTURE.md). It follows the upload-based TallyThis flow: React/Vite frontend, Express `/api/*`, validation, audit logging, Neon/Postgres, optional private R2 file storage, parser/extractor, rules-first matching, reports, risk engine, CA review queue, and optional server-side AI extraction with schema validation and human review.

## What Is Real

- Navigable SaaS prototype with landing page, database-backed auth, app shell, dashboard, uploads, transactions, invoices, ledger matching, reconciliation, GST/TDS risk flags, payroll, gateway settlements, CA review, reports, integrations, settings, and docs.
- **Month Close Command Center**: guided workflow on the Upload Center that determines current state and drives the user through the close sequence (import → extract → review → reconcile → exceptions → CA review → export).
- **Route registry** (`src/lib/routes.ts`): all app routes defined in one place; `/app/ledger`, `/app/risks`, `/app/gateway`, `/app/review` redirect to canonical routes.
- **Import All Parsed Files** (`POST /api/uploads/import-all-parsed`): batch re-import for all parsed upload batches with per-source row counts.
- **Reconciliation Preflight** (`POST /api/reconciliation/preflight`): checks available data, returns blockers, warnings, and matching options before running reconciliation.
- **Invoice Batch Extraction** (`POST /api/invoices/extract-batch`, `GET /api/invoices/extractions/pending`, `POST /api/invoices/extractions/bulk-action`): AI extraction for all pending invoice PDFs in one action.
- **GST/TDS Review Generate** (`POST /api/gst-tds-review/generate`): creates risk flags and exceptions for unmatched GST records.
- **Payroll Match** (`POST /api/payroll/match`): runs payroll-to-bank matching and creates exceptions for mismatches.
- **Gateway Match** (`POST /api/gateway-settlements/match`): runs gateway-to-bank matching and creates exceptions for mismatches.
- **Exceptions and Document Requests** (`GET/POST /api/exceptions`, resolve, dismiss, send-to-ca-review; `GET/POST /api/document-requests`, resolve).
- **CA Pack Export** (`POST /api/reports/export-ca-pack`): generates full CA-ready pack with blockers check.
- **Docs page** (`/app/docs`): in-app documentation covering workflow, upload flow, AI rules, reconciliation, and limitations.
- Rule-based matching functions for bank-to-invoice, bank-to-ledger, duplicate detection, partial/split payments, gateway settlement checks, payroll checks, and risk flag generation.
- CSV export flow for transactions, invoices, risks, payroll, and report data.
- Server-side CSV, Excel, and PDF parsing for row counts, detected columns, sheet/page metadata, text previews, and audit logging.
- Production-style auth foundation: hashed passwords, signed bearer tokens, revocable database sessions, route permissions, and company-scoped queries.
- Object storage abstraction for raw uploads and stored exports using metadata-only mode by default or S3/R2/GCS-compatible storage when configured.
- Optional server-side AI provider layer with Gemini primary, Claude (Anthropic) as last-resort fallback, NVIDIA optional, OpenRouter disabled by default, strict JSON validation, usage logging, and rule-based fallback.
- Bank statement PDFs are read by column position (`services/pdfStatement.ts`): each amount is taken from the Withdrawal, Deposit or Balance column it sits under, and every row is proved against the bank's printed running balance (previous balance + deposit − withdrawal = balance), plus the printed opening/closing balance and row numbers when present. The bank is identified from the IFSC printed in the header (`services/bankDirectory.ts`). Password-protected PDFs are detected in the browser and the password is asked for before upload; it is used only to open the file.
- Scanned statements, photos, and statements the table reader cannot fully prove are read a second time by Gemini, then Claude only if every Gemini model fails (locked PDFs are sent as page images). Each AI answer is scored by the same running-balance proof; a fully proved answer is used, otherwise the next model is tried. Invoice PDFs are read the same way and stay "AI extracted — pending review".
- History (`/app/history`): the last `HISTORY_MONTHS` months (default 3) of jobs the workspace has run, newest first, with who ran it. Search by file name, filter by job, open an item to see the saved result and download the Tally file, CSV, report or GST draft again. Backed by `GET /api/jobs/history` and `/api/jobs/history/:id`, scoped to the active client. Older items are never deleted: they stay in the database, the page says how many are waiting and asks the person to email `SUPPORT_EMAIL`, and opening one directly returns 403 `outside_window` with the same message. Original uploaded files are not kept by the four jobs; only what was read from them is.
- Incognito (paid plans only, backed by the existing privacy flag): a Normal / Incognito segmented control sits above uploads on Home and all four core jobs. Incognito has a hat-and-glasses icon and switches only the app workspace to charcoal, with a subtle background grid; landing and login pages remain unchanged. Free accounts see a locked Premium option with an explanation and contact link. The mode is fixed during processing/review, each open tab keeps its own selection, and the advanced Upload Center directs Incognito users to a core job because it saves files. Normal and Incognito use the same financial checks. With it on, the upload is processed and returned and nothing is saved: no run, result, history entry, audit or AI-usage row, remembered ledger choice or stored file; the page tells the person to download before leaving. Entitlement is the signed-in account's own plan (`companies.plan`, `plan_until`), checked on every request; a request without a paid plan gets 403 `privacy_not_available` and is never quietly saved. Files that can be read without AI (Excel, CSV, text PDFs the balance proof accepts) never reach an AI service. A scan or photo needs AI, so the person is asked first, once per file, and it goes to Gemini only (never Claude) and only when `PRIVACY_AI_ALLOWED=true` confirms the key is a paid, billed Google key. Google's paid terms say it does not train on this data but may log requests briefly to prevent abuse; this is not zero data retention, and the screen says so. There is no billing integration: set a plan with `pnpm --filter @workspace/db run set-plan -- <companyId> <free|starter|growth|ca_firm|enterprise> [YYYY-MM-DD]`.
- Database move: `pnpm --filter @workspace/db run copy-db` copies `DATABASE_URL_OLD` into an empty `DATABASE_URL_NEW` (schema, data, sequences, indexes), reading the old one only, then compares row counts and an MD5 of every table. The active database is now Neon Singapore (`aws-ap-southeast-1`); Neon has no Mumbai region.
- Dev tool: `FV_PDF_PASSWORD=... pnpm --filter @workspace/api-server run read-statement -- <file.pdf> [--ai]` prints every row and the proof.
- Drop-anything home page: `POST /api/jobs/detect` classifies uploaded files (bank statement, Tally export, marketplace report, invoice list or document) and opens the right job.
- Bank → Tally XML includes create-only ledger masters (parties under Sundry Debtors/Creditors, expenses under their groups) so imports do not stop on a missing ledger. Existing ledgers are not altered.
- Bank → Tally shows the detected bank and a local official logo when available, lets the user correct the bank, and exports reviewed transactions as CSV or a formatted Excel working copy. E-commerce GST lets an accountant correct uploaded rows, HSN and document counts, compare an uploaded state-wise TCS summary, and export an Excel working summary or Sales voucher XML for test import. The GST JSON remains a TallyThis draft; marketplace format recognition is broader than verified report-layout support. These workbooks are not GST portal or Tally import files.
- Reports offers a saved-records Excel CA workbook as well as the PDF review pack. The Excel workbook includes reconciliation, unmatched transactions, invoices, review flags, ledger totals, and journal entries where those optional tables exist; each sheet has a row limit noted in the workbook summary.
- Platform/security posture APIs for company profile, users, documents, GST records, audit logs, and security status.
- Local Tally connector for customer-run Tally gateways. It pulls Tally Day Book XML through the Python worker, refreshes tax-audit Tally tables, creates ledger entries for reconciliation, and reruns rule-based matching.

## What Is Mocked Or Prototype-Only

- Auth uses hashed passwords, signed bearer tokens, database-backed sessions, revocation on logout, role permissions, and company-scoped API queries. The frontend stores the bearer session in localStorage; production deployments should harden this further with secure cookies or an equivalent trusted session transport.
- Current version is upload-first, with a local Tally connector available when Tally is reachable from the API host.
- File storage is metadata-only unless private Cloudflare R2 or another compatible storage provider is configured. Large binaries are not stored in Neon.
- Direct GST/GSP, bank feed, Zoho Books API, Razorpay/Cashfree/Stripe API, Gmail invoice import, WhatsApp collection, and Account Aggregator integrations are future work.
- Without a Claude or Gemini key, scanned PDFs and photos fall back to local Tesseract OCR if installed, otherwise the user is asked for the bank's Excel/CSV download.
- Optional demo seeding exists only for product validation and is disabled unless `ALLOW_DEMO_SEED=true`.

## Run Locally

Install dependencies:

```bash
pnpm install
```

Typecheck:

```bash
pnpm run typecheck
```

Job automation tests (parsers, matching, Tally XML, file detection):

```bash
pnpm --filter @workspace/api-server test
```

Sample PDFs (text and scanned) for manual testing:

```bash
node backend/api/scripts/make-sample-statements.mjs ./tmp-samples
```

Build:

```bash
pnpm run build
```

Run the API:

```bash
pnpm --filter @workspace/api-server run dev
```

Run the frontend:

```bash
pnpm --filter @workspace/finverify-os run dev
```

Optional demo data, disabled unless `ALLOW_DEMO_SEED=true`:

```bash
curl -X POST http://localhost:8080/api/demo/seed
```

After schema changes, push the database schema:

```bash
pnpm --filter @workspace/db run push
```

## Environment Variables

- `DATABASE_URL`: Neon/PostgreSQL connection string required by the API/database package.
- `DIRECT_DATABASE_URL`: optional direct Neon URL for migration/admin workflows.
- `JWT_SECRET` or `SESSION_SECRET`: required in production for signed auth sessions.
- `SESSION_HOURS`: optional session duration override. Defaults to 12 hours.
- `APP_URL`: public frontend URL used after OAuth callbacks, for example `http://localhost:21950`.
- `API_PUBLIC_URL`: public API URL used to construct OAuth callback URLs, for example `http://localhost:8080`.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`: Google OAuth web application credentials. The redirect URI should be `/api/auth/google/callback`.
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI`: GitHub OAuth app credentials. The redirect URI should be `/api/auth/github/callback`.
- `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ENDPOINT`, `CLOUDFLARE_R2_BUCKET`, `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`: private R2 upload storage. `STORAGE_*` aliases are still supported for older code paths.
- `CLOUDFLARE_R2_PUBLIC_URL`: optional custom public prefix, only if you deliberately configure one. Normal file access should use signed URLs.
- `ANTHROPIC_API_KEY` (alias `CLAUDE_API_KEY`), `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`, `ANTHROPIC_MAX_TOKENS`: Claude is the fallback used only when every Gemini model fails. Defaults: model `claude-opus-5-5`, effort `low`, 16000 max tokens. Organisation-level keys also need `ANTHROPIC_WORKSPACE_ID`. Requests use server-side refusal fallback (`fallbacks: "default"`).
- `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`: Gemini is the primary provider. Recommended: `GEMINI_MODEL=gemini-3.1-pro-preview` and `GEMINI_FALLBACK_MODEL=gemini-3.5-flash,gemini-2.5-flash` (comma-separated, tried in order). Pro models need a billed Google project; on a free-tier key they fail at once and the flash models are used. Brief "high demand" errors are retried.
- `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `NVIDIA_MODEL`: NVIDIA is the secondary provider using OpenAI-compatible chat completions.
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_ENABLED=false`, `OPENROUTER_PRODUCTION_ONLY=true`: OpenRouter is an emergency fallback only and is disabled by default.
- `AI_PROVIDER_ORDER=gemini,claude`, `AI_ENABLE_FALLBACKS=true`, `AI_ENABLE_STRUCTURED_OUTPUT=true`, `AI_ENABLE_LOGGING=true`, `AI_STORE_RAW_PROMPTS=false`, `AI_TIMEOUT_MS=30000`, `AI_MAX_RETRIES=1`: provider routing and safety controls.
- `HISTORY_MONTHS` (default `3`): how many months of History people see. Nothing older is deleted. `SUPPORT_EMAIL`: the address shown for older history and for upgrades.
- `PRIVACY_MODE_PLANS` (default `starter,growth,ca_firm,enterprise`): plans that include Privacy mode. `PRIVACY_AI_ALLOWED` (default `false`): set `true` only when `GEMINI_API_KEY` belongs to a paid, billed Google project; until then Privacy mode never sends a scan to AI.
- `STORAGE_FORCE_PATH_STYLE`: set `true` for compatible providers that require path-style addressing.
- `ALLOW_DEMO_SEED`: set `true` to allow `/api/demo/seed`. Leave unset for real-data workspaces.

## AI Mode Vs Rule-Based Mode

AI is optional, rule-first, and server-side only. Browser code never receives provider API keys. The deterministic matching engine remains the source of truth.

Provider order:

1. Gemini main model from `GEMINI_MODEL`
2. Gemini fallback models from `GEMINI_FALLBACK_MODEL`
3. Claude from `ANTHROPIC_MODEL` (skipped when no key is set)
4. NVIDIA model from `NVIDIA_MODEL` (only if listed in `AI_PROVIDER_ORDER`)
5. OpenRouter only when explicitly enabled and allowed
6. Rule-based fallback

AI can assist with invoice extraction, bank narration interpretation, ledger suggestions, risk explanations, month-end summaries, CA-friendly notes, text cleanup, and column mapping suggestions. It must not mark transactions verified, make legal/tax judgments, invent financial fields, file GST/TDS, execute payments, or modify financial data without review.

Every AI response is parsed through `safeParseAIJson`, validated with Zod schemas, retried once with a JSON repair prompt when needed, and then replaced by deterministic fallback if validation still fails. AI extraction rows are stored as `extracted_pending_review`; accepted/verified status must come from user review or deterministic rules.

Usage logs store provider, model, purpose, success, latency, token estimate, fallback state, and error code. Raw prompts are not stored by default; if `AI_STORE_RAW_PROMPTS=true`, only development can opt in and sensitive values must be redacted.

Dev-only provider smoke test:

```bash
curl -X POST http://localhost:8080/api/dev/test-ai
```

## AI Extraction

Invoice AI extraction is available after an upload has parsed text. The flow is:

1. Upload an invoice PDF or structured file.
2. The backend stores upload metadata and, when configured, the raw file in private R2-compatible storage.
3. PDF text is extracted server-side.
4. The Upload Center shows PDF-specific metadata such as page count, extracted text length, table hints, and AI extraction status.
5. The user clicks `Run AI Extraction`.
6. Gemini extracts structured invoice JSON first. NVIDIA is the fallback. OpenRouter is disabled by default and only used when `OPENROUTER_ENABLED=true`.
7. The extracted JSON is saved to `ai_extractions` as `extracted_pending_review`.
8. The UI shows `AI extracted — pending review`; low-confidence results show `Needs review`.
9. Accepted extractions create invoice records with `pending_reconciliation` status so deterministic reconciliation can use them.

AI does not verify accounting truth. It does not confirm GST, TDS, legality, fraud, audit conclusions, or CA readiness. If AI providers fail, TallyThis returns `AI unavailable — using rule-based extraction` and keeps the result pending review.

Dev-only invoice extraction smoke test:

```bash
curl -X POST http://localhost:8080/api/dev/test-ai-extraction
```

Health check:

```bash
curl http://localhost:8080/api/health
```

## Authentication

Email/password signup and signin are real database-backed flows. A new signup creates an empty company workspace in Neon with founder permissions; it does not seed demo data.

Google and GitHub OAuth use server-side authorization-code flow. The browser redirects to the provider, the backend exchanges the code using server-only client secrets, fetches the verified email/profile, links to an existing user by email when present, or creates a new empty workspace for first-time OAuth users. TallyThis then issues its own JWT session and stores a revocable session row.

OAuth callback URLs for local development:

- Google: `http://localhost:8080/api/auth/google/callback`
- GitHub: `http://localhost:8080/api/auth/github/callback`

Demo data is never loaded automatically. `/api/demo/seed` remains disabled unless `ALLOW_DEMO_SEED=true`.

## Upload Formats Supported

- CSV: server-side row count, detected columns, and preview.
- Excel: server-side first-sheet row count, detected columns, and sheet names.
- PDF: server-side text extraction, page count, and text preview.
- Image invoices: accepted as metadata/extraction-ready uploads; OCR is future work.
- Tally files: supported through upload-based XML/CSV workflows and the local Tally connector when configured.
- Zoho/GST/payroll/gateway files: supported through upload-based workflows, not live API connectors.

When R2 is configured, raw uploaded files are written to a private bucket and Neon stores metadata only: provider, bucket, region, key, size, checksum, retention date, and deletion metadata. Files should be accessed with temporary signed URLs, not public bucket permissions. Stored report exports are available through `GET /api/reports/export-csv?type=...&store=true`.

## Matching Engine

The matching engine scores records using:

- Amount match: 35 points
- Date closeness: 15 points
- Vendor/name similarity: 20 points
- Reference/invoice/UTR/RRN match: 20 points
- Source consistency: 10 points

Thresholds:

- 85+ = Verified/exact match candidate
- 60-84 = Needs review/potential match
- Below 60 = Unverified
- Missing document or suspicious tax/compliance heuristic = Potential risk — needs CA review.

## Future Roadmap

- Production auth and role-based permissions.
- Persistent company/user model and multi-tenant isolation.
- Robust CSV/XLSX mapping templates.
- Document extraction for PDFs and images.
- Broader connector coverage for Zoho Books, GST/GSP, gateway, bank feed, Gmail, WhatsApp, and Account Aggregator integrations.
- Audit logs, data retention controls, and production-grade export packages.

## Known Limitations

- This version is a prototype for validation.
- Current version is upload-first with a local Tally connector.
- Document storage is metadata-only by default; S3/R2/GCS-compatible object storage is available when configured.
- GST and bank integrations are future work; the Tally connector requires customer-side Tally gateway setup.
- AI is optional and not required for app operation.
- This tool does not replace CA, legal, tax, or compliance review.
- Compliance findings are only potential risks that need CA review.

## Platform APIs Added

- `GET /api/company`
- `GET /api/users`
- `GET /api/documents`
- `POST /api/ai/extract-invoice`
- `POST /api/ai/extractions/:id/accept`
- `PATCH /api/ai/extractions/:id/edit`
- `POST /api/ai/extractions/:id/reject`
- `GET /api/gst-records`
- `GET /api/audit-logs`
- `GET /api/security/posture`
