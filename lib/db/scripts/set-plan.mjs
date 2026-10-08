/**
 * Sets a workspace's subscription plan (there is no billing integration yet).
 *   pnpm --filter @workspace/db run set-plan -- <companyId> <plan> [YYYY-MM-DD]
 * Plans: free, starter, growth, ca_firm, enterprise. The optional date is when the plan lapses.
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
const [companyId, plan, until] = process.argv.slice(2).filter(arg => arg !== "--");
const PLANS = ["free", "starter", "growth", "ca_firm", "enterprise"];
if (!/^\d+$/.test(companyId ?? "") || !PLANS.includes(plan)) {
  console.error(`Usage: set-plan <companyId> <${PLANS.join("|")}> [YYYY-MM-DD]`);
  process.exit(1);
}
if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
  console.error("The lapse date must look like 2027-03-31.");
  process.exit(1);
}
const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
const result = await client.query("update companies set plan = $2, plan_until = $3 where id = $1 returning id, name, plan, plan_until", [Number(companyId), plan, until || null]);
console.log(result.rows.length ? `set: ${JSON.stringify(result.rows[0])}` : `no company with id ${companyId}`);
await client.end();
