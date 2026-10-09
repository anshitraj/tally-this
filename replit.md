# FinVerify OS

Pre-CA finance verification dashboard for Indian startups — reconcile bank transactions, flag GST/TDS risks, and hand off audit-ready books to your CA.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, proxied at `/api`)
- `pnpm --filter @workspace/finverify-os run dev` — run the React frontend (port 21950, proxied at `/`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Demo Credentials

- **Founder View:** `rahul@novastack.in` / `demo1234`
- **CA View:** `ca@finverify.in` / `demo1234`
- Seed data: `POST /api/demo/seed`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + pino logging
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec at `lib/api-spec/openapi.yaml`)
- Frontend: React + Vite + shadcn/ui + Framer Motion + Recharts + wouter
- Build: esbuild (CJS bundle)

## Where things live

- `lib/db/src/schema/finverify.ts` — DB schema (9 tables)
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth)
- `lib/api-zod/src/generated/api.ts` — generated Zod schemas
- `backend/api/src/routes/` — API route handlers
- `backend/api/src/lib/seedData.ts` — demo seed data for NovaStack Labs
- `frontend/src/pages/` — all frontend pages
- `frontend/src/components/app/` — shared app components

## Architecture decisions

- Contract-first API: OpenAPI spec → Orval codegen → Zod schemas used on both client and server
- Auth is local-only (localStorage) for demo purposes — not production auth
- All routes mount at `/api/...`; frontend at `/`
- Demo data seeded with 60 bank txns, 30 invoices, 10 payroll entries, 12 gateway settlements
- Verification score = % of transactions in `verified` status (0–100, ≥85 = CA ready)

## Product

Pages: Landing, Login, Overview (score + charts), Upload Center, Transactions, Invoices, Ledger Match, Reconciliation Engine, GST/TDS Risks, Payroll, Gateway Settlements, CA Review Queue, Reports, Integrations, Settings.

## User preferences

- Indian startup context: use ₹, lakhs/crores formatting
- Brand: bg #FAFAF7, accent orange #F26B3A, text #101828, success #0F9F6E, risk red #DC2626
- Never use `console.log` in server code — use `req.log` or `logger`

## Gotchas

- Always run `pnpm --filter @workspace/db run push` after schema changes
- Run `pnpm --filter @workspace/api-spec run codegen` after openapi.yaml changes
- Seed demo data before testing: `curl -X POST http://localhost:80/api/demo/seed`
- Express 5: params typed as `string | string[]`, cast with `Array.isArray(p) ? p[0] : p`

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
