import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { counterpartyFrom, parseBankStatement, unifyParties } from "./bankStatement";

test("bank input with sub-paise values is rejected instead of rounded silently", () => {
  const result = parseBankStatement("Date,Narration,Debit,Credit,Balance\n2026-05-01,Test,1.005,,100.00", "test.csv");
  assert.notEqual(result.status, "parsed");
});

test("marketplace negative source amounts survive into the working evidence", () => {
  const pack = normalizeMarketplaceCsv("Invoice Number,Invoice Date,Taxable Value,CGST,SGST,Gross Amount,Cess,HSN,GST Rate,Place of Supply,Transaction Type\nCN-1,01/05/2026,-100,-9,-9,-123,-5,610910,18,Karnataka,credit_note", "amazon", "negative.csv");
  assert.equal(pack.sales[0].taxableValue, -100);
  assert.equal(pack.sales[0].grossAmount, -123);
  assert.equal(pack.sales[0].cess, -5);
});
import { buildTallyVoucherXml, LEDGER_OPTIONS, resolveLedger, suggestLedger, suggestLedgerDetail, validateTallyVoucherXml } from "./tallyVoucherXml";
import { compareBankWithTally, parseTallyLedgerCsv } from "./statementCompare";
import { buildGstDraftJson, mergeEcommercePacks, normalizeMarketplaceCsv, salesToCsv } from "./ecommerceGst";
import { comparePortalTcs, readPortalTcs, reviewDocumentSummary, reviewMarketplaceSales } from "./ecommerceReview";
import { buildEcommerceSalesXml } from "./ecommerceSalesXml";
import { detectFileKind, detectMarketplace } from "./fileDetect";
import { compareInvoicesWithBank, parseInvoiceCsv } from "./invoiceVerify";
import { recognizeStatement } from "./statementOcr";
import { createLoginThrottle, throttleMessage } from "./loginThrottle";
import * as XLSX from "xlsx";
import { NOT_A_STATEMENT, UnreadableFileError, notAStatementMessage, sheetToCsvText } from "./fileDetect";
import { detectBankFromStatement } from "./bankDirectory";
import { buildBankToTallyWorkbook } from "./bankToTallyWorkbook";
import { parseCompanyNames, parseImportResponse, parseLedgers, sendVouchersToTally } from "./tallyPush";
import { buildEcommerceWorkbook } from "./ecommerceWorkbook";
import { mergeLedgerPreferences } from "./ledgerPreferences";

test("posting stops on ledger failures and requires actual Tally acknowledgements", async () => {
  const calls: string[] = [];
  const blocked = await sendVouchersToTally({ mastersXml: "masters", vouchersXml: "vouchers", expected: 2 }, async xml => { calls.push(xml); return "<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Group does not exist</LINEERROR></RESPONSE>"; });
  assert.equal(blocked.ok, false);
  assert.deepEqual(calls, ["masters"]);
  await assert.rejects(sendVouchersToTally({ vouchersXml: "vouchers", expected: 2 }, async () => "Unknown Request"), /acknowledgement/);
  const accepted = await sendVouchersToTally({ mastersXml: "masters", vouchersXml: "vouchers", expected: 2 }, async xml => xml === "masters" ? "<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger already exists</LINEERROR></RESPONSE>" : "<RESPONSE><CREATED>2</CREATED><ERRORS>0</ERRORS></RESPONSE>");
  assert.equal(accepted.ok, true);
});
import ExcelJS from "exceljs";
import { aiDecision, historyCutoff, historyMonths, outsideWindowMessage, planIsActive, privacyAvailable, truthy } from "./privacyPolicy";

test("later ledger choices keep prior approved parties and exact keys", () => {
  assert.deepEqual(mergeLedgerPreferences([[{ counterparty: "Acme", ledgerName: "Office Expenses" }], [{ counterparty: "ACME", ledgerName: "Purchase" }, { counterparty: "Beta", ledgerName: "Sales" }], [{ counterparty: 5, ledgerName: "Cash" }]]), [{ counterparty: "Acme", ledgerName: "Office Expenses" }, { counterparty: "Beta", ledgerName: "Sales" }]);
  assert.equal(resolveLedger({ narration: "Payment to ALPHABETA", description: "Payment to ALPHABETA", counterparty: "ALPHABETA", credit: null }, [{ counterparty: "ALPHA", ledgerName: "Professional Fees" }]).name, "Suspense");
});

test("bank XML rejects sub-paise amounts, same-ledger postings and XML control characters", () => {
  const row = { date: "2026-05-01", narration: "Test", description: "Test", reference: null, debit: 2, credit: null, rowNumber: 1, counterparty: null, ledgerName: "Suspense" } as any;
  for (const change of [{ debit: 1.005 }, { ledgerName: "Bank" }, { narration: "Test\u0001text" }]) assert.equal(buildTallyVoucherXml({ companyName: "Test", bankLedger: "Bank", transactions: [{ ...row, ...change }] }).ok, false);
});

test("linked credit notes preserve source signs, reduce totals and reverse voucher lines", () => {
  const original = normalizeMarketplaceCsv("Invoice Number,Invoice Date,Taxable Value,CGST,SGST,Gross Amount,HSN,GST Rate,Place of Supply\nINV-1,01/05/2026,100,9,9,118,610910,18,Karnataka", "amazon", "sales.csv").sales[0];
  const note = { ...original, invoiceNumber: "CN-1", originalInvoiceNumber: "INV-1", invoiceDate: "2026-05-02", taxableValue: -50, cgst: -4.5, sgst: -4.5, grossAmount: -59, transactionType: "credit_note", sourceRow: 3 };
  const reviewed = reviewMarketplaceSales([original, note], "amazon");
  assert.equal(reviewed.ok, true);
  if (!reviewed.ok) return;
  assert.equal(reviewed.pack.summary.errors, 0);
  assert.equal(reviewed.pack.summary.taxableValue, 50);
  assert.equal(reviewed.pack.summary.gst, 9);
  assert.equal(reviewed.pack.summary.gross, 59);
  assert.equal(reviewed.pack.tabs.hsn[0].taxableValue, 50);
  assert.equal(reviewed.pack.sales[1].grossAmount, -59);
  const xml = buildEcommerceSalesXml({ clientName: "Example", sales: reviewed.pack.sales });
  assert.equal(xml.ok, true);
  if (xml.ok) { assert.equal(xml.voucherCount, 2); assert.match(xml.xml, /VCHTYPE="Credit Note"/); assert.match(xml.xml, /<REFERENCE>INV-1<\/REFERENCE>/); }
  const draft = buildGstDraftJson(reviewed.pack);
  if (!draft.ok) throw new Error("Draft should retain linked credit notes");
  assert.equal(draft.json.creditNotes[0].total, -59);
  const workbook = buildEcommerceWorkbook({ clientName: "Example", sales: reviewed.pack.sales });
  assert.equal(workbook.getWorksheet("Summary")!.getCell("B10").value, 59);
  assert.equal(workbook.getWorksheet("HSN summary")!.getCell("C2").value, 50);
  assert.equal(workbook.getWorksheet("Credit notes")!.getCell("G2").value, -59);
  for (const invalid of [{ originalInvoiceNumber: "MISSING" }, { gstRate: 12 }, { taxableValue: -200, cgst: -18, sgst: -18, grossAmount: -236 }]) {
    const rejected = reviewMarketplaceSales([original, { ...note, ...invalid }], "amazon");
    assert.equal(rejected.ok, true);
    if (rejected.ok) { assert.ok(rejected.pack.summary.errors > 0); assert.equal(buildEcommerceSalesXml({ clientName: "Example", sales: rejected.pack.sales }).ok, false); }
  }
});

test("unreadable marketplace amounts stop the entire multi-file pack", () => {
  const valid = normalizeMarketplaceCsv("Invoice Number,Invoice Date,Taxable Value\nINV-1,01/05/2026,100", "amazon", "valid.csv");
  const invalid = normalizeMarketplaceCsv("Invoice Number,Invoice Date,Taxable Value\nINV-2,01/05/2026,unreadable", "amazon", "invalid.csv");
  assert.notEqual(valid.status, "failed");
  assert.equal(invalid.status, "failed");
  assert.match(invalid.message, /unreadable|precision/);
  assert.equal(mergeEcommercePacks([valid, invalid]).status, "failed");
});

