import fs from "node:fs";
import { createRequire } from "node:module";
import { isLoopbackDatabaseUrl } from "../../lib/db/src/driver.ts";

/**
 * Direct access to the throwaway database the stack runs on, for the things a person cannot do from the screen:
 * setting a company's plan, adding a team member with another role, and checking what was (not) saved.
 * It refuses any database that is not on this computer.
 */

const requireFromDb = createRequire(new URL("../../lib/db/package.json", import.meta.url));

function databaseUrl(): string {
  const fromEnv = process.env.STACK_DATABASE_URL;
  let url = fromEnv;
  if (!url) {
    try {
      url = JSON.parse(fs.readFileSync(new URL("../../.stack/state.json", import.meta.url), "utf8")).database as string | undefined;
    } catch {
      // no state file: the stack is not running
    }
  }
  if (!url) throw new Error("STACK_DATABASE_URL is not set and the stack has not recorded its database");
  if (!isLoopbackDatabaseUrl(url)) throw new Error("these tests only touch a database on this computer");
  return url;
}

export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const pg = requireFromDb("pg");
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

export async function companyIdOf(email: string): Promise<number> {
  const rows = await sql<{ company_id: number }>("select company_id from users where lower(email) = lower($1)", [email]);
  if (!rows[0]) throw new Error(`no account for ${email}`);
  return rows[0].company_id;
}

/** Puts the company of this account on a paid plan (or back on the free one). */
export async function setPlan(email: string, plan: string, until: string | null = null) {
  await sql("update companies set plan = $1, plan_until = $2 where id = (select company_id from users where lower(email) = lower($3))", [plan, until, email]);
}

/** Adds a second person to the same company, with the same sign-in as the first, and the given role. */
export async function addTeamMember(email: string, newEmail: string, role: string, name = "Team Member") {
  await sql(
    `insert into users (company_id, name, email, password_hash, password_salt, role, status)
     select company_id, $2, $3, password_hash, password_salt, $4, 'active' from users where lower(email) = lower($1)`,
    [email, name, newEmail, role],
  );
}

export async function runCount(companyId: number): Promise<number> {
  const rows = await sql<{ n: number }>("select count(*)::int as n from workflow_runs where company_id = $1", [companyId]);
  return rows[0].n;
}
