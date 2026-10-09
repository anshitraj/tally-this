# Deploy TallyThis: Vercel + Railway + Neon + R2

Use this setup for staging first. Folder organization and build configuration do
not resolve the security blockers documented in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).

## Repository layout

```text
frontend/                 React/Vite landing page and accounting workspace
  vercel.mjs              Output, SPA routes and configurable Railway proxy
  .env.example            Frontend deployment variables (no secrets)
backend/
  api/                    TypeScript authentication, workflows, reports and R2
    Dockerfile
    .env.example
  gateway/                Go API entry point and reconciliation routes
    Dockerfile
    .env.example
  worker/                 Python extraction/parsing service
    Dockerfile
    .env.example
lib/                      Shared database schema and generated API types
scripts/                  Database migration and maintenance tools
docs/                     Deployment and product documentation
artifacts/mockup-sandbox/  Optional design sandbox, not the production frontend
```

Keep one GitHub repository, `anshitraj/tally-this`. There is one Vercel project
and three Railway services. PostgreSQL and object storage are external services.
Existing package names and database schema names are preserved for compatibility.

## 1. Keep the existing Neon database

The TypeScript API uses `@neondatabase/serverless` with Drizzle's Neon HTTP driver.
Keep the existing Neon PostgreSQL database; Supabase is not a drop-in replacement
for this driver. Do not create a second database or copy production data as part
of deployment setup.

Set `DATABASE_URL` on both Railway `api` and `gateway` services to the same intended
Neon database connection URL, with TLS enabled. Use a separate Neon branch/database
for staging. Keep migration credentials and direct connection URLs private.
Review the existing schema and SQL migrations before applying any changes; these
deployment files do not automatically migrate or seed your database.

## 2. Create private Cloudflare R2 storage

Create a private bucket and scoped read/write credentials for the API. Disable
public access; do not configure `CLOUDFLARE_R2_PUBLIC_URL` for financial documents.
Set these on **api only**:

```text
STORAGE_PROVIDER=r2
CLOUDFLARE_R2_ACCOUNT_ID=<your account id>
CLOUDFLARE_R2_BUCKET=<your private bucket>
CLOUDFLARE_R2_ACCESS_KEY_ID=<scoped access key>
CLOUDFLARE_R2_SECRET_ACCESS_KEY=<scoped secret>
```

The API derives the endpoint from the account ID, or accepts
`CLOUDFLARE_R2_ENDPOINT` explicitly. Test signed downloads, deletion and permissions
with synthetic files. R2 stores files; Neon stores application records. Redis is
not required by the current code and does not replace file storage. Add it only
when implementing shared rate limits, caching or a durable job queue.

## 3. Create three Railway services from the same repo

Create services named **`api`**, **`worker`**, **`gateway`** in one Railway project
and environment. Select the branch containing this layout. After merging, use `main`.
Keep **Root Directory `/`** for all three: each Dockerfile uses repository-root
COPY paths, and the API needs shared workspace packages.

| Service | `RAILWAY_DOCKERFILE_PATH` | Set `PORT` | Healthcheck | Public domain |
| --- | --- | --- | --- | --- |
| api | `backend/api/Dockerfile` | `8080` | `/api/health` | None |
| worker | `backend/worker/Dockerfile` | `8091` | `/health` | None |
| gateway | `backend/gateway/Dockerfile` | `8090` | `/api/health` | Generate HTTPS domain |

Use the Dockerfile's default start command; no dashboard build/start override is
needed. Set healthcheck timeout to 120 seconds and restart on failure. Adding
`RAILWAY_DOCKERFILE_PATH` tells Railway which Dockerfile to build.
Use each service's `.env.example` as a variable checklist, replacing blanks with
real values in Railway; do not upload `.env` files to GitHub.

On **api**:

- `NODE_ENV=production`, `APP_ENV=production`, `PORT=8080`, `ALLOW_DEMO_SEED=false`.
- `DATABASE_URL`, a strong random `JWT_SECRET`, and the R2 variables above.
- `PYTHON_WORKER_URL=http://worker.railway.internal:8091`.
- `APP_URL`, `API_PUBLIC_URL`, and `CORS_ORIGIN`: the final **frontend HTTPS origin**
  because OAuth returns through Vercel's same-origin `/api` proxy.
