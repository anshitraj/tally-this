import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Advisory GHSA-mrhx-c7xc-m3w5: zod can run out of memory validating a very large array whose schema has
 * no length limit. The fix is in zod 4, a major upgrade planned for a later phase. Until then the exposure
 * is closed by capping every array that takes data from a request. The arrays below parse replies from AI
 * models, whose size is already bounded by the model's own output limit, so they are listed on purpose.
 */
// Tests run from backend/api (pnpm test), and the bundled test file does not sit beside the source.
const SRC = path.resolve(process.cwd(), "src");

const BOUNDED_BY_THE_MODEL = new Set([
  "server/ai/schemas/invoiceExtractionSchema.ts",
  "server/ai/schemas/monthEndSummarySchema.ts",
  "server/ai/schemas/riskExplanationSchema.ts",
  "server/ai/validators.ts",
  "services/aiDocumentReader.ts",
  "services/aiStatementShape.ts",
  "services/ledgerSuggest.ts",
]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

test("every array that takes data from a request has a length limit", { skip: !fs.existsSync(path.join(SRC, "routes")) }, () => {
  const missing: string[] = [];
  let checked = 0;
  for (const file of sourceFiles(SRC)) {
    const relative = path.relative(SRC, file).split(path.sep).join("/");
    if (BOUNDED_BY_THE_MODEL.has(relative)) continue;
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
      if (!line.includes("z.array(")) return;
      checked += 1;
      if (!line.includes(".max(")) missing.push(`${relative}:${index + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.ok(checked >= 20, `only ${checked} array schemas were found; the check is not looking in the right place`);
  assert.deepEqual(missing, [], "add .max(n) to these arrays, or list the file as model-bounded with a reason");
});
