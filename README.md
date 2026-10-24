# TallyThis

Deployment: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. Frontend source is in
**`frontend/`** (Vercel Root Directory); the backend services are in **`backend/api/`**,
**`backend/gateway/`** and **`backend/worker/`** and run in Docker on one Google Cloud VM
([runbook](docs/GCP_VM_DEPLOYMENT.md), scripts in `deploy/vm/`). The database schema and its
migrations are in `lib/db/`. Set `BACKEND_ORIGIN` in Vercel to the backend's HTTPS address
(`https://api.tallythis.xyz`). Existing Vercel projects must update their old Root Directory.

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
- GSTR-2B ↔ Books, Bills → Tally, Sales → GSTR-1 & 3B and Payroll (offered on Home and in search; the side menu lists them under Advanced → More jobs)
- Clients, Reports, Activity, Settings
- Advanced keeps the older upload center, tax audit, payroll, gateway, and CA review screens

Workflow details: [`docs/PRODUCT_WORKFLOWS.md`](docs/PRODUCT_WORKFLOWS.md). Service split: [`docs/MIGRATION_GO_PYTHON.md`](docs/MIGRATION_GO_PYTHON.md).

Public Repotic workflow comparison and remaining gaps: [`docs/REPOTIC_COMPARISON.md`](docs/REPOTIC_COMPARISON.md).

Wider competitor research and implementation priorities: [`docs/COMPETITOR_REVIEW.md`](docs/COMPETITOR_REVIEW.md). Financial correctness and evidence required before accuracy claims: [`docs/ACCURACY_STANDARD.md`](docs/ACCURACY_STANDARD.md).

## Interface and product walkthroughs

