# Deploy TallyThis: Vercel + Google Cloud VM + Neon + R2

The website runs on Vercel. The backend (the Go gateway, the TypeScript API and the Python worker) runs in Docker on one virtual machine in your own Google Cloud project. Records live in Neon (Postgres) and uploaded files in Cloudflare R2. This replaced Railway after [Railway's 21 October 2026 security disclosure](https://blog.railway.com/p/security-disclosure-wednesday-october-21st); see [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md).

Use a staging copy first. Folder organization and build configuration do not resolve the security blockers documented in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).

## Repository layout

```text
frontend/                 React/Vite landing page and accounting workspace
  vercel.mjs              Output, SPA routes and the configurable /api proxy to the backend
  .env.example            Frontend deployment variables (no secrets)
backend/
  api/                    TypeScript authentication, workflows, reports and R2
  gateway/                Go API entry point and reconciliation routes
  worker/                 Python extraction/parsing service
                          (each has a Dockerfile and an .env.example)
deploy/vm/                Scripts and the compose file that run the three services on the Google Cloud VM
lib/db/                   Database schema, the migrations (lib/db/migrations) and their runner
lib/                      Generated API types
scripts/                  Maintenance tools; scripts/stack runs the whole product on one computer for tests
docs/                     Deployment and product documentation
```

Keep one GitHub repository, `anshitraj/tally-this`. There is one Vercel project and one Google Cloud VM. PostgreSQL (Neon) and object storage (R2) are external services.

## 1. Database (Neon)

The TypeScript API reaches Neon over HTTP (`@neondatabase/serverless` with Drizzle's Neon HTTP driver). It uses a plain Postgres connection only when the database host is this computer (`localhost`, `127.0.0.1`, `::1`), which is how the tests run; a real database never gets that driver. Keep the existing Neon database; Supabase is not a drop-in replacement.

**Schema.** `lib/db/migrations/*.sql` are applied in order by one command, each file once, in its own transaction, and recorded in the table `schema_migrations`:

```sh
DATABASE_URL=postgresql://... pnpm --filter @workspace/db run migrate -- --check            # lists what is not applied; changes nothing
DATABASE_URL=postgresql://... pnpm --filter @workspace/db run migrate -- --remote           # applies it (--remote is required away from this computer)
```

The address must be in the environment: the runner never reads a `.env` file, so it cannot reach a real database by accident. The files only add things and are safe to run again, so the live database, which predates the runner, simply records them as applied. **Apply migrations before deploying code that needs them**: the API reads every column of a table, so code that expects a new column fails on a database that does not have it yet. `0004` adds the `company_id` indexes and a case-blind unique index on `users.email`; the unique index fails loudly, and changes nothing, if two accounts already share an address (the live database had none when checked on 25 October 2026). Use a separate Neon branch for staging, and keep migration credentials private.

## 2. Create private Cloudflare R2 storage

Create a private bucket and scoped read/write credentials for the API. Disable public access; do not configure `CLOUDFLARE_R2_PUBLIC_URL` for financial documents. The API uses:

```text
STORAGE_PROVIDER=r2
CLOUDFLARE_R2_ACCOUNT_ID=<your account id>
CLOUDFLARE_R2_BUCKET=<your private bucket>
CLOUDFLARE_R2_ACCESS_KEY_ID=<scoped access key>       (secret)
CLOUDFLARE_R2_SECRET_ACCESS_KEY=<scoped secret>        (secret)
```

The API derives the endpoint from the account ID, or accepts `CLOUDFLARE_R2_ENDPOINT` explicitly. Test signed downloads, deletion and permissions with synthetic files. R2 stores files; Neon stores application records. Redis is not required by the current code.

## 3. The backend on a Google Cloud VM

[GCP_VM_DEPLOYMENT.md](GCP_VM_DEPLOYMENT.md) is the runbook: what runs where, how it is secured, the first-time steps, and every day-to-day command (`deploy/vm/deploy.sh`, `set-secrets.sh`, `ssh.sh`, `smoke-test.sh`). In short:

- Only **Caddy** listens to the internet (ports 80 and 443, with its own HTTPS certificate). The gateway, API and worker publish no ports and talk over a private Docker network.
- **Secrets** are in Google Secret Manager, never in a file or in Vercel. At start the VM's own identity fetches them into memory and each container gets only what it uses: the gateway gets the database address and signing secret; the API gets those, the worker token, the storage keys and the AI keys; the worker gets only the worker token.
- **Non-secret settings** are in `deploy/vm/runtime.env` (see `runtime.env.example`): the public address, the site origin, the R2 account and bucket, the Neon sign-in addresses, the AI model names, upload and history limits. In production the API runs with `NODE_ENV=production` and `ALLOW_DEMO_SEED=false`, the worker with `APP_ENV=production`, so the worker refuses every request without its token and the sample-workspace login is closed.
- `JWT_SECRET` must be at least 32 random characters and not a value from this repository; the API and gateway exit at start-up otherwise. The worker token must be at least 24 characters and identical on the API and the worker. Leave `TALLY_CONNECTOR_ENABLED` unset: a cloud server cannot reach an accountant's TallyPrime.
- `CORS_ORIGIN` on the gateway is the website origin (comma-separated if several). In production it allows cross-origin browser requests only from these origins, and from none if it is unset. The Vercel proxy is same-origin and needs none.

Merging to `main` deploys only the website (through Vercel). The backend is deployed by hand with `bash deploy/vm/deploy.sh`, which sends a committed revision to the VM, builds the images there and rolls back by itself if the new release does not become healthy.

## 4. Deploy the frontend to Vercel

Import the same repo with:

| Setting | Value |
| --- | --- |
| Root Directory | **`frontend`** |
| Include source files outside Root Directory | Enabled |
| Framework | Vite |
| Node.js | 22.x |
| Package manager | pnpm 10.28.0 (root package pin) |
| Install command | `pnpm install --frozen-lockfile` |
| Build command | `pnpm run build` |
| Output Directory | **`dist/public`** |
| Production Branch | `main` |

Add one Vercel variable: **`BACKEND_ORIGIN`**, the HTTPS address of the backend, with no path or `/api` suffix: `https://api.tallythis.xyz`. Set it for Production and redeploy; a changed variable only applies to a new deployment. `vercel.mjs` reads it at deployment time; it is not a browser secret. Never put `DATABASE_URL`, JWT, R2, OAuth secrets or AI keys in frontend variables, especially ones beginning with `VITE_`.

This keeps all browser requests at `/api` on the website's own origin and forwards them to the backend. It also serves the React application when `/login`, `/onboarding` or dashboard routes are opened directly. Without `BACKEND_ORIGIN`, only the public landing page works. See [VERCEL_FRONTEND.md](VERCEL_FRONTEND.md) for how Vercel's limits affect long requests (a proxied request is cut at 120 seconds).

## 5. Domain, sign-in and email

DNS for `tallythis.xyz` is hosted at Spaceship (name servers `launch1.spaceship.net` and `launch2.spaceship.net`). The website's records point at Vercel; the record `api` points at the VM's reserved address and must stay **DNS only** if DNS ever moves to a provider with a proxy, because the VM gets its own certificate.

Provider callback URLs for optional OAuth must match exactly: `https://<website domain>/api/auth/google/callback` and `https://<website domain>/api/auth/github/callback`. Setting `contact@tallythis.xyz` in the app does not create a mailbox: set up the mailbox, MX/SPF/DKIM/DMARC, and the sign-in email sender described in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) before public registration.

