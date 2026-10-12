/** Opt-in acceptance check against a disposable Tally company, never a mock server. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { buildTallyVoucherXml } from "../src/services/tallyVoucherXml";
import { parseCompanyNames, sendVouchersToTally } from "../src/services/tallyPush";
import { paise } from "../src/services/money";

const endpoint = process.env.TALLY_TEST_URL ?? "http://127.0.0.1:9000";
const company = process.env.TALLY_TEST_COMPANY ?? "";
const date = process.env.TALLY_TEST_DATE ?? "2025-04-01";
const output = process.env.TALLY_TEST_REPORT ?? "dist/TallyThis_import_acceptance.json";
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const report: Record<string, unknown> = { status: "blocked", engine: "real TallyPrime HTTP server", company, date, checkedAt: new Date().toISOString() };
async function request(body: string) {
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Tally HTTP status ${response.status}`);
  return response.text();
}
function collection(type: string, fields: string, target?: string) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>TallyThisAcceptance</ID></HEADER><BODY><DESC><STATICVARIABLES>${target ? `<SVCURRENTCOMPANY>${escape(target)}</SVCURRENTCOMPANY>` : ""}</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="TallyThisAcceptance" ISMODIFY="No"><TYPE>${type}</TYPE><FETCH>${fields}</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}
try {
  const companies = parseCompanyNames(await request(collection("Company", "NAME")));
  report.loadedCompanies = companies;
  if (!company || !companies.includes(company)) throw new Error("Choose a loaded disposable test company with TALLY_TEST_COMPANY. No import was attempted.");
  if (!process.argv.includes("--allow-test-import")) throw new Error("Read-only preflight complete. --allow-test-import is required to write synthetic test vouchers.");
  const tag = `TALLYTHIS-TEST-${randomUUID()}`;
  const rows = [
    { date, narration: `${tag} receipt`, description: `${tag} receipt`, reference: `${tag}-R`, debit: null, credit: 100.29, balance: null, counterparty: null, rowNumber: 1, confidence: 1 },
    { date, narration: `${tag} payment`, description: `${tag} payment`, reference: `${tag}-P`, debit: 29.01, credit: null, balance: null, counterparty: null, rowNumber: 2, confidence: 1 },
  ];
  const built = buildTallyVoucherXml({ companyName: company, tallyCompany: company, bankLedger: "TallyThis Test Bank", transactions: rows.map(row => ({ ...row, ledgerName: "Suspense" })) as any, createLedgers: false });
  if (!built.ok || !built.xml) throw new Error(built.errors.join(" "));
  const imported = await sendVouchersToTally({ mastersXml: built.mastersXml, vouchersXml: built.xml, expected: 2 }, request);
  report.importResult = imported;
  report.source = rows;
  if (!imported.ok) throw new Error("The real Tally import did not acknowledge exactly two clean voucher creations.");
  const actual = await request(collection("Voucher", "DATE,REFERENCE,VOUCHERTYPENAME,NARRATION,ALLLEDGERENTRIES.LIST", company));
  const vouchers = actual.match(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/gi) ?? [];
  const checked = rows.map(row => {
    const matches = vouchers.filter(xml => xml.includes(`<REFERENCE>${row.reference}</REFERENCE>`));
    if (matches.length !== 1) throw new Error(`Expected one read-back voucher for ${row.reference}; found ${matches.length}.`);
    const xml = matches[0];
    if (!xml.includes(`<DATE>${date.replace(/-/g, "")}</DATE>`)) throw new Error("Read-back date differs.");
    if (!xml.includes(`<VOUCHERTYPENAME>${row.credit != null ? "Receipt" : "Payment"}</VOUCHERTYPENAME>`)) throw new Error("Read-back voucher type differs.");
    const expected = row.credit != null ? -paise(row.credit)! : paise(row.debit!)!;
    const lines = xml.match(/<ALLLEDGERENTRIES.LIST>[\s\S]*?<\/ALLLEDGERENTRIES.LIST>/gi) ?? [];
    const bank = lines.find(line => line.includes("<LEDGERNAME>TallyThis Test Bank</LEDGERNAME>"));
    const bankAmount = bank?.match(/<AMOUNT>([^<]+)<\/AMOUNT>/)?.[1];
    if (bankAmount == null || paise(Number(bankAmount)) !== expected) throw new Error("Read-back bank amount or ledger differs.");
    const other = lines.find(line => line.includes("<LEDGERNAME>Suspense</LEDGERNAME>"))?.match(/<AMOUNT>([^<]+)<\/AMOUNT>/)?.[1];
    if (lines.length !== 2 || other == null || paise(Number(other)) !== -expected) throw new Error("Read-back other ledger or amount differs.");
    return { reference: row.reference, date, bankPaise: expected };
  });
  report.status = "passed_first_import";
  report.readBack = checked;
  report.remainingGate = "Repeat-import, master compatibility, other voucher types and all bank formats need separate acceptance evidence.";
} catch (error) {
  report.reason = error instanceof Error ? error.message : "Acceptance check failed.";
  process.exitCode = 2;
} finally {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, reason: report.reason, report: output }));
}
