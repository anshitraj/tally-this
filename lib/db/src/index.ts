import "./env";
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// ── Neon Serverless HTTP Driver ───────────────────────────────────────────
// Uses HTTP/1.1 instead of TCP+TLS to reach Neon. Eliminates the 1.5-2.5s
// cold-start TCP handshake on Neon's serverless tier.
// Benchmark: cold-start ~50-200ms vs ~2000ms with node-postgres pool.
//
// Trade-offs vs pg Pool:
//   ✓ No cold start             — HTTP keep-alive is handled by the edge
//   ✓ No pool management needed — each query is a self-contained HTTP request
//   ✓ Works great for serverless deployments
//   ✗ Can't use pool.connect()  — use db.transaction() instead
//   ✗ Not suitable for long-running queries >30s (use node-postgres for those)

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// fetchConnectionCache is now always true in @neondatabase/serverless v1+
// (setting it explicitly generates a deprecation warning)

const sql = neon(process.env.DATABASE_URL);

export const db = drizzle(sql, { schema });

// ── Backward-compat shim ──────────────────────────────────────────────────
// `pool` was exported by the old pg-based driver and is referenced in:
//   - backend/api/src/index.ts  (keep-alive pinger — no longer needed)
//   - backend/api/src/server/db/index.ts (re-export)
// We export a minimal shim so no other file needs to change.
// The keep-alive pinger in index.ts is safe to leave; the shim's connect()
// does a real lightweight query and returns a release-able object.
export const pool = {
  connect: async () => {
    const release = () => {};
    return {
      query: async (text: string) => { await sql.query(text); },
      release,
    };
  },
  end: async () => {},
  query: async (text: string, values?: unknown[]) => {
    if (values) return await sql.query(text, values as any[]);
    return await sql.query(text);
  },
  on: () => {},
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
};

export * from "./schema";
