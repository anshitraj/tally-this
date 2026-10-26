/**
 * Builds or brings up to date the database schema: applies lib/db/migrations/*.sql in file-name order.
 * Each file runs once, in its own transaction, and is recorded in the table schema_migrations. The files
 * only add things and are safe to run again, so an older database that already has the tables simply
 * records them as applied.
 *
 *   DATABASE_URL=postgresql://... pnpm --filter @workspace/db run migrate
 *   DATABASE_URL=postgresql://... pnpm --filter @workspace/db run migrate -- --check
 *
 * --check   only lists the files that have not been applied (nothing is changed; exit code 1 if any are missing)
 * --remote  required to apply anything to a database that is not on this computer
 *
 * The address must be in the environment: this script never reads a .env file, so it cannot reach a
 * real database by accident.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { isLoopbackDatabaseUrl } from "../src/driver.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "../migrations");
const args = process.argv.slice(2).filter(arg => arg !== "--");
const checkOnly = args.includes("--check");
const remote = args.includes("--remote");

function fail(message) {
  console.error(message);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL must be set in the environment (this script does not read .env files).");
const onThisComputer = isLoopbackDatabaseUrl(url);
const where = onThisComputer ? "this computer" : new URL(url).hostname.replace(/^[^.]+/, "<endpoint>");
if (!onThisComputer && !checkOnly && !remote) {
  fail(`DATABASE_URL points at ${where}, not at this computer. Check that it is the database you mean, then add --remote to apply migrations there.`);
}

const files = fs.readdirSync(dir).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const tracked = (await client.query("select to_regclass('public.schema_migrations') as found")).rows[0].found !== null;
  const applied = new Set(tracked ? (await client.query("select name from schema_migrations")).rows.map(row => row.name) : []);
  const pending = files.filter(name => !applied.has(name));

  if (checkOnly) {
    console.log(pending.length ? `Not applied on ${where}: ${pending.join(", ")}` : `Every migration is applied on ${where}.`);
    process.exitCode = pending.length ? 1 : 0;
  } else if (!pending.length) {
    console.log(`Nothing to do: every migration is already applied on ${where}.`);
  } else {
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    for (const name of pending) {
      await client.query("begin");
      try {
        await client.query(fs.readFileSync(path.join(dir, name), "utf8"));
        await client.query("insert into schema_migrations (name) values ($1)", [name]);
        await client.query("commit");
        console.log(`applied ${name} on ${where}`);
      } catch (error) {
        await client.query("rollback");
        fail(`${name} failed and was rolled back: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
} finally {
  await client.end();
}
