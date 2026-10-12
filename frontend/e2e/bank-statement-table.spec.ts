import { test, expect, type Page } from "@playwright/test";

const user = { email: "bank-table@example.test", name: "Test Accountant", role: "ca", company: "Test Practice", companyId: 1 };
const shots = process.env.E2E_SCREENSHOTS;

const normalize = {
  ok: true, bankName: "DBS Bank India", bankOptions: ["DBS Bank India"], accountNumberMasked: "4321", periodLabel: "01 Apr 2025 – 31 Mar 2026",
  source: "pdf_layout",
  check: { rows: 3, checked: 3, passed: 3, failed: 0, failedRows: [], openingBalance: 5000, closingBalance: 3000, printedClosing: 3000, closingMatches: true, serialComplete: null, verified: true },
  transactions: [
    { date: "2025-04-03", valueDate: "2025-04-03", narration: "UPI 100000000001 ravisharma@ybl RAVI SHARMA", reference: null, debit: null, credit: 300, balance: 5300, counterparty: "RAVI SHARMA", confidence: 0.99, rowNumber: 1 },
    { date: "2025-04-09", valueDate: "2025-04-08", narration: "ATM WDL MAIN ROAD", reference: "S7313", debit: 2000, credit: null, balance: 3300, counterparty: null, confidence: 0.99, rowNumber: 2 },
    { date: "2025-10-13", valueDate: "2025-10-13", narration: "UPI 100000000002 acmejewel@ybl ACME JEWELLERS", reference: null, debit: 300, credit: null, balance: 3000, counterparty: "ACME JEWELLERS", confidence: 0.99, rowNumber: 3 },
  ],
  ledgerGroups: [
    { key: "RAVI SHARMA", label: "RAVI SHARMA", ledger: "Sundry Debtors", source: "remembered", count: 1, total: 300, direction: "in", sample: "UPI RAVI SHARMA" },
    { key: "ATM WDL MAIN ROAD", label: "ATM WDL MAIN ROAD", ledger: "Cash", source: "rule", count: 1, total: 2000, direction: "out", sample: "ATM WDL" },
    { key: "ACME JEWELLERS", label: "ACME JEWELLERS", ledger: "Suspense", source: "none", count: 1, total: 300, direction: "out", sample: "UPI ACME JEWELLERS" },
  ],
  ledgerOptions: ["Sundry Debtors", "Sundry Creditors", "Office Expenses", "Cash", "Suspense"],
};

async function setup(page: Page, payloads: Record<string, unknown>) {
  await page.addInitScript(value => {
    localStorage.setItem("finverify_auth", JSON.stringify({ user: value }));
    localStorage.setItem(`finverify_onboarding_complete:${value.email}`, "true");
  }, user);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("bank-statement/normalize")) await route.fulfill({ json: normalize });
    else if (path.endsWith("bank-to-tally/excel")) {
      payloads.excel = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, body: Buffer.from("synthetic workbook"), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    } else if (path.endsWith("tally/status")) await route.fulfill({ json: { ok: true, running: true, companies: ["Example Traders"], message: "Connected to Tally." } });
    else if (path.endsWith("tally/ledgers")) await route.fulfill({ json: { ok: true, ledgers: [{ name: "DBS Bank 4321", parent: "Bank Accounts" }, { name: "HDFC Bank", parent: "Bank Accounts" }, { name: "Suspense A/c", parent: "Suspense A/c" }, { name: "Acme Jewellers Pvt Ltd", parent: "Sundry Creditors" }] } });
    else if (path.endsWith("bank-to-tally/send")) {
      payloads.send = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ json: { ok: true, expected: 3, created: 3, failed: 0, ledgersCreated: 1, messages: [], tallyCompany: "Example Traders", message: "3 entries created in Tally." } });
    } else if (path.endsWith("practice/clients")) await route.fulfill({ json: { clients: [{ companyId: 2, linkId: 2, name: "Example Traders" }], source: "database" } });
    else if (path.endsWith("auth/me")) await route.fulfill({ json: { user, company: { name: user.company } } });
    else await route.fulfill({ json: { ok: true, picks: [] } });
  });
  await page.goto("/app/jobs/bank-to-tally");
  await page.locator('input[type="file"]').setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Narration,Debit\n03/04/2025,UPI,300\n") });
}

