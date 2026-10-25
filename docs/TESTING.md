# Testing TallyThis

What each test layer covers, how to run it, and what it needs. Passing tests here show that the code behaves as the tests describe. They do not show that a real TallyPrime accepts an import, that the GST portal accepts a file, that Neon's sign-in and email work, or that a bank statement layout the tests have never seen is read correctly. Those need the checks in the last sections, and the live walk-through in [GO_LIVE.md](GO_LIVE.md).

Counts below are from the runs of 25 October 2026 on branch `release/go-live`. They will drift; the commands are what matter.

## Automatic: runs on every pull request

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs these eight jobs. None needs a Tally installation, cloud storage or an AI key, and the only database is a throwaway Postgres the job starts for itself. Nothing in the workflow deploys anything. The workflow had not run on GitHub when this was written: the local runs below are the evidence so far.

| Job | Command | What it covers | Last local result |
| --- | --- | --- | --- |
| TypeScript | `pnpm run typecheck`, `pnpm --filter @workspace/api-server test`, `pnpm --filter @workspace/db test`, `pnpm run build`, `pnpm run test:deployment` | Types for libraries, API and frontend. Parsers, matching, Tally/GST/payroll XML builders, permissions, security configuration, log scrubbing, the Settings validator, the database error mapping, the rule that chooses the database driver by host. The production build. The website's Vercel configuration (rewrites, security headers). | API tests 214 pass, database package 2 pass, deployment configuration 4 pass. |
| Dependency advisories | `node scripts/audit-gate.mjs` | Fails on a new critical or high advisory in production dependencies, and on an accepted one past its review date (`scripts/audit-allowlist.json`). Needs the npm registry. | 2 advisories left: zod 3 (accepted, guarded by `zodArrayLimits.test.ts`, review by 31 Dec 2026), esbuild (low, build tool only). |
| Go gateway | `cd backend/gateway && gofmt -l . && go vet ./... && go test ./...` | Sign-in token checks, signing-secret rules, the permission check on every gateway route (401, 403 and fail-closed cases), and which routes go to the TypeScript API instead of the gateway's own handlers. The role table is read from the API's `permissions.ts`, so the two cannot drift without a test failing. CI fails on any file `gofmt` would change; on Windows `gofmt -l` also lists files that merely have CRLF line endings, which git stores as LF. | Pass. |
| Go gateway against Postgres | `go test ./internal/routes/ -run RealDatabase` with `GATEWAY_TEST_DATABASE_URL` set (see below) | The gateway's real sign-in and permission SQL against the real tables: every role against every permission the gateway's routes use, expired, revoked, forged and wrong-company sessions, disabled users, a permission switched off, another company's rows not widening access, and the audit row written for each refusal. CI creates the schema with the migrations, checks that nothing is left to apply, and applies them again (a second run must change nothing); a skipped check fails the job. | 3 pass against a throwaway Postgres 18; mutation-checked. |
| Deployment scripts | `python -m pytest deploy/vm/tests -q`, shellcheck, the compose file rendered with sample settings | The secret-fetching and release scripts for the Google Cloud VM, against a fake Google. | 26 pass, 1 skipped (a file-mode check that only runs on Linux). |
| Python worker | `cd backend/worker && python -m pytest tests -q` | Service-token check on every worker route, production fail-closed start, and the Tally connector's address rules (loopback, private ranges, cloud metadata, DNS answers, redirects). | 81 pass. |
| Browser | `pnpm --filter @workspace/finverify-os exec playwright test` | The screens, with every API answer pretended. Playwright starts the Vite dev server itself. Includes `phase0-honesty.spec.ts`: the hosted site must not offer sending straight to Tally, and Settings must say Saved only after the server confirms. | 89 pass. |
| Browser against the real backend | `pnpm --filter @workspace/finverify-os run test:real` | See the next section. CI gives it a Postgres service container, empties and migrates it, and fails the job on any skipped test. | 109 pass in 4.5 minutes. |

