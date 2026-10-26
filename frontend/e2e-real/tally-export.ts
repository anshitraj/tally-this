/**
 * A small Tally XML export (ledger masters and vouchers), written the way Tally writes it: a debit is a negative amount
 * with ISDEEMEDPOSITIVE Yes, a credit a positive one. The books are made up and small enough to check by hand; every
 * finding the Tax Audit page should give for them is worked out in tax-audit.spec.ts.
 */

const money = (value: number) => value.toFixed(2);

function masterLedger(name: string, group: string, opening: number, closing: number): string {
  return `<TALLYMESSAGE><LEDGER NAME="${name}"><PARENT>${group}</PARENT><OPENINGBALANCE>${money(opening)}</OPENINGBALANCE><CLOSINGBALANCE>${money(closing)}</CLOSINGBALANCE></LEDGER></TALLYMESSAGE>`;
}

const debit = (ledger: string, amount: number) =>
  `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${ledger}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>${money(-amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
const credit = (ledger: string, amount: number) =>
  `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${ledger}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${money(amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;

function voucher(kind: string, number: string, date: string, party: string, amount: number, debited: string, credited: string, narration: string): string {
  return `<TALLYMESSAGE><VOUCHER VCHTYPE="${kind}"><DATE>${date}</DATE><VOUCHERTYPENAME>${kind}</VOUCHERTYPENAME><VOUCHERNUMBER>${number}</VOUCHERNUMBER>`
    + `<PARTYLEDGERNAME>${party}</PARTYLEDGERNAME><NARRATION>${narration}</NARRATION>${debit(debited, amount)}${credit(credited, amount)}</VOUCHER></TALLYMESSAGE>`;
}

const envelope = (...messages: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>${messages.join("")}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

const MASTERS = [
  masterLedger("Cash", "Cash-in-Hand", 50_000, 20_000),
  masterLedger("HDFC Bank", "Bank Accounts", 100_000, 90_000),
  masterLedger("Vendor A", "Sundry Creditors", -100_000, -90_000),
  masterLedger("Vendor B", "Sundry Creditors", 0, -15_000),
  masterLedger("Customer A", "Sundry Debtors", 40_000, -5_000),
  masterLedger("Customer B", "Sundry Debtors", 30_000, 30_000),
  masterLedger("Director Loan", "Unsecured Loans", -200_000, -250_000),
  masterLedger("Sales", "Sales Accounts", 0, -1_000_000),
  masterLedger("Purchases", "Purchase Accounts", 0, 600_000),
  masterLedger("Stock", "Stock-in-Hand", 100_000, 200_000),
  masterLedger("Office Rent", "Indirect Expenses", 0, 120_000),
  masterLedger("Salary", "Indirect Expenses", 0, 240_000),
];

// Tally numbers each type of voucher on its own, so "1" is a Payment, a Receipt and a Journal here.
const VOUCHERS = [
  voucher("Payment", "1", "20250610", "Vendor B", 12_000, "Vendor B", "Cash", "Freight paid in cash"),
  voucher("Payment", "2", "20250701", "Vendor A", 6_000, "Vendor A", "Cash", "Part payment in cash"),
  voucher("Payment", "3", "20250801", "Vendor A", 6_000, "Vendor A", "Cash", "Part payment in cash, a month later"),
  voucher("Payment", "4", "20250901", "Vendor A", 50_000, "Vendor A", "HDFC Bank", "Paid by bank transfer"),
  voucher("Receipt", "1", "20251005", "Customer B", 250_000, "Cash", "Customer B", "Cash received against invoice"),
  voucher("Receipt", "2", "20251105", "Director Loan", 60_000, "Cash", "Director Loan", "Loan from director received in cash"),
  voucher("Journal", "1", "20260410", "Customer A", 5_000, "Customer A", "Salary", "Adjustment after year end"),
  voucher("Journal", "2", "20260201", "Customer A", 3_000, "Customer A", "Purchases", "Purchase booked against a debtor"),
];

/** Ledger masters with balances, and the vouchers: everything the checks need. */
export const COMPANY_BOOKS = envelope(...MASTERS, ...VOUCHERS);

/** Vouchers only, as a Day Book export gives them: no ledger groups and no balances. */
export const DAY_BOOK_ONLY = envelope(...VOUCHERS);

/** Ledger masters only. */
export const MASTERS_ONLY = envelope(...MASTERS);

/** What the page should say for COMPANY_BOOKS, worked out by hand from the balances and vouchers above. */
export const EXPECTED = {
  flagged: 9,
  total: 20,
  high: 6,
  notRun: 4,
  /** Checks that could not run and why: no fixed assets, no prior-year figures, no capital accounts. */
  notRunIds: ["clause-18", "grouping-mismatch", "op-cl-mismatch", "partner-dashboard"],
  /** Rows per check (the same findings, counted). */
  rows: {
    "neg-balances": 1,        // Customer A is a debtor with a credit balance of 5,000
    "same-op-cl": 1,          // Customer B did not move
    "ageing": 4,              // no bill-wise detail, so the four party ledgers, by balance
    "party-jv": 2,            // the two journals both touch Customer A
    "cross-posting": 1,       // Journal 2: Customer A against the Purchases ledger
    "clause-31": 1,           // Receipt 2: a 60,000 loan received in cash
    "sec-269st": 1,           // Receipt 1: 2,50,000 in cash
    "clause-40": 4,
    "clause-23": 2,
    "cash-exposure": 2,
    "creditor-op-cash": 0,    // Vendor B had no opening balance; Vendor A's two payments were on different days
    "creditor-cash": 1,       // Vendor B, 12,000 in cash on one day
    "clause-44": 5,
    "clause-22": 0,
    "tds-tcs": 0,
    "post-yearend-jv": 1,     // Journal 1 on 10 April 2026
  } as Record<string, number>,
};