The landing page and workspace share a forest green and white visual system, a custom TallyThis wordmark and T/check symbol, and responsive layouts. The main navigation shows Clients, Bank → Tally, Bank ↔ Tally, E-commerce GST, Invoice ↔ Bank, Reports and Activity. The logo opens the workspace home. Settings, History and Help are in the account menu at the bottom of the side menu; every other page is on one Advanced page (a single entry in the menu), grouped, with a search box, and also found by Ctrl K search. Reports links directly to saved job outputs, offers a CA review PDF, and keeps individual reports under More options.

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
- Reading order for a statement PDF: the table reader first (a 150-page text statement is read in about a second and is exact). A statement the reader got through is never sent to AI when every row follows the running balance, and a long one (more than `AI_WHOLE_DOCUMENT_PAGES`, default 12) is never sent whole at all, because no single AI answer can hold hundreds of rows: rows that do not follow the balance stay flagged for the reviewer instead. A short statement the table reader could not fully prove gets one second, independent read by Gemini, then Claude only if every Gemini model fails (locked PDFs are sent as page images); each answer is scored by the same running-balance proof and the next model is tried until one fully proves.
- A long scan (more than 12 pages, no text layer) is read page group by page group: `AI_PAGES_PER_CALL` (default 2) pages per request, `AI_CALLS_IN_FLIGHT` (default 8) requests at once, each answered as plain 7-item rows to halve the output, the quicker Gemini models first and the primary model last for groups that did not prove (`AI_CALL_TIMEOUT_MS` per attempt, `AI_READ_BUDGET_MS` for the whole scan). The groups are joined in page order and the running balance is checked across every join, so a group that was skipped or misread shows up as rows that do not follow the balance. If any group cannot be read nothing is created and the message names the pages. An AI read is never marked verified, because the model also reads the balances and can report the last row it read as the closing balance; the reviewer is asked to compare the transaction count and totals with the bank statement, and rows out of date order are flagged. Invoice PDFs are read by AI the same way and stay "AI extracted — pending review".
- Long reads run in the background: `POST /api/jobs/bank-statement/normalize` with `async=1` answers a quick file at once and a slow one with `202 {pending, jobId}`; the page polls `GET /api/jobs/bank-statement/progress/:id` for "Reading page 40 of 152". Jobs live only in the API server's memory (a result is dropped once delivered or after 20 minutes), belong to the company and user that started them, and are lost on a restart or when a second server instance answers the poll; the page then asks for the upload again. Privacy mode never uses a background job. Uploads up to `MAX_UPLOAD_MB` (default 60) are accepted; a larger file is refused with a plain message.
- Measured so far: the table reader on synthetic 160-page, 6,400-row statements (about 0.3 s, all rows proved) and the page-group reader on synthetic 12- and 40-page image statements with live Gemini. Not measured: a real 150-page scan, real bank layouts beyond the sample files, and the live provider's rate limits at full concurrency.
- History (`/app/history`): the last `HISTORY_MONTHS` months (default 3) of jobs the workspace has run, newest first, with who ran it. Search by file name, filter by job, open an item to see the saved result and download the Tally file, CSV, report or GST draft again. Backed by `GET /api/jobs/history` and `/api/jobs/history/:id`, scoped to the active client. Older items are never deleted: they stay in the database, the page says how many are waiting and asks the person to email `SUPPORT_EMAIL`, and opening one directly returns 403 `outside_window` with the same message. Original uploaded files are not kept by the four jobs; only what was read from them is.
- Incognito (paid plans only, backed by the existing privacy flag): a Normal / Incognito segmented control sits above uploads on Home and all four core jobs. Incognito has a hat-and-glasses icon and switches only the app workspace to charcoal, with a subtle background grid; landing and login pages remain unchanged. Free accounts see a locked Premium option with an explanation and contact link. The mode is fixed during processing/review, each open tab keeps its own selection, and the advanced Upload Center directs Incognito users to a core job because it saves files. Normal and Incognito use the same financial checks. With it on, the upload is processed and returned and nothing is saved: no run, result, history entry, audit or AI-usage row, remembered ledger choice or stored file; the page tells the person to download before leaving. Entitlement is the signed-in account's own plan (`companies.plan`, `plan_until`), checked on every request; a request without a paid plan gets 403 `privacy_not_available` and is never quietly saved. Files that can be read without AI (Excel, CSV, text PDFs the balance proof accepts) never reach an AI service. A scan or photo needs AI, so the person is asked first, once per file, and it goes to Gemini only (never Claude) and only when `PRIVACY_AI_ALLOWED=true` confirms the key is a paid, billed Google key. Google's paid terms say it does not train on this data but may log requests briefly to prevent abuse; this is not zero data retention, and the screen says so. There is no billing integration: set a plan with `pnpm --filter @workspace/db run set-plan -- <companyId> <free|starter|growth|ca_firm|enterprise> [YYYY-MM-DD]`.
- Database move: `pnpm --filter @workspace/db run copy-db` copies `DATABASE_URL_OLD` into an empty `DATABASE_URL_NEW` (schema, data, sequences, indexes), reading the old one only, then compares row counts and an MD5 of every table. The active database is now Neon Singapore (`aws-ap-southeast-1`); Neon has no Mumbai region.
- Dev tool: `FV_PDF_PASSWORD=... pnpm --filter @workspace/api-server run read-statement -- <file.pdf> [--ai]` prints every row and the proof.
- GSTR-2B ↔ Books (`/app/jobs/gstr-2b`, `POST /api/jobs/gstr-2b/compare`): GSTR-2B (portal JSON or Excel, one or several months) against a purchase register (Excel/CSV, columns found by their headings). Pure, deterministic matching in `services/gstrRecon.ts`, amounts held in paise. When the register's headings are not recognised, an optional AI step (schema-validated; not used when no AI key is set, and in privacy mode only if the person allows AI) is asked only to name the columns from heading text and the share of GSTIN-, date- and amount-like cells, never cell values; every suggestion is checked against the column's data and a note on the result lists what was matched. It never touches the matching. A match needs the same supplier GSTIN and invoice number and amounts within ₹1; a different invoice number or a different GSTIN is only a suggestion until the person confirms it, and two documents can be linked by hand. Output: counts, ITC not supported by GSTR-2B, ITC by tax head, supplier follow-up messages (copy or email) and an Excel working copy. Verified with synthetic fixtures only (`gstrRecon.test.ts`); GST portal acceptance, real portal files of every layout and real Tally exports are not claimed. It never decides whether ITC may be claimed.
- Bank ↔ Tally outputs: a bank reconciliation statement (`POST /api/jobs/bank-tally/brs`, working from the bank balance to the books balance, with an optional Tally balance to check it adds up) and, for entries missing in Tally, vouchers through the existing Bank → Tally XML builder. Invoice ↔ Bank offers an Excel file and a copy-ready request for payments with no invoice.
- Reports builds a month pack from the saved job runs of the active client (`GET /api/reports/jobs-overview`, `POST /api/reports/jobs-pack`): jobs done and every open item. The older CA review pack depends on the Upload center's month-close tables and says what blocks it, with a link to fix each blocker.
- 26AS TDS reconciliation reads the TRACES text file (Part I / Part A, final bookings only), Excel or CSV, and matches books lines that have only a party name by TAN (looked up from the 26AS) or by tidied name. Not verified against a real TRACES file. A PDF is refused with the way to get a readable copy.
- Navigation and resilience: one persistent shell, Ctrl K / ⌘K search over jobs, pages and clients, an in-app 404, an error boundary on every page, and a global rule that an API 401 sends the person to sign in and back to the same page. Page queries throw on a failed reply (`lib/api.ts`) instead of treating an error body as data, and the client list is read once and shared (`GET /api/practice/clients?light=1`) so it does not run the tax-audit engine for every client on every page. Pages load lazily.
- Drop-anything home page: `POST /api/jobs/detect` classifies uploaded files (bank statement, Tally export, marketplace report, invoice list or document) and opens the right job.
- Bank conversion opens the bank-format preview with balances, search and direct Excel/XML downloads. Review is separate and AI ledger suggestions are opt-in. Exports use the ledgers already settled (a sure rule, the client's earlier choice or the person's confirmation) and keep everything else, including unconfirmed AI suggestions, in Suspense; switching off "Use confirmed ledger choices" gives a conversion-only file with every row in Suspense. Search never excludes rows from downloads. Uncertain source values still require checks before XML, while Excel remains available as a working copy. DBS now has a local official logo; bank-format accuracy and actual TallyPrime acceptance remain subject to the documented evidence gates.
- Bank running/closing checks now require exact paise and complete row coverage. Sub-paise source values stop rather than being rounded silently. Excel uploads stop if financial tables span multiple sheets or the row limit truncates a sheet; upload each table separately as CSV. The opt-in real-engine import/read-back check is documented in [TALLY_IMPORT_ACCEPTANCE.md](docs/TALLY_IMPORT_ACCEPTANCE.md); it has not passed an actual company import yet.
- Marketplace signed values are preserved. Supported credit notes link to a single original invoice row in the same upload; net/HSN totals, the Excel working copy and Sales/Credit Note XML share their reviewed treatment. Unlinked, oversized or inconsistent notes stop XML. Multi-line/cross-period notes, settlements, verified real platform layouts and portal-ready JSON remain incomplete. Ledger preferences retain earlier parties, and client questions can download separately for replies.
- Bank → Tally XML includes create-only ledger masters (parties under Sundry Debtors/Creditors, expenses under their groups) so imports do not stop on a missing ledger. Existing ledgers are not altered.
- Bank → Tally shows the detected bank and a local official logo when available, lets the user correct the bank, and exports reviewed transactions as CSV or a formatted Excel working copy. E-commerce GST lets an accountant correct uploaded rows, HSN and document counts, compare an uploaded state-wise TCS summary, and export an Excel working summary or Sales voucher XML for test import. The GST JSON remains a TallyThis draft; marketplace format recognition is broader than verified report-layout support. These workbooks are not GST portal or Tally import files.
- Reports offers a saved-records Excel CA workbook as well as the PDF review pack. The Excel workbook includes reconciliation, unmatched transactions, invoices, review flags, ledger totals, and journal entries where those optional tables exist; each sheet has a row limit noted in the workbook summary.
- Platform/security posture APIs for company profile, users, documents, GST records, audit logs, and security status.
- Local Tally connector for customer-run Tally gateways. It pulls Tally Day Book XML through the Python worker, refreshes tax-audit Tally tables, creates ledger entries for reconciliation, and reruns rule-based matching. It only reaches this computer or hosts an administrator lists (`TALLY_ALLOWED_HOSTS`, `TALLY_ALLOWED_PORTS`), never cloud-metadata or link-local addresses, and is off by default in production (`TALLY_CONNECTOR_ENABLED`): a cloud server cannot reach an accountant's TallyPrime.
- Bank → Tally opens the statement full screen as soon as it is read: balances, Default / Bank / Tally views, Raise Query and a Download menu (Excel, CSV, Tally XML) along the top. History lists saved items as a table and **View** reopens a saved statement in the same viewer (read-only). The viewer has an all-transactions table (Default, bank-statement view with value date and Chq/Ref, and Tally view), per-row voucher type (Receipt, Payment, or Contra for cash) and ledger, a row menu (money in/out, leave out, client query), and client questions that copy as a list and export to a "Client queries" Excel sheet.
- Bank → Tally ledger suggestions follow [docs/BANK_LEDGER_RULES.md](docs/BANK_LEDGER_RULES.md): sure rules are taken as chosen, uncertain ones (payment-app credits, refunds into expenses, card bills) are shown as suggestions the CA confirms.
- Bank → Tally "Send to Tally" loads the Tally company's own ledgers (bank, Suspense and party ledgers) for mapping, then posts the reviewed vouchers to TallyPrime's local XML server at `TALLY_URL` (default `http://localhost:9000`; set on the API, never from the browser), after creating missing ledgers, and reports Tally's own created/error counts. It only reaches a Tally on the API host's computer or network, so it is offered (and marked Experimental) only where TallyThis runs next to TallyPrime; on the hosted site the button reads Export, the send routes answer 409, and the Tally XML download is the way in. It has not yet been verified against a live TallyPrime import; sending twice creates duplicate vouchers.