## Verification and remaining launch work

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/db test
pnpm run build
pnpm test:deployment
node scripts/audit-gate.mjs
(cd backend/gateway && go vet ./... && go test ./...)
(cd backend/worker && python -m pytest tests -q)
python -m pytest deploy/vm/tests -q
pnpm --filter @workspace/finverify-os exec playwright test
```

The last command is the quick browser suite with every answer pretended. The thorough one runs the real worker, API and gateway on a Postgres on this computer and drives the product in a browser:

```sh
STACK_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/tallythis_stack pnpm --filter @workspace/finverify-os run test:real
```

All of these run on every pull request in `.github/workflows/ci.yml`. What each one does and does not prove, and which checks need a real TallyPrime or the live site, is in [TESTING.md](TESTING.md). For the optional local Docker stack, fill the root `.env` and use `docker compose up --build`; it uses your configured Neon database, not a new local Postgres instance, so point `DATABASE_URL` at a development database, never the live one.

Before using real client documents, verify the items in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md): retention and deletion, OAuth and account verification, mailbox delivery, alerts, backup restoration, privacy and terms, rollback and support. Billing is only needed before selling paid plans. These remain release work; folder separation does not certify production readiness.

References: [Vercel programmatic configuration](https://vercel.com/docs/project-configuration/vercel-ts),
[Vercel monorepo sources](https://vercel.com/docs/monorepos/monorepo-faq),
[Google Cloud Secret Manager](https://cloud.google.com/secret-manager/docs),
[Cloudflare private R2 access](https://developers.cloudflare.com/r2/buckets/public-buckets/).