test("a workbook with two populated financial sheets never silently drops one", () => {
  const book = XLSX.utils.book_new();
  for (const name of ["Bank one", "Bank two"]) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Date", "Narration", "Debit"], ["2026-05-01", name, 100]]), name);
  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  assert.throws(() => sheetToCsvText({ originalname: "two-banks.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer }), /multiple|more than one/i);
});

test("an Excel reading limit never returns a truncated financial table", () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Date", "Narration", "Debit"], ["2026-05-01", "A", 100], ["2026-05-02", "B", 200]]), "Bank");
  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  assert.throws(() => sheetToCsvText({ originalname: "limited.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer }, 2), /incomplete|limit/);
});

function repoFile(name: string) {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    dir = join(dir, "..");
  }
  throw new Error(`Missing fixture ${name}`);
}

const bankCsv = readFileSync(repoFile("finverify_test_bank_statement_may_2026.csv"), "utf8");
const tallyCsv = readFileSync(repoFile("finverify_test_tally_ledger_may_2026.csv"), "utf8");
const amazonCsv = readFileSync(repoFile("fixtures/synthetic/amazon_sales_may_2026.csv"), "utf8");

test("bank statement keeps debit and credit values", () => {
  const summary = parseBankStatement(bankCsv, "finverify_test_bank_statement_may_2026.csv");
  assert.equal(summary.transactions.length, 10);
  assert.equal(summary.bankName, "HDFC Bank");
  assert.equal(summary.transactions[0].debit, 5000);
  assert.equal(summary.transactions[1].credit, 75000);
  assert.ok(summary.debitTotal > 0);
  assert.ok(summary.creditTotal > 0);
  assert.match(summary.message, /Parsed successfully/);
});

test("bank detection prefers the account IFSC and understands short bank names", () => {
  assert.equal(detectBankFromStatement("ICICI Bank\nBranch IFSC Code: ICIC0000123\nTransfer to HDFC Bank")?.name, "ICICI Bank");
  assert.equal(detectBankFromStatement("Bank Name: KOTAK\nAccount Statement")?.name, "Kotak Mahindra Bank");
  assert.equal(detectBankFromStatement("", "ICICI_Statement_May.pdf")?.name, "ICICI Bank");
  assert.equal(detectBankFromStatement("IFSC: SMCB0001015\nAccount statement")?.name, "Shivalik Small Finance Bank");
  assert.equal(detectBankFromStatement("Unity Small Finance Bank\nAccount statement")?.name, "Unity Small Finance Bank");
  assert.equal(detectBankFromStatement("Account Statement", "statement.pdf"), null);
});

test("a dated bank row with an unreadable amount stops an incomplete export", () => {
  const summary = parseBankStatement([
    "Bank Name: HDFC Bank",
    "Date,Narration,Debit,Credit,Balance",
    "01/05/2026,UPI/ACME,500.00,,1000.00",
    "02/05/2026,NEFT/PAYROLL,unreadable,,1500.00",
  ].join("\n"), "statement.csv");
  assert.equal(summary.status, "failed");
  assert.equal(summary.transactions.length, 0);
  assert.match(summary.message, /1 dated row has no readable/);
});

test("an impossible transaction date stops the statement export", () => {
  const summary = parseBankStatement([
    "Date,Narration,Debit,Credit,Balance",
    "01/05/2026,UPI/ACME,500.00,,1000.00",
    "31/02/2026,NEFT/PAYROLL,,100.00,1100.00",
  ].join("\n"), "statement.csv");
  assert.equal(summary.status, "failed");
  assert.equal(summary.transactions.length, 0);
  assert.match(summary.message, /invalid date/);
});

test("Excel statement keeps reviewed ledger choices and marks left-out rows", async () => {
  const source = parseBankStatement(bankCsv, "statement.csv").transactions.slice(0, 2);
  const workbook = buildBankToTallyWorkbook({
    clientName: "Example Client",
    bankName: "HDFC Bank",
    accountNumberMasked: "1234",
    periodLabel: "May 2026",
    openingBalance: 1000,
    closingBalance: 900,
    balanceCheck: "passed",
    rows: source.map((txn, index) => ({
      rowNumber: txn.rowNumber,
      date: txn.date,
      valueDate: txn.valueDate,
      narration: txn.narration,
      reference: txn.reference,
      debit: txn.debit,
      credit: txn.credit,
      balance: txn.balance,
      counterparty: txn.counterparty,
      ledgerChoice: index === 0 ? "Office Expenses" : "Suspense",
      ledgerConfirmed: true,
      needsReview: index === 0,
      reviewed: index === 0,
      edited: false,
      excluded: index === 1,
    })),
  });
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
  assert.equal(loaded.worksheets[0].name, "Statement");
  const statement = loaded.getWorksheet("Statement")!;
  assert.equal(statement.getCell("C2").value, 1000);
  assert.equal(statement.getCell("C4").value, "Ready for Tally");
  assert.equal(statement.getCell("E7").value, source[0].debit);
  assert.equal(statement.getCell("H7").value, source[0].credit != null ? "Receipt" : "Payment");
  assert.equal(statement.getCell("I7").value, "Office Expenses");
  assert.equal(statement.getCell("K7").value, "Checked");
  assert.equal(statement.getCell("I8").value, "");
  assert.equal(statement.getCell("K8").value, "Left out of Tally file");
  assert.equal(statement.getCell("C9").value, "Total");
  const summary = loaded.getWorksheet("Summary")!;
  assert.equal(summary.getCell("B6").value, "HDFC Bank");
  assert.equal(summary.getCell("B9").value, 1);
  assert.equal(summary.getCell("B10").value, 1);

  const party = { rowNumber: 1, date: "2026-05-01", valueDate: null, narration: "UPI/ACME SUPPLIES", reference: null, debit: 500, credit: null, balance: null, counterparty: "ACME SUPPLIES", needsReview: false, reviewed: false, edited: false, excluded: false };
  const partyCopy = buildBankToTallyWorkbook({
    clientName: "Example Client", bankName: "HDFC Bank", accountNumberMasked: null, periodLabel: null, openingBalance: null, closingBalance: null, balanceCheck: "passed",
    rows: [{ ...party, ledgerChoice: "Sundry Creditors", ledgerConfirmed: true }],
  });
  assert.equal(partyCopy.getWorksheet("Statement")?.getCell("I7").value, "Acme Supplies");
  assert.equal(partyCopy.getWorksheet("Statement")?.getCell("J7").value, "Sundry Creditors");
});

test("Excel shows the same open items as the review screen", () => {
  const base = { valueDate: null, reference: null, credit: null, balance: null, needsReview: false, reviewed: false, edited: false, excluded: false };
  const workbook = buildBankToTallyWorkbook({
    clientName: "Example Client", bankName: "DBS Bank India", accountNumberMasked: "4321", periodLabel: null, openingBalance: 100, closingBalance: 40, balanceCheck: "passed",
    rows: [
      { ...base, rowNumber: 1, date: "2026-05-01", narration: "UPI 1 vendorone@ybl VENDOR ONE", debit: 10, counterparty: "VENDOR ONE", ledgerChoice: "Sundry Creditors", ledgerConfirmed: false },
      { ...base, rowNumber: 2, date: "2026-05-02", narration: "UPI 2 vendorone@ybl VENDOR ONE", debit: 20, counterparty: "VENDOR ONE", ledgerChoice: "Sundry Creditors", ledgerConfirmed: false },
      { ...base, rowNumber: 3, date: "2026-05-03", narration: "UPI 3 vendortwo@ybl VENDOR TWO", debit: 30.1, counterparty: "VENDOR TWO", ledgerChoice: "Suspense", ledgerConfirmed: false },
      { ...base, rowNumber: 4, date: "2026-05-04", narration: "UPI 4 google@icici Google India", debit: 0.2, counterparty: "Google India", ledgerChoice: "Software Expenses", ledgerConfirmed: true },
    ],
  });
  const statement = workbook.getWorksheet("Statement")!;
  assert.equal(statement.getCell("C4").value, "Not ready for Tally: 2 items need attention");
  assert.equal(statement.getCell("K7").value, "Confirm ledger");
  assert.equal(statement.getCell("K9").value, "Choose ledger");
  assert.equal(statement.getCell("K10").value, "Ready");
  const summary = workbook.getWorksheet("Summary")!;
  const value = (label: string) => summary.getRows(1, summary.rowCount)?.find(row => row.getCell(1).value === label)?.getCell(2).value;
  assert.equal(value("Party ledgers to choose or confirm"), 2);
  assert.equal(value("Parties going to Suspense"), 1);
  assert.equal(value("Money paid"), 60.3);
  assert.equal(value("Questions for the client"), 0);
  assert.equal(workbook.getWorksheet("Client queries"), undefined);
});

test("Excel carries row voucher choices and the client's questions", () => {
  const base = { valueDate: null, reference: null, balance: null, needsReview: false, reviewed: false, edited: false, excluded: false, ledgerConfirmed: true };
  const workbook = buildBankToTallyWorkbook({
    clientName: "Example Client", bankName: "HDFC Bank", accountNumberMasked: null, periodLabel: null, openingBalance: null, closingBalance: null, balanceCheck: "passed",
    rows: [
      { ...base, rowNumber: 1, date: "2026-05-01", narration: "ATM WDL", debit: 2000, credit: null, counterparty: null, ledgerChoice: "Cash" },
      { ...base, rowNumber: 2, date: "2026-05-02", narration: "UPI ACME JEWELLERS", debit: 100000, credit: null, counterparty: "ACME JEWELLERS", ledgerChoice: "Suspense", query: "What was this jewellery purchase for?" },
    ],
  });
  const statement = workbook.getWorksheet("Statement")!;
  assert.equal(statement.getCell("H7").value, "Contra");
  assert.equal(statement.getCell("H8").value, "Payment");
  const queries = workbook.getWorksheet("Client queries")!;
  assert.equal(queries.getCell("B2").value, "UPI ACME JEWELLERS");
  assert.equal(queries.getCell("E2").value, "What was this jewellery purchase for?");
});

test("tally xml balances and rejects empty input", () => {
  const summary = parseBankStatement(bankCsv, "statement.csv");
  const built = buildTallyVoucherXml({
    companyName: "NovaStack Labs Pvt Ltd",
    bankLedger: "HDFC Bank",
    transactions: summary.transactions,
  });
  assert.equal(built.ok, true);
  assert.equal(built.voucherCount, 10);
  assert.equal(validateTallyVoucherXml(built.xml ?? "", 10).ok, true);
  assert.match(built.xml ?? "", /<ENVELOPE>/);
  const empty = buildTallyVoucherXml({ companyName: "NovaStack Labs Pvt Ltd", bankLedger: "HDFC Bank", transactions: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.xml, undefined);
  const invalidDate = buildTallyVoucherXml({ companyName: "NovaStack Labs Pvt Ltd", bankLedger: "HDFC Bank", transactions: [{ ...summary.transactions[0], date: "2026-02-31" }] });
  assert.equal(invalidDate.ok, false);
  assert.match(invalidDate.errors.join(" "), /date/);
});

test("bank and tally comparison stays on the uploaded rows", () => {
  const bank = parseBankStatement(bankCsv, "bank.csv");
  const tally = parseTallyLedgerCsv(tallyCsv);
  const result = compareBankWithTally(bank.transactions, tally);
  assert.equal(result.counts.bank, 10);
  assert.equal(result.counts.tally, 10);
  assert.ok(result.counts.confirmed + result.counts.suggested + result.counts.bankOnly + result.counts.amountDifferences >= 10);

  const mismatch = compareBankWithTally(
    [{ ...bank.transactions[0], debit: 9999, credit: null, narration: "UPI-ACME Corp", counterparty: "ACME Corp" }],
    tally.filter(row => row.ledgerName.includes("ACME")),
  );
  assert.equal(mismatch.counts.amountDifferences, 1);

  const onlyBank = compareBankWithTally(
    [{ ...bank.transactions[0], narration: "Unique counterparty ZZTOP", counterparty: "ZZTOP", debit: 42, credit: null }],
    [],
  );
  assert.equal(onlyBank.counts.bankOnly, 1);
});

test("amazon sales become a draft gst json", () => {
  const pack = normalizeMarketplaceCsv(amazonCsv, "amazon", "amazon_sales_may_2026.csv");
  assert.ok(pack.sales.length >= 3);
  assert.ok(pack.tabs.b2b.length >= 1);
  assert.ok(pack.tabs.b2c.length >= 1);
  assert.ok(pack.tabs.hsn.length >= 1);
  const gst = buildGstDraftJson(pack);
  assert.equal(gst.ok, true);
  if (gst.ok) assert.equal(gst.json.schema, "finverify.gstr1.draft.v1");
});

test("marketplace CSV escapes spreadsheet formulas in uploaded text", () => {
  const pack = normalizeMarketplaceCsv(amazonCsv, "amazon", "amazon.csv");
  const csv = salesToCsv([{ ...pack.sales[0], invoiceNumber: "=HYPERLINK(\"https://example.test\")" }]);
  assert.match(csv, /"'=HYPERLINK/);
});

test("reviewed GST rows recalculate HSN sections and document counts", () => {
  const pack = normalizeMarketplaceCsv(amazonCsv, "amazon", "amazon.csv");
  const changed = pack.sales.map(sale => sale.invoiceNumber === "INV-A-2" ? { ...sale, hsn: "620400", gstRate: 18 } : sale);
  const reviewed = reviewMarketplaceSales(changed, "amazon", true);
  assert.equal(reviewed.ok, true);
  if (!reviewed.ok) return;
  assert.ok(reviewed.pack.tabs.hsn.some(row => row.supply === "B2C" && row.hsn === "620400"));
  assert.ok(reviewed.pack.sales.some(sale => sale.hsn === "6109" && sale.issues.some(issue => issue.includes("HSN length"))));
  const docs = reviewDocumentSummary([{ platform: "amazon", issued: 7, cancelled: 1, source: "accountant correction" }], reviewed.pack.sales);
  assert.equal(docs.ok, true);
  if (docs.ok) assert.equal(docs.rows[0].issued, 7);
  assert.equal(reviewDocumentSummary([{ platform: "amazon", issued: 1, cancelled: 2 }], reviewed.pack.sales).ok, false);
  const recounted = reviewDocumentSummary([{ platform: "amazon", issued: 99, cancelled: 0, source: "uploaded reports" }], reviewed.pack.sales);
  if (recounted.ok) assert.equal(recounted.rows[0].issued, 3, "source-derived counts follow reviewed invoice rows");
});

test("uploaded portal TCS compares states and rejects unreadable summaries", () => {
  const pack = normalizeMarketplaceCsv(amazonCsv, "amazon", "amazon.csv");
  const portal = readPortalTcs("State,TCS Amount\nKarnataka,140\n27 - Maharashtra,20\n");
  assert.equal(portal.ok, true);
  if (!portal.ok) return;
  const compared = comparePortalTcs(pack.sales, portal.rows);
  assert.equal(compared.ok, true);
  if (compared.ok) assert.equal(compared.mismatches, 0);
  const mismatch = comparePortalTcs(pack.sales, [{ state: "27", amount: 12 }]);
  if (mismatch.ok) assert.ok(mismatch.mismatches > 0);
  assert.equal(readPortalTcs("State,Value\nKarnataka,100").ok, false);
  const paiseDifference = comparePortalTcs(pack.sales, [{ state: "29", amount: 139.99 }, { state: "27", amount: 20 }]);
  if (paiseDifference.ok) assert.equal(paiseDifference.mismatches, 1, "one paise difference is not an exact match");
  const adjusted = pack.sales.map((sale, index) => index === 0 ? { ...sale, tcsAmount: -sale.tcsAmount } : sale);
  const signed = comparePortalTcs(adjusted, [{ state: "29", amount: 0 }, { state: "27", amount: 20 }]);
  assert.equal(signed.ok, true);
  if (signed.ok) assert.ok(signed.rows.find(row => row.code === "29")!.uploaded < 0, "negative TCS adjustments keep their sign");
});

test("Sales XML needs reviewed rows and B2B ledgers, then balances tax lines", () => {
  const pack = normalizeMarketplaceCsv(amazonCsv, "amazon", "amazon.csv");
  assert.equal(buildEcommerceSalesXml({ clientName: "Example", sales: pack.sales }).ok, false);
  const clean = pack.sales.filter(sale => sale.transactionType !== "refund");
  const missingParties = buildEcommerceSalesXml({ clientName: "Example", sales: clean });
  assert.equal(missingParties.ok, false);
  if (!missingParties.ok) assert.match(missingParties.errors.join(" "), /party ledgers/i);
  const built = buildEcommerceSalesXml({ clientName: "Example", sales: clean, partyLedgers: { "29ABCDE1234F1Z5": "Customer Karnataka", "27AABCU9603R1ZM": "Customer Maharashtra" } });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal((built.xml.match(/<VOUCHER VCHTYPE="Sales"/g) ?? []).length, clean.length);
  assert.match(built.xml, /<LEDGERNAME>Output CGST<\/LEDGERNAME>/);
  for (const voucher of built.xml.match(/<VOUCHER VCHTYPE="Sales"[\s\S]*?<\/VOUCHER>/g) ?? []) {
    const total = [...voucher.matchAll(/<AMOUNT>(-?\d+\.\d{2})<\/AMOUNT>/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    assert.equal(Math.round(total * 100), 0);
  }
});

test("cancelled documents are retained in evidence and excluded from GST and Sales vouchers", async () => {
  const source = normalizeMarketplaceCsv(amazonCsv, "amazon", "amazon.csv").sales[1];
  const cancelled = { ...source, invoiceNumber: "CANCEL-2", sourceRow: 99, transactionType: "CANCELLED", hsn: null };
  const reviewed = reviewMarketplaceSales([source, cancelled], "amazon");
  assert.equal(reviewed.ok, true);
  if (!reviewed.ok) return;
  assert.equal(reviewed.pack.sales.length, 2);
  assert.equal(reviewed.pack.tabs.b2c.length, 1);
  assert.equal(reviewed.pack.summary.gross, source.grossAmount);
  assert.equal(reviewed.pack.summary.excludedSalesRows, 1);
  const built = buildEcommerceSalesXml({ clientName: "Example", sales: reviewed.pack.sales });
  assert.equal(built.ok, true);
  if (built.ok) {
    assert.equal(built.voucherCount, 1);
    assert.equal(built.excludedCancelled, 1);
    assert.doesNotMatch(built.xml, /CANCEL-2/);
  }
  const workbook = buildEcommerceWorkbook({ clientName: "Example", sales: reviewed.pack.sales });
  assert.equal(workbook.getWorksheet("Summary")!.getCell("B10").value, source.grossAmount);
  assert.equal(workbook.getWorksheet("Sales")!.getCell("R3").value, "Excluded from sales totals");
});

test("returns, credit notes and negative source adjustments cannot become ordinary sales", () => {
  const source = normalizeMarketplaceCsv(amazonCsv, "amazon", "amazon.csv").sales[1];
  for (const type of ["RETURN", "credit_note", "refund", "adjustment"]) {
    const review = reviewMarketplaceSales([{ ...source, transactionType: type }], "amazon");
    if (!review.ok) throw new Error("Review rejected a valid adjustment row");
    assert.equal(review.pack.tabs.b2c.length, 0, type);
    assert.equal(review.pack.summary.gross, 0, type);
    assert.ok(review.pack.sales[0].issues.length, type);
    assert.equal(buildEcommerceSalesXml({ clientName: "Example", sales: review.pack.sales }).ok, false, type);
  }
  const negative = normalizeMarketplaceCsv("Invoice Number,Invoice Date,Taxable Value,CGST,SGST,Gross Amount,HSN,GST Rate,Place of Supply\nCN-1,01/05/2026,-100,-9,-9,-118,610910,18,Karnataka", "amazon", "negative.csv");
  assert.equal(negative.sales[0].transactionType, "adjustment");
  assert.equal(negative.tabs.b2c.length, 0);
});

test("cess is checked separately from the GST rate and preserved in working exports", () => {
  const source = normalizeMarketplaceCsv(amazonCsv, "amazon", "amazon.csv").sales[1];
  const row = { ...source, taxableValue: 100, cgst: 9, sgst: 9, igst: 0, cess: 5, grossAmount: 123 };
  const review = reviewMarketplaceSales([row], "amazon");
  assert.equal(review.ok, true);
  if (!review.ok) return;
  assert.equal(review.pack.summary.errors, 0);
  assert.equal(review.pack.summary.gst, 18);
  assert.equal(review.pack.summary.cess, 5);
  const json = buildGstDraftJson(review.pack);
  assert.equal(json.ok, true);
  if (json.ok) assert.equal(json.json.b2c[0].csamt, 5);
  const xml = buildEcommerceSalesXml({ clientName: "Example", sales: review.pack.sales });
  assert.equal(xml.ok, true);
  if (xml.ok) assert.match(xml.xml, /<LEDGERNAME>Output Cess<\/LEDGERNAME>/);
  const workbook = buildEcommerceWorkbook({ clientName: "Example", sales: review.pack.sales });
  assert.equal(workbook.getWorksheet("Sales")!.getCell("P2").value, 5);
  assert.equal(workbook.getWorksheet("Summary")!.getCell("B12").value, 5);
  const mismatch = reviewMarketplaceSales([{ ...row, grossAmount: 123.50 }], "amazon");
  if (mismatch.ok) assert.ok(mismatch.pack.sales[0].issues.some(issue => issue.includes("do not add up")), "a difference below one rupee is still a discrepancy");
});

test("marketplace Excel summary keeps numeric sales and uploaded TCS by state", async () => {
  const pack = normalizeMarketplaceCsv(amazonCsv, "amazon", "amazon_sales_may_2026.csv");
  const comparison = comparePortalTcs(pack.sales, [{ state: "Karnataka", amount: 140 }, { state: "Maharashtra", amount: 20 }]);
  assert.equal(comparison.ok, true);
  if (!comparison.ok) return;
  const workbook = buildEcommerceWorkbook({ clientName: "Example Client", sales: pack.sales, documents: [{ platform: "amazon", issued: 3, cancelled: 0, source: "accountant correction" }], tcsComparison: comparison });
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
  assert.equal(loaded.getWorksheet("Summary")?.getCell("B4").value, pack.sales.length);
  assert.equal(loaded.getWorksheet("Summary")?.getCell("B11").value, Math.round(pack.sales.reduce((total, sale) => total + sale.tcsAmount, 0) * 100) / 100);
  assert.equal(loaded.getWorksheet("Sales")?.getCell("I2").value, pack.sales[0].taxableValue);
  assert.ok((loaded.getWorksheet("TCS by state")?.rowCount ?? 0) > 1);
  assert.ok((loaded.getWorksheet("Portal TCS comparison")?.rowCount ?? 0) > 1);
  assert.equal(loaded.getWorksheet("Documents")?.getCell("B2").value, 3);
});

test("invoice register suggests a payment match", () => {
  const bank = parseBankStatement(bankCsv, "bank.csv");
  const invoices = parseInvoiceCsv("Invoice Number,Invoice Date,Vendor,Total\nINV-100,01/05/2026,ACME Corp,5000\nINV-404,02/05/2026,Missing Vendor,111\n");
  const result = compareInvoicesWithBank(bank.transactions, invoices);
  assert.ok(result.items.some(item => item.bucket === "matched" || item.bucket === "suggested"));
  assert.ok(result.items.some(item => item.bucket === "invoice_without_payment"));
});

test("empty text does not pretend rows were found", () => {
  const summary = parseBankStatement("   ", "scan.pdf");
  assert.equal(summary.transactions.length, 0);
  assert.match(summary.message, /scanned|not detected/i);
});

test("ocr fails closed when the engine is missing", async () => {
  const previous = process.env.TESSERACT_PATH;
  process.env.TESSERACT_PATH = "E:\\missing\\finverify-tesseract.exe";
  try {
    const result = await recognizeStatement({ buffer: Buffer.from("not-an-image"), fileName: "scan.png", kind: "image" });
    assert.equal(result.available, false);
    if (!result.available) {
      assert.equal(result.reason, "OCR unavailable");
      assert.match(result.note, /No transactions were created/);
    }
  } finally {
    if (previous == null) delete process.env.TESSERACT_PATH;
    else process.env.TESSERACT_PATH = previous;
  }
});

test("Go does not own /api/jobs until response parity exists", () => {
  const gateway = readFileSync(repoFile("backend/gateway/cmd/api/main.go"), "utf8");
  const jobs = readFileSync(repoFile("backend/api/src/routes/jobs.ts"), "utf8");
  assert.doesNotMatch(gateway, /\/api\/jobs\//);
  assert.match(gateway, /TypeScript fallback/);
  for (const route of [
    "/jobs/bank-statement/normalize",
    "/jobs/bank-to-tally/xml",
    "/jobs/bank-tally/compare",
    "/jobs/runs/:id/decision",
    "/jobs/ecommerce/normalize",
    "/jobs/invoice-bank/compare",
  ]) {
    assert.match(jobs, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

function fakeFile(originalname: string, text: string) {
  return { originalname, mimetype: originalname.endsWith(".pdf") ? "application/pdf" : "text/csv", buffer: Buffer.from(text, "utf8") };
}

test("uploads are routed to the right job without asking", () => {
  assert.equal(detectFileKind(fakeFile("statement.csv", bankCsv)).kind, "bank_statement");
  assert.equal(detectFileKind(fakeFile("ledger.csv", tallyCsv)).kind, "tally_export");
  const amazon = detectFileKind(fakeFile("mtr_may.csv", amazonCsv));
  assert.equal(amazon.kind, "marketplace_report");
  assert.equal(amazon.platform, "amazon");
  const invoices = readFileSync(repoFile("fixtures/synthetic/invoice_register_may_2026.csv"), "utf8");
  assert.equal(detectFileKind(fakeFile("register.csv", invoices)).kind, "invoice_register");
  assert.equal(detectFileKind(fakeFile("scan.pdf", "%PDF")).kind, "bank_statement");
  assert.equal(detectFileKind(fakeFile("INV-204.pdf", "%PDF")).kind, "invoice_document");
});

test("marketplace is detected from the file name or header", () => {
  assert.equal(detectMarketplace("flipkart_sales_may.csv", ""), "flipkart");
  assert.equal(detectMarketplace("sales.csv", "Sub Order No,Supplier ID,Taxable Value"), "meesho");
  assert.equal(detectMarketplace("sales.csv", "Order ID,Invoice Number,Taxable Value"), "generic");
});

test("additional marketplace names are recognized without claiming layout coverage", () => {
  for (const [name, expected] of [["GlowRoad", "glowroad"], ["Shop101", "shop101"], ["Paytm", "paytm"], ["Snapdeal", "snapdeal"], ["AJIO", "ajio"], ["CityMall", "citymall"], ["LimeRoad", "limeroad"]] as const) {
    assert.equal(detectMarketplace(`${name}_sales.csv`, "Invoice,Amount\nA,100"), expected);
  }
});

test("several marketplace reports merge into one pack", () => {
  const flipkart = readFileSync(repoFile("fixtures/synthetic/flipkart_sales_may_2026.csv"), "utf8");
  const a = normalizeMarketplaceCsv(amazonCsv, "amazon", "amazon.csv");
  const b = normalizeMarketplaceCsv(flipkart, "flipkart", "flipkart.csv");
  const merged = mergeEcommercePacks([a, b]);
  assert.equal(merged.sales.length, a.sales.length + b.sales.length);
  assert.equal(merged.platform, "amazon + flipkart");
  assert.equal(merged.summary.documents, merged.sales.length);
});

test("ledger rules pick from the fixed choice list", () => {
  assert.equal(suggestLedger("NEFT-SALARY MAY 2026"), "Salary Expenses");
  assert.equal(suggestLedger("UPI-GOOGLE ADS/INV-22"), "Advertisement Expenses");
  assert.equal(suggestLedger("SMS ALERT CHGS"), "Bank Charges");
  assert.equal(suggestLedger("UPI-RANDOM PERSON"), "Suspense");
  assert.equal(suggestLedger("POS KOLAR STORES"), "Suspense");
  for (const name of ["Salary Expenses", "Advertisement Expenses", "Bank Charges", "Suspense"]) {
    assert.ok((LEDGER_OPTIONS as readonly string[]).includes(name));
  }
});

test("rows that break the running balance are sent to review", () => {
  const csv = [
    "Date,Narration,Debit,Credit,Balance",
    "01/05/2026,Opening deposit,,1000,1000",
    "02/05/2026,UPI-Shop,100,,900",
    "03/05/2026,UPI-Cafe,50,,800",
    "04/05/2026,UPI-Book,25,,775",
  ].join("\n");
  const summary = parseBankStatement(csv, "test.csv");
  assert.equal(summary.transactions.length, 4);
  const flagged = summary.transactions.filter(txn => txn.confidence < 0.9);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].narration, "UPI-Cafe");
  assert.ok(summary.warnings.some(warning => /running balance/.test(warning)));
});

test("newest-first statements do not raise balance warnings", () => {
  const csv = [
    "Date,Narration,Debit,Credit,Balance",
    "04/05/2026,UPI-Book,25,,825",
    "03/05/2026,UPI-Cafe,50,,850",
    "02/05/2026,UPI-Shop,100,,900",
    "01/05/2026,Opening deposit,,1000,1000",
  ].join("\n");
  const summary = parseBankStatement(csv, "test.csv");
  assert.equal(summary.transactions.filter(txn => txn.confidence < 0.9).length, 0);
});

test("same-day unique amounts without shared evidence remain review suggestions", () => {
  const bank = parseBankStatement(bankCsv, "bank.csv");
  const tally = parseTallyLedgerCsv(tallyCsv);
  const result = compareBankWithTally(bank.transactions, tally);
  assert.equal(result.counts.confirmed, 0);
  assert.equal(result.counts.suggested, 10);
});

test("a Tally bank-ledger export with debit and credit swapped still matches", () => {
  const bank = parseBankStatement(bankCsv, "bank.csv");
  const flipped = parseTallyLedgerCsv(tallyCsv).map(row => ({ ...row, debit: row.credit, credit: row.debit }));
  const result = compareBankWithTally(bank.transactions, flipped);
  assert.equal(result.counts.confirmed, 0);
  assert.equal(result.counts.suggested, 10);
});

test("confirmed bank matches need exact amounts and a complete shared reference", () => {
  const txn = parseBankStatement(bankCsv, "bank.csv").transactions[0];
  const row = { ...parseTallyLedgerCsv(tallyCsv)[0], narration: "Payment UTR12345678" };
  assert.equal(compareBankWithTally([txn], [row]).counts.confirmed, 1);
  assert.equal(compareBankWithTally([txn], [{ ...row, debit: row.debit! + .50 }]).counts.confirmed, 0, "rupee-tolerant amounts need review");
  assert.equal(compareBankWithTally([txn], [{ ...row, narration: "Payment UTR123456789" }]).counts.confirmed, 0, "a reference substring is not shared evidence");
  assert.equal(compareBankWithTally([{ ...txn, reference: "1" }], [{ ...row, narration: "Payment 1" }]).counts.confirmed, 0, "short references remain ambiguous");
});

test("two equal payments on nearby days stay suggestions, not automatic matches", () => {
  const bank = parseBankStatement(bankCsv, "bank.csv");
  const tally = parseTallyLedgerCsv(tallyCsv);
  const first = bank.transactions[0];
  const twin = { ...first, rowNumber: 99, date: "2026-05-02", narration: "UPI-Someone else/REF" };
  const tallyTwin = { ...tally[0], id: "tally-twin", rowNumber: 99, date: "2026-05-02", ledgerName: "Someone else" };
  const result = compareBankWithTally([first, twin], [tally[0], tallyTwin]);
  assert.equal(result.counts.confirmed, 0);
});

test("amounts that landed in the wrong column are fixed from the running balance", () => {
  // What a PDF table extractor produces when it loses column positions: every amount in one column.
  const csv = [
    "Date,Narration,Debit,Credit,Balance",
    "01/06/2026,UPI-SHARMA TRADERS,,12500.00,187500.00",
    "02/06/2026,NEFT CR-MEHTA EXPORTS,,45000.00,232500.00",
    "04/06/2026,IMPS-AIRTEL BROADBAND,,1179.00,231321.00",
    "06/06/2026,ATM WDL/ANDHERI,,10000.00,221321.00",
  ].join("\n");
  const summary = parseBankStatement(csv, "icici.pdf");
  const [first, second, third, fourth] = summary.transactions;
  assert.equal(second.credit, 45000);
  assert.equal(third.debit, 1179);
  assert.equal(third.credit, null);
  assert.equal(fourth.debit, 10000);
  assert.ok(first.confidence < 0.9, "earliest row has no prior balance, so it goes to review");
  assert.equal(summary.debitTotal, 11179);
});

test("bank name comes from the header, not an IFSC code in a row", () => {
  const csv = [
    "ICICI Bank Ltd - Statement of Account",
    "Date,Narration,Debit,Credit,Balance",
    "01/06/2026,UPI-SHARMA/HDFC0001234,500,,9500",
  ].join("\n");
  assert.equal(parseBankStatement(csv, "statement.csv").bankName, "ICICI Bank");
});

test("Tally XML creates missing ledgers and posts parties to their own ledger", () => {
  const bank = parseBankStatement(bankCsv, "bank.csv");
  const result = buildTallyVoucherXml({
    companyName: "Sharma Traders",
    bankLedger: "HDFC Bank",
    transactions: bank.transactions,
    mappings: [
      { counterparty: "ACME Corp", ledgerName: "Sundry Creditors" },
      { counterparty: "Office supplies", ledgerName: "Office Expenses" },
    ],
  });
  assert.equal(result.ok, true);
  const xml = result.xml ?? "";
  assert.doesNotMatch(xml, /SVCURRENTCOMPANY/, "import goes into whichever company is open in Tally");
  assert.match(xml, /<LEDGER NAME="HDFC Bank" ACTION="Create">[\s\S]*?<PARENT>Bank Accounts<\/PARENT>/);
  assert.match(xml, /<LEDGER NAME="ACME Corp" ACTION="Create">[\s\S]*?<PARENT>Sundry Creditors<\/PARENT>/);
  assert.match(xml, /<LEDGER NAME="Office Expenses" ACTION="Create">[\s\S]*?<PARENT>Indirect Expenses<\/PARENT>/);
  assert.doesNotMatch(xml, /<LEDGERNAME>Sundry Creditors<\/LEDGERNAME>/, "a group is never used as a ledger");
  assert.doesNotMatch(xml, /<LEDGER NAME="Cash"/, "built-in Cash ledger is not recreated");
  assert.equal(validateTallyVoucherXml(xml, bank.transactions.length).ok, true);
});

test("ledger masters can be left out", () => {
  const bank = parseBankStatement(bankCsv, "bank.csv");
  const result = buildTallyVoucherXml({ companyName: "X", bankLedger: "HDFC Bank", transactions: bank.transactions, createLedgers: false });
  assert.doesNotMatch(result.xml ?? "", /<LEDGER NAME=/);
});

test("invoice number in the narration plus exact amount is a match", () => {
  const bank = parseBankStatement(bankCsv, "bank.csv");
  const invoices = parseInvoiceCsv(readFileSync(repoFile("fixtures/synthetic/invoice_register_may_2026.csv"), "utf8"));
  const result = compareInvoicesWithBank(bank.transactions, invoices);
  const matched = result.items.filter(item => item.bucket === "matched").map(item => item.invoice?.invoiceNumber).sort();
  assert.deepEqual(matched, ["BILL-77", "INV-100"]);
  assert.ok(result.items.some(item => item.bucket === "no_invoice_expected"), "salary and ATM rows are not flagged as missing invoices");
});

test("bank interest credited is income, loan interest debited is an expense", () => {
  assert.equal(suggestLedger("100000002222:Int.Pd:01-01-2026 to 31-03-2026", [], "in"), "Interest Received");
  assert.equal(suggestLedger("CREDIT INTEREST - Saving", [], "in"), "Interest Received");
  assert.equal(suggestLedger("LOAN INT DEBIT 4455", [], "out"), "Interest Paid");
  assert.equal(suggestLedger("FD MATURITY PROCEEDS :5150212235/24-08-25", [], "in"), "Fixed Deposits");
  assert.equal(suggestLedger("Term Deposit-8000000000000001-ASHOK", [], "out"), "Fixed Deposits");
  assert.equal(suggestLedger("PG KOTAK MAHINDRA LIFE", [], "out"), "Insurance Premium");
});

test("per-row ledger and voucher choices reach the Tally XML, and Contra needs cash", () => {
  const base = { valueDate: null, description: "", reference: null, balance: null, accountName: null, accountNumberMasked: null, bankName: null, confidence: 1, sourceFile: "", sourcePage: null, sourceQuote: "" };
  const rows = [
    { ...base, rowNumber: 1, date: "2026-05-01", narration: "ATM WDL MAIN ROAD", counterparty: null, debit: 2000, credit: null },
    { ...base, rowNumber: 2, date: "2026-05-02", narration: "UPI 1 zepto@ybl Zepto", counterparty: "Zepto", debit: 71, credit: null, ledgerName: "Office Expenses" },
    { ...base, rowNumber: 3, date: "2026-05-03", narration: "CASH DEPOSIT BY SELF", counterparty: null, debit: null, credit: 5000, voucherType: "Contra" as const },
  ];
  const built = buildTallyVoucherXml({ companyName: "Example", bankLedger: "HDFC Bank", transactions: rows, mappings: [{ counterparty: "Zepto", ledgerName: "Suspense" }] });
  assert.equal(built.ok, true, built.errors.join(" "));
  const vouchers = (built.xml ?? "").split("<VOUCHER ").slice(1);
  assert.match(vouchers[0], /VCHTYPE="Contra"[\s\S]*<LEDGERNAME>Cash<\/LEDGERNAME>/);
  assert.match(vouchers[1], /VCHTYPE="Payment"[\s\S]*<LEDGERNAME>Office Expenses<\/LEDGERNAME>/);
  assert.match(vouchers[2], /VCHTYPE="Contra"[\s\S]*<LEDGERNAME>Cash<\/LEDGERNAME>/);
  assert.equal(validateTallyVoucherXml(built.xml ?? "", 3).ok, true);
  assert.match(built.mastersXml ?? "", /<REPORTNAME>All Masters<\/REPORTNAME>/);

  const badContra = buildTallyVoucherXml({ companyName: "Example", bankLedger: "HDFC Bank", transactions: [{ ...rows[1], voucherType: "Contra" }] });
  assert.equal(badContra.ok, false);
  assert.match(badContra.errors.join(" "), /Contra entry needs Cash/);
  const wrongWay = buildTallyVoucherXml({ companyName: "Example", bankLedger: "HDFC Bank", transactions: [{ ...rows[1], voucherType: "Receipt" }] });
  assert.equal(wrongWay.ok, false);
  const targeted = buildTallyVoucherXml({ companyName: "Example", bankLedger: "HDFC Bank", transactions: [rows[1]], tallyCompany: "Example Traders & Co" });
  assert.match(targeted.xml ?? "", /<SVCURRENTCOMPANY>Example Traders &amp; Co<\/SVCURRENTCOMPANY>/);
});

test("Tally's import answer and company list are read correctly", () => {
  const answer = parseImportResponse("<RESPONSE><CREATED>58</CREATED><ALTERED>0</ALTERED><IGNORED>0</IGNORED><ERRORS>2</ERRORS><EXCEPTIONS>0</EXCEPTIONS><LINEERROR>Ledger &apos;Vendor One&apos; does not exist!</LINEERROR></RESPONSE>");
  assert.deepEqual(answer, { created: 58, altered: 0, ignored: 0, errors: 2, exceptions: 0, messages: ["Ledger 'Vendor One' does not exist!"] });
  assert.deepEqual(parseCompanyNames('<ENVELOPE><COLLECTION><COMPANY NAME="Example Traders" RESERVEDNAME=""><NAME TYPE="String">Example Traders</NAME></COMPANY><COMPANY NAME="ABC &amp; Sons"></COMPANY></COLLECTION></ENVELOPE>'), ["Example Traders", "ABC & Sons"]);
  assert.deepEqual(
    parseLedgers('<ENVELOPE><COLLECTION><LEDGER NAME="Suspense A/c" RESERVEDNAME=""><PARENT TYPE="String">Suspense A/c</PARENT></LEDGER><LEDGER NAME="DBS Bank 4321"><PARENT TYPE="String">Bank Accounts</PARENT></LEDGER><LEDGER NAME="Vendor One &amp; Co"><PARENT TYPE="String">Sundry Debtors</PARENT></LEDGER></COLLECTION></ENVELOPE>'),
    [{ name: "DBS Bank 4321", parent: "Bank Accounts" }, { name: "Suspense A/c", parent: "Suspense A/c" }, { name: "Vendor One & Co", parent: "Sundry Debtors" }],
  );
});

test("Send to Tally can post Suspense rows to the company's own Suspense ledger", () => {
  const base = { valueDate: null, description: "", reference: null, balance: null, accountName: null, accountNumberMasked: null, bankName: null, confidence: 1, sourceFile: "", sourcePage: null, sourceQuote: "" };
  const built = buildTallyVoucherXml({
    companyName: "Example", bankLedger: "DBS Bank 4321", suspenseLedger: "Suspense A/c",
    transactions: [{ ...base, rowNumber: 1, date: "2026-05-01", narration: "UPI ACME JEWELLERS", counterparty: "ACME JEWELLERS", debit: 100, credit: null }],
  });
  assert.equal(built.ok, true);
  assert.match(built.xml ?? "", /<LEDGERNAME>Suspense A\/c<\/LEDGERNAME>/);
  assert.doesNotMatch(built.xml ?? "", /<LEDGERNAME>Suspense<\/LEDGERNAME>/);
});

test("Google Pay rows are split by handle and only confident rules skip review", () => {
  const rows: Array<[string, "in" | "out", string, string, boolean]> = [
    ["UPI 814031432615 goog-payments@axisbank GOOGLE IND", "in", "Google payments", "Cashback Received", false],
    ["UPI 526177489666 gpayvoucher@icici Google India Se", "out", "Google Pay voucher", "Suspense", false],
    ["UPI 571629103449 gpayrecharge@icici Google India S", "out", "Google Pay recharge", "Telephone & Internet", false],
    ["UPI 530237378635 playstore@axisbank GOOGLE INDIA D", "out", "Google Play", "Software Expenses", false],
    ["UPI 608767315055 gpay-creditcard@okpayaxis Google", "out", "Google Pay card bill", "Credit Card Payable", false],
    ["NEFT GOOGLE WORKSPACE INV 8812", "out", "", "Software Expenses", true],
    ["REFUND ADOBE SOFTWARE ORDER 5521", "in", "", "Software Expenses", false],
  ];
  for (const [narration, direction, party, ledger, sure] of rows) {
    if (party) assert.equal(counterpartyFrom(narration), party, narration);
    assert.deepEqual(suggestLedgerDetail(narration, direction), { ledger, sure }, narration);
  }
  assert.deepEqual(suggestLedgerDetail("NEFT SBIN225353384588 ITDTAX REFUND 2025 26 BFZPG", "in"), { ledger: "Income Tax", sure: false });
  assert.deepEqual(suggestLedgerDetail("PCD/5335/ENCALM LOUNGE/DELHI060725/11:40", "out"), { ledger: "Travelling Expenses", sure: false });
  assert.equal(suggestLedger("ADVANCE TAX PAYMENT ITNS 280", [], "out"), "Income Tax");
  assert.equal(suggestLedger("MB:SENT MONEY TO OWN 5111806138", [], "out"), "Suspense");
  assert.equal(counterpartyFrom("MB:SENT MONEY TO OWN 5111806138"), "Own account transfer");
  assert.equal(suggestLedger("EPFO CHALLAN TRRN 123456", [], "out"), "PF Payable");
  assert.equal(suggestLedger("ESIC CONTRIBUTION MAY 26", [], "out"), "ESI Payable");
  assert.equal(suggestLedger("MAHA PTAX PAYMENT", [], "out"), "Professional Tax Payable");
  assert.equal(suggestLedger("UPI SELF TRANSFER TO HDFC", [], "out"), "Suspense");
  assert.equal(suggestLedger("CASH DEP CDM MUMBAI", [], "in"), "Cash");
  assert.equal(suggestLedger("NEFT AWS INDIA AMAZON WEB SERVICES", [], "out"), "Software Expenses");
});

test("paying through a gateway or marketplace handle is not a settlement", () => {
  assert.equal(suggestLedger("RAZORPAY SETTLEMENT 88213", [], "in"), "Payment Gateway Settlements");
  assert.equal(suggestLedger("AMAZON SELLER SERVICES SETTLEMENT", [], "in"), "Marketplace Settlements");
  assert.equal(suggestLedger("UPI 572776661341 vil.payu@hdfcbank VODAFONEIDEA LI", [], "out"), "Telephone & Internet");
  assert.equal(suggestLedger("UPI 571352036309 flipkartgiftcard.payu@hdfcbank WW", [], "out"), "Suspense");
  assert.equal(suggestLedger("UPI 77120 jiomart.payu@hdfcbank JIOMART", [], "out"), "Suspense");
});

test("quarterly interest rows are one party", () => {
  const csv = [
    "Date,Narration,Debit,Credit,Balance",
    "30/06/2026,Int.Pd:0211300197:01-04-2026 to 30-06-2026,,100.00,1100.00",
    "30/09/2026,Int.Pd:0211300197:01-07-2026 to 30-09-2026,,110.00,1210.00",
  ].join("\n");
  const rows = parseBankStatement(csv, "s.csv").transactions;
  assert.deepEqual(rows.map(row => row.counterparty), ["Bank interest", "Bank interest"]);
});

test("party names come out of real Indian narration formats", () => {
  const cases: Array<[string, string | null]> = [
    ["UPI/ROHAN SHARMA/100000000003/Payment from Ph", "ROHAN SHARMA"],
    ["UPI/ANKIT KUMAR CHO/386145065356/Sent using Payt", "ANKIT KUMAR CHO"],
    ["UPI 100000000001 priyasharma2@ybl PRIYA SHARMA", "PRIYA SHARMA"],
    ["UPI 100000000004 mohankumar0001@ybl MOHAN", "MOHAN"],
    ["UPI 529395980588 zeptoonline@ybl Zepto", "Zepto"],
    ["N/INDBH00000000000/KKBK/ASHOK VERMA", "ASHOK VERMA"],
    ["IMP-100000000005-9000000001-ASHOK VERMA", "ASHOK VERMA"],
    ["Purchase-519417077479-130725 17:19:43-SWIGGY Bangalore IN", "Swiggy"],
    ["Purchase-521812004761-060825 17:43:00-PAY*Swiggy BANGALORE IN", "Swiggy"],
    ["UPI 608748525465 swiggy1online.gpay@okpayaxis Swig", "Swiggy"],
    ["UPI 572776661341 vil.payu@hdfcbank VODAFONEIDEA LI", "Vodafone Idea"],
    ["UPI 535972109358 viprevf@hsbc VODAFONE IDEA LIMITE", "Vodafone Idea"],
    ["UPI 571352036309 flipkartgiftcard.payu@hdfcbank WW", "Flipkart"],
    ["VISA POS TXN AT IN/BOOKMYSHOW COM 124305400", "BOOKMYSHOW"],
    ["VISA POS TXN AT IN/BOOKMYSHOW 022560889", "BOOKMYSHOW"],
    ["PCD/5335/ENCALM LOUNGE/DELHI060725/11:40", "ENCALM LOUNGE"],
    ["UPI-ACME Corp/INV-100/YESB0001234", "ACME Corp"],
    ["Razorpay Settlement/RZP-9988", "Razorpay Settlement"],
    ["NEFT-Google Workspace/GSuite", "Google Workspace"],
    ["PG KOTAK MAHINDRA LIFE", "KOTAK MAHINDRA LIFE"],
    ["Term Deposit-8000000000000001-ASHOK VERMA", "Fixed deposit"],
    ["CREDIT INTEREST - Saving", "Bank interest"],
    ["ATM WDL/ATM-Koramangala", "Cash withdrawal"],
    ["UPI 566081058767 zeptomarketplac357841.rzp@hdfcban", "Zepto"],
  ];
  for (const [narration, party] of cases) assert.equal(counterpartyFrom(narration), party, narration);
});

test("names the bank cut short are treated as one party", () => {
  const row = (counterparty: string) => ({ counterparty } as unknown as Parameters<typeof unifyParties>[0][number]);
  const rows = ["Rakesh Rak", "Rakesh Rake", "Vodafone Ide", "VODAFONE IDEA LIMITE", "Google", "Google India Se"].map(row);
  unifyParties(rows);
  assert.deepEqual(rows.map(item => item.counterparty), ["Rakesh Rake", "Rakesh Rake", "VODAFONE IDEA LIMITE", "VODAFONE IDEA LIMITE", "Google", "Google India Se"]);
});

test("privacy mode needs a paid, active plan", () => {
  const now = new Date("2026-10-09T00:00:00Z");
  assert.equal(privacyAvailable({ plan: "free", until: null }, {}, now), false);
  assert.equal(privacyAvailable({ plan: "growth", until: null }, {}, now), true);
  assert.equal(privacyAvailable({ plan: "Growth", until: new Date("2027-01-01") }, {}, now), true);
  assert.equal(privacyAvailable({ plan: "growth", until: new Date("2026-10-01") }, {}, now), false, "a lapsed plan no longer counts");
  assert.equal(planIsActive({ plan: "enterprise", until: null }, now), true);
  assert.equal(privacyAvailable({ plan: "starter", until: null }, { PRIVACY_MODE_PLANS: "growth,ca_firm" }, now), false, "the operator can limit it to higher plans");
  assert.equal(privacyAvailable({ plan: "unknown_plan", until: null }, {}, now), false);
});

test("privacy flags are read from forms and JSON alike", () => {
  for (const yes of ["1", "true", "TRUE", true, 1]) assert.equal(truthy(yes), true, String(yes));
  for (const no of ["0", "false", "", undefined, null, false, "no"]) assert.equal(truthy(no), false, String(no));
});

test("in privacy mode a file read without AI never goes to AI, and a scan only with consent", () => {
  const base = { aiConfigured: true, confirmed: true };
  assert.equal(aiDecision({ ...base, privacy: false, allowAi: false, readWithoutAi: false }), "use_ai", "normal mode is unchanged");
  assert.equal(aiDecision({ ...base, privacy: true, allowAi: true, readWithoutAi: true }), "no_ai_needed", "even with consent a readable file stays off AI");
  assert.equal(aiDecision({ ...base, privacy: true, allowAi: false, readWithoutAi: false }), "ask_consent");
  assert.equal(aiDecision({ ...base, privacy: true, allowAi: true, readWithoutAi: false }), "use_ai");
  assert.equal(aiDecision({ ...base, privacy: true, allowAi: true, readWithoutAi: false, confirmed: false }), "ai_blocked", "AI keys not confirmed as paid-tier");
  assert.equal(aiDecision({ aiConfigured: false, confirmed: true, privacy: true, allowAi: true, readWithoutAi: false }), "ai_blocked");
});

test("history shows the last three months by default and the message says how to get older items", () => {
  assert.equal(historyMonths({}), 3);
  assert.equal(historyMonths({ HISTORY_MONTHS: "6" }), 6);
  assert.equal(historyMonths({ HISTORY_MONTHS: "0" }), 3);
  assert.equal(historyMonths({ HISTORY_MONTHS: "abc" }), 3);
  const cutoff = historyCutoff(3, new Date("2026-10-09T10:00:00Z"));
  assert.equal(cutoff.toISOString().slice(0, 10), "2026-07-09");
  assert.match(outsideWindowMessage(3, "help@example.com"), /older than 3 months.*email us at help@example\.com/);
  assert.match(outsideWindowMessage(3, ""), /contact us/);
});

test("repeated wrong passwords lock that email for a while, then it recovers", () => {
  const throttle = createLoginThrottle({ maxFailures: 3, windowMs: 60_000 });
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) {
    assert.equal(throttle.check("a@x.in", t0 + i).blocked, false);
    throttle.fail("a@x.in", t0 + i);
  }
  const locked = throttle.check("a@x.in", t0 + 10);
  assert.equal(locked.blocked, true);
  assert.ok(locked.retryAfterSeconds > 0 && locked.retryAfterSeconds <= 60);
  assert.equal(throttle.check("b@x.in", t0 + 10).blocked, false, "another email is not affected");
  assert.equal(throttle.check("a@x.in", t0 + 61_000).blocked, false, "the lock ends after the window");
  throttle.fail("a@x.in", t0 + 61_000);
  assert.equal(throttle.check("a@x.in", t0 + 61_001).blocked, false, "the count starts again after the window");
});

test("a good sign-in clears the failure count", () => {
  const throttle = createLoginThrottle({ maxFailures: 2, windowMs: 60_000 });
  throttle.fail("a@x.in", 1);
  throttle.reset("a@x.in");
  throttle.fail("a@x.in", 2);
  assert.equal(throttle.check("a@x.in", 3).blocked, false);
  assert.match(throttleMessage(61), /2 minutes/);
  assert.match(throttleMessage(5), /1 minute\./);
});

test("Excel files are read as .xlsx and as the older .xls, and a damaged one gives a clear error", () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Date", "Narration", "Amount"], ["01/05/2026", "UPI-ACME", 5000]]), "Sheet1");
  for (const [bookType, name] of [["xlsx", "a.xlsx"], ["biff8", "a.xls"]] as const) {
    const buffer = XLSX.write(book, { type: "buffer", bookType }) as Buffer;
    const csv = sheetToCsvText({ originalname: name, mimetype: "", buffer });
    assert.match(csv, /Date,Narration,Amount/, name);
    assert.match(csv, /UPI-ACME,5000/, name);
  }
  assert.throws(() => sheetToCsvText({ originalname: "broken.xlsx", mimetype: "", buffer: Buffer.from("PK\u0003\u0004 not a workbook") }), UnreadableFileError);
  assert.equal(sheetToCsvText({ originalname: "plain.csv", mimetype: "text/csv", buffer: Buffer.from("a,b\n1,2") }), "a,b\n1,2", "CSV is passed through");
});

test("a file that is not a bank statement says so, and names what it looks like", () => {
  const csv = (name: string, text: string) => ({ originalname: name, mimetype: "text/csv", buffer: Buffer.from(text) });
  assert.equal(notAStatementMessage({ originalname: "notes.pdf", mimetype: "application/pdf", buffer: Buffer.from("") }), NOT_A_STATEMENT, "a PDF of something else");
  assert.equal(notAStatementMessage(csv("random.csv", "Name,Team,Notes\nAsha,Ops,Hello")), NOT_A_STATEMENT);
  assert.match(notAStatementMessage(csv("tally.csv", "Date,Particulars,Vch Type,Vch No.,Debit,Credit\n01/05/2026,ACME,Payment,1,500,")), /Tally export.*Bank ↔ Tally/);
  assert.match(notAStatementMessage(csv("amazon_sales.csv", "Order ID,ASIN,Taxable Value,Place of Supply\n1,B0X,100,KA")), /marketplace sales report.*E-commerce GST/);
  assert.match(NOT_A_STATEMENT, /something else/);
});
