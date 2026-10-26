import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChecks, markWhatCouldNotRun,
  DEMO_ASSETS, DEMO_BILLS, DEMO_LEDGERS, DEMO_VOUCHERS,
  type AssetRow, type Bill, type CheckResult, type Ledger, type Voucher, type VoucherLine,
} from "./taxAuditEngine";

// ── small builders ──────────────────────────────────────────────────────────

const ledger = (name: string, group: string, opening: number, closing: number, extra: Partial<Ledger> = {}): Ledger =>
  ({ name, group, openingBalance: opening, closingBalance: closing, ...extra });
const line = (name: string, group: string, debit: number, credit: number): VoucherLine => ({ ledger: name, group, debit, credit });
const voucher = (v: Omit<Voucher, "lines"> & { lines: VoucherLine[] }): Voucher => v;

/** A cash payment to a creditor: the creditor is debited, Cash-in-Hand credited. */
const cashPayment = (number: string, date: string, party: string, amount: number): Voucher => voucher({
  date, type: "Payment", number, party, amount, mode: "Cash",
  lines: [line(party, "Sundry Creditors", amount, 0), line("Cash", "Cash-in-Hand", 0, amount)],
});

const byId = (checks: CheckResult[], id: string): CheckResult => {
  const found = checks.find(c => c.id === id);
  assert.ok(found, `check ${id} exists`);
  return found;
};

// Enough ledgers and vouchers for the data-quality rules (three ledgers with entries and balances that moved).
const books = {
  ledgers: [
    ledger("Cash", "Cash-in-Hand", 50_000, 20_000),
    ledger("Vendor A", "Sundry Creditors", -100_000, -90_000),
    ledger("Customer A", "Sundry Debtors", 40_000, 60_000),
  ],
  vouchers: [
    cashPayment("1", "2025-06-01", "Vendor A", 5_000),
    voucher({ date: "2025-06-02", type: "Sales", number: "2", party: "Customer A", amount: 20_000, mode: "Bank", lines: [line("Customer A", "Sundry Debtors", 20_000, 0), line("Sales", "Sales Accounts", 0, 20_000)] }),
    voucher({ date: "2025-06-03", type: "Receipt", number: "3", party: "Customer A", amount: 1_000, mode: "Bank", lines: [line("Cash", "Cash-in-Hand", 1_000, 0), line("Customer A", "Sundry Debtors", 0, 1_000)] }),
  ],
  assets: [] as AssetRow[],
  bills: [] as Bill[],
};

// ── the demo company: every check has something to say, nothing is "not run" ─

test("demo data: twenty checks, none marked not run, and the counts a person can verify by hand", () => {
  const checks = buildChecks(DEMO_LEDGERS, DEMO_VOUCHERS, DEMO_ASSETS, DEMO_BILLS);
  assert.equal(checks.length, 20);
  assert.deepEqual(checks.filter(c => c.notRun).map(c => c.id), []);

  const rows = Object.fromEntries(checks.map(c => [c.id, c.rows.length]));
  assert.deepEqual(rows, {
    "neg-balances": 2,        // Brightline (debtor, credit balance) and Apex (creditor, debit balance)
    "same-op-cl": 2,          // Orbit Media and Metro Logistics did not move
    "ageing": 8,              // eight bill references still open
    "party-jv": 5,            // journals that touch a debtor or creditor
    "cross-posting": 2,       // Orbit hit by Purchase, Galaxy hit by Sales
    "clause-31": 2,           // RC-090 (loan received in cash) and PY-310 (loan repaid in cash)
    "sec-269st": 2,           // RC-114 and RC-201, both cash receipts of 2 lakh or more
    "clause-40": 4,
    "clause-23": 6,
    "cash-exposure": 2,
    "creditor-op-cash": 2,    // Metro and Pioneer carried an opening balance
    "creditor-cash": 2,
    "clause-44": 5,
    "clause-22": 2,           // Apex and Pioneer are flagged MSME
    "clause-18": 4,
    "op-cl-mismatch": 3,      // Orbit, Zenith and Pioneer
    "partner-dashboard": 2,
    "tds-tcs": 3,
    "grouping-mismatch": 1,   // Galaxy Hardware
    "post-yearend-jv": 2,     // JV-Y01 and JV-Y02
  });
});

