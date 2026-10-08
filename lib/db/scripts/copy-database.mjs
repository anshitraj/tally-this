/**
 * Copies one Postgres database into another empty one: schema, data, sequences, indexes.
 * The source is only ever read. The target must have no tables.
 *
 *   pnpm --filter @workspace/db run copy-db            (DATABASE_URL_OLD → DATABASE_URL_NEW, from the root .env)
 *   pnpm --filter @workspace/db run copy-db -- --verify-only
 *
 * After copying, every table is checked: row count and an MD5 of all rows must match.
 * Values travel as text, so timestamps, numerics and JSON are copied exactly.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

function readEnv() {
  const values = {};
  const file = path.resolve(here, "../../../.env");
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return values;
}

const env = { ...readEnv(), ...process.env };
const sourceUrl = env.DATABASE_URL_OLD;
const targetUrl = env.DATABASE_URL_NEW;
const verifyOnly = process.argv.includes("--verify-only");
if (!sourceUrl || !targetUrl) {
  console.error("Set DATABASE_URL_OLD and DATABASE_URL_NEW in the root .env.");
  process.exit(1);
}
if (sourceUrl === targetUrl) {
  console.error("DATABASE_URL_OLD and DATABASE_URL_NEW are the same database.");
  process.exit(1);
}

// Keep every value as text: no JS Date/number conversion, so nothing is rounded.
const rawTypes = { getTypeParser: () => value => value };
const connect = async url => {
  const client = new pg.Client({ connectionString: url, types: rawTypes });
  await client.connect();
  return client;
};

const q = (client, text, params) => client.query(text, params).then(result => result.rows);
const ident = name => `"${String(name).replace(/"/g, '""')}"`;
const host = url => new URL(url).hostname.replace(/^[^.]+/, "<endpoint>");

const source = await connect(sourceUrl);
const target = await connect(targetUrl);
console.log(`source ${host(sourceUrl)}  →  target ${host(targetUrl)}${verifyOnly ? "  (verify only)" : ""}`);

// ── Read the source schema ─────────────────────────────────────────────────

const tables = (await q(source, `
  select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' order by c.relname`));

async function describe(table) {
  const columns = await q(source, `
    select a.attname name, format_type(a.atttypid, a.atttypmod) type, a.attnotnull notnull, a.attidentity identity, a.attgenerated generated,
           pg_get_expr(d.adbin, d.adrelid) default_expr
    from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [table.oid]);
  const constraints = await q(source, `
    select conname name, contype type, pg_get_constraintdef(oid) def from pg_constraint where conrelid = $1 order by contype, conname`, [table.oid]);
  const indexes = await q(source, `
    select indexdef from pg_indexes i where schemaname = 'public' and tablename = $1
      and not exists (select 1 from pg_constraint k where k.conindid = (quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))::regclass)`, [table.relname]);
  return { ...table, columns, constraints, indexes };
}

const described = [];
for (const table of tables) described.push(await describe(table));

if (!verifyOnly) {
  const existing = await q(target, `select count(*)::int n from information_schema.tables where table_schema = 'public'`);
  if (existing[0].n > 0) {
    console.error(`The target already has ${existing[0].n} tables. Use an empty database.`);
    process.exit(1);
  }

  const extensions = await q(source, `select extname from pg_extension where extname <> 'plpgsql'`);
  const sequences = await q(source, `
    select c.relname name, format_type(s.seqtypid, null) type, s.seqstart start, s.seqmin min, s.seqmax max, s.seqincrement inc, s.seqcycle cycle
    from pg_sequence s join pg_class c on c.oid = s.seqrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'i')`);
  const functions = await q(source, `
    select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`);
  const triggers = await q(source, `
    select pg_get_triggerdef(t.oid) def from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal`);

  await target.query("begin");
  try {
    for (const row of extensions) await target.query(`create extension if not exists ${ident(row.extname)}`);
    for (const fn of functions) await target.query(fn.def);
    for (const seq of sequences) {
      await target.query(`create sequence ${ident(seq.name)} as ${seq.type} start ${seq.start} minvalue ${seq.min} maxvalue ${seq.max} increment ${seq.inc} ${seq.cycle ? "cycle" : "no cycle"}`);
    }
    for (const table of described) {
      const columns = table.columns.map(column => {
        const parts = [ident(column.name), column.type];
        if (column.identity === "a") parts.push("generated always as identity");
        else if (column.identity === "d") parts.push("generated by default as identity");
        else if (column.generated === "s") parts.push(`generated always as (${column.default_expr}) stored`);
        else if (column.default_expr) parts.push(`default ${column.default_expr}`);
        if (column.notnull) parts.push("not null");
        return parts.join(" ");
      });
      await target.query(`create table ${ident(table.relname)} (${columns.join(", ")})`);
    }
    // Sequences owned by serial columns keep their ownership.
    const owned = await q(source, `
      select s.relname seq, t.relname tbl, a.attname col from pg_depend d
      join pg_class s on s.oid = d.objid and s.relkind = 'S' join pg_class t on t.oid = d.refobjid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
      join pg_namespace n on n.oid = s.relnamespace where n.nspname = 'public' and d.deptype = 'a'`);
    for (const row of owned) await target.query(`alter sequence ${ident(row.seq)} owned by ${ident(row.tbl)}.${ident(row.col)}`).catch(() => undefined);
    for (const table of described) {
      for (const constraint of table.constraints.filter(item => item.type !== "f")) {
        await target.query(`alter table ${ident(table.relname)} add constraint ${ident(constraint.name)} ${constraint.def}`);
      }
    }
    await target.query("commit");
  } catch (error) {
    await target.query("rollback");
    throw error;
  }
  console.log(`schema: ${described.length} tables, ${sequences.length} sequences created`);

  // ── Data, in batches ─────────────────────────────────────────────────────
  let total = 0;
  for (const table of described) {
    const names = table.columns.filter(column => column.generated !== "s").map(column => column.name);
    if (names.length === 0) continue;
    const hasIdentityAlways = table.columns.some(column => column.identity === "a");
    const rows = await q(source, `select ${names.map(ident).join(", ")} from ${ident(table.relname)}`);
    const perBatch = Math.max(1, Math.floor(6000 / names.length));
    await target.query("begin");
    try {
      for (let start = 0; start < rows.length; start += perBatch) {
        const batch = rows.slice(start, start + perBatch);
        const params = [];
        const tuples = batch.map(row => `(${names.map(name => { params.push(row[name]); return `$${params.length}`; }).join(", ")})`);
        await target.query(`insert into ${ident(table.relname)} (${names.map(ident).join(", ")}) ${hasIdentityAlways ? "overriding system value " : ""}values ${tuples.join(", ")}`, params);
      }
      await target.query("commit");
    } catch (error) {
      await target.query("rollback");
      throw new Error(`copying ${table.relname}: ${error.message}`);
    }
    total += rows.length;
  }
  console.log(`data: ${total} rows copied`);

  // ── Foreign keys, indexes, triggers, sequence positions ──────────────────
  for (const table of described) {
    for (const constraint of table.constraints.filter(item => item.type === "f")) {
      await target.query(`alter table ${ident(table.relname)} add constraint ${ident(constraint.name)} ${constraint.def}`);
    }
  }
  for (const table of described) for (const index of table.indexes) await target.query(index.indexdef.replace(/^CREATE (UNIQUE )?INDEX/, "CREATE $1INDEX IF NOT EXISTS"));
  for (const trigger of triggers) await target.query(trigger.def);
  const allSequences = await q(source, `select c.relname name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'S'`);
  for (const seq of allSequences) {
    const state = (await q(source, `select last_value, is_called from ${ident(seq.name)}`))[0];
    await target.query(`select setval($1, $2::bigint, $3::boolean)`, [`public.${ident(seq.name)}`, state.last_value, state.is_called === "t" || state.is_called === true]);
  }
  console.log(`finished: constraints, ${described.reduce((sum, table) => sum + table.indexes.length, 0)} indexes, ${triggers.length} triggers, ${allSequences.length} sequence positions`);
}

// ── Verify: counts and checksums of every table ─────────────────────────────

let bad = 0;
for (const table of described) {
  const sql = `select count(*)::text n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '-') sum from ${ident(table.relname)} t`;
  const [a] = await q(source, sql);
  const [b] = await q(target, sql).catch(() => [{ n: "missing", sum: "" }]);
  const ok = a.n === b.n && a.sum === b.sum;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${table.relname.padEnd(24)} rows ${a.n} / ${b.n}`);
}
const indexCounts = await Promise.all([source, target].map(async client => (await q(client, `select count(*)::int n from pg_indexes where schemaname = 'public'`))[0].n));
console.log(`indexes: source ${indexCounts[0]}, target ${indexCounts[1]}${indexCounts[0] === indexCounts[1] ? "" : "  MISMATCH"}`);
if (indexCounts[0] !== indexCounts[1]) bad += 1;

await source.end();
await target.end();
console.log(bad === 0 ? "\nVERIFIED: every table matches." : `\n${bad} problem(s). Do not switch.`);
process.exit(bad === 0 ? 0 : 2);
