# Testing TallyThis

What each test layer covers, how to run it, and what it needs. Passing tests here show that the code behaves as the tests describe. They do not show that a real TallyPrime accepts an import, that the GST portal accepts a file, or that a bank statement layout the tests have never seen is read correctly. Those need the checks in the last section.

Counts below are from the Phase 0 run on 24 October 2026 (see [PHASE0_STABILIZATION.md](PHASE0_STABILIZATION.md)). They will drift; the commands are what matter.

## Automatic: runs on every pull request

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs these six jobs. None needs a Tally installation, cloud storage or an AI key, and the only database is a throwaway Postgres the job starts for itself. Nothing in the workflow deploys anything. The workflow had not run on GitHub when this was written: the local runs below are the evidence so far.

| Job | Command | What it covers | Last local result |
| --- | --- | --- | --- |
| TypeScript | `pnpm run typecheck`, `pnpm --filter @workspace/api-server test`, `pnpm run build` | Types for libraries, API and frontend. Parsers, matching, Tally/GST/payroll XML builders, permissions, security configuration, log scrubbing, the Settings validator. The production build. | API tests 212 pass. |
| Dependency advisories | `node scripts/audit-gate.mjs` | Fails on a new critical or high advisory in production dependencies, and on an accepted one past its review date (`scripts/audit-allowlist.json`). Needs the npm registry. | 2 advisories left: zod 3 (accepted, guarded by `zodArrayLimits.test.ts`, review by 31 Dec 2026), esbuild (low, build tool only). |
| Go gateway | `cd backend/gateway && gofmt -l . && go vet ./... && go test ./...` | Sign-in token checks, signing-secret rules, and the permission check on every gateway route, including the 401, 403 and fail-closed cases. The role table is read from the API's `permissions.ts`, so the two cannot drift without a test failing. | Pass. |
| Go gateway against Postgres | `go test ./internal/routes/ -run RealDatabase` with `GATEWAY_TEST_DATABASE_URL` set (see below) | The gateway's real sign-in and permission SQL against the real tables: every role against every permission the gateway's routes use (allowed exactly where the API's role table allows), expired, revoked, forged and wrong-company sessions, disabled users, a permission switched off, a role with no rows, another company's rows not widening access, and the audit row written for each refusal. CI starts a Postgres service container and creates the schema with `pnpm --filter @workspace/db run push`; a skipped check fails the job. | 3 pass locally against a throwaway Postgres 18; mutation-checked (dropping the role condition, the `enabled` condition, or the revoked-session condition each fails it). |
| Python worker | `cd backend/worker && python -m pytest tests -q` | Service-token check on every worker route, production fail-closed start, and the Tally connector's address rules (loopback, private ranges, cloud metadata, DNS answers, redirects). | 81 pass. |
| Browser | `pnpm --filter @workspace/finverify-os exec playwright test` | The screens, with every API answer pretended. Playwright starts the Vite dev server itself. Includes `phase0-honesty.spec.ts`: the hosted site must not offer sending straight to Tally, and Settings must say Saved only after the server confirms. | 78 pass. |

Run everything locally from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/api-server test
pnpm run build
node scripts/audit-gate.mjs
(cd backend/gateway && go vet ./... && go test ./...)
(cd backend/worker && python -m pytest tests -q)
pnpm --filter @workspace/finverify-os exec playwright test
```

The worker tests need `pip install -r backend/worker/requirements.txt pytest`. The browser tests need `pnpm --filter @workspace/finverify-os exec playwright install chromium` once.

## Needs a real database

Everything here talks to a database. Use a **throwaway Postgres on your own computer, never the production Neon database**. The `.env` file used for local work has historically held the production connection string; check it before running anything.

| Check | How | What it shows |
| --- | --- | --- |
| Gateway sign-in and permission SQL | Start a local Postgres, create the schema with `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/tallythis_test pnpm --filter @workspace/db run push`, then `GATEWAY_TEST_DATABASE_URL=<same address> go test ./internal/routes/ -run RealDatabase -v` from `backend/gateway`. Runs in CI. | See the table above. The test refuses any host except this computer, adds rows under one company named "Gateway test ..." and removes them afterwards. Without the variable it skips. |
| API and database are up | `pnpm run test:db` (needs the API running; reads `/api/health`) | The API reaches its database. It does not test any route. |

**The API's routes have no committed database-backed test.** The API talks to Neon through its HTTP driver, which cannot connect to a plain local Postgres, so a route test needs the database layer made swappable (a Phase 1 item). Their logic is covered by unit tests on the pure functions they call; the wiring by the typecheck.

For Phase 0 the changed routes were instead exercised once by hand (24 October 2026): the real worker, the real Go gateway and a throwaway build of the real API whose only difference was a plain `pg` connection in place of the Neon HTTP driver, all against a throwaway Postgres 18 holding the Drizzle schema. 52 checks passed:

- `PATCH /api/company` saves valid details, refuses a bad GSTIN with a reason and changes nothing, ignores fields the Settings page does not own (plan, retention, currency, id), refuses an empty save, writes an audit row, answers 403 to a viewer, and answers 401 when not signed in.
- In production mode `POST /api/jobs/{bank-to-tally,bills,payroll}/send` and `GET /api/jobs/tally/ledgers` answer 409 with the plain explanation, `GET /api/jobs/tally/status` reports not available without contacting Tally, and the tax-audit connector refuses a cloud-metadata address and even `localhost`. In development mode status says available, metadata, private and non-Tally addresses are refused, and `localhost:9000` reaches the worker.
- Through the real gateway in production mode, 11 of its 15 routes were called (the other four share their permissions with these): founder allowed, viewer allowed or refused as the API's role table says, anonymous 401. Express answered the viewer the same way as the gateway for `reconciliation/run`, refusals were audited, and `CORS_ORIGIN` was honoured (an unlisted origin got no allow header).
- The upload route reached the worker with the shared token (200 in the worker's log); without the token the worker answered 401 and the upload still completed through the built-in reader.

The same session loaded the real Settings and Connections pages in a browser against that stack: an invalid GSTIN showed "Not saved" with the server's reason, a valid save reached the database and survived a reload, and the Connections page said that sending straight to Tally needs TallyThis on the same computer as TallyPrime.

That harness was not kept in the repository: it depended on the swapped driver and on a local Postgres install. The Neon HTTP driver path itself, and any route not listed above, were not exercised. Database-backed route tests in CI are the first Phase 1 testing item.

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
- A new gateway route goes in `backend/gateway/internal/routes/protected.go` with its permission. There is no way to add one that skips the check, and `authz_test.go` fails if the permission name does not exist in `permissions.ts`.
- Browser: add `*.spec.ts` in `frontend/e2e`, mock `**/api/**`, and sign in by seeding `localStorage` as the existing specs do.
