/**
 * Dev tool: prints what FinVerify reads from a bank statement PDF.
 *   pnpm --filter @workspace/api-server run read-statement -- <file.pdf> [--json] [--ai]
 * --ai skips the table reader and asks Claude/Gemini to read the page images instead.
 * The PDF password, if any, is read from the FV_PDF_PASSWORD environment variable.
 */
import fs from "node:fs";
import type { BankStatementSummary } from "../src/services/bankStatement";
import type { StatementCheck } from "../src/services/statementCheck";
import { readStatementPdf, renderPdfPages } from "../src/services/pdfStatement";

const file = process.argv.slice(2).find(arg => !arg.startsWith("--"));
if (!file) {
  console.error("Usage: read-statement <file.pdf> [--json] [--ai]");
  process.exit(1);
}
const buffer = fs.readFileSync(file);
const password = process.env.FV_PDF_PASSWORD || undefined;
const fileName = file.split(/[\\/]/).pop() ?? "statement.pdf";

let summary: BankStatementSummary | undefined;
let check: StatementCheck | undefined;
let label = "";
const started = Date.now();
if (process.argv.includes("--ai")) {
  const { readBankStatementWithAI } = await import("../src/services/aiDocumentReader");
  const files = password
    ? (await renderPdfPages(buffer, password)).map(data => ({ data, mimeType: "image/png" }))
    : [{ data: buffer, mimeType: "application/pdf" }];
  const result = await readBankStatementWithAI({ files, fileName });
  if (!result.ok) {
    console.log("AI read failed:", result.error);
    process.exit(1);
  }
  ({ summary, check } = result.read);
  label = `ai (${result.read.provider} ${result.read.model})`;
} else {
  const result = await readStatementPdf(buffer, { password, fileName });
  ({ summary, check } = result);
  label = `layout status=${result.status} pages=${result.pageCount}`;
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ summary, check }, null, 2));
} else {
  console.log(`${label}  ${Date.now() - started}ms`);
  if (summary) {
    console.log(`bank: ${summary.bankName}  account: ••${summary.accountNumberMasked}  period: ${summary.periodLabel}`);
    console.log(`opening: ${summary.openingBalance}  closing: ${summary.closingBalance}  in: ${summary.creditTotal}  out: ${summary.debitTotal}`);
    console.log(`check: ${JSON.stringify(check)}`);
    for (const txn of summary.transactions) {
      const amount = txn.debit != null ? `-${txn.debit}` : `+${txn.credit}`;
      console.log(`${String(txn.rowNumber).padStart(3)} ${txn.date}${txn.valueDate ? `/${txn.valueDate}` : ""} ${amount.padStart(12)} ${String(txn.balance).padStart(12)} ${txn.confidence >= 0.9 ? "ok " : "CHK"} ${txn.narration}${txn.reference ? `  [${txn.reference}]` : ""}`);
    }
    if (summary.warnings.length) console.log("warnings:", summary.warnings);
  }
}
process.exit(0);
