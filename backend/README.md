# TallyThis backend

| Folder | Role | Reached by | Health check |
| --- | --- | --- | --- |
| `api/` | TypeScript business logic, authentication, uploads, exports | the gateway (private) | `/api/health` |
| `gateway/` | Go API entry point and reconciliation routes | Caddy, the only public service | `/api/health` |
| `worker/` | Python file extraction and parsing | the API (private) | `/health` |

All three run in Docker on one Google Cloud VM (see `../deploy/vm/` and
[the runbook](../docs/GCP_VM_DEPLOYMENT.md)). Each image is built from the **repository
root** with its own Dockerfile. Only Caddy faces the internet. The shared PostgreSQL schema,
its migrations and client types are in `../lib/`; the TypeScript API must have that build
context.

Follow [the deployment guide](../docs/DEPLOYMENT.md) for service variables,
Vercel proxy setup and database/storage requirements. Folder separation is not
a substitute for the security release work in
[production readiness](../docs/PRODUCTION_READINESS.md).
