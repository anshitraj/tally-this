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
    else if (path.endsWith("bank-to-tally/xml")) {
      payloads.xml = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true, xml: "<ENVELOPE />", fileName: "statement.xml", voucherCount: 3 } });
    }
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

async function closeViewer(page: Page) {
  await page.getByTestId("statement-viewer").getByRole("button", { name: "Back to results" }).click();
  await expect(page.getByTestId("statement-viewer")).toHaveCount(0);
}

async function download(page: Page, item: RegExp) {
  await page.getByTestId("statement-viewer").getByRole("button", { name: "Download", exact: true }).click();
  const file = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: item }).click();
  return file;
}

test("the statement opens as an editor: views, per-row choices, queries, downloads and Send to Tally", async ({ page }) => {
  const payloads: Record<string, any> = {};
  await setup(page, payloads);
  const viewer = page.getByTestId("statement-viewer");
  await expect(viewer).toBeVisible();

  // Balances and the actions sit along the top, like an editor.
  await expect(viewer.getByText("Opening Bal.")).toContainText("₹5,000");
  await expect(viewer.getByText("Closing Bal.")).toContainText("₹3,000");
  await expect(viewer.getByRole("button", { name: /Raise Query/ })).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await expect(viewer.getByRole("tab", { name: "Default", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(viewer.getByRole("columnheader", { name: "Dr. amount" })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/viewer-default.png` });

  // Bank view shows the statement as printed.
  await viewer.getByRole("tab", { name: "Bank", exact: true }).click();
  await expect(viewer.getByRole("columnheader", { name: "Value date" })).toBeVisible();
  await expect(viewer.getByText("08/04/2025")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/viewer-bank.png` });

  // Tally view: choosing a ledger for one row opts in to reviewed choices; the confirmed Cash row becomes a Contra.
  await viewer.getByRole("tab", { name: "Tally", exact: true }).click();
  await viewer.getByLabel(/Ledger for 13\/10\/2025/).selectOption("Office Expenses");
  await expect(viewer.getByLabel(/Voucher type for 09\/04\/2025/)).toHaveValue("Contra");
  await expect(viewer.getByLabel(/Ledger for 09\/04\/2025/)).toHaveValue("Cash");
  if (shots) await page.screenshot({ path: `${shots}/viewer-tally.png` });

  // Raise a query with the client from the row menu.
  await viewer.getByRole("button", { name: /Actions for 13\/10\/2025/ }).click();
  await page.getByRole("menuitem", { name: "Raise query with client" }).click();
  await page.getByRole("button", { name: "What was this payment for?" }).click();
  await page.getByRole("button", { name: "Save query" }).click();
  await expect(viewer.getByRole("button", { name: /Raise Query \(1\)/ })).toBeVisible();
  await viewer.getByRole("button", { name: /Raise Query \(1\)/ }).click();
  const questions = page.waitForEvent("download");
  await viewer.getByRole("button", { name: "Download questions", exact: true }).click();
  expect((await questions).suggestedFilename()).toBe("TallyThis_Client_Questions.csv");

  // The Download menu offers Excel, CSV and Tally XML.
  await viewer.getByRole("button", { name: "Download", exact: true }).click();
  for (const name of [/^Excel/, /^CSV/, /^Tally XML/]) await expect(page.getByRole("menuitem", { name })).toBeVisible();
  await page.keyboard.press("Escape");
  expect((await download(page, /^Excel/)).suggestedFilename()).toBe("TallyThis_Bank_Transactions.xlsx");
  const rows = payloads.excel.rows as Array<{ rowNumber: number; voucherType: string; ledgerChoice: string; ledgerConfirmed: boolean; query: string | null }>;
  expect(rows.find(row => row.rowNumber === 2)).toMatchObject({ voucherType: "Contra", ledgerChoice: "Cash" });
  expect(rows.find(row => row.rowNumber === 3)).toMatchObject({ ledgerChoice: "Office Expenses", ledgerConfirmed: true, query: "What was this payment for?" });
  expect((await download(page, /^CSV/)).suggestedFilename()).toBe("bank-transactions.csv");

  // Send straight to Tally from the top bar.
  await viewer.getByRole("button", { name: "Send to Tally", exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await page.getByRole("button", { name: "Connect to Tally" }).click();
  await expect(page.getByLabel("Bank ledger in Tally")).toHaveValue("DBS Bank 4321");
  await expect(page.getByLabel("Suspense ledger in Tally")).toHaveValue("Suspense A/c");

  // The Tally company's own ledgers join the row ledger lists.
  await page.getByRole("tab", { name: "Statement", exact: true }).click();
  await page.getByRole("button", { name: "Open statement", exact: true }).click();
  await viewer.getByRole("tab", { name: "Tally", exact: true }).click();
  await viewer.getByLabel(/Ledger for 13\/10\/2025/).selectOption("Acme Jewellers Pvt Ltd");
  await closeViewer(page);
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "Connect to Tally" }).click();
  await expect(page.getByLabel("Bank ledger in Tally")).toHaveValue("DBS Bank 4321");
  if (shots) await page.locator("section").filter({ hasText: "Send straight to Tally" }).screenshot({ path: `${shots}/send-ledgers.png` });
  await page.getByRole("button", { name: "Send 3 entries to Example Traders" }).click();
  await expect(page.getByText("3 entries created in Tally.")).toBeVisible();
  expect(payloads.send.tallyCompany).toBe("Example Traders");
  expect(payloads.send).toMatchObject({ bankLedger: "DBS Bank 4321", suspenseLedger: "Suspense A/c" });
  expect(payloads.send.transactions.find((txn: { rowNumber: number }) => txn.rowNumber === 3)).toMatchObject({ ledgerName: "Acme Jewellers Pvt Ltd", voucherType: "Payment" });
  await page.getByRole("button", { name: "Send again" }).click();
  await expect(page.getByText("Sending again creates a second copy")).toBeVisible();
});

test("Escape and the back arrow return to the results page", async ({ page }) => {
  await setup(page, {});
  await expect(page.getByTestId("statement-viewer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("statement-viewer")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Statement", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Open statement", exact: true }).click();
  await expect(page.getByTestId("statement-viewer")).toBeVisible();
});

for (const width of [1280, 390]) {
  test(`conversion-only preview downloads XML and Excel from the top bar without ledger review at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const payloads: Record<string, any> = {};
    const suggestions: string[] = [];
    page.on("request", request => { if (request.url().endsWith("ledger-suggestions")) suggestions.push(request.url()); });
    await setup(page, payloads);
    const viewer = page.getByTestId("statement-viewer");
    // Dr. and Cr. stay on screen at every width; the running balance (also in the Bank view) waits for wider screens.
    await expect(viewer.getByRole("columnheader", { name: "Dr. amount" })).toBeVisible();
    await expect(viewer.getByRole("columnheader", { name: "Cr. amount" })).toBeVisible();
    if (width >= 640) await expect(viewer.getByRole("columnheader", { name: "Balance", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (shots) await page.screenshot({ path: `${shots}/viewer-${width}.png` });

    await viewer.getByLabel("Search transactions").fill("ACME");
    await expect(viewer.getByRole("status")).toContainText("1 of 3 transactions match");
    const table = viewer.getByRole("table");
    await expect(table).toContainText("ACME JEWELLERS");
    await expect(table).not.toContainText("RAVI SHARMA");
    expect((await download(page, /^Tally XML/)).suggestedFilename()).toBe("statement.xml");
    expect(payloads.xml.transactions).toHaveLength(3);
    // Ledgers already settled (remembered for the client, or a sure rule) go in; the rest stays in Suspense.
    expect(payloads.xml.transactions.map((row: { ledgerName: string }) => row.ledgerName)).toEqual(["Sundry Debtors", "Cash", "Suspense"]);
    expect(payloads.xml.transactions[1]).toMatchObject({ rowNumber: 2, debit: 2000, credit: null, voucherType: "Contra" });
    expect(Object.fromEntries(payloads.xml.mappings.map((row: { counterparty: string; ledgerName: string }) => [row.counterparty, row.ledgerName]))).toEqual({
      "RAVI SHARMA": "Sundry Debtors",
      "ATM WDL MAIN ROAD": "Cash",
      "ACME JEWELLERS": "Suspense",
    });
    await expect(viewer.getByText("Tally XML downloaded · 3 vouchers.", { exact: false })).toBeVisible();
    await download(page, /^Excel/);
    expect(payloads.excel.rows).toHaveLength(3);
    expect(payloads.excel.rows.map((row: { ledgerChoice: string }) => row.ledgerChoice)).toEqual(["Sundry Debtors", "Cash", "Suspense"]);
    await viewer.getByLabel("Search transactions").fill("");

    // Behind the viewer, the results page still shows the bank, with nothing to review.
    await closeViewer(page);
    await expect(page.getByRole("tab", { name: "Statement", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("items need attention", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Use AI review (optional)")).not.toBeChecked();
    expect(suggestions).toHaveLength(0);
    await expect(page.locator('img[src*="brands/dbs.svg"]')).toBeVisible();
    await expect.poll(() => page.locator('img[src*="brands/dbs.svg"]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("AI review is opt-in and unconfirmed suggestions never enter XML", async ({ page }) => {
  const payloads: Record<string, any> = {};
  const suggestions: string[] = [];
  page.on("request", request => { if (request.url().endsWith("ledger-suggestions")) suggestions.push(request.url()); });
  await setup(page, payloads);
  await closeViewer(page);
  await page.route("**/api/jobs/ledger-suggestions", route => route.fulfill({ json: { ok: true, picks: [{ key: "ACME JEWELLERS", ledger: "Office Expenses" }, { key: "RAVI SHARMA", ledger: "Invented ledger" }] } }));
  expect(suggestions).toHaveLength(0);
  await page.getByLabel("Use AI review (optional)").check();
  await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Suggestions are ready in Review.", { exact: false })).toBeVisible();
  expect(suggestions).toHaveLength(1);
  await expect(page.getByLabel("Ledger for ACME JEWELLERS", { exact: true })).toHaveValue("Office Expenses");
  const xml = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Tally XML", exact: true }).click();
  await xml;
  // The AI's pick for ACME is only a suggestion until it is chosen, so that row stays in Suspense.
  expect(payloads.xml.transactions[2]).toMatchObject({ ledgerName: "Suspense", debit: 300 });
  await page.getByLabel("Ledger for ACME JEWELLERS", { exact: true }).selectOption("Office Expenses");
  const approvedXml = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Tally XML", exact: true }).click();
  await approvedXml;
  expect(payloads.xml.transactions[2]).toMatchObject({ ledgerName: "Office Expenses", debit: 300, voucherType: "Payment" });
});

test("the editor stays inside the page on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setup(page, {});
  const viewer = page.getByTestId("statement-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/viewer-mobile.png` });
});
