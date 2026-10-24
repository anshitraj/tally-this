# Phase 0: stabilisation record

24 October 2026. Branch `phase0/stabilize`, built on local `main`.

Aim: close the authorisation, worker and Tally-connector gaps found in the code review, make the screens say only what the product does, and add regression protection. Not in scope and not done: a frontend rewrite, new services, a database change, removing any legacy feature, the Windows companion.

Nothing here was deployed, and no production data was read or changed. Everything below was verified on a development machine; the "Not verified" list is part of the record.

## Security fixes

| Gap found | What it allowed | Now |
| --- | --- | --- |
| **Go gateway checked sign-in but not role.** Its reconciliation, workflow, upload-import and action-history routes accepted any signed-in person. | A `viewer` could run, approve or reject reconciliation and import files through the gateway, which the Express API would have refused. | All 15 gateway routes go through `Authorizer.Require(permission)`, using the same `role_permissions` table as Express (`backend/gateway/internal/routes/protected.go`). No sign-in: 401. Role without the permission: 403 and an `auth.permission_denied` audit row. Lookup failure: 500, never allow. A route cannot be registered without naming its permission. Tests read the role table from `permissions.ts`, so a permission the API does not know, or a role mismatch, fails a test. |
| **Python worker had no authentication.** | Anyone who could reach port 8091 could parse files, call the AI reader and use the Tally connector. | Every route except `/health` needs `X-Service-Token` (`WORKER_SERVICE_TOKEN`). In production the worker refuses all requests (503) unless the token is set and at least 24 characters. API docs and CORS are off in production. The API sends the token (`services/workerClient.ts`). The worker and gateway images now set `APP_ENV=production` themselves, as the API image already set `NODE_ENV=production`, so a Railway service that missed the variable cannot start in development mode. |
| **Tally connector fetched whatever address the browser sent** (server-side request forgery). | A signed-in user could make the server call internal services or cloud metadata addresses. | Address must be this computer or a host an administrator listed in `TALLY_ALLOWED_HOSTS`; port 9000 or one in `TALLY_ALLOWED_PORTS`. Cloud metadata, link-local, unspecified and multicast addresses are never allowed. The worker resolves the name, checks every answer, connects to the address it checked, follows no redirects and ignores proxy settings. Off by default in production (`TALLY_CONNECTOR_ENABLED`). Local development with TallyPrime on `localhost:9000` still works. Both the API and the worker apply the rules. |
| **Signing-secret fallback.** The Go gateway and the Express API used a published development secret when none was set. | Anyone could mint a valid session for any account on a deployment that missed the variable. | In production both services refuse to start, and refuse to sign or verify, with a missing secret, a value published in this repository (the development fallback, and the sample in `.env.example`, which at 33 characters would otherwise pass the length rule), or fewer than 32 characters. A test follows whatever sample `.env.example` shows. |
| **Secrets in logs.** | A database or provider error can carry the whole connection string or an API key in its message, and logs are shared with support and the hosting dashboard. | The logger scrubs database URLs, common API-key shapes (Google, Anthropic/OpenAI-style, GitHub, Resend, Neon), bearer tokens and `password=`/`token=`/`secret=` pairs from every logged string, including inside errors (`lib/scrub.ts`). It is a safety net for logged errors, not a reason to log secrets. |
| **Dependencies.** Upload path and transitive packages had advisories. | | `multer` 2.5.0, `body-parser` 2.4.0, `fast-uri` 4.2.3, `uuid` 11.1.1 under exceljs, zod 4.6.6 inside the Neon sign-in SDK. Production advisories: 9 (5 high) down to 2. |

### Accepted advisory