- `SUPPORT_EMAIL=contact@tallythis.xyz`.

On **gateway**:

- `NODE_ENV=production`, `APP_ENV=production`, `PORT=8090`, `GO_API_PORT=8090`.
- The same `DATABASE_URL` and `JWT_SECRET` as api.
- `TYPESCRIPT_API_URL=http://api.railway.internal:8080`.
- `PYTHON_WORKER_URL=http://worker.railway.internal:8091`.
- `CORS_ORIGIN`: the frontend origin.

On **worker**:

- `PORT=8091`, `PYTHON_WORKER_PORT=8091`; keep this service private.
- AI keys/models are optional and belong only on the services using them. Ordinary
  file parsing and rule-based workflows work without an AI key. The API container
  includes Tesseract and Poppler for its local OCR fallback.

The private hostnames above assume these exact service names. If Railway displays
different private domains, use the actual service domains. Deploy worker and api
first, then gateway. Check every service's logs and health response without printing
secrets. Do not expose the extraction worker or create public Tally ports.

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
| Production Branch | `main`, after merging this layout |

Add one Vercel variable: **`BACKEND_ORIGIN`**, whose value is the public HTTPS
Railway **gateway** origin, with no path or `/api` suffix. For example, replace
`https://your-actual-gateway.up.railway.app` with your real hostname. Set it for
the intended deployment environment and redeploy. It is used by `vercel.mjs` at
deployment time; it is not an AI/storage credential or a browser secret.

This keeps all browser requests at `/api` on the frontend origin and forwards them
to Railway. It also serves the React application when `/login`, `/onboarding` or
dashboard routes are opened directly. Without `BACKEND_ORIGIN`, only the public
landing page is usable. Never put `DATABASE_URL`, JWT, R2, OAuth secrets or AI keys
in frontend variables, especially ones beginning with `VITE_`.

**Existing Vercel project:** change Root Directory from `artifacts/finverify-os`
to `frontend` when deploying this layout. Confirm the intended `.vercel.app`
hostname is assigned under Domains. See [VERCEL_FRONTEND.md](VERCEL_FRONTEND.md)
for the root-404 investigation; a successful build alone does not confirm the
correct output/domain has been published.

## 5. Domain, sign-in and email

Choose the confirmed website hostname in Vercel and follow its exact DNS records.
The earlier request mentioned both `tally.xyz` and `tallythis.xyz`; this code does
not choose or alter either domain's DNS.

Configure optional OAuth on api. Provider callback URLs must match exactly:
`https://<frontend-domain>/api/auth/google/callback` and
`https://<frontend-domain>/api/auth/github/callback`.
Setting `contact@tallythis.xyz` in the app does not create a mailbox. Set up the
mailbox, MX/SPF/DKIM/DMARC, then implement and test transactional account verification
and recovery before public registration is launched.

## Verification and remaining launch work

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test:deployment
pnpm --filter @workspace/api-server test
```

Go: `cd backend/gateway && go test ./...`. Python: install
`backend/worker/requirements.txt`, then run the worker tests from that folder.
Run the existing frontend browser tests against a running dev or preview server.
For the optional local Docker stack, fill the root `.env` and use
`docker compose up --build`; it uses your configured Neon database, not a new local
Postgres instance. API and worker stay private within the Compose network.

Before using real client documents, verify tenant/role isolation, dependency
remediation, retention/deletion, OAuth/account verification, upload limits and
rate limiting. Also set up database backups and restoration, error/uptime alerts,
privacy/terms, rollback and support. Billing is only needed before selling paid
plans. These remain release work; folder separation does not certify production
readiness. The complete checklist is [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).

References: [Vercel programmatic configuration](https://vercel.com/docs/project-configuration/vercel-ts),
[Vercel monorepo sources](https://vercel.com/docs/monorepos/monorepo-faq),
[Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles),
[Railway private networking](https://docs.railway.com/networking/private-networking),
[Cloudflare private R2 access](https://developers.cloudflare.com/r2/buckets/public-buckets/).
