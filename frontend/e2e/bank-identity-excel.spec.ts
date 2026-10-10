import { test, expect } from "@playwright/test";

const user = { email: "bank-identity@example.test", name: "Test Accountant", role: "ca", company: "Test Practice", companyId: 1 };

test("unknown bank can be corrected and the reviewed Excel output is downloadable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(value => {
    localStorage.setItem("finverify_auth", JSON.stringify({ user: value }));
    localStorage.setItem(`finverify_onboarding_complete:${value.email}`, "true");
  }, user);
  let excelPayload: { bankName?: string; rows?: Array<{ ledgerChoice?: string; excluded?: boolean }> } | null = null;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("bank-statement/normalize")) {
      await route.fulfill({ json: {
        ok: true, bankName: null, bankOptions: ["HDFC Bank", "ICICI Bank"],
        transactions: [{ date: "2026-05-01", narration: "NEFT/ACME", reference: null, debit: 500, credit: null, balance: 1000, counterparty: "ACME", confidence: 0.99, rowNumber: 1 }],
        ledgerGroups: [{ key: "ACME", label: "ACME", ledger: "Office Expenses", source: "rule", count: 1, total: 500, direction: "out", sample: "NEFT/ACME" }],
        ledgerOptions: ["Office Expenses", "Suspense"], source: "sheet",
      } });
    } else if (path.endsWith("bank-to-tally/excel")) {
      excelPayload = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, body: Buffer.from("synthetic workbook"), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    } else if (path.endsWith("practice/clients")) {
      await route.fulfill({ json: { clients: [{ companyId: 2, linkId: 2, name: "Synthetic Client" }], source: "database" } });
    } else if (path.endsWith("auth/me")) {
      await route.fulfill({ json: { user, company: { name: user.company } } });
    } else {
      await route.fulfill({ json: { ok: true, picks: [] } });
    }
  });
  await page.goto("/app/jobs/bank-to-tally");
  await page.locator('input[type="file"]').setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Narration,Debit\n01/05/2026,NEFT/ACME,500\n") });
  await expect(page.getByText("Choose the bank", { exact: true })).toBeVisible();
  await page.getByLabel("Which bank issued this statement?").selectOption("ICICI Bank");
  await expect(page.getByText("ICICI Bank", { exact: true })).toBeVisible();
  await expect(page.locator('img[src*="brands/icici.svg"]')).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Excel" }).click();
  expect((await download).suggestedFilename()).toBe("TallyThis_Bank_Transactions.xlsx");
  expect(excelPayload?.bankName).toBe("ICICI Bank");
  expect(excelPayload?.rows?.[0].ledgerChoice).toBe("Office Expenses");
  await expect(page.getByRole("button", { name: "Review 1 item" })).toBeVisible();
  await page.getByRole("button", { name: "Review 1 item" }).click();
  await expect(page.getByText("Check the statement totals")).toBeVisible();
  await page.getByRole("button", { name: "I checked these totals" }).click();
  await expect(page.getByRole("button", { name: "Generate Tally File" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
