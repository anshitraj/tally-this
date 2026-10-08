/**
 * Applies a SQL file to DATABASE_URL from the root .env.
 *   pnpm --filter @workspace/db run apply-sql -- ../../scripts/migrate-plans.sql
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "../../../.env");
const env = { ...process.env };
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && env[match[1]] === undefined) env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}
const file = process.argv.slice(2).find(arg => arg !== "--");
if (!file || !env.DATABASE_URL) {
  console.error("Usage: apply-sql <file.sql>   (needs DATABASE_URL)");
  process.exit(1);
}
const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
await client.query(fs.readFileSync(path.resolve(process.cwd(), file), "utf8"));
console.log(`applied ${file} to ${new URL(env.DATABASE_URL).hostname.replace(/^[^.]+/, "<endpoint>")}`);
await client.end();