test("demo data: the ratios are the ones worked out from the demo balances", () => {
  const ratios = Object.fromEntries(byId(buildChecks(DEMO_LEDGERS, DEMO_VOUCHERS, DEMO_ASSETS, DEMO_BILLS), "clause-40").rows.map(r => [r.ratio, r.value]));
  // Sales 1,85,00,000; purchases 1,22,00,000; stock 18,00,000 to 21,50,000; indirect expenses 54,54,000.
  // Cost of goods 1,18,50,000, gross profit 66,50,000, net profit 11,96,000.
  assert.deepEqual(ratios, {
    "Gross Profit / Turnover": 35.95,
    "Net Profit / Turnover": 6.46,
    "Stock Turnover (times)": 6,
    "Material Consumed / Turnover": 65.95,
  });
});

test("demo data: the cash exposure and the day-wise 40A(3) rows", () => {
  const checks = buildChecks(DEMO_LEDGERS, DEMO_VOUCHERS, DEMO_ASSETS, DEMO_BILLS);
  const exposure = byId(checks, "cash-exposure");
  assert.equal(exposure.severity, "high");
  // Cash payments 50,000 + 18,000 + 24,500 + 12,000 of 2,54,500 in all; every receipt was cash.
  assert.deepEqual(exposure.rows.map(r => r.ratio), [41.06, 100]);

  const daily = byId(checks, "creditor-cash").rows;
  assert.deepEqual(daily.map(r => [r.party, r.daysOver, r.cashPaid, r.largestInADay]), [
    ["Metro Logistics", 2, 30_000, 18_000],
    ["Pioneer Supplies", 1, 24_500, 24_500],
  ]);
});

// ── 40A(3): one party, one day ──────────────────────────────────────────────

test("40A(3): small cash payments on different days are not added together", () => {
  const vouchers = [
    cashPayment("1", "2025-04-02", "Vendor A", 6_000),
    cashPayment("2", "2025-05-02", "Vendor A", 6_000),
    cashPayment("3", "2025-06-02", "Vendor A", 6_000),
  ];
  const checks = buildChecks(books.ledgers, vouchers, [], []);
  assert.deepEqual(byId(checks, "creditor-cash").rows, []);
  assert.equal(byId(checks, "creditor-cash").severity, "info");
});

test("40A(3): payments to one party on one day are added, and the limit itself is not over the limit", () => {
  const sameDay = [cashPayment("1", "2025-04-02", "Vendor A", 6_000), cashPayment("2", "2025-04-02", "Vendor A", 5_000)];
  const rows = byId(buildChecks(books.ledgers, sameDay, [], []), "creditor-cash").rows;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].daysOver, rows[0].cashPaid, rows[0].largestInADay], [1, 11_000, 11_000]);

  const exactly = [cashPayment("1", "2025-04-02", "Vendor A", 10_000)];
  assert.deepEqual(byId(buildChecks(books.ledgers, exactly, [], []), "creditor-cash").rows, []);
});

test("40A(3): two different parties on one day are not added together, and bank payments are ignored", () => {
  const ledgers = [...books.ledgers, ledger("Vendor B", "Sundry Creditors", 0, -1)];
  const vouchers = [
    cashPayment("1", "2025-04-02", "Vendor A", 6_000),
    cashPayment("2", "2025-04-02", "Vendor B", 6_000),
    voucher({ date: "2025-04-02", type: "Payment", number: "3", party: "Vendor A", amount: 50_000, mode: "Bank", lines: [line("Vendor A", "Sundry Creditors", 50_000, 0), line("HDFC", "Bank Accounts", 0, 50_000)] }),
  ];
  assert.deepEqual(byId(buildChecks(ledgers, vouchers, [], []), "creditor-cash").rows, []);
});

