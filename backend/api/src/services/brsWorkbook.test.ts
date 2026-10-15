import assert from "node:assert/strict";
import test from "node:test";
import { brsFigures, brsSchema, buildBrsWorkbook } from "./brsWorkbook";
import { buildInvoiceBankWorkbook, invoiceBankWorkbookSchema, invoiceRequestText } from "./invoiceBankWorkbook";

const input = brsSchema.parse({
  clientName: "Alpha Trading Co",
  bankName: "HDFC Bank",
  periodLabel: "October 2026",
  bankClosing: 100000,
  booksClosing: 100600,
  items: [
    // Deposited in books on the 30th; the bank credits it next month.
    { key: "t1", bucket: "tally_only", status: "suggested", why: [], tally: { date: "2026-10-30", ledgerName: "Sharma Traders", debit: 5000, credit: null } },
    // Cheque issued, not presented yet.
    { key: "t2", bucket: "tally_only", status: "suggested", why: [], tally: { date: "2026-10-29", ledgerName: "Beta Metals", debit: null, credit: 3000 } },
    // A direct credit the books do not show yet.
    { key: "b1", bucket: "bank_only", status: "suggested", why: [], bank: { date: "2026-10-12", narration: "NEFT-INTEREST", debit: null, credit: 2000 } },
    // Bank charges the books do not show yet.
    { key: "b2", bucket: "bank_only", status: "suggested", why: [], bank: { date: "2026-10-31", narration: "SMS CHARGES", debit: 500, credit: null } },
    // Receipt entered as 1,100 in books, 1,000 in the bank.
    {
      key: "d1",
      bucket: "amount_difference",
      status: "suggested",
      why: ["Amounts differ"],
      bank: { date: "2026-10-05", narration: "UPI-GAMMA", debit: null, credit: 1000 },
      tally: { date: "2026-10-05", ledgerName: "Gamma", debit: 1100, credit: null },
    },
    { key: "s1", bucket: "suggested", status: "suggested", why: ["Same amount, different date"], bank: { date: "2026-10-08", narration: "X", debit: 700, credit: null } },
    { key: "m1", bucket: "confirmed", status: "approved", why: [], bank: { date: "2026-10-02", narration: "OK", debit: 10, credit: null } },
  ],
});

test("the books balance is worked out from the bank balance and the reconciling items", () => {
  const figures = brsFigures(input);
  assert.equal(figures.bankClosing, 100000);
  assert.equal(figures.depositsNotCredited, 5000);
  assert.equal(figures.paymentsNotPresented, 3000);
  assert.equal(figures.creditsNotBooked, 2000);
  assert.equal(figures.debitsNotBooked, 500);
  assert.equal(figures.differences, 100);
  // 100000 + 5000 − 3000 − 2000 + 500 + 100
  assert.equal(figures.computedBooks, 100600);
  assert.equal(figures.gap, 0);
  assert.equal(figures.unresolved, 1);
});

test("a gap against the Tally balance is shown, not hidden", () => {
  const figures = brsFigures({ ...input, booksClosing: 100000 });
  assert.equal(figures.gap, 600);
});

test("with no bank balance the statement says so instead of guessing", () => {
  const figures = brsFigures({ ...input, bankClosing: null });
  assert.equal(figures.bankClosing, null);
  assert.equal(figures.computedBooks, null);
  assert.equal(figures.gap, null);
});

test("the workbook has the statement and one sheet for each kind of item", async () => {
  const workbook = buildBrsWorkbook(input);
  assert.deepEqual(
    workbook.worksheets.map(sheet => sheet.name),
    ["Bank reconciliation", "In books, not in bank", "In bank, not in books", "Amounts differ", "To confirm"],
  );
  const bytes = await workbook.xlsx.writeBuffer();
  assert.ok(bytes.byteLength > 2000);
});

test("invoice ↔ bank: the workbook and the request message list payments without invoices", async () => {
  const data = invoiceBankWorkbookSchema.parse({
    clientName: "Alpha Trading Co",
    items: [
      { key: "a", bucket: "payment_without_invoice", decision: "suggested", why: [], bank: { date: "2026-10-04", narration: "NEFT-DELTA STATIONERS", debit: 5900, credit: null } },
      { key: "b", bucket: "payment_without_invoice", decision: "rejected", why: [], bank: { date: "2026-10-05", narration: "SALARY", debit: 100, credit: null } },
      { key: "c", bucket: "matched", decision: "suggested", why: [], bank: { date: "2026-10-06", narration: "NEFT-ALPHA", debit: 118000, credit: null }, invoice: { invoiceNumber: "ALP-1", vendorName: "Alpha", total: 118000 } },
    ],
  });
  const text = invoiceRequestText(data);
  assert.match(text, /NEFT-DELTA STATIONERS/);
  assert.doesNotMatch(text, /SALARY/);
  const workbook = buildInvoiceBankWorkbook(data);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["Summary", "Needs attention", "Matched", "No invoice expected"]);
});
