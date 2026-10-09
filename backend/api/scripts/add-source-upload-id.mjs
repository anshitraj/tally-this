import { readFileSync } from "node:fs";
for (const line of readFileSync("E:/accountant/Asset-Manager/.env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const pg = (await import("file:///E:/accountant/Asset-Manager/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js")).default;

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const tables = [
  "bank_transactions",
  "invoices",
  "ledger_entries",
  "payroll_entries",
  "gateway_settlements",
  "gst_records",
];

for (const t of tables) {
  try {
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS source_upload_id integer`);
    console.log(`ok: ${t}.source_upload_id`);
  } catch (err) {
    console.error(`fail: ${t}: ${err.message}`);
  }
}

await pool.end();