- Bills → Tally (`/app/jobs/bills-tally`, `POST /api/jobs/bills/read|check|xml|send|excel`): purchase bills from invoice PDFs (read by their printed labels, no AI), scans and photos (AI reader, with consent) or a purchase list (Excel/CSV) become Tally Purchase vouchers. Every bill is checked in paise: GSTIN checksum, taxable + tax = total (a difference under ₹1 goes to a round-off ledger), CGST = SGST, IGST not together with CGST/SGST, repeated supplier + invoice number. A bill that does not pass blocks the file until it is fixed or left out. Supplier ledgers (new, or an existing Tally ledger the person picks) and per-supplier purchase ledgers are remembered per client. Credit and debit notes are listed and left out. The XML carries a stable GUID per bill so a repeat import can be recognised. Verified with synthetic fixtures (`booksJobs.test.ts`) and not yet against a live TallyPrime: see `docs/TALLY_IMPORT_ACCEPTANCE.md` and `pnpm --filter @workspace/api-server run verify-tally-books`.
- Sales → GSTR-1 & 3B (`/app/jobs/gst-sales`, `POST /api/jobs/gst-sales/read|3b|excel`): a sales register (Excel/CSV from Tally or other software) is sorted into B2B, B2C Large, B2C Small, credit/debit notes, exports/SEZ and nil/exempt tables, with HSN and document summaries. The tables are proved against the register's own rows (a difference holds the Excel file back). A GSTR-3B working takes outward supplies from the register and input credit from a saved GSTR-2B ↔ Books result, and sets credit off in the order the law sets. It is a working for CA review, not a return: it is not validated by the GST portal or the offline utility, the B2C Large limit (₹1 lakh) is a stated setting to be checked against the current notification, and export, SEZ and the nil/exempt split need the CA.
- Payroll (`/app/jobs/payroll`, `POST /api/jobs/payroll/read|journal|send|excel`): a salary sheet (Excel/CSV, one row per employee) is read by its headings with the employer's name (from the person, the file's title or the client), month and optional PAN, TAN, PF and ESI codes saved per client. Per-employee checks (gross, deductions, net, PF at 12%, ESI limit, UAN/PAN present), a PF/ESI/PT/TDS working in which every figure not in the sheet is marked computed, a check against an optional bank statement (one payment per employee, or one bulk payment), an Excel register and a balanced Tally Journal entry. It does not file ECR, challans or Form 24Q.
- Measuring on real files: `pnpm --filter @workspace/api-server run measure-corpus -- <folder>` reads a folder of redacted client files and compares every figure with a hand-checked `answers.json`. See `docs/REAL_FILE_CORPUS.md`. No real corpus has been measured yet.

