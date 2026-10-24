# Testing TallyThis

What each test layer covers, how to run it, and what it needs. Passing tests here show that the code behaves as the tests describe. They do not show that a real TallyPrime accepts an import, that the GST portal accepts a file, or that a bank statement layout the tests have never seen is read correctly. Those need the checks in the last section.

Counts below are from the Phase 0 run on 24 October 2026 (see [PHASE0_STABILIZATION.md](PHASE0_STABILIZATION.md)). They will drift; the commands are what matter.

## Automatic: runs on every pull request

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs these five jobs. None needs a database, a Tally installation, cloud storage or an AI key. Nothing in the workflow deploys anything. The workflow had not run on GitHub when this was written: the local runs below are the evidence so far.

| Job | Command | What it covers | Last local result |
| --- | --- | --- | --- |
| TypeScript | `pnpm run typecheck`, `pnpm --filter @workspace/api-server test`, `pnpm run build` | Types for libraries, API and frontend. Parsers, matching, Tally/GST/payroll XML builders, permissions, security configuration, log scrubbing, the Settings validator. The production build. | API tests 211 pass. |
| Dependency advisories | `node scripts/audit-gate.mjs` | Fails on a new critical or high advisory in production dependencies, and on an accepted one past its review date (`scripts/audit-allowlist.json`). Needs the npm registry. | 2 advisories left: zod 3 (accepted, guarded by `zodArrayLimits.test.ts`, review by 31 Dec 2026), esbuild (low, build tool only). |
| Go gateway | `cd backend/gateway && gofmt -l . && go vet ./... && go test ./...` | Sign-in token checks, signing-secret rules, and the permission check on every gateway route, including the 401, 403 and fail-closed cases. The role table is read from the API's `permissions.ts`, so the two cannot drift without a test failing. | Pass. |
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

## Manual: needs a real database

None of these run in CI. They talk to the database named in `DATABASE_URL`, so point them at a **separate Neon branch or a throwaway database, never production**. The `.env` file used for local work has historically held the production connection string; check it before running anything below.

| Check | How | What it shows |
| --- | --- | --- |
| API and database are up | `pnpm run test:db` (needs the API running; reads `/api/health`) | The API reaches its database. It does not test any route. |
| Route behaviour with real data | Start the API and gateway against the test database, then use the app | The routes below have **no automated test that runs them against a database**. Their logic is covered by unit tests on the pure functions they call; the wiring is covered by the typecheck only. |

Routes in that second row that changed in Phase 0 and have not been exercised against a database: `PATCH /api/company`, the `409` answer on `/api/jobs/*/send`, `GET /api/jobs/tally/status` and `GET /api/jobs/tally/ledgers`, the `403` on `/api/tax-audit/connector/sync`, and the Go gateway's permission lookup against the real `role_permissions` table. Open Settings, save a change, and reload; try a Bank → Tally send on a hosted build; call a gateway reconciliation route as a viewer. Writing database-backed route tests is a recommended Phase 1 item.

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
