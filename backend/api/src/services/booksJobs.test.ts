import assert from "node:assert/strict";
import test from "node:test";
import { extractBillTaxFromText, extractInvoicesFromText } from "./invoicePdf";
import { billFromPdf, buildPurchaseXml, checkBills, readBillsFromTable, resetBillKeys, validatePurchaseXml, type BillInput } from "./purchaseBills";
import { buildGstr1, readSalesRegister } from "./salesRegister";
import { buildGstr3b, itcFromGstr2b, setOff } from "./gstr3b";
import { buildPayrollJournal, matchSalaryPayments, readPayroll, statutoryOf } from "./payroll";
import { detectFileKind } from "./fileDetect";
import * as XLSX from "xlsx";
import type { Table } from "./gstrRecon";

// Real-shaped GSTINs with valid checksum characters (same ones the GSTR-2B tests use).
const SELLER = "27AAPFU0939F1ZV";
const BUYER_B2B = "29AABCT1332L1ZA";

function bill(over: Partial<BillInput> = {}): BillInput {
  return {
    key: "b1",
    source: "sheet",
    fileName: "bills.xlsx",
    row: 2,
    supplierName: "Alpha Traders",
    supplierGstin: SELLER,
    invoiceNumber: "INV-001",
    invoiceDate: "2026-10-05",
    placeOfSupply: null,
    taxable: 10000,
    igst: 0,
    cgst: 900,
    sgst: 900,
    cess: 0,
    total: 11800,
    reverseCharge: false,
    include: true,
    ...over,
  };
}

const CONFIG = {
  clientName: "Demo Co",
  purchaseLedger: "Purchase",
  igstLedger: "Input IGST",
  cgstLedger: "Input CGST",
  sgstLedger: "Input SGST",
  cessLedger: "Input Cess",
  roundOffLedger: "Round Off",
};

test("a clean bill passes the checks and posts a balanced Purchase voucher", () => {
  const [checked] = checkBills([bill()]);
  assert.equal(checked.blocked, false);
  assert.equal(checked.gstinValid, true);
  const built = buildPurchaseXml([checked], CONFIG);
  assert.equal(built.ok, true, built.errors.join(";"));
  assert.equal(built.voucherCount, 1);
  const xml = built.xml!;
  assert.match(xml, /VCHTYPE="Purchase"/);
  assert.match(xml, /<REFERENCE>INV-001<\/REFERENCE>/);
  // Supplier credited with the total, purchase and tax ledgers debited.
  assert.match(xml, /<LEDGERNAME>Alpha Traders<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>11800.00<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>Purchase<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-10000.00<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>Input CGST<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-900.00<\/AMOUNT>/);
  assert.deepEqual(validatePurchaseXml(xml, 1), { ok: true, errors: [] });
  assert.match(built.mastersXml!, /<PARENT>Sundry Creditors<\/PARENT>/);
  assert.match(built.mastersXml!, new RegExp(`<PARTYGSTIN>${SELLER}</PARTYGSTIN>`));
});

test("a bill whose total does not add up is blocked, and no file is made", () => {
  const checked = checkBills([bill({ total: 12500 })]);
  assert.equal(checked[0].blocked, true);
  assert.ok(checked[0].issues.some(issue => issue.code === "total_mismatch"));
  const built = buildPurchaseXml(checked, CONFIG);
  assert.equal(built.ok, false);
  assert.equal(built.xml, undefined);
});

test("a rounding difference under one rupee is posted to the round-off ledger", () => {
  const [checked] = checkBills([bill({ total: 11800.4 })]);
  assert.equal(checked.blocked, false);
  assert.equal(checked.roundOff, 0.4);
  const built = buildPurchaseXml([checked], CONFIG);
  assert.equal(built.ok, true);
  // Debit side is 11800.00; credit 11800.40, so Round Off is a debit of 0.40.
  assert.match(built.xml!, /<LEDGERNAME>Round Off<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-0.40<\/AMOUNT>/);
  assert.equal(validatePurchaseXml(built.xml!, 1).ok, true);
});