test("40A(3): the opening-balance check lists only creditors that had one", () => {
  const ledgers = [ledger("Vendor A", "Sundry Creditors", -100_000, -90_000), ledger("Vendor B", "Sundry Creditors", 0, -1), ledger("Customer A", "Sundry Debtors", 1, 2)];
  const vouchers = [cashPayment("1", "2025-04-02", "Vendor A", 12_000), cashPayment("2", "2025-04-03", "Vendor B", 15_000)];
  const checks = buildChecks(ledgers, vouchers, [], []);
  assert.deepEqual(byId(checks, "creditor-op-cash").rows, [{ party: "Vendor A", openingBalance: 100_000, cashPaid: 12_000 }]);
  assert.deepEqual(byId(checks, "creditor-cash").rows.map(r => r.party).sort(), ["Vendor A", "Vendor B"]);
});

// ── other thresholds ────────────────────────────────────────────────────────

test("269SS/269T: a cash loan receipt or repayment of 20,000 or more is listed, a smaller one or a bank one is not", () => {
  const loan = (number: string, type: "Receipt" | "Payment", amount: number, mode: "Cash" | "Bank") => voucher({
    date: "2025-07-01", type, number, party: "Director", amount, mode,
    lines: [line("Director", "Unsecured Loans", type === "Payment" ? amount : 0, type === "Receipt" ? amount : 0), line("Cash", "Cash-in-Hand", 0, 0)],
  });
  const rows = byId(buildChecks(books.ledgers, [loan("1", "Receipt", 20_000, "Cash"), loan("2", "Payment", 25_000, "Cash"), loan("3", "Receipt", 19_999, "Cash"), loan("4", "Receipt", 90_000, "Bank")], [], []), "clause-31").rows;
  assert.deepEqual(rows.map(r => [r.voucher, r.section]), [["1", "269SS (accepted)"], ["2", "269T (repaid)"]]);
});

test("269ST: a cash receipt of 2 lakh or more is listed unless it is a capital-account entry", () => {
  const receipt = (number: string, amount: number, capital: boolean) => voucher({
    date: "2025-07-01", type: "Receipt", number, party: "Customer A", amount, mode: "Cash",
    lines: [line("Cash", "Cash-in-Hand", amount, 0), line(capital ? "Capital - A" : "Customer A", capital ? "Capital Account" : "Sundry Debtors", 0, amount)],
  });
  const rows = byId(buildChecks(books.ledgers, [receipt("1", 200_000, false), receipt("2", 199_999, false), receipt("3", 500_000, true)], [], []), "sec-269st").rows;
  assert.deepEqual(rows.map(r => r.voucher), ["1"]);
});

test("cash exposure: worked from the payment and receipt vouchers; a cash deposit to the bank is not a payment", () => {
  const vouchers = [
    cashPayment("1", "2025-04-02", "Vendor A", 1_000),
    voucher({ date: "2025-04-03", type: "Payment", number: "2", party: "Vendor A", amount: 19_000, mode: "Bank", lines: [line("Vendor A", "Sundry Creditors", 19_000, 0), line("HDFC", "Bank Accounts", 0, 19_000)] }),
    voucher({ date: "2025-04-04", type: "Contra", number: "3", amount: 500_000, mode: "Cash", lines: [line("HDFC", "Bank Accounts", 500_000, 0), line("Cash", "Cash-in-Hand", 0, 500_000)] }),
  ];
  const rows = byId(buildChecks(books.ledgers, vouchers, [], []), "cash-exposure").rows;
  assert.equal(rows[0].ratio, 5);                 // 1,000 of 20,000 is exactly 5%: not above it
  assert.equal(rows[0].flag, "OK");
  assert.equal(rows[1].ratio, "n/a");             // there were no receipts to take a share of
});

