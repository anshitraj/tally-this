/**
 * Fails when a production dependency has a critical or high advisory that is not listed in
 * scripts/audit-allowlist.json. Each allowlist entry needs a reason and a review date; an entry whose
 * date has passed fails the check too, so a known risk cannot be forgotten.
 *
 *   node scripts/audit-gate.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const allowlist = JSON.parse(fs.readFileSync(path.join(here, "audit-allowlist.json"), "utf8")).allowed ?? [];
const today = new Date();

const audit = spawnSync("pnpm", ["audit", "--prod", "--json"], { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error("Could not read the output of `pnpm audit`. Is the registry reachable?");
  console.error((audit.stderr || audit.stdout || "").slice(0, 500));
  process.exit(2);
}

const advisories = Object.values(report.advisories ?? {});
const problems = [];
let known = 0;
for (const advisory of advisories) {
  const severity = advisory.severity;
  const id = advisory.github_advisory_id || advisory.url || String(advisory.id);
  const label = `${severity.toUpperCase()} ${advisory.module_name} ${advisory.vulnerable_versions} (${id}): ${advisory.title}`;
  if (severity !== "critical" && severity !== "high") continue;
  const entry = allowlist.find(item => item.id === id);
  if (!entry) {
    problems.push(`NEW  ${label}\n     fix: upgrade to ${advisory.patched_versions}, or add it to scripts/audit-allowlist.json with a reason and a review date`);
    continue;
  }
  if (!entry.reason || !entry.reviewBy || new Date(entry.reviewBy) < today) {
    problems.push(`DUE  ${label}\n     its review date (${entry.reviewBy ?? "missing"}) has passed or its reason is empty: decide again`);
    continue;
  }
  known += 1;
  console.log(`known  ${label}\n       accepted until ${entry.reviewBy}: ${entry.reason}`);
}

const counts = report.metadata?.vulnerabilities ?? {};
console.log(`\nAdvisories in production dependencies: ${JSON.stringify(counts)}; critical/high listed as accepted: ${known}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("No unreviewed critical or high advisories.");