test("a wrong GSTIN, mixed tax types and a repeated invoice are caught", () => {
  const checked = checkBills([
    bill({ key: "a", supplierGstin: "27AAPFU0939F1ZX" }),
    bill({ key: "b", invoiceNumber: "INV-002", igst: 100, taxable: 10000, total: 11900 }),
    bill({ key: "c", invoiceNumber: "INV-003" }),
    bill({ key: "d", invoiceNumber: "inv/003" }),
  ]);
  assert.ok(checked[0].issues.some(issue => issue.code === "gstin"));
  assert.ok(checked[1].issues.some(issue => issue.code === "mixed_tax"));
  assert.equal(checked[2].blocked, false);
  assert.equal(checked[3].duplicateOf, "c");
  assert.equal(checked[3].blocked, true);
});

test("an unregistered supplier is kept as a purchase without a GSTIN", () => {
  const [checked] = checkBills([bill({ supplierGstin: "", cgst: 0, sgst: 0, taxable: 5000, total: 5000, supplierName: "ravi stationers" })]);
  assert.equal(checked.blocked, false);
  const built = buildPurchaseXml([checked], CONFIG);
  assert.equal(built.ok, true);
  assert.match(built.mastersXml!, /<GSTREGISTRATIONTYPE>Unregistered<\/GSTREGISTRATIONTYPE>/);
  assert.match(built.xml!, /<PARTYLEDGERNAME>Ravi Stationers<\/PARTYLEDGERNAME>/);
});

test("the same bill always gets the same GUID, so a repeat import can be recognised", () => {
  const first = buildPurchaseXml(checkBills([bill()]), CONFIG).xml!;
  const second = buildPurchaseXml(checkBills([bill({ key: "other", fileName: "again.pdf" })]), CONFIG).xml!;
  const guid = (xml: string) => /<GUID>([^<]+)<\/GUID>/.exec(xml)?.[1];
  assert.ok(guid(first));
  assert.equal(guid(first), guid(second));
});

test("a purchase list with and without GSTIN is read, notes are left out", () => {
  resetBillKeys();
  const table: Table = [
    ["Date", "Particulars", "Supplier GSTIN", "Supplier Invoice No.", "Voucher Type", "Taxable Value", "CGST", "SGST", "IGST", "Gross Total"],
    ["05-10-2026", "Alpha Traders", SELLER, "INV-001", "Purchase", 10000, 900, 900, 0, 11800],
    ["06-10-2026", "Ravi Stationers", "", "RS-77", "Purchase", 500, 0, 0, 0, 500],
    ["07-10-2026", "Alpha Traders", SELLER, "CN-1", "Debit Note", 1000, 90, 90, 0, 1180],
    ["Grand Total", "", "", "", "", 11500, 990, 990, 0, 13480],
  ];
  const read = readBillsFromTable(table, "purchases.xlsx");
  assert.equal(read.bills.length, 3);
  assert.equal(read.bills[1].supplierGstin, "");
  assert.equal(read.bills[2].note, true);
  assert.equal(read.bills[2].include, false);
  const checked = checkBills(read.bills);
  assert.equal(checked.filter(item => item.blocked).length, 0);
});

test("tax lines are read from a PDF's text, with separate heads", () => {
  const text = [
    "TAX INVOICE - INV-2026-044",
    "Alpha Traders Pvt Ltd",
    "GSTIN: 27AAPFU0939F1ZV",
    "Invoice Date: 12/10/2026",
    "Place of Supply: Maharashtra (27)",
    "Taxable Value 10,000.00",
    "CGST @ 9% 900.00",
    "SGST @ 9% 900.00",
    "Grand Total 11,800.00",
  ].join("\n");
  const tax = extractBillTaxFromText(text);
  assert.equal(tax.taxable, 10000);
  assert.equal(tax.cgst, 900);
  assert.equal(tax.sgst, 900);
  assert.equal(tax.igst, 0);
  assert.match(tax.placeOfSupply ?? "", /Maharashtra/);
  const [invoice] = extractInvoicesFromText(text);
  assert.ok(invoice);
  const built = billFromPdf(invoice, tax, "inv.pdf");
  assert.equal(built.taxable, 10000);
  assert.equal(built.total, 11800);
  assert.equal(checkBills([built])[0].blocked, false);
});