## What Is Mocked Or Prototype-Only

- Auth uses hashed passwords, signed bearer tokens, database-backed sessions, revocation on logout, role permissions, and company-scoped API queries. The frontend stores the bearer session in localStorage; production deployments should harden this further with secure cookies or an equivalent trusted session transport.
- Current version is upload-first, with a local Tally connector available when Tally is reachable from the API host.
- File storage is metadata-only unless private Cloudflare R2 or another compatible storage provider is configured. Large binaries are not stored in Neon.
- Direct GST/GSP, bank feed, Zoho Books API, Razorpay/Cashfree/Stripe API, Gmail invoice import, WhatsApp collection, and Account Aggregator integrations are future work.
- Without a Claude or Gemini key, scanned PDFs and photos fall back to local Tesseract OCR (and `pdftoppm` or ImageMagick to render PDF pages) if installed, otherwise the user is asked for the bank's Excel/CSV download. Only pages without a text layer are OCR'd, a few at a time (`OCR_PAGES_IN_FLIGHT`, default one per spare CPU core), up to `OCR_MAX_PAGES` (default 200); a scan with a page that cannot be read is refused, never half read. This path has not been timed on a real 100+ page scan yet: with Tesseract and Poppler installed, `pnpm --filter @workspace/api-server run read-statement -- <scan.pdf> --ocr` prints pages, workers and seconds per page.
- A statement read (not spreadsheets, never in privacy mode) is remembered in server memory for 30 minutes per company and file content, so the same file uploaded again is answered at once. Nothing is written to disk or the database for this, and a restart clears it.
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

