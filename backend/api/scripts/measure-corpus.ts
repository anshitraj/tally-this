/**
 * Measures TallyThis's readers on a folder of REAL, redacted client files.
 *
 *   pnpm --filter @workspace/api-server run measure-corpus -- ./corpus
 *
 * For every file it names what the file was taken to be, runs the matching reader and reports the
 * counts, totals, review items and time. If the folder holds an `answers.json` written by whoever
 * checked the file by hand, every figure in it is compared EXACTLY (money in paise) and reported as
 * agree or differ. Without answers the report says "no answer to compare" for that file: a reader
 * that returns numbers is not the same as a reader that returns the right numbers.
 *
 * answers.json, keyed by file name (all fields optional):
 *   { "hdfc-oct.pdf": { "kind": "bank_statement", "rows": 214, "debitTotal": 512340.5, "creditTotal": 610000,
 *                        "openingBalance": 12000, "closingBalance": 109659.5 },
 *     "sales-oct.xlsx": { "kind": "sales_register", "documents": 88, "taxable": 1250000, "igst": 90000, "cgst": 45000, "sgst": 45000 },
 *     "salary-oct.xlsx": { "kind": "payroll_sheet", "employees": 32, "net": 845200 },
 *     "bills-oct.xlsx":  { "kind": "purchase_register", "bills": 51, "total": 702345.12 },
 *     "gstr2b-oct.json": { "kind": "gstr2b", "documents": 140, "tax": 98000 } }
 * The folder is read, never changed, and nothing is uploaded: everything runs on this computer.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { detectFileKind, extensionOf, sheetToCsvText, type FileKind } from "../src/services/fileDetect";
import { peekPdfKind } from "../src/services/documentPeek";
import { readBankStatementFile } from "../src/services/fileReaders";
import { sheetsOf, kindOfGstFile, readPortalFile, readRegisterFile } from "../src/services/gstrFiles";
import { buildGstr1, readSalesRegister } from "../src/services/salesRegister";
import { checkBills, readBillsFromTable } from "../src/services/purchaseBills";
import { readPayroll, statutoryOf } from "../src/services/payroll";
import { readTallyExportFile } from "../src/services/tallyExport";
import { readTdsFile } from "../src/services/tdsFiles";

type Measured = Record<string, number | string | boolean | null>;
type Answer = Record<string, number | string | boolean>;

const folder = process.argv.slice(2).find(arg => !arg.startsWith("--"));
const output = process.env.CORPUS_REPORT ?? "dist/TallyThis_corpus_report.json";
const password = process.env.CORPUS_PDF_PASSWORD;
if (!folder) {
  console.error("Usage: measure-corpus <folder with redacted files and an optional answers.json>");
  process.exit(2);
}

const MONEY_KEYS = /total|taxable|igst|cgst|sgst|net|tax|balance|amount/i;

function compare(measured: Measured, answer: Answer | undefined) {
  if (!answer) return { status: "no answer to compare" as const, differences: [] as string[] };
  const differences: string[] = [];
  for (const [key, expected] of Object.entries(answer)) {
    if (key === "kind") {
      if (measured.kind !== expected) differences.push(`kind: expected ${expected}, read as ${measured.kind}`);
      continue;
    }
    const actual = measured[key];
    if (actual === undefined) {
      differences.push(`${key}: this reader does not report it`);
      continue;
    }
    const same = typeof expected === "number" && typeof actual === "number" && MONEY_KEYS.test(key) ? Math.round(expected * 100) === Math.round(actual * 100) : actual === expected;
    if (!same) differences.push(`${key}: expected ${expected}, read ${actual}`);
  }
  return { status: differences.length === 0 ? ("agrees" as const) : ("differs" as const), differences };
}

async function measureFile(name: string, buffer: Buffer): Promise<Measured> {
  const started = Date.now();
  const lower = name.toLowerCase();
  const ext = extensionOf(lower);
  const mimetype = ext === "pdf" ? "application/pdf" : ext === "json" ? "application/json" : "application/octet-stream";
  const file = { originalname: name, mimetype, buffer };
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;

  if (ext === "json") {
    const kind = kindOfGstFile({ originalname: name, buffer });
    if (kind === "portal") {
      const read = readPortalFile({ originalname: name, buffer });
      const tax = read.docs.reduce((sum, doc) => sum + doc.igst + doc.cgst + doc.sgst + doc.cess, 0) / 100;
      return { kind: "gstr2b", documents: read.docs.length, tax, period: read.period ?? "", recipientGstin: read.recipientGstin ?? "", seconds: seconds() };
    }
    return { kind: "unknown", seconds: seconds() };
  }
  if (ext === "txt") {
    const read = readTdsFile({ originalname: name, buffer });
    return { kind: "tds_file", entries: read.entries.length, source: read.source, seconds: seconds() };
  }

  let kind: FileKind = "unknown";
  try {
    kind = detectFileKind(file).kind;
    if (ext === "pdf") {
      const peek = await peekPdfKind(buffer);
      if (peek !== "unknown") kind = peek as FileKind;
    }
  } catch {
    kind = "unknown";
  }

  if (kind === "bank_statement") {
    const read = await readBankStatementFile(file as never, { privacy: true, allowAi: false, password });
    const summary = read.summary;
    const txns = summary?.transactions ?? [];
    return {
      kind,
      ok: read.ok,
      rows: txns.length,
      flagged: txns.filter(txn => txn.confidence < 0.9).length,
      debitTotal: txns.reduce((sum, txn) => sum + Math.round((txn.debit ?? 0) * 100), 0) / 100,
      creditTotal: txns.reduce((sum, txn) => sum + Math.round((txn.credit ?? 0) * 100), 0) / 100,
      openingBalance: read.check?.openingBalance ?? null,
      closingBalance: read.check?.printedClosing ?? read.check?.closingBalance ?? null,
      balanceProved: read.check?.verified ?? false,
      bank: summary?.bankName ?? "",
      source: read.source ?? "",
      message: read.message?.slice(0, 140) ?? "",
      seconds: seconds(),
    };
  }
  if (kind === "sales_register") {
    let best: ReturnType<typeof readSalesRegister> | null = null;
    for (const sheet of sheetsOf({ originalname: name, buffer })) {
      try {
        const read = readSalesRegister(sheet.table);
        if (!best || read.docs.length > best.docs.length) best = read;
      } catch {
        // Another sheet may hold the register.
      }
    }
    if (!best) return { kind, ok: false, message: "No sales register could be read.", seconds: seconds() };
    const result = buildGstr1(best);
    const t = result.totals.all;
    return {
      kind,
      ok: true,
      documents: result.counts.documents,
      cancelled: result.counts.cancelled,
      flagged: result.flagged.length,
      taxable: t.taxable / 100,
      igst: t.igst / 100,
      cgst: t.cgst / 100,
      sgst: t.sgst / 100,
      tablesAgreeWithRegister: Object.values(result.difference).every(value => value === 0),
      seconds: seconds(),
    };
  }
  if (kind === "purchase_register" || kind === "invoice_register") {
    let best: ReturnType<typeof readBillsFromTable> | null = null;
    for (const sheet of sheetsOf({ originalname: name, buffer })) {
      try {
        const read = readBillsFromTable(sheet.table, name);
        if (!best || read.bills.length > best.bills.length) best = read;
      } catch {
        // Another sheet may hold the list.
      }
    }
    if (!best) return { kind, ok: false, message: "No purchase list could be read.", seconds: seconds() };
    const checked = checkBills(best.bills);
    return {
      kind,
      ok: true,
      bills: checked.length,
      blocked: checked.filter(bill => bill.blocked).length,
      total: checked.filter(bill => bill.include !== false).reduce((sum, bill) => sum + Math.round(bill.total * 100), 0) / 100,
      seconds: seconds(),
    };
  }
  if (kind === "payroll_sheet") {
    let best: ReturnType<typeof readPayroll> | null = null;
    for (const sheet of sheetsOf({ originalname: name, buffer })) {
      try {
        const read = readPayroll(sheet.table);
        if (!best || read.employees.length > best.employees.length) best = read;
      } catch {
        // Another sheet may hold the register.
      }
    }
    if (!best) return { kind, ok: false, message: "No salary sheet could be read.", seconds: seconds() };
    const statutory = statutoryOf(best.employees);
    return {
      kind,
      ok: true,
      employer: best.employer,
      month: best.month ?? "",
      employees: best.employees.length,
      flagged: best.employees.filter(employee => employee.flags.length > 0).length,
      gross: statutory.gross / 100,
      net: statutory.net / 100,
      seconds: seconds(),
    };
  }
  if (kind === "tally_export") {
    const read = await readTallyExportFile(file as never);
    return { kind, ok: read.ok, rows: read.rows.length, source: read.source, message: read.ok ? "" : read.message.slice(0, 140), seconds: seconds() };
  }
  if (kind === "unknown" && ["xlsx", "xls", "csv"].includes(ext)) {
    // A purchase register in GSTR-2B terms: supplier GSTIN, invoice number and tax columns.
    try {
      const read = await readRegisterFile({ originalname: name, buffer });
      return { kind: "purchase_register_gstr", ok: true, documents: read.docs.length, seconds: seconds() };
    } catch {
      return { kind, ok: false, message: "Not recognised as any job's input.", seconds: seconds() };
    }
  }
  void sheetToCsvText;
  return { kind, ok: false, message: "This kind of file is not part of the measurement.", seconds: seconds() };
}

const entries = (await readdir(folder)).filter(name => name !== "answers.json" && !name.startsWith(".")).sort();
let answers: Record<string, Answer> = {};
try {
  answers = JSON.parse(await readFile(join(folder, "answers.json"), "utf8"));
} catch {
  // No answers yet: the report says so for each file.
}

const results: Array<{ file: string; measured: Measured; status: string; differences: string[] }> = [];
for (const name of entries) {
  if (![".pdf", ".xlsx", ".xls", ".csv", ".json", ".txt", ".xml"].includes(extname(name).toLowerCase())) continue;
  let measured: Measured;
  try {
    measured = await measureFile(name, await readFile(join(folder, name)));
  } catch (error) {
    measured = { kind: "error", ok: false, message: (error instanceof Error ? error.message : "Could not read").slice(0, 140) };
  }
  const { status, differences } = compare(measured, answers[name]);
  results.push({ file: name, measured, status, differences });
  const line = Object.entries(measured).map(([key, value]) => `${key}=${value}`).join(" ");
  console.log(`${status === "agrees" ? "AGREES " : status === "differs" ? "DIFFERS" : "NO-ANS "} ${basename(name)}\n         ${line}`);
  for (const difference of differences) console.log(`         ! ${difference}`);
}

const summary = {
  files: results.length,
  agree: results.filter(item => item.status === "agrees").length,
  differ: results.filter(item => item.status === "differs").length,
  withoutAnswer: results.filter(item => item.status === "no answer to compare").length,
};
console.log(`\n${summary.files} files · ${summary.agree} agree with the answer file · ${summary.differ} differ · ${summary.withoutAnswer} have no answer to compare`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ measuredAt: new Date().toISOString(), summary, results }, null, 2));
console.log(`Report: ${output}`);
if (summary.differ > 0) process.exitCode = 1;