// ── Sales register → GSTR-1 ─────────────────────────────────────────────────

const REGISTER: Table = [
  ["Demo Co", "", "", "", "", "", "", "", "", ""],
  [`GSTIN/UIN: ${SELLER}`, "", "", "", "", "", "", "", "", ""],
  ["Date", "Particulars", "Voucher Type", "Voucher No.", "GSTIN/UIN", "Place of Supply", "Taxable Value", "IGST", "CGST", "SGST", "Gross Total"],
  ["02-10-2026", "Buyer One Pvt Ltd", "Sales", "S-001", BUYER_B2B, "Karnataka", 100000, 18000, 0, 0, 118000],
  ["03-10-2026", "Local Buyer", "Sales", "S-002", "", "Maharashtra", 5000, 0, 450, 450, 5900],
  ["04-10-2026", "Local Buyer 2", "Sales", "S-003", "", "Maharashtra", 2000, 0, 180, 180, 2360],
  ["05-10-2026", "Delhi Walk-in", "Sales", "S-004", "", "Delhi", 150000, 27000, 0, 0, 177000],
  ["06-10-2026", "Delhi Small", "Sales", "S-005", "", "Delhi", 40000, 7200, 0, 0, 47200],
  ["07-10-2026", "Buyer One Pvt Ltd", "Credit Note", "CN-001", BUYER_B2B, "Karnataka", 10000, 1800, 0, 0, 11800],
  ["08-10-2026", "Exempt Goods Buyer", "Sales", "S-006", "", "Maharashtra", 3000, 0, 0, 0, 3000],
];