test("ratios come from the groups, whatever the ledgers are called, and say n/a rather than invent a number", () => {
  const ledgers = [
    ledger("Domestic Sales 18%", "Sales Accounts", 0, -1_000_000),
    ledger("Sales Returns", "Sales Accounts", 0, 100_000),
    ledger("Goods Bought", "Purchase Accounts", 0, 600_000),
    ledger("Stock", "Stock-in-Hand", 100_000, 200_000),
    ledger("Office Rent", "Indirect Expenses", 0, 50_000),
  ];
  const ratios = Object.fromEntries(byId(buildChecks(ledgers, [], [], []), "clause-40").rows.map(r => [r.ratio, r.value]));
  // Net sales 9,00,000; cost of goods 1,00,000 + 6,00,000 - 2,00,000 = 5,00,000; gross profit 4,00,000; net profit 3,50,000.
  assert.deepEqual(ratios, { "Gross Profit / Turnover": 44.44, "Net Profit / Turnover": 38.89, "Stock Turnover (times)": 3.33, "Material Consumed / Turnover": 66.67 });

  const none = byId(buildChecks([ledger("Cash", "Cash-in-Hand", 1, 2)], [], [], []), "clause-40").rows;
  assert.deepEqual(none.map(r => r.value), ["n/a", "n/a", "n/a", "n/a"]);
});

test("Clause 23 lists the specified expense heads by name from Indirect Expenses, not other ledgers", () => {
  const ledgers = [
    ledger("Staff Salary", "Indirect Expenses", 0, 300_000),
    ledger("Shop Rent", "Indirect Expenses", 0, 100_000),
    ledger("Electricity", "Indirect Expenses", 0, 50_000),
    ledger("Rent Received", "Indirect Incomes", 0, -70_000),
  ];
  const rows = byId(buildChecks(ledgers, [], [], []), "clause-23").rows;
  assert.deepEqual(rows.map(r => [r.expense, r.amount, r.materiality]), [["Staff Salary", 300_000, "75%"], ["Shop Rent", 100_000, "25%"]]);
});

test("MSME, TDS/TCS, partner and grouping checks read what the ledgers carry", () => {
  const ledgers = [
    ledger("Vendor A", "Sundry Creditors", -100_000, -90_000, { isMsme: true, msmeType: "Micro" }),
    ledger("TDS Payable 194C", "Duties & Taxes", 0, -5_000),
    ledger("Capital - Asha", "Capital Account", -300_000, -350_000),
    ledger("Capital - Ravi", "Capital Account", -100_000, -120_000),
    ledger("Remuneration to Partners", "Indirect Expenses", 0, 80_000),
    ledger("Interest on Capital", "Indirect Expenses", 0, 40_000),
    ledger("Old Group Ledger", "Sundry Creditors", 0, 0, { prevYearGroup: "Sundry Debtors", prevYearClosing: 0 }),
  ];
  const checks = buildChecks(ledgers, [], [], []);
  assert.deepEqual(byId(checks, "clause-22").rows.map(r => [r.creditor, r.msmeType, r.outstanding, r.status]), [["Vendor A", "Micro", 90_000, "Payable"]]);
  assert.deepEqual(byId(checks, "tds-tcs").rows.map(r => [r.ledger, r.type, r.closing]), [["TDS Payable 194C", "TDS", 5_000]]);
  // Shared by opening capital: Asha 3 parts in 4, Ravi 1 in 4.
  assert.deepEqual(byId(checks, "partner-dashboard").rows.map(r => [r.partner, r.interest, r.remuneration]), [["Asha", 30_000, 60_000], ["Ravi", 10_000, 20_000]]);
  assert.deepEqual(byId(checks, "grouping-mismatch").rows.map(r => r.ledger), ["Old Group Ledger"]);
});