test("statement table: bank view, per-row voucher and ledger, client query, send to Tally", async ({ page }) => {
  const payloads: Record<string, any> = {};
  await setup(page, payloads);
  await page.getByRole("button", { name: "View all 3 transactions" }).click();

  // Tally view: the ATM row is a Contra to Cash by default.
  await expect(page.getByLabel(/Voucher type for 09\/04\/2025/)).toHaveValue("Contra");
  await expect(page.getByLabel(/Ledger for 09\/04\/2025/)).toHaveValue("Cash");
  if (shots) await page.locator("section").filter({ hasText: "All transactions" }).screenshot({ path: `${shots}/table-tally-view.png` });

  // Bank view shows the statement as printed.
  await page.getByRole("tab", { name: "Bank statement" }).click();
  await expect(page.getByRole("columnheader", { name: "Value date" })).toBeVisible();
  await expect(page.getByText("08/04/2025")).toBeVisible();
  if (shots) await page.locator("section").filter({ hasText: "All transactions" }).screenshot({ path: `${shots}/table-bank-view.png` });
  await page.getByRole("tab", { name: "Tally view" }).click();

  // One row gets its own ledger; that party no longer needs a decision.
  await page.getByLabel(/Ledger for 13\/10\/2025/).selectOption("Office Expenses");
  await expect(page.getByRole("button", { name: "Generate Tally File" })).toBeVisible();

  // Raise a query with the client from the row menu.
  await page.getByRole("button", { name: /Actions for 13\/10\/2025/ }).click();
  await page.getByRole("menuitem", { name: "Raise query with client" }).click();
  await page.getByRole("button", { name: "What was this payment for?" }).click();
  await page.getByRole("button", { name: "Save query" }).click();
  await expect(page.getByRole("button", { name: "Client queries (1)" })).toBeVisible();
  await expect(page.getByText("1 question for the client")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Excel" }).click();
  await download;
  const rows = payloads.excel.rows as Array<{ rowNumber: number; voucherType: string; ledgerChoice: string; ledgerConfirmed: boolean; query: string | null }>;
  expect(rows.find(row => row.rowNumber === 2)).toMatchObject({ voucherType: "Contra", ledgerChoice: "Cash" });
  expect(rows.find(row => row.rowNumber === 3)).toMatchObject({ ledgerChoice: "Office Expenses", ledgerConfirmed: true, query: "What was this payment for?" });

  // Send straight to Tally.
  await page.getByRole("button", { name: "Send to Tally" }).click();
  await page.getByRole("button", { name: "Connect to Tally" }).click();
  await expect(page.getByLabel("Bank ledger in Tally")).toHaveValue("DBS Bank 4321");
  await expect(page.getByLabel("Suspense ledger in Tally")).toHaveValue("Suspense A/c");
  // The Tally company's own ledgers join the row ledger lists.
  await page.getByLabel(/Ledger for 13\/10\/2025/).selectOption("Acme Jewellers Pvt Ltd");
  if (shots) await page.locator("section").filter({ hasText: "Send straight to Tally" }).screenshot({ path: `${shots}/send-ledgers.png` });
  await page.getByRole("button", { name: "Send 3 entries to Example Traders" }).click();
  await expect(page.getByText("3 entries created in Tally.")).toBeVisible();
  expect(payloads.send.tallyCompany).toBe("Example Traders");
  expect(payloads.send).toMatchObject({ bankLedger: "DBS Bank 4321", suspenseLedger: "Suspense A/c" });
  expect(payloads.send.transactions.find((txn: { rowNumber: number }) => txn.rowNumber === 3)).toMatchObject({ ledgerName: "Acme Jewellers Pvt Ltd", voucherType: "Payment" });
  await page.getByRole("button", { name: "Send again" }).click();
  await expect(page.getByText("Sending again creates a second copy")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/send-to-tally.png`, fullPage: true });
});

test("statement table stays inside the page on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setup(page, {});
  await page.getByRole("button", { name: "View all 3 transactions" }).click();
  await expect(page.getByRole("tab", { name: "Bank statement" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/table-mobile.png`, fullPage: true });
});
