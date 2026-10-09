// Direct test of hybrid PDF extractor (rules + AI fallback)
// Use compiled bundle by mocking the import via node-process env then dynamic import
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

for (const line of readFileSync("E:/accountant/Asset-Manager/.env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const require = createRequire(import.meta.url);
// Use tsx loader
process.argv = [process.argv[0], "test"];
const { register } = require("node:module");
const { pathToFileURL } = require("node:url");
const tsxLoader = path.resolve("E:/accountant/Asset-Manager/node_modules/tsx/dist/loader.mjs");

try {
  register("tsx", pathToFileURL("./"));
} catch (e) {
  console.error("tsx register failed:", e.message);
  process.exit(1);
}

const { extractHybrid } = await import("file:///E:/accountant/Asset-Manager/backend/api/src/services/pdfTableExtractor.ts");

const hdfcText = `HDFC BANK Ltd
Account Statement May 2026

01/05/2026  NEFT-ACME Corp INV-100 UTR12345  5,000.00  95,000.00
03/05/2026  Salary credit Rahul SAL2026  75,000.00  170,000.00
05/05/2026  Razorpay settlement RZP-9988  12,500.00  182,500.00
07/05/2026  UPI-Office supplies UTR67890  2,300.00  180,200.00`;

const r = await extractHybrid(hdfcText, "bank", () => null);
console.log("method:", r.method, "confidence:", r.confidence, "rows:", r.rows.length);
console.log("notes:", r.notes);
console.log("first row:", r.rows[0] ?? "(none)");