test("ageing is bill by bill from the bill date to 31 March, and nets a part payment against its bill", () => {
  const bills: Bill[] = [
    { party: "Vendor A", group: "Sundry Creditors", ref: "B1", date: "2025-09-01", amount: 100_000, type: "New Ref" },
    { party: "Vendor A", group: "Sundry Creditors", ref: "B1", date: "2025-12-01", amount: 40_000, type: "Agst Ref" },
    { party: "Customer A", group: "Sundry Debtors", ref: "B2", date: "2026-03-01", amount: 5_000, type: "New Ref" },
    { party: "Customer A", group: "Sundry Debtors", ref: "B3", date: "2026-01-01", amount: 7_000, type: "New Ref" },
    { party: "Customer A", group: "Sundry Debtors", ref: "B3", date: "2026-02-01", amount: 7_000, type: "Agst Ref" },
  ];
  const rows = byId(buildChecks(books.ledgers, books.vouchers, [], bills), "ageing").rows;
  // B3 is settled in full and is not listed. 1 Sep 2025 to 31 Mar 2026 is 211 days.
  assert.deepEqual(rows.map(r => [r.ref, r.days, r.outstanding, r.bucket]), [["B1", 211, 60_000, ">180 days"], ["B2", 30, 5_000, "0-30 days"]]);
});

test("a journal after 31 March is listed, and so are party journals and cross-postings", () => {
  const ledgers = [ledger("Customer A", "Sundry Debtors", 1, 2), ledger("Vendor A", "Sundry Creditors", -1, -2), ledger("Cash", "Cash-in-Hand", 1, 2)];
  const journal = (number: string, date: string, lines: VoucherLine[]) => voucher({ date, type: "Journal", number, amount: 1_000, mode: "Journal", lines });
  const vouchers = [
    journal("J1", "2026-03-31", [line("Customer A", "Sundry Debtors", 1_000, 0), line("Misc", "Indirect Expenses", 0, 1_000)]),
    journal("J2", "2026-04-01", [line("Customer A", "Sundry Debtors", 0, 1_000), line("Purchases", "Purchase Accounts", 1_000, 0)]),
    journal("J3", "2026-04-02", [line("Vendor A", "Sundry Creditors", 0, 1_000), line("Sales", "Sales Accounts", 1_000, 0)]),
  ];
  const checks = buildChecks(ledgers, vouchers, [], []);
  assert.deepEqual(byId(checks, "post-yearend-jv").rows.map(r => r.voucher), ["J2", "J3"]);
  assert.equal(byId(checks, "party-jv").rows.length, 3);
  assert.deepEqual(byId(checks, "cross-posting").rows.map(r => [r.voucher, r.partyType]), [["J2", "Debtor"], ["J3", "Creditor"]]);
});

// ── a check without its data is "not run", never "clear" ────────────────────

test("a check that has the data it needs and finds nothing is clear, not 'not run'", () => {
  const checks = buildChecks(books.ledgers, books.vouchers, DEMO_ASSETS, [], );
  const quiet = ["sec-269st", "clause-31", "creditor-cash", "creditor-op-cash", "cross-posting", "post-yearend-jv"];
  for (const id of quiet) {
    assert.equal(byId(checks, id).notRun, undefined, `${id} ran`);
    assert.deepEqual(byId(checks, id).rows, [], `${id} found nothing`);
  }
});

test("with no ledger masters, everything that needs groups or balances is not run, with the reason", () => {
  const onlyVouchers = books.vouchers.map(v => ({ ...v, mode: undefined, lines: v.lines.map(l => ({ ...l, group: "" })) }));
  const checks = buildChecks([], onlyVouchers, [], []);
  const notRun = checks.filter(c => c.notRun).map(c => c.id);
  for (const id of ["neg-balances", "same-op-cl", "ageing", "party-jv", "cross-posting", "clause-31", "sec-269st", "clause-40", "clause-23", "cash-exposure", "creditor-op-cash", "creditor-cash", "clause-44", "clause-22", "clause-18", "op-cl-mismatch", "partner-dashboard", "tds-tcs", "grouping-mismatch"]) {
    assert.ok(notRun.includes(id), `${id} is not run`);
  }
  assert.match(byId(checks, "neg-balances").notRun ?? "", /no ledger masters/i);
  // Vouchers were there, so the check on journals after 31 March ran (and found none).
  assert.equal(byId(checks, "post-yearend-jv").notRun, undefined);
  for (const c of checks.filter(x => x.notRun)) {
    assert.deepEqual(c.rows, []);
    assert.equal(c.severity, "info");
  }
});

