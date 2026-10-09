# TallyThis Railway deployment

Deployed on 9 October 2026 in Webcoin Labs's Projects.

- Dashboard: https://railway.com/project/2e743b6d-f44d-401d-b776-a5eb11d179fc
- Public gateway: https://gateway-production-5253.up.railway.app
- Health: https://gateway-production-5253.up.railway.app/api/health
- Source: `anshitraj/tally-this`, branch `main`, release `430c936874d33ed321b95c7f911bfea285158a57`.
- All three services are connected to GitHub main for automatic deployment.

| Service | Exposure | Dockerfile | Health check |
| --- | --- | --- | --- |
| gateway | Public HTTPS, port 8090 | `backend/gateway/Dockerfile` | `/api/health` |
| api | Private, port 8080 | `backend/api/Dockerfile` | `/api/health` |
| worker | Private, port 8091 | `backend/worker/Dockerfile` | `/health` |

Each build uses repository root `/`. Each service has one replica, a 300-second
startup health-check window, and an on-failure restart policy with five retries.
API and gateway use the existing Neon database and a shared strong JWT secret.
Only API receives Cloudflare R2 credentials. No migration or demo seed was run.
The configured website origin is `https://tallythis.xyz` and the support address
is `contact@tallythis.xyz`. This does not provision a mailbox or change DNS.

## Connect Vercel

In the Vercel frontend project's environment variables, set this for Production:

```text
BACKEND_ORIGIN=https://gateway-production-5253.up.railway.app
```

Redeploy the frontend after saving it. Use Root Directory `frontend`, include
source files outside the root, and use the repository's `vercel.mjs` configuration.
Do not append `/api` to BACKEND_ORIGIN. Never copy database, JWT, R2 or provider
secrets into Vercel frontend variables.

Add `tallythis.xyz` in that Vercel project's Domains settings and apply the exact
DNS records Vercel supplies at the registrar. The initial deployment check timed
out. A later check on 9 October 2026 confirmed that `https://tallythis.xyz/`,
`/login` and `/app/jobs/bank-to-tally` return frontend HTML with HTTP 200.
`https://tallythis.xyz/api/health` returns HTTP 200 and reports the Go gateway,
TypeScript fallback, Python worker and database as healthy. Unauthenticated
`/api/account/plan` and `/api/auth/me` return HTTP 401, as expected.

This confirms the custom-domain frontend and same-origin API proxy are reachable.
It does not verify an authenticated upload, export, Tally import or GST filing.
The improvements on `codex/finverify-upload-architecture`, including the Normal /
Incognito selector, are separate from the deployed `main` release. Pushing that
branch does not update the production deployment. The current deployed commit
must be checked in each host's release dashboard before claiming feature delivery.

## Verification and remaining work

All three Railway Linux Docker builds and startup health checks succeeded.
The public gateway reported healthy API, Python worker and database connections.
The proxied API health response reported `db: ok` and `r2: ok`.
A synthetic R2 object was uploaded, downloaded with a signed URL and deleted.
Unauthenticated account, overview and client-list requests returned 401; empty
login returned 400; demo login returned 403. No customer data was modified.

Google/GitHub OAuth and optional AI credentials have not been enabled. Existing
email/password authentication endpoints are available. Redis is not required by
the current deployment.

These checks establish infrastructure operation, not complete product readiness.
Full authenticated upload/review/export flows through the Vercel proxy still need
verification, including real upload-size limits. Resolve the existing application
security and privacy blockers in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)
before onboarding customers with financial documents. The gateway's existing CORS
middleware also adds a wildcard alongside the API's configured origin on proxied
responses; use the intended same-origin Vercel proxy and fix this before supporting
direct browser requests to Railway.