The Go gateway, Python worker and browser tests, what each one proves, and which checks need a real database or TallyPrime are in [docs/TESTING.md](docs/TESTING.md). `.github/workflows/ci.yml` runs them on every pull request.

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
- `JWT_SECRET` or `SESSION_SECRET`: required in production for signed auth sessions, at least 32 characters, and never a value published in this repository (including the `.env.example` sample). The API and the Go gateway exit at start-up in production otherwise, and both must hold the same value.
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
- `MAX_UPLOAD_MB` (default `60`): largest statement the job pages accept. `AI_WHOLE_DOCUMENT_PAGES` (`12`), `AI_PAGES_PER_CALL` (`2`), `AI_CALLS_IN_FLIGHT` (`8`), `AI_CALL_TIMEOUT_MS` (`150000`), `AI_READ_BUDGET_MS` (`1200000`): how long scans are read by AI (see the reading order above).
- `HISTORY_MONTHS` (default `3`): how many months of History people see. Nothing older is deleted. `SUPPORT_EMAIL`: the address shown for older history and for upgrades.
- Excel uploads (`.xlsx` and the older `.xls`) are read with SheetJS `xlsx` 0.20.3, installed from SheetJS's own CDN (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, integrity pinned in `pnpm-lock.yaml`) because the npm registry copy (0.18.5) is outdated and has known advisories. Workbooks open without formulas or styles and are capped at 250,000 rows; a damaged file returns a 422 with a plain message.
- `NEON_AUTH_URL`, `NEON_JWKS_URL`: Neon Auth address (Neon console → Connect → Auth) and its key-set address. Public values, not secrets. Leave `NEON_AUTH_URL` empty to keep the older sign-in. `LEGACY_PASSWORD_LOGIN=false` closes the older password sign-in once everyone has moved.
- `LOGIN_MAX_FAILURES` (default `8`), `LOGIN_LOCK_MINUTES` (default `15`): after that many wrong passwords for one email, sign-in for that email is refused with 429 until the window ends. The count is kept in memory per API instance, so it resets on restart and is not shared between instances; it does not replace email verification or password recovery.
- `PRIVACY_MODE_PLANS` (default `starter,growth,ca_firm,enterprise`): plans that include Privacy mode. `PRIVACY_AI_ALLOWED` (default `false`): set `true` only when `GEMINI_API_KEY` belongs to a paid, billed Google project; until then Privacy mode never sends a scan to AI.
- `STORAGE_FORCE_PATH_STYLE`: set `true` for compatible providers that require path-style addressing.
- `ALLOW_DEMO_SEED`: set `true` to allow `/api/demo/seed`. Leave unset for real-data workspaces.
- `WORKER_SERVICE_TOKEN`: shared secret between the API and the Python worker, at least 24 characters in production. Set the same value on both, never on the gateway or in the browser. The worker answers only requests that carry it, and in production (its image sets `APP_ENV=production`) refuses everything except `/health` without it. Optional on a developer machine.
- `CORS_ORIGIN`: on the gateway, the comma-separated origins allowed to call it from a browser. In production no other origin is allowed; the Vercel same-origin proxy needs none.
- `TALLY_CONNECTOR_ENABLED`, `TALLY_ALLOWED_HOSTS`, `TALLY_ALLOWED_PORTS`: live Tally connection. On by default on a developer machine, off by default in production. Allowed hosts are this computer plus the comma-separated list; allowed ports are 9000 plus the list. Cloud-metadata and link-local addresses are never allowed.

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