zod 3.25.76 (GHSA-mrhx-c7xc-m3w5, high): out-of-memory when validating a huge array whose schema has no length limit. The fix exists only in zod 4, a major upgrade across the API. Mitigation: every `z.array(` that takes request data has a `.max()`, enforced by `zodArrayLimits.test.ts` (the arrays without one only parse AI model replies, which the model's own output limit bounds). The advisory is listed in `scripts/audit-allowlist.json` with a review date of 31 December 2026; CI fails after that date. Plan: move to zod 4 in Phase 1.

The other remaining advisory is esbuild (low), used only to build.

## Screens that said more than they did

- **Send to Tally** is offered only where it can work (TallyThis running on the same computer or network as TallyPrime) and is marked Experimental. On the hosted site the button is Export, with a plain explanation of how to import the XML into Tally. XML download was never a verified import; it is now described as a file to import.
- **Tax Audit and Connections** no longer show Tally set-up steps on a site that cannot reach Tally.
- **Settings Save** now saves. It calls `PATCH /api/company`, shows Saved only after the server confirms, and shows the server's reason when it refuses (for example a malformed GSTIN). Made-up values (CIN, state, city, CA name) and switches that did nothing were removed or marked "Coming soon". Two-factor sign-in is marked as coming soon. The data-export button is an email link.

## API changes

Security-driven. No path or field was removed.

| Change | Who is affected |
| --- | --- |
| New `PATCH /api/company` (needs `settings.manage_company`). Fields: `name`, `gstin`, `pan`, `caEmail`, `financialYearStart`. | Settings page only. |
| `POST /api/jobs/bank-to-tally/send`, `POST /api/jobs/bills/send`, `POST /api/jobs/payroll/send`, `GET /api/jobs/tally/ledgers` answer **409** `{ok:false, message}` when live Tally is off (the production default). | Anyone sending to Tally from the hosted site. The XML download routes are unchanged. |
| `GET /api/jobs/tally/status` now includes `available`. When off, it answers without contacting Tally. `?check=0` answers `available` without a probe. | Frontend. |
| `POST /api/tax-audit/connector/sync` answers **403** for an address or port that is not allowed, or when the connector is off. | Tally connector users. |
| Gateway reconciliation, workflow, import and action-history routes answer **403** to roles lacking the matching permission. | Any client that used the gateway as a way around role checks. |
| Worker: every route except `/health` needs `X-Service-Token`. | Only the API calls the worker. Anything else calling it directly must send the token. |
| Production start: API and gateway exit on a weak or missing signing secret; the worker answers 503 without its token. | Operators. |

## Deployment steps

Do these before, or together with, deploying this branch. Order matters for the first two.

1. **Set `WORKER_SERVICE_TOKEN`** to the same random value, at least 24 characters (use 32 or more), on the Railway `api` and `worker` services. Not on the gateway or the frontend. Enter it yourself in Railway; do not paste it into chat or a file. Without it, the worker refuses every request in production and the API falls back to its built-in readers, which are slower on large files but give the same figures.
2. **Check `JWT_SECRET` (or `SESSION_SECRET`)** is at least 32 characters and is **not** the value in `.env.example`, on both `api` and `gateway`, and is the same on both. The services now exit at start-up otherwise. This was the case at the last check (64 characters on both).
3. **Set `CORS_ORIGIN`** on the gateway to the frontend origin (`https://www.tallythis.xyz`). Without it the gateway allows no cross-origin browser request. The Vercel proxy is same-origin, so normal use is unaffected.
4. **Leave `TALLY_CONNECTOR_ENABLED` unset** in production. Setting it `true` lets a cloud server connect out to Tally addresses; do so only for a deliberate private-network deployment, with `TALLY_ALLOWED_HOSTS` and `TALLY_ALLOWED_PORTS` listing exactly what is needed.
5. **Keep the worker private** (no public domain; Railway private networking). The token is a second lock, not a replacement for this.
6. Deploy `worker` and `api` first, then `gateway`, as before. Check the health responses. Then, as an owner account, open Settings, change a field, save, reload.
7. After the next sign-in test with real Neon Auth accounts has passed, set `LEGACY_PASSWORD_LOGIN=false` (carried over from earlier work; not part of this branch).

Rollback: redeploy the previous Railway release for each service. This branch changes no table definition and runs no migration. The only new write is Settings Save, which updates the existing company columns.

## Not verified

- **The CI workflow has not run on GitHub.** Each job's commands were run locally.
- **No real TallyPrime import.** The acceptance runners (`verify-tally`, `verify-tally-books`) have never been run. Nothing here changes what XML is produced.
- **No database-backed test of the changed routes** (`PATCH /company`, the 409 and 403 answers, `tally/status`, the gateway's permission lookup on the real `role_permissions` table). They are covered by pure-function tests, the typecheck, and mutation checks that deliberately break the code and confirm tests fail.
- **Not deployed.** Docker images were not rebuilt and no Railway service was touched.
- **Neon sign-in** (sign-up, code, reset, Google, GitHub, Safari) still needs a live test by the owner.
- `TALLY_URL` is one setting for the whole API process: if live Tally were ever switched on for a multi-tenant host, every client would share it. Another reason it stays off in production.
- The Go gateway still carries its older reconciliation engine alongside the TypeScript one. Which one answers a given screen is unchanged; removing the duplicate is outside Phase 0.
- Local `.env` files have pointed at the production database. Use a separate Neon branch for development.

## Existing work preserved

Bills → Tally, GST sales (GSTR-1 and 3B workings), Payroll, the OCR and Canara reader work and every earlier commit are intact on this branch: it contains local `main` in full. At the time of writing those commits (five on top of GitHub's `main`) existed only on the development machine. The test counts in [TESTING.md](TESTING.md) include their tests: the API suite went from 190 to 211 tests and the browser suite from 73 to 78, with none removed or changed to pass.