Run everything locally from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/db test
pnpm run build
pnpm run test:deployment
node scripts/audit-gate.mjs
(cd backend/gateway && go vet ./... && go test ./...)
(cd backend/worker && python -m pytest tests -q)
python -m pytest deploy/vm/tests -q
pnpm --filter @workspace/finverify-os exec playwright test
```

The worker tests need `pip install -r backend/worker/requirements.txt pytest`. The browser tests need `pnpm --filter @workspace/finverify-os exec playwright install chromium` once.

## The real backend, in a browser

The quick browser suite pretends every answer, so it cannot catch a screen that disagrees with the server, a route the gateway shadows, a missing column or a permission that blocks the wrong person. This layer runs the actual thing: [`scripts/stack/stack.mjs`](../scripts/stack/stack.mjs) starts the Python worker, the TypeScript API (built, in production mode, with the sample-workspace login closed), the Go gateway and the built website served the way Vercel serves it (same rewrites, same security headers), all against a Postgres on this computer. [`frontend/e2e-real`](../frontend/e2e-real) then drives it in Chromium (a desktop screen, and a Pixel 7 screen for tests tagged `@phone`).

```bash
STACK_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/tallythis_stack pnpm --filter @workspace/finverify-os run test:real
```

- **The database must be on this computer, and nobody else may need it.** The tests add accounts and files to it, and with `STACK_FRESH=1` (what CI sets) the stack first drops and recreates its `public` schema. The runner, the stack and the test helpers refuse any other host, so the production database cannot be reached by mistake. In the API, a loopback host uses a plain `pg` connection; every other host uses Neon's HTTP driver, unchanged.
- **Start the stack yourself to run single files** (`node --experimental-strip-types --no-warnings scripts/stack/stack.mjs`, then `npx playwright test --config playwright.real.config.ts <files>` from `frontend`); Playwright reuses a stack that is already up. **Restart it after any change to the API, the gateway or the frontend**: it rebuilds all three at start.
- **Covers:** sign-up and the two setup screens (refresh, back, a second device, skipping); each job from upload to download with exact figures from synthetic files (Bank → Tally, Bank ↔ Tally, E-commerce GST, Invoice ↔ Bank, Bills → Tally, Sales → GSTR-1 and 3B, Payroll, GSTR-2B); the Tally proof rule for statements; a text PDF statement, a locked PDF, a scan; the Upload Center; Settings, Clients, History, Activity, Reports, Admin; privacy mode and plans; the security cases (signed out, forged tokens, two companies kept apart, a read-only role, slowed repeated wrong passwords, the upload size limit, bad JSON, cross-site calls); a 5,000-row statement and several people reading at once; every page opening without errors; the main pages on a phone screen; the landing page and a file dropped before signing in.
- **Does not cover:** Neon sign-in (a test must not create accounts on Neon's hosted service, so the local stack uses the older password sign-in), email, R2 (files go to a local folder), any AI provider (no key; the rule-based path), a real TallyPrime, the GST portal, Safari, a real phone, bank or marketplace layouts that are not in the synthetic files, and Vercel's own proxy limits.

## Needs a real database (gateway SQL)

Use a **throwaway Postgres on your own computer, never the production Neon database**. The `.env` file used for local work has historically held the production connection string; check it before running anything.

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/tallythis_test pnpm --filter @workspace/db run migrate
GATEWAY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/tallythis_test go test ./internal/routes/ -run RealDatabase -v   # from backend/gateway
```

The gateway test refuses any host except this computer, adds rows under one company named "Gateway test ..." and removes them afterwards. Without the variable it skips.

**Migrations.** `lib/db/migrations/*.sql`, applied in order by `pnpm --filter @workspace/db run migrate`, each once, in its own transaction, recorded in `schema_migrations`. `-- --check` lists what is not applied and changes nothing; away from this computer the runner needs `-- --remote`, and it reads `DATABASE_URL` from the environment only, never from a `.env` file. The tests build the whole schema this way, so the migrations and the Drizzle schema cannot drift without something failing. How to apply them to the live database: [GO_LIVE.md](GO_LIVE.md).

`pnpm run test:db` (needs the API running; reads `/api/health`) only shows that the API reaches its database.

## Against a deployed backend

```bash
node scripts/smoke-live.mjs https://api.tallythis.xyz
node scripts/smoke-live.mjs https://api.tallythis.xyz --site https://www.tallythis.xyz
```

