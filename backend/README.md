# TallyThis backend

| Folder | Role | Railway service | Health check |
| --- | --- | --- | --- |
| `api/` | TypeScript business logic, authentication, uploads, exports | `api` (private) | `/api/health` |
| `gateway/` | Go API entry point and reconciliation routes | `gateway` (public) | `/api/health` |
| `worker/` | Python file extraction and parsing | `worker` (private) | `/health` |

Deploy each service from the **repository root**, with its
`RAILWAY_DOCKERFILE_PATH` set to the Dockerfile shown in its `.env.example`.
Only the gateway needs a public domain. Shared PostgreSQL schema and client types
remain in `../lib/`; the TypeScript API must have that build context.

Follow [the deployment guide](../docs/DEPLOYMENT.md) for service variables,
Vercel proxy setup and database/storage requirements. Folder separation is not
a substitute for the security release work in
[production readiness](../docs/PRODUCTION_READINESS.md).