**Neon Auth (managed Better Auth, beta).** When `NEON_AUTH_URL` is set, the sign-in page uses Neon Auth: email + password with a 6-digit email code to confirm the address, a code-based password reset, and Google/GitHub through Neon. The browser talks to Neon with `@neondatabase/auth` (loaded only on the sign-in page); `POST /api/auth/neon/exchange` then checks the signed Neon token against Neon's public keys (`NEON_JWKS_URL`, default `<NEON_AUTH_URL>/.well-known/jwks.json`; EdDSA only, issuer pinned), reads the person from the `neon_auth` schema in the same database, and returns the same TallyThis session the older sign-in returns, so the Go gateway and every route are unchanged. An older account with the same email is claimed only after Neon has verified that email (`users.neon_user_id`, migration `scripts/migrate-neon-auth.sql`). With Neon Auth on, `/api/auth/register` is closed because it skips email confirmation; set `LEGACY_PASSWORD_LOGIN=false` to close the older password sign-in as well. Verification codes work with Neon's shared email sender, which is rate-limited; set a custom SMTP provider and your own Google/GitHub OAuth apps in the Neon console before launch. Not verified against a live sign-in by the developer: test sign-up, code confirmation, password reset and Google/GitHub in a browser, including Safari, because Neon's session cookie is set from another domain. See [PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md).

Older email/password signup and signin are real database-backed flows. A new signup creates an empty company workspace in Neon with founder permissions; it does not seed demo data.

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