Checks a deployed backend from outside, as anyone on the internet could: no account, no password, nothing created or changed, and never the sample-workspace login. It checks the HTTPS certificate and redirect, that the health answer reports the database, worker and gateway ok and names no secret, the security headers, that private routes refuse a stranger and an unsigned token, that an unknown address is a JSON 404, and that another website cannot read answers. With `--site` it also checks that the website's `/api` reaches the same backend and probes unsigned uploads of a few sizes through it (information only). It does not sign in, upload a real file or test email. On the VM itself, `bash deploy/vm/ssh.sh 'sudo bash /opt/tallythis/current/deploy/vm/smoke-test.sh'` starts each built image alone with throwaway values.

## Manual: needs R2 or an AI key

`pnpm run test:r2` (private bucket upload, signed download and delete, with a synthetic object) and `pnpm run test:ai` (provider smoke test). They spend a little money or write a test object. Use a test bucket and a key with a spending cap.

## Manual: needs a real TallyPrime

**Not run to date.** See [TALLY_IMPORT_ACCEPTANCE.md](TALLY_IMPORT_ACCEPTANCE.md) for the exact commands. Until they pass on a disposable company, the statement is: TallyThis produces Tally XML that is well formed and balanced to the paise, and that its tests check against a specification; whether TallyPrime imports it, and imports it once on a repeat, is unverified.

| Check | Command | Needs |
| --- | --- | --- |
| Receipt and Payment vouchers, ledger masters, read-back | `pnpm --filter @workspace/api-server run verify-tally --allow-test-import` | TallyPrime running with its XML server, a disposable company, `TALLY_TEST_URL`, `TALLY_TEST_COMPANY`, `TALLY_TEST_DATE` |
| Purchase voucher, repeat import, salary Journal | `pnpm --filter @workspace/api-server run verify-tally-books --allow-test-import` | The same |

Do not run either against a client's company. Both write vouchers.

The "Send to Tally" button and the Tax Audit Tally connection use the same local XML server. They are hidden or refused on the hosted site on purpose: a cloud server cannot reach a PC running Tally. They work only when TallyThis runs on the same computer or network as TallyPrime and are marked Experimental.

## Manual: needs real files

- **Bank statements.** `pnpm --filter @workspace/api-server run read-statement -- <file.pdf>` prints what the reader found and the running-balance check for one PDF.
- **Any job's input.** `pnpm --filter @workspace/api-server run measure-corpus -- ./corpus` runs the readers over a folder of real, redacted files and compares each figure exactly with the answers a CA worked out by hand (`answers.json`). Without an answer file it reports "no answer to compare", which is not a pass. Method and file list: [REAL_FILE_CORPUS.md](REAL_FILE_CORPUS.md). Real files contain client data; keep them out of the repository.
- **Marketplace and GST files, Tally exports, invoices.** The tests use synthetic fixtures built from the published layouts; they show the code does what the fixtures say, not that a platform's current export matches.
- **GST portal.** No GST portal upload has been tried. GST output is described as a draft for CA review.

## Adding a test

- API: add `*.test.ts` beside the code in `backend/api/src`. The `test` script finds it; no list to update. Use `node:test` and `node:assert/strict`.
- Any new `z.array(` that takes request data needs a `.max(n)`; `zodArrayLimits.test.ts` fails otherwise.
- A new gateway route goes in `backend/gateway/internal/routes/protected.go` with its permission. There is no way to add one that skips the check, and `authz_test.go` fails if the permission name does not exist in `permissions.ts`. If the gateway has a wildcard route (`/api/workflow/runs/{id}`) and the API owns a fixed address under it (`/api/workflow/runs/suggest-name`), add the fixed address to `ProxiedLiteralRoutes`; `proxied_test.go` fails if it is shadowed or listed without cause.
- A new table or column goes in a new `lib/db/migrations/NNNN_*.sql` (additive and safe to run twice) and in the Drizzle schema, in the same commit. Apply it to the live database before deploying code that reads it.
- Quick browser: add `*.spec.ts` in `frontend/e2e`, mock `**/api/**`, and sign in by seeding `localStorage` as the existing specs do.
- Real backend: add `*.spec.ts` in `frontend/e2e-real`. Make an account with `signedUpAccount` (`helpers.ts`), use `statValue` and `settledText` rather than reading a count that is still animating, and put expected figures in `data.ts` worked out by hand from the file, not copied from what the screen showed.