test("a sales register is sorted into the GSTR-1 tables and the tables add up to the register", () => {
  const read = readSalesRegister(REGISTER);
  assert.equal(read.sellerGstin, SELLER);
  assert.equal(read.docs.length, 7);
  const result = buildGstr1(read);
  assert.equal(result.b2b.length, 1);
  assert.equal(result.b2cl.length, 1, "inter-state unregistered above ₹1 lakh");
  assert.equal(result.b2cl[0].customer, "Delhi Walk-in");
  assert.equal(result.cdnr.length, 1);
  assert.equal(result.cdnr[0].type, "C");
  assert.equal(result.nil.reduce((sum, row) => sum + row.documents, 0), 1);
  // B2CS: Maharashtra 18% (two sales) and Delhi 18% (the small one).
  const states = result.b2cs.map(row => `${row.pos}:${row.rate}`).sort();
  assert.deepEqual(states, ["07:18", "27:18"]);
  assert.deepEqual(result.difference, { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
  // Net IGST = 18000 + 27000 + 7200 − 1800 = 50400 rupees.
  assert.equal(result.totals.all.igst, 5040000);
  assert.equal(result.period, "2026-10");
});

test("a document that cannot be placed stays visible with a reason and still adds up", () => {
  const table: Table = [
    ["Date", "Particulars", "Voucher No.", "GSTIN/UIN", "Taxable Value", "IGST", "CGST", "SGST", "Gross Total"],
    ["02-10-2026", "Somebody", "X-1", "", 250000, 45000, 0, 0, 295000],
  ];
  const result = buildGstr1(readSalesRegister(table));
  assert.equal(result.b2cl.length + result.review.length, 1);
  assert.deepEqual(result.difference, { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
  assert.ok(result.flagged.length >= 1);
});

test("item lines of one invoice are added together", () => {
  const table: Table = [
    ["Date", "Particulars", "Invoice No.", "GSTIN/UIN", "HSN/SAC", "Rate", "Taxable Value", "IGST", "CGST", "SGST", "Gross Total"],
    ["02-10-2026", "Buyer One Pvt Ltd", "S-100", BUYER_B2B, "8471", 18, 60000, 10800, 0, 0, 70800],
    ["02-10-2026", "Buyer One Pvt Ltd", "S-100", BUYER_B2B, "9983", 5, 20000, 1000, 0, 0, 21000],
  ];
  const result = buildGstr1(readSalesRegister(table, { sellerGstin: SELLER }));
  assert.equal(result.b2b.length, 1);
  assert.deepEqual(result.b2b[0].rates.map(rate => rate.rate), [5, 18]);
  assert.equal(result.b2b[0].value, 9180000, "70,800 and 21,000 added per invoice, in paise");
  assert.equal(result.hsnB2b.length, 2);
  assert.deepEqual(result.difference, { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
});

test("cancelled vouchers are counted but not taxed, and number gaps are listed", () => {
  const table: Table = [
    ["Date", "Particulars", "Voucher Type", "Voucher No.", "GSTIN/UIN", "Taxable Value", "IGST", "CGST", "SGST", "Gross Total"],
    ["02-10-2026", "A", "Sales", "INV-001", "", 1000, 0, 90, 90, 1180],
    ["03-10-2026", "B (Cancelled)", "Sales", "INV-002", "", 1000, 0, 90, 90, 1180],
    ["04-10-2026", "C", "Sales", "INV-004", "", 1000, 0, 90, 90, 1180],
  ];
  const result = buildGstr1(readSalesRegister(table, { sellerGstin: SELLER }));
  assert.equal(result.counts.cancelled, 1);
  assert.equal(result.totals.all.taxable, 200000);
  const series = result.documents.find(item => item.kind === "Invoices for outward supply")!;
  assert.deepEqual(series.missing, ["INV-003"]);
  assert.equal(series.net, 2);
});

// ── Payroll ─────────────────────────────────────────────────────────────────

const SALARY_SHEET: Table = [
  ["Sunrise Traders Pvt Ltd"],
  ["Salary register for the month of October 2026"],
  [],
  ["Emp Code", "Employee Name", "UAN", "PAN", "Bank A/c No", "Paid Days", "Basic", "HRA", "Special Allowance", "Gross", "PF", "ESI", "Professional Tax", "TDS", "Loan Recovery", "Net Pay"],
  ["E001", "Anita Rao", "100200300401", "ABCDE1234F", "501000123456", 31, 20000, 8000, 7000, 35000, 1800, 0, 200, 1000, 0, 32000],
  ["E002", "Ravi Kumar", "100200300402", "ABCDE1234G", "501000123457", 31, 12000, 4800, 3000, 19800, 1440, 149, 200, 0, 500, 17511],
  ["E003", "Meena Joshi", "", "", "501000123458", 30, 15000, 6000, 4000, 25000, 1800, 0, 200, 0, 0, 23000],
  ["Total", "", "", "", "", "", 47000, 18800, 14000, 79800, 5040, 149, 600, 1000, 500, 72511],
];

test("a salary sheet is read with the employer, the month, and every employee's figures", () => {
  const read = readPayroll(SALARY_SHEET);
  assert.equal(read.employer, "Sunrise Traders Pvt Ltd");
  assert.equal(read.month, "2026-10");
  assert.equal(read.employees.length, 3);
  const anita = read.employees[0];
  assert.equal(anita.gross, 3500000);
  assert.equal(anita.net, 3200000);
  assert.equal(anita.blocked, false);
  // Meena has PF but no UAN.
  assert.ok(read.employees[2].flags.some(text => /UAN/.test(text)));
  // Ravi's gross is under ₹21,000 and ESI is deducted: no flag.
  assert.equal(read.employees[1].flags.some(text => /ESI/.test(text)), false);
});

test("the statutory working adds up and says which figures are computed", () => {
  const read = readPayroll(SALARY_SHEET);
  const statutory = statutoryOf(read.employees);
  assert.equal(statutory.employees, 3);
  assert.equal(statutory.gross, 7980000);
  assert.equal(statutory.pf.employee, 504000);
  assert.equal(statutory.pf.employerComputed, true);
  assert.equal(statutory.pf.employer, 504000);
  assert.equal(statutory.tds, 100000);
  assert.ok(statutory.pf.challan > statutory.pf.employee + statutory.pf.employer);
});

test("the journal balances, uses the employer's own ledger names, and refuses a sheet that does not add up", () => {
  const read = readPayroll(SALARY_SHEET);
  const statutory = statutoryOf(read.employees);
  const config = {
    clientName: "Sunrise Traders",
    month: "2026-10",
    salaryExpense: "Salary Expenses",
    salaryPayable: "Salary Payable",
    pfPayable: "PF Payable",
    esiPayable: "ESI Payable",
    ptPayable: "Professional Tax Payable",
    tdsPayable: "TDS Payable",
    otherDeductionLedger: "Employee Advances",
    employerPfExpense: "Employer PF Contribution",
    employerEsiExpense: "Employer ESI Contribution",
  };
  const journal = buildPayrollJournal(statutory, read.employees, config);
  assert.equal(journal.ok, true, journal.errors.join(";"));
  const debit = journal.lines.reduce((sum, line) => sum + Math.round(line.debit * 100), 0);
  const credit = journal.lines.reduce((sum, line) => sum + Math.round(line.credit * 100), 0);
  assert.equal(debit, credit);
  assert.match(journal.xml!, /VCHTYPE="Journal"/);
  assert.match(journal.xml!, /<DATE>20261031<\/DATE>/);
  const broken = readPayroll([
    ["Employee Name", "Basic", "Gross", "PF", "Net Pay"],
    ["Wrong Sum", 10000, 12000, 1200, 5000],
  ]);
  assert.equal(broken.employees[0].blocked, true);
  assert.equal(buildPayrollJournal(statutoryOf(broken.employees), broken.employees, config).ok, false);
});

test("salary payments are matched to bank debits by amount and name, and a bulk payment is recognised", () => {
  const read = readPayroll(SALARY_SHEET);
  const debit = (rowNumber: number, amount: number, narration: string, date = "2026-10-31") =>
    ({ rowNumber, date, valueDate: null, description: narration, narration, reference: null, debit: amount, credit: null, balance: null, counterparty: null, accountName: null, accountNumberMasked: null, bankName: null, confidence: 1, sourceFile: "b.csv", sourcePage: null, sourceQuote: "" }) as const;
  const bank = [debit(1, 32000, "NEFT-ANITA RAO-SALARY OCT"), debit(2, 17511, "IMPS/RAVI KUMAR"), debit(3, 4500, "SALARY ADVANCE X")];
  const check = matchSalaryPayments(read.employees, bank as never, "2026-10");
  const names = Object.fromEntries(check.matches.map(match => [match.employee, match.status]));
  assert.equal(names["Anita Rao"], "paid");
  assert.equal(names["Ravi Kumar"], "paid");
  assert.equal(names["Meena Joshi"], "not_found");
  assert.equal(check.unexplained.length, 1);
  const bulk = matchSalaryPayments(read.employees, [debit(9, 72511, "BULK SALARY OCT")] as never, "2026-10");
  assert.equal(bulk.matches.every(match => match.status === "bulk"), true);
});

// ── File detection ──────────────────────────────────────────────────────────

function sheetFile(name: string, rows: Array<Array<string | number>>) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  return { originalname: name, mimetype: "application/octet-stream", buffer };
}

test("a sales register, a purchase list and a salary sheet are told apart from a bank statement and a marketplace report", () => {
  const sales = sheetFile("register.xlsx", [
    ["Demo Co"],
    ["Date", "Particulars", "Voucher Type", "Voucher No.", "GSTIN/UIN", "Taxable Value", "IGST", "CGST", "SGST", "Gross Total"],
    ["02-10-2026", "Buyer", "Sales", "S-1", BUYER_B2B, 1000, 180, 0, 0, 1180],
  ]);
  const purchases = sheetFile("register.xlsx", [
    ["Date", "Supplier Name", "Supplier GSTIN", "Supplier Invoice No.", "Taxable Value", "CGST", "SGST", "IGST", "Invoice Value"],
    ["02-10-2026", "Alpha", SELLER, "A-1", 1000, 90, 90, 0, 1180],
  ]);
  const salary = sheetFile("october.xlsx", [
    ["Sunrise Traders"],
    ["Salary for October 2026"],
    ["Employee Name", "Basic", "HRA", "Gross", "PF", "ESI", "Net Pay"],
    ["Anita", 20000, 8000, 28000, 1800, 0, 26200],
  ]);
  const bank = sheetFile("statement.xlsx", [
    ["Date", "Narration", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
    ["02-10-2026", "UPI/ravi/salary advance", 5000, "", 20000],
  ]);
  const marketplace = sheetFile("amazon.xlsx", [
    ["Order ID", "Invoice Number", "Taxable Value", "IGST", "CGST", "SGST"],
    ["171-1", "INV-1", 100, 18, 0, 0],
  ]);
  assert.equal(detectFileKind(sales as never).kind, "sales_register");
  assert.equal(detectFileKind(purchases as never).kind, "purchase_register");
  assert.equal(detectFileKind(salary as never).kind, "payroll_sheet");
  assert.equal(detectFileKind(bank as never).kind, "bank_statement");
  assert.equal(detectFileKind(marketplace as never).kind, "marketplace_report");
});

// ── GSTR-3B working ─────────────────────────────────────────────────────────

test("credit pays liability in the order the law sets, and the rest is cash", () => {
  const paid = setOff(
    { igst: 5000_00, cgst: 3000_00, sgst: 3000_00, cess: 0 },
    { igst: 6000_00, cgst: 1000_00, sgst: 4000_00, cess: 0 },
  );
  // IGST credit: 5000 to IGST, 1000 to CGST. CGST credit 1000 to CGST. SGST credit 3000 to SGST.
  assert.equal(paid.setOff.igstToIgst, 5000_00);
  assert.equal(paid.setOff.igstToCgst, 1000_00);
  assert.equal(paid.setOff.cgstToCgst, 1000_00);
  assert.equal(paid.setOff.sgstToSgst, 3000_00);
  assert.deepEqual(paid.cash, { igst: 0, cgst: 1000_00, sgst: 0, cess: 0 });
  assert.deepEqual(paid.carryForward, { igst: 0, cgst: 0, sgst: 1000_00, cess: 0 });
});

test("CGST and SGST credit can pay IGST only after IGST credit is used", () => {
  const paid = setOff({ igst: 4000_00, cgst: 0, sgst: 0, cess: 0 }, { igst: 1000_00, cgst: 2000_00, sgst: 1500_00, cess: 0 });
  assert.equal(paid.setOff.igstToIgst, 1000_00);
  assert.equal(paid.setOff.cgstToIgst, 2000_00);
  assert.equal(paid.setOff.sgstToIgst, 1000_00);
  assert.equal(paid.cash.igst, 0);
  assert.equal(paid.carryForward.sgst, 500_00);
});

test("the working takes credit from a saved GSTR-2B result and warns when it is missing", () => {
  const result = buildGstr1(readSalesRegister(REGISTER));
  const none = buildGstr3b(result, null);
  assert.ok(none.warnings.some(text => /GSTR-2B/.test(text)));
  assert.equal(none.payment.cash.igst, result.totals.all.igst - result.totals.exp.igst - result.totals.nil.igst);
  const itc = itcFromGstr2b({
    period: "2026-10",
    recipientGstin: SELLER,
    byHead: {
      portal: { igst: 20000, cgst: 1000, sgst: 1000, cess: 0 },
      matched: { igst: 15000, cgst: 1000, sgst: 1000, cess: 0 },
      atRisk: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
      notEligible: { igst: 100, cgst: 0, sgst: 0, cess: 0 },
    },
  }, "run-1");
  const withItc = buildGstr3b(result, itc, "matched");
  assert.equal(withItc.itc.available.igst, 15000_00);
  assert.equal(withItc.itc.source?.runId, "run-1");
  assert.equal(withItc.warnings.some(text => /different|belongs/.test(text)), false);
  const portal = buildGstr3b(result, itc, "portal");
  assert.equal(portal.itc.available.igst, 20000_00);
});
