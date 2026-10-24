/**
 * Dev tool: prints what FinVerify reads from a bank statement PDF.
 *   pnpm --filter @workspace/api-server run read-statement -- <file.pdf> [--json] [--ai] [--ocr]
 * --ai skips the table reader and asks Claude/Gemini to read the page images instead.
 * --ocr skips the table reader and times local Tesseract OCR over every page (OCR_PAGES_IN_FLIGHT sets how many at once).
 * The PDF password, if any, is read from the FV_PDF_PASSWORD environment variable.
 */
import fs from "node:fs";
import type { BankStatementSummary } from "../src/services/bankStatement";
import type { StatementCheck } from "../src/services/statementCheck";
import { readStatementPdf, renderPdfPages } from "../src/services/pdfStatement";

const file = process.argv.slice(2).find(arg => !arg.startsWith("--"));
if (!file) {
  console.error("Usage: read-statement <file.pdf> [--json] [--ai] [--ocr]");
  process.exit(1);
}
const buffer = fs.readFileSync(file);
const password = process.env.FV_PDF_PASSWORD || undefined;
const fileName = file.split(/[\\/]/).pop() ?? "statement.pdf";

if (process.argv.includes("--ocr")) {
  // Times local OCR on every page of a scan. Needs tesseract and pdftoppm (or ImageMagick) installed.
  const { PDFParse } = await import("pdf-parse");
  const { recognizeStatement } = await import("../src/services/statementOcr");
  const { OCR_PAGES_IN_FLIGHT } = await import("../src/services/statementReadPlan");
  const parser = new PDFParse({ data: new Uint8Array(buffer), password });
  const pageCount = (await parser.getInfo()).total;
  await parser.destroy();
  const ocrStarted = Date.now();
  const outcome = await recognizeStatement({
    buffer,
    fileName,
    kind: "pdf",
    pageCount,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) console.log(`  ${done}/${total} pages  ${((Date.now() - ocrStarted) / 1000).toFixed(1)}s`);
    },
  });
  const seconds = (Date.now() - ocrStarted) / 1000;
  if (!outcome.available) {
    console.log(`OCR did not run: ${outcome.note}`);
    process.exit(1);
  }
  console.log(`ocr pages=${outcome.pages.length} in-flight=${OCR_PAGES_IN_FLIGHT} ${seconds.toFixed(1)}s  ${(seconds / Math.max(1, outcome.pages.length)).toFixed(2)}s/page  ${outcome.text.length} characters`);
  process.exit(0);
}

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