test("ledgers with no vouchers: the checks on payments, receipts and journals are not run", () => {
  const checks = buildChecks(books.ledgers, [], [], []);
  assert.match(byId(checks, "creditor-cash").notRun ?? "", /no vouchers/i);
  assert.match(byId(checks, "post-yearend-jv").notRun ?? "", /no vouchers/i);
  assert.equal(byId(checks, "neg-balances").notRun, undefined);
});

test("vouchers whose ledgers carry no groups cannot be told apart as cash or bank", () => {
  const noMode = books.vouchers.map(v => ({ ...v, mode: undefined }));
  const checks = buildChecks(books.ledgers, noMode, [], []);
  assert.match(byId(checks, "cash-exposure").notRun ?? "", /cash from bank/i);
  assert.match(byId(checks, "creditor-cash").notRun ?? "", /cash from bank/i);
  assert.equal(byId(checks, "neg-balances").notRun, undefined);
});

test("closing balances equal to the opening ones on every ledger with entries mean they were not in the file", () => {
  const ledgers = [ledger("A", "Sundry Debtors", 10, 10), ledger("B", "Sundry Debtors", 20, 20), ledger("C", "Sundry Creditors", -30, -30), ledger("D", "Cash-in-Hand", 5, 5)];
  const vouchers = [voucher({ date: "2025-04-01", type: "Journal", number: "1", amount: 1, mode: "Journal", lines: [line("A", "Sundry Debtors", 1, 0), line("B", "Sundry Debtors", 0, 1), line("C", "Sundry Creditors", 0, 0)] })];
  const checks = buildChecks(ledgers, vouchers, [], []);
  assert.match(byId(checks, "neg-balances").notRun ?? "", /no closing balances/i);
  assert.match(byId(checks, "same-op-cl").notRun ?? "", /no closing balances/i);
  // The same data with one balance that moved is real books, and the balance checks run.
  const moved = ledgers.map(l => l.name === "A" ? { ...l, closingBalance: 11 } : l);
  assert.equal(byId(buildChecks(moved, vouchers, [], []), "neg-balances").notRun, undefined);
});

test("the prior-year and fixed-asset checks are not run when the import carries neither", () => {
  const checks = buildChecks(books.ledgers, books.vouchers, [], []);
  assert.match(byId(checks, "op-cl-mismatch").notRun ?? "", /prior-year balances/i);
  assert.match(byId(checks, "grouping-mismatch").notRun ?? "", /prior-year groups/i);
  assert.match(byId(checks, "clause-18").notRun ?? "", /fixed-asset/i);
  assert.match(byId(checks, "partner-dashboard").notRun ?? "", /Capital Account/);
});

test("markWhatCouldNotRun does not touch a check whose data is there", () => {
  const checks = buildChecks(DEMO_LEDGERS, DEMO_VOUCHERS, DEMO_ASSETS, DEMO_BILLS);
  const again = markWhatCouldNotRun(checks, { ledgers: DEMO_LEDGERS, vouchers: DEMO_VOUCHERS, assets: DEMO_ASSETS, bills: DEMO_BILLS });
  assert.equal(again.filter(c => c.notRun).length, 0);
});

test("no wording claims the law's outcome as certain", () => {
  const checks = buildChecks(DEMO_LEDGERS, DEMO_VOUCHERS, DEMO_ASSETS, DEMO_BILLS);
  const risks = checks.flatMap(c => c.rows.map(r => r.risk).filter(Boolean));
  assert.ok(risks.length > 0);
  assert.ok(risks.every(r => r === "Potential risk — needs CA review."), "a risk cell says what the product says everywhere else");
  const text = JSON.stringify(checks.map(c => [c.description, c.notes]));
  assert.doesNotMatch(text, /\battracts penalty\b|\bare disallowed\b|\bis disallowed\b/i);
});
