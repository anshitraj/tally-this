import { test, expect, type Page } from "@playwright/test";

const user = { email: "history@example.test", name: "Test Accountant", role: "ca", company: "Test Practice", companyId: 1 };
const shots = process.env.E2E_SCREENSHOTS;

const runs = [
  { id: "run-bank-1", run_type: "bank_to_tally", title: "Bank Statement → Tally — bank-statement-fy25.pdf", status: "completed", created_at: "2026-10-12T10:29:00.000Z", user_name: "Test Accountant", user_email: user.email, info: { bankName: "DBS Bank India", periodLabel: "01 Apr 2025 – 31 Mar 2026", rows: 3, verified: true } },
  { id: "run-bank-2", run_type: "bank_to_tally", title: "Bank Statement → Tally — broken-scan.pdf", status: "failed", created_at: "2026-10-10T08:12:00.000Z", user_name: "Test Accountant", user_email: user.email, info: null },
];

const transactions = [
  { rowNumber: 1, date: "2025-04-03", valueDate: "2025-04-03", narration: "UPI 100000000001 ravisharma@ybl RAVI SHARMA", reference: null, debit: null, credit: 300, balance: 5300, counterparty: "RAVI SHARMA", confidence: 0.99 },
  { rowNumber: 2, date: "2025-04-09", valueDate: "2025-04-08", narration: "ATM WDL MAIN ROAD", reference: "S7313", debit: 2000, credit: null, balance: 3300, counterparty: null, confidence: 0.99 },
  { rowNumber: 3, date: "2025-10-13", valueDate: "2025-10-13", narration: "UPI 100000000002 acmejewel@ybl ACME JEWELLERS", reference: null, debit: 300, credit: null, balance: 3000, counterparty: "ACME JEWELLERS", confidence: 0.99 },
];

const detail = {
  ok: true,
  run: runs[0],
  artifacts: [
    { id: 1, artifact_type: "bank_statement", title: "statement", created_at: runs[0].created_at, json_data: { bankName: "DBS Bank India", accountNumberMasked: "4321", periodLabel: "01 Apr 2025 – 31 Mar 2026", transactions, creditTotal: 300, debitTotal: 2300, check: { rows: 3, checked: 3, passed: 3, failed: 0, failedRows: [], openingBalance: 5000, closingBalance: 3000, printedClosing: 3000, closingMatches: true, serialComplete: null, verified: true } } },
    { id: 2, artifact_type: "tally_xml", title: "statement.xml", created_at: runs[0].created_at, json_data: { xml: "<ENVELOPE />", voucherCount: 3 } },
  ],
};

async function setup(page: Page, payloads: Record<string, any>) {
  await page.addInitScript(value => {
    localStorage.setItem("finverify_auth", JSON.stringify({ user: value }));
    localStorage.setItem(`finverify_onboarding_complete:${value.email}`, "true");
  }, user);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/jobs/history")) await route.fulfill({ json: { ok: true, runs, hasMore: false, windowMonths: 3, olderCount: 0, supportEmail: "support@example.test" } });
    else if (path.endsWith("/jobs/history/run-bank-1")) await route.fulfill({ json: detail });
    else if (path.endsWith("bank-to-tally/excel")) {
      payloads.excel = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, body: Buffer.from("synthetic workbook"), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    } else if (path.endsWith("practice/clients")) await route.fulfill({ json: { clients: [{ companyId: 2, linkId: 2, name: "Example Traders" }], source: "database" } });
    else if (path.endsWith("auth/me")) await route.fulfill({ json: { user, company: { name: user.company } } });
    else await route.fulfill({ json: { ok: true } });
  });
}

test("history is a table with a View link and a ticket link for every item", async ({ page }) => {
  await setup(page, {});
  await page.goto("/app/history");
  const table = page.getByRole("table", { name: "History" });
  await expect(table).toBeVisible();
  for (const name of ["Date & time", "File name", "Details", "Status", "View", "Raise a ticket"]) {
    await expect(table.getByRole("columnheader", { name })).toBeVisible();
  }
  await expect(table.getByRole("row")).toHaveCount(3);
  const first = table.getByRole("row").nth(1);
  await expect(first).toContainText("bank-statement-fy25.pdf");
  await expect(first).toContainText("Bank → Tally");
  await expect(first).toContainText("DBS Bank India · 3 transactions");
  // View and the ticket link are on screen without scrolling the table sideways.
  await expect(first.getByRole("button", { name: /^View / })).toBeInViewport();
  await expect(first.getByRole("link", { name: /Raise a ticket/ })).toBeInViewport();
  await expect(first).toContainText("Success");
  await expect(table.getByRole("row").nth(2)).toContainText("Failed");

  const href = await first.getByRole("link", { name: /Raise a ticket/ }).getAttribute("href");
  expect(href).toMatch(/^mailto:support@example\.test\?subject=/);
  expect(decodeURIComponent(href ?? "")).toContain("bank-statement-fy25.pdf");
  expect(decodeURIComponent(href ?? "")).toContain("run-bank-1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/history-table.png` });
});

test("View opens the saved statement in the viewer with Excel, CSV and Tally XML downloads", async ({ page }) => {
  const payloads: Record<string, any> = {};
  await setup(page, payloads);
  await page.goto("/app/history");
  await page.getByRole("button", { name: /^View bank-statement-fy25/ }).click();
  await expect(page).toHaveURL(/\/app\/history\/run-bank-1$/);

  const viewer = page.getByTestId("statement-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText("Opening Bal.")).toContainText("₹5,000");
  await expect(viewer.getByText("Closing Bal.")).toContainText("₹3,000");
  await expect(viewer.getByRole("row")).toHaveCount(4);
  // A saved statement is read-only: no editing, no client queries.
  await expect(viewer.getByRole("button", { name: /Raise Query/ })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: /Actions for/ })).toHaveCount(0);
  await expect(viewer.getByRole("tab", { name: "Tally", exact: true })).toHaveCount(0);
  await viewer.getByRole("tab", { name: "Bank", exact: true }).click();
  await expect(viewer.getByRole("columnheader", { name: "Value date" })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/history-viewer.png` });

  await viewer.getByRole("button", { name: "Download", exact: true }).click();
  for (const name of [/^Excel/, /^CSV/, /^Tally XML/]) await expect(page.getByRole("menuitem", { name })).toBeVisible();
  const excel = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /^Excel/ }).click();
  expect((await excel).suggestedFilename()).toBe("TallyThis_Bank_Transactions.xlsx");
  expect(payloads.excel).toMatchObject({ bankName: "DBS Bank India", accountNumberMasked: "4321", openingBalance: 5000, closingBalance: 3000, balanceCheck: "passed" });
  expect(payloads.excel.rows).toHaveLength(3);
  expect(payloads.excel.rows.every((row: { ledgerChoice: string; ledgerConfirmed: boolean }) => row.ledgerChoice === "Suspense" && row.ledgerConfirmed === false)).toBe(true);

  await viewer.getByRole("button", { name: "Download", exact: true }).click();
  const xml = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /^Tally XML/ }).click();
  expect((await xml).suggestedFilename()).toBe("statement.xml");

  // Back to the saved item, which can reopen the viewer.
  await viewer.getByRole("button", { name: "Back to history" }).click();
  await expect(viewer).toHaveCount(0);
  await page.getByRole("button", { name: "Open statement", exact: true }).click();
  await expect(viewer).toBeVisible();
});

test("history stays inside the page on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setup(page, {});
  await page.goto("/app/history");
  await expect(page.getByRole("table", { name: "History" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/history-mobile.png` });
});
