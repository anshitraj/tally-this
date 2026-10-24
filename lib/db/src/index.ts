import "./env";
import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { isLoopbackDatabaseUrl } from "./driver";

// ── Which driver ───────────────────────────────────────────────────────────
// The real database (Neon) is reached over HTTP/1.1 instead of TCP+TLS. That removes the 1.5-2.5s
// cold-start handshake of a pooled connection (~50-200ms vs ~2000ms with node-postgres).
//
// A database on this computer (localhost, 127.0.0.1, ::1) is a plain Postgres that the HTTP driver
// cannot talk to. Tests and local checks use it, with the normal driver. Only a loopback host
// qualifies, so a real database is never reached by the plain driver by mistake.
//
// Trade-offs of the HTTP driver:
//   ✓ No cold start             — HTTP keep-alive is handled by the edge
//   ✓ No pool management needed — each query is a self-contained HTTP request
//   ✗ No interactive transactions
//   ✗ Not suitable for long-running queries >30s

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const connectionString = process.env.DATABASE_URL;
const onThisComputer = isLoopbackDatabaseUrl(connectionString);

// The API only uses what both drivers share, so the plain driver is typed as the HTTP one.
type Database = NeonHttpDatabase<typeof schema>;

const localPool = onThisComputer ? new pg.Pool({ connectionString }) : null;
const sql = onThisComputer ? null : neon(connectionString);

export const db: Database = localPool
  ? (drizzleNodePostgres(localPool, { schema }) as unknown as Database)
  : drizzle(sql!, { schema });

// ── Backward-compat shim ──────────────────────────────────────────────────
// `pool` was exported by the old pg-based driver and is referenced in:
//   - backend/api/src/index.ts  (keep-alive pinger — no longer needed)
//   - backend/api/src/server/db/index.ts (re-export)
// We export a minimal shim so no other file needs to change. `query` answers with the rows, as the
// HTTP driver does.
export const pool = {
  connect: async () => {
    const release = () => {};
    return {
      query: async (text: string) => {
        if (localPool) await localPool.query(text);
        else await sql!.query(text);
      },
      release,
    };
  },
  end: async () => {
    if (localPool) await localPool.end();
  },
  query: async (text: string, values?: unknown[]) => {
    if (localPool) return (await localPool.query(text, values as any[])).rows;
    return values ? await sql!.query(text, values as any[]) : await sql!.query(text);
  },
  on: () => {},
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
};

export { isLoopbackDatabaseUrl };
export * from "./schema";
