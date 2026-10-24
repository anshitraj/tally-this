/**
 * Opt-in acceptance check of the Purchase and Journal vouchers, and of repeat import, against a
 * real TallyPrime company that is a disposable test company. It never runs against a mock.
 *
 *   TALLY_TEST_URL=http://127.0.0.1:9000 TALLY_TEST_COMPANY="TallyThis Test" TALLY_TEST_DATE=2025-04-01 \
 *     pnpm --filter @workspace/api-server run verify-tally-books --allow-test-import
 *
 * Without --allow-test-import only the read-only preflight runs. Every check is reported with what
 * Tally actually answered; a check that Tally refuses is recorded as failed, not retried quietly.
 * Do not run this against a company that holds real books.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPurchaseXml, checkBills, type BillInput } from "../src/services/purchaseBills";
import { buildPayrollJournal, readPayroll, statutoryOf } from "../src/services/payroll";
import { parseCompanyNames, parseImportResponse, sendVouchersToTally } from "../src/services/tallyPush";

const endpoint = process.env.TALLY_TEST_URL ?? "http://127.0.0.1:9000";
const company = process.env.TALLY_TEST_COMPANY ?? "";
const date = process.env.TALLY_TEST_DATE ?? "2025-04-01";
const output = process.env.TALLY_TEST_REPORT ?? "dist/TallyThis_books_acceptance.json";
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Check {
  name: string;
  status: "passed" | "failed" | "info";
  detail: string;
}
const report: { status: string; engine: string; company: string; date: string; checkedAt: string; loadedCompanies?: string[]; checks: Check[]; reason?: string; remainingGate?: string } = {
  status: "blocked",
  engine: "real TallyPrime HTTP server",
  company,
  date,
  checkedAt: new Date().toISOString(),
  checks: [],
};
const note = (name: string, status: Check["status"], detail: string) => report.checks.push({ name, status, detail });

async function request(body: string) {
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Tally HTTP status ${response.status}`);
  return response.text();
}

function collection(type: string, fields: string) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>TallyThisBooks</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escape(company)}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="TallyThisBooks" ISMODIFY="No"><TYPE>${type}</TYPE><FETCH>${fields}</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

async function vouchersWithReference(reference: string) {
  const text = await request(collection("Voucher", "DATE,REFERENCE,VOUCHERTYPENAME,PARTYLEDGERNAME,NARRATION,ALLLEDGERENTRIES.LIST,GUID"));
  return (text.match(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/gi) ?? []).filter(xml => xml.includes(`<REFERENCE>${reference}</REFERENCE>`));
}

function lineAmounts(voucher: string) {
  const map = new Map<string, number>();
  for (const line of voucher.match(/<ALLLEDGERENTRIES.LIST>[\s\S]*?<\/ALLLEDGERENTRIES.LIST>/gi) ?? []) {
    const name = /<LEDGERNAME>([^<]+)<\/LEDGERNAME>/.exec(line)?.[1];
    const amount = /<AMOUNT>([^<]+)<\/AMOUNT>/.exec(line)?.[1];
    if (name && amount != null) map.set(name, Math.round(Number(amount) * 100));
  }
  return map;
}

try {
  const companies = parseCompanyNames(await request(collection("Company", "NAME")));
  report.loadedCompanies = companies;
  if (!company || !companies.includes(company)) throw new Error("Choose a loaded disposable test company with TALLY_TEST_COMPANY. No import was attempted.");
  if (!process.argv.includes("--allow-test-import")) throw new Error("Read-only preflight complete. --allow-test-import is required to write synthetic test vouchers.");

  const tag = `TT${randomUUID().slice(0, 8).toUpperCase()}`;
  const ledgers = {
    purchase: `TallyThis Test Purchase ${tag}`,
    igst: `TallyThis Test Input IGST ${tag}`,
    cgst: `TallyThis Test Input CGST ${tag}`,
    sgst: `TallyThis Test Input SGST ${tag}`,
    cess: `TallyThis Test Input Cess ${tag}`,
    roundOff: `TallyThis Test Round Off ${tag}`,
  };
  const bill: BillInput = {
    key: "t1",
    source: "sheet",
    fileName: "acceptance.xlsx",
    row: 2,
    supplierName: `TallyThis Test Supplier ${tag}`,
    supplierGstin: "27AAPFU0939F1ZV",
    invoiceNumber: `${tag}-INV-1`,
    invoiceDate: date,
    placeOfSupply: "Maharashtra",
    taxable: 10000,
    igst: 0,
    cgst: 900,
    sgst: 900,
    cess: 0,
    total: 11800.4,
    reverseCharge: false,
    include: true,
  };

  // 1. Purchase voucher, first import, with supplier master and bill allocation.
  const [checked] = checkBills([bill]);
  const built = buildPurchaseXml([checked], { clientName: company, tallyCompany: company, purchaseLedger: ledgers.purchase, igstLedger: ledgers.igst, cgstLedger: ledgers.cgst, sgstLedger: ledgers.sgst, cessLedger: ledgers.cess, roundOffLedger: ledgers.roundOff, numbering: "auto" });
  if (!built.ok || !built.xml) throw new Error(`The purchase file was not built: ${built.errors.join(" ")}`);
  // The GST ledgers are not in the generated masters on purpose: a CA's company already has them.
  const dutyMasters = [ledgers.igst, ledgers.cgst, ledgers.sgst, ledgers.cess]
    .map(name => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${escape(name)}" ACTION="Create"><NAME.LIST><NAME>${escape(name)}</NAME></NAME.LIST><PARENT>Duties &amp; Taxes</PARENT></LEDGER></TALLYMESSAGE>`)
    .join("") + `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${escape(ledgers.roundOff)}" ACTION="Create"><NAME.LIST><NAME>${escape(ledgers.roundOff)}</NAME></NAME.LIST><PARENT>Indirect Expenses</PARENT></LEDGER></TALLYMESSAGE>`;
  const mastersXml = built.mastersXml!.replace("</REQUESTDATA>", `${dutyMasters}</REQUESTDATA>`);
  const first = await sendVouchersToTally({ mastersXml, vouchersXml: built.xml, expected: 1 }, request);
  note("Purchase voucher imported", first.ok ? "passed" : "failed", `created ${first.created} of ${first.expected}; messages: ${first.messages.join(" | ") || "none"}`);

  const readBack = await vouchersWithReference(bill.invoiceNumber);
  if (readBack.length === 1) {
    const voucher = readBack[0];
    const amounts = lineAmounts(voucher);
    const expect: Array<[string, number]> = [
      [built.vouchers[0].party, 1180040],
      [ledgers.purchase, -1000000],
      [ledgers.cgst, -90000],
      [ledgers.sgst, -90000],
      [ledgers.roundOff, -40],
    ];
    const wrong = expect.filter(([name, value]) => amounts.get(name) !== value).map(([name, value]) => `${name}: expected ${value}, got ${amounts.get(name) ?? "missing"}`);
    note("Purchase read-back amounts agree to the paise", wrong.length === 0 ? "passed" : "failed", wrong.length === 0 ? "party, purchase, CGST, SGST and round-off lines agree" : wrong.join("; "));
    note("Purchase read-back type and date", /<VOUCHERTYPENAME>Purchase<\/VOUCHERTYPENAME>/.test(voucher) && voucher.includes(`<DATE>${date.replace(/-/g, "")}</DATE>`) ? "passed" : "failed", "voucher type Purchase on the requested date");
    note("Voucher number given by Tally (numbering: auto)", "info", /<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/.exec(voucher)?.[1] || "none returned");
  } else {
    note("Purchase read-back", "failed", `expected one voucher with reference ${bill.invoiceNumber}, found ${readBack.length}`);
  }

  // 2. The same file sent again: what does Tally do?
  let repeatDetail = "";
  try {
    const reply = parseImportResponse(await request(built.xml));
    repeatDetail = `created ${reply.created}, altered ${reply.altered}, ignored ${reply.ignored}, errors ${reply.errors}; messages: ${reply.messages.join(" | ") || "none"}`;
  } catch (error) {
    repeatDetail = error instanceof Error ? error.message : "Tally did not answer the repeat import.";
  }
  const afterRepeat = await vouchersWithReference(bill.invoiceNumber);
  note("Repeat import does not duplicate the purchase", afterRepeat.length === 1 ? "passed" : "failed", `${afterRepeat.length} voucher(s) carry the reference after sending the same file twice. Tally said: ${repeatDetail}`);

  // 3. Salary journal.
  const sheet = readPayroll([
    [company],
    [`Salary for ${date.slice(0, 7)}`],
    ["Employee Name", "Basic", "HRA", "Gross", "PF", "ESI", "Professional Tax", "TDS", "Net Pay"],
    ["Test Employee One", 20000, 8000, 28000, 1800, 0, 200, 500, 25500],
    ["Test Employee Two", 12000, 4800, 16800, 1440, 126, 200, 0, 15034],
  ]);
  const statutory = statutoryOf(sheet.employees);
  const names = {
    salaryExpense: `TallyThis Test Salary Expenses ${tag}`,
    salaryPayable: `TallyThis Test Salary Payable ${tag}`,
    pfPayable: `TallyThis Test PF Payable ${tag}`,
    esiPayable: `TallyThis Test ESI Payable ${tag}`,
    ptPayable: `TallyThis Test PT Payable ${tag}`,
    tdsPayable: `TallyThis Test TDS Payable ${tag}`,
    otherDeductionLedger: `TallyThis Test Advances ${tag}`,
    employerPfExpense: `TallyThis Test Employer PF ${tag}`,
    employerEsiExpense: `TallyThis Test Employer ESI ${tag}`,
  };
  const journal = buildPayrollJournal(statutory, sheet.employees, { clientName: company, tallyCompany: company, month: date.slice(0, 7), ...names });
  if (!journal.ok || !journal.xml) {
    note("Salary journal built", "failed", journal.errors.join(" "));
  } else {
    const sent = await sendVouchersToTally({ mastersXml: journal.mastersXml, vouchersXml: journal.xml, expected: 1 }, request);
    note("Salary journal imported", sent.ok ? "passed" : "failed", `created ${sent.created} of ${sent.expected}; messages: ${sent.messages.join(" | ") || "none"}`);
  }

  const failed = report.checks.filter(check => check.status === "failed");
  report.status = failed.length === 0 ? "passed" : "failed";
  report.remainingGate = "A real client's masters (GST duty ledgers with their GST settings), several rates in one invoice, and actual GST register output in Tally still need a CA's test on that company.";
  if (failed.length > 0) process.exitCode = 2;
} catch (error) {
  report.reason = error instanceof Error ? error.message : "Acceptance check failed.";
  process.exitCode = 2;
} finally {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, reason: report.reason, checks: report.checks.map(check => `${check.status}: ${check.name}`), report: output }, null, 2));
}
