import { test, expect, type Page } from "@playwright/test";

// Synthetic browser fixtures only. No accounts or financial records are changed.
const user = { email: "large-statement@example.test", name: "Test Accountant", role: "ca", company: "Test Practice", companyId: 1 };

function statement(parties: number, perParty = 2) {
  const transactions = Array.from({ length: parties * perParty }, (_, i) => ({
    date: "2026-05-01",
    narration: `Receipt from Party ${(i % parties) + 1}`,
    reference: null,
    debit: null,
    credit: 100,
    balance: 1000 + (i + 1) * 100,
    counterparty: `Party ${(i % parties) + 1}`,
    confidence: 0.99,
    rowNumber: i + 1,
  }));
  const ledgerGroups = Array.from({ length: parties }, (_, i) => ({
    key: `Party ${i + 1}`, label: `Party ${i + 1}`, ledger: "Suspense", source: "none", count: perParty, total: perParty * 100, direction: "in", sample: `Receipt from Party ${i + 1}`,
  }));
  const rows = transactions.length;
  return {
    ok: true,
    runId: "synthetic-large",
    source: "ai",
    bankName: "Test Bank",
    transactions,
    ledgerGroups,
    ledgerOptions: ["Suspense", "Sales", "Sundry Debtors"],
    check: { rows, checked: rows, passed: rows, failed: 0, failedRows: [], openingBalance: 1000, closingBalance: 1000 + rows * 100, printedClosing: 1000 + rows * 100, closingMatches: true, serialComplete: null, verified: true },
  };
}

async function signIn(page: Page) {
  await page.addInitScript(value => {
    localStorage.setItem("finverify_auth", JSON.stringify({ user: value }));
    localStorage.setItem(`finverify_onboarding_complete:${value.email}`, "true");
  }, user);
}

async function openJobPage(page: Page, handler: (path: string, postData: string | null) => unknown | Promise<unknown>) {
  await signIn(page);
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = await handler(path, request.postData());
    if (body && typeof body === "object" && "__status" in (body as object)) {
      const { __status, ...rest } = body as { __status: number };
      await route.fulfill({ status: __status, json: rest });
      return;
    }
    if (body !== undefined) {
      await route.fulfill({ json: body });
      return;
    }
    if (path.endsWith("practice/clients")) await route.fulfill({ json: { clients: [{ companyId: 2, linkId: 2, name: "Synthetic Client" }], source: "database" } });
    else if (path.endsWith("auth/me")) await route.fulfill({ json: { user, company: { name: user.company } } });
    else if (path.endsWith("ledger-suggestions")) await route.fulfill({ json: { ok: true, picks: [] } });
    else await route.fulfill({ json: {} });
  });
  await page.goto("/app/jobs/bank-to-tally");
}

const scan = { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% synthetic\n") };

test("a long scan shows where it is up to and opens the statement when it is done", async ({ page }) => {
  let polls = 0;
  let upload = "";
  await openJobPage(page, (path, postData) => {
    if (path.endsWith("bank-statement/normalize")) {
      upload = postData ?? "";
      return { __status: 202, ok: true, pending: true, jobId: "job-1", percent: 8, step: "Reading 152 pages" };
    }
    if (path.endsWith("bank-statement/progress/job-1")) {
      polls += 1;
      if (polls === 1) return { ok: true, state: "working", percent: 40, step: "Reading page 60 of 152" };
      return { ok: true, state: "done", httpStatus: 200, result: statement(5) };
    }
    return undefined;
  });
  await page.locator('input[type="file"]').setInputFiles(scan);
  await expect(page.getByText("Reading 152 pages")).toBeVisible();
  await expect(page.getByText("Reading page 60 of 152")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("40%", { exact: true })).toBeVisible();
  await expect(page.getByText("read a few pages at a time", { exact: false })).toBeVisible();
  await expect(page.getByTestId("statement-viewer")).toBeVisible({ timeout: 15_000 });
  expect(upload).toContain('name="async"');
  expect(polls).toBe(2);
});

test("an upload the server no longer has asks for the statement again", async ({ page }) => {
  await openJobPage(page, path => {
    if (path.endsWith("bank-statement/normalize")) return { __status: 202, ok: true, pending: true, jobId: "job-gone", percent: 5, step: "Reading your statement" };
    if (path.endsWith("bank-statement/progress/job-gone")) return { __status: 404, ok: false, message: "This upload is no longer available. Please upload the statement again." };
    return undefined;
  });
  await page.locator('input[type="file"]').setInputFiles(scan);
  await expect(page.getByText("This upload is no longer available. Please upload the statement again.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("statement-viewer")).toHaveCount(0);
});

test("a failed long read shows the pages that could not be read", async ({ page }) => {
  await openJobPage(page, path => {
    if (path.endsWith("bank-statement/normalize")) return { __status: 202, ok: true, pending: true, jobId: "job-failed", percent: 5, step: "Reading your statement" };
    if (path.endsWith("bank-statement/progress/job-failed")) {
      return { ok: true, state: "done", httpStatus: 422, result: { ok: false, message: "Pages 61–64 of this 152-page scan could not be read, so nothing was created. Try again in a little while, or use the bank's Excel or CSV download." } };
    }
    return undefined;
  });
  await page.locator('input[type="file"]').setInputFiles(scan);
  await expect(page.getByText("Pages 61–64 of this 152-page scan could not be read", { exact: false })).toBeVisible({ timeout: 10_000 });
});

test("hundreds of parties are listed a page at a time", async ({ page }) => {
  await openJobPage(page, path => (path.endsWith("bank-statement/normalize") ? statement(400) : undefined));
  await page.locator('input[type="file"]').setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Narration,Credit\n01/05/2026,Test,100\n") });
  await expect(page.getByTestId("statement-viewer")).toBeVisible();
  await page.getByTestId("statement-viewer").getByRole("button", { name: "Back to results" }).click();
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(page.getByText("400 party ledgers need choosing or confirming.", { exact: false })).toBeVisible();
  const ledgerSelects = page.getByRole("combobox", { name: /^Ledger for Party / });
  await expect(ledgerSelects).toHaveCount(50);
  await page.getByRole("button", { name: /Show 100 more of 350 remaining/ }).click();
  await expect(ledgerSelects).toHaveCount(150);
});
