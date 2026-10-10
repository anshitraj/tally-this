import { test, expect, type Page } from "@playwright/test";

// Synthetic browser fixtures only. No accounts or financial records are changed.
const user = { email: "review-counts@example.test", name: "Test Accountant", role: "ca", company: "Test Practice", companyId: 1 };

function statement(uncertain = false, checked = 60) {
  const transactions = Array.from({ length: 60 }, (_, i) => ({
    date: "2026-05-01", narration: `Receipt from Party ${i % 24 + 1}`,
    reference: null, debit: null, credit: 100, balance: 1000 + (i + 1) * 100,
    counterparty: `Party ${i % 24 + 1}`, confidence: uncertain && i === 0 ? 0.6 : 0.99, rowNumber: i + 1,
  }));
  const ledgerGroups = Array.from({ length: 24 }, (_, i) => ({
    key: `Party ${i + 1}`, label: `Party ${i + 1}`, ledger: "Suspense", source: "none",
    count: transactions.filter(t => t.counterparty === `Party ${i + 1}`).length,
    total: transactions.filter(t => t.counterparty === `Party ${i + 1}`).length * 100,
    direction: "in", sample: `Receipt from Party ${i + 1}`,
  }));
  return { ok: true, runId: "synthetic-review", source: "sheet", bankName: "Test Bank", transactions, ledgerGroups,
    ledgerOptions: ["Suspense", "Sales", "Sundry Debtors"],
    check: { rows: 60, checked, passed: checked - (uncertain ? 1 : 0), failed: uncertain ? 1 : 0,
      failedRows: uncertain ? [1] : [], openingBalance: checked === 60 ? 1000 : null,
      closingBalance: 7000, printedClosing: 7000, closingMatches: true, serialComplete: true, verified: !uncertain },
  };
}

async function upload(page: Page, result: ReturnType<typeof statement>) {
  await page.addInitScript(u => {
    localStorage.setItem("finverify_auth", JSON.stringify({ user: u }));
    localStorage.setItem(`finverify_onboarding_complete:${u.email}`, "true");
  }, user);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("bank-statement/normalize") ? result
      : path.endsWith("practice/clients") ? { clients: [{ companyId: 2, linkId: 2, name: "Synthetic Client" }], source: "database" }
      : path.endsWith("auth/me") ? { user, company: { name: user.company } }
      : path.endsWith("ledger-suggestions") ? { ok: true, picks: [] } : {};
    await route.fulfill({ json: body });
  });
  await page.goto("/app/jobs/bank-to-tally");
  await page.locator('input[type="file"]').setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Narration,Credit\n01/05/2026,Test,100\n") });
  await expect(page.getByText("transactions detected", { exact: true })).toBeVisible();
}

for (const width of [1280, 390]) {
  test(`60 checked amounts and 24 ledger choices remain distinct at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await upload(page, statement());
    const attentionStat = page.getByText("items need attention", { exact: true }).locator("..");
    await expect(attentionStat).toContainText("24");
    await expect(page.getByText("24 party ledgers need choosing or confirming.", { exact: false })).toBeVisible();
    await expect(page.getByText("60 of 60 transaction amounts match the running balance", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review 24 items", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate Tally File", exact: true })).toHaveCount(0);
    await page.screenshot({ path: `../tmp/bank-review-counts-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Review 24 items", exact: true }).click();
    await page.getByRole("combobox", { name: "Ledger for Party 1", exact: true }).first().selectOption("Sales");
    await expect(page.getByText("23 party ledgers need choosing or confirming.", { exact: false })).toBeVisible();
    await expect(attentionStat).toContainText("23");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("a genuine row issue is counted separately and edits invalidate the original proof", async ({ page }) => {
  const result = statement(true);
  // An explicit failed balance check must flag the row even when parser confidence is high.
  result.transactions[0].confidence = 0.99;
  await upload(page, result);
  await expect(page.getByText("items need attention", { exact: true }).locator("..")).toContainText("26");
  await expect(page.getByText("24 party ledgers need choosing or confirming.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Review 26 items", exact: true }).click();
  await page.getByRole("button", { name: "It's money out", exact: true }).click();
  await expect(page.getByText("The original running-balance check does not verify the edited export.", { exact: false })).toBeVisible();
  await expect(page.getByText("items need attention", { exact: true }).locator("..")).toContainText("25");
  await expect(page.getByText("Running-balance checks passed", { exact: true })).toHaveCount(0);
});

test("partial balance checks show the actual checked count", async ({ page }) => {
  await upload(page, statement(false, 59));
  await expect(page.getByText("59 of 60 transaction amounts match the running balance", { exact: false })).toBeVisible();
  await expect(page.getByText("Every row matches the bank's running balance", { exact: true })).toHaveCount(0);
});
