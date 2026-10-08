import { test, expect, type Page } from "@playwright/test";

// These are browser-only fixtures. No real accounts, client records or books are changed.
const user = {
  name: "Priya Shah",
  email: "ui-fixture@example.test",
  role: "ca",
  company: "Shah & Co.",
  companyId: 1,
};
const clients = [
  { companyId: 2, linkId: 2, name: "Sharma Traders" },
  { companyId: 3, linkId: 3, name: "Studio North" },
];

async function workspace(page: Page) {
  await page.addInitScript(
    (fixture) =>
      localStorage.setItem("finverify_auth", JSON.stringify({ user: fixture })),
    user,
  );
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const body = url.includes("practice/clients")
      ? { clients, source: "database" }
      : url.includes("auth/me")
        ? { user, company: { name: user.company } }
        : url.includes("jobs/history")
          ? { ok: true, runs: [], hasMore: false }
          : url.includes("reports/summary")
            ? {
                companyName: "Sharma Traders",
                month: "October 2026",
                generatedAt: "2026-10-08T10:00:00Z",
                verificationScore: 0,
                totalTransactions: 0,
                verifiedTransactions: 0,
                totalInvoices: 0,
                missingInvoices: 0,
                totalRisks: 0,
                highRisks: 0,
                totalPayroll: 0,
                totalGatewaySettlements: 0,
                caReadyStatus: "Upload records to start",
              }
            : [];
    await route.fulfill({ json: body });
  });
}

test("the landing page explains the product and renders every bank logo", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle("TallyThis — Less entry. More clarity.");
  await expect(page.getByRole("button", { name: "TallyThis home" })).toBeVisible();
  await expect(page.getByRole("link", { name: "contact@tallythis.xyz" })).toHaveAttribute("href", "mailto:contact@tallythis.xyz");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Books, in order.",
  );
  await page.locator("#banks").scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page
        .locator("#banks .fv-bank-logo img")
        .evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  await expect(page.locator("#banks")).toContainText(
    "not connected bank accounts",
  );
  await page
    .getByRole("button", { name: "Start your first job" })
    .first()
    .click();
  await expect(page).toHaveURL(/\/login\?mode=signup/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Create your free account",
  );
});

test("solution tabs support keyboard navigation and explain distinct jobs", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: /Bank → Tally/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tabpanel")).toContainText(
    "Find the differences.",
  );
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tabpanel")).toContainText("GST-ready data.");
  await page.keyboard.press("End");
  await expect(page.getByRole("tabpanel")).toContainText("Know what’s paid.");
  await page.keyboard.press("Home");
  await expect(page.getByRole("tabpanel")).toContainText("Your Tally entries.");
});

test("the live walkthrough can pause, resume and replay", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const demo = page.locator(".fv-hero .fv-product-demo");
  await expect(demo).toHaveClass(/phase-1/, { timeout: 8000 });
  await demo.getByRole("button", { name: "Pause walkthrough" }).click();
  const frozen = await demo.innerText();
  await page.waitForTimeout(650);
  expect(await demo.innerText()).toBe(frozen);
  await demo
    .getByRole("button", { name: "Play walkthrough", exact: true })
    .click();
  await expect(demo).toHaveClass(/phase-2/, { timeout: 7000 });
  await demo.getByRole("button", { name: "Replay walkthrough" }).click();
  await expect(demo).toHaveClass(/phase-0/);
});

test("reduced motion shows a stable completed illustration", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const demo = page.locator(".fv-hero .fv-product-demo");
  await expect(demo).toHaveClass(/phase-3/);
  await expect(
    demo.getByRole("button", { name: "Pause walkthrough" }),
  ).toBeDisabled();
  await expect(demo).toContainText("Tally file ready");
});

test("a landing upload survives sign-in and reaches Bank to Tally", async ({
  page,
}) => {
  let uploaded = "";
  await page.addInitScript(() =>
    localStorage.setItem(
      "finverify_onboarding_complete:ui-fixture@example.test",
      "true",
    ),
  );
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("auth/login"))
      return route.fulfill({
        json: {
          user,
          token: "browser-test-only",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      });
    if (url.endsWith("bank-statement/normalize")) {
      uploaded = route.request().postData() ?? "";
      return route.fulfill({
        json: {
          ok: true,
          bankName: "HDFC Bank",
          transactions: [],
          ledgerGroups: [],
          ledgerOptions: [],
        },
      });
    }
    return route.fulfill({
      json: url.includes("practice/clients") ? { clients: [] } : {},
    });
  });
  await page.goto("/");
  await page
    .locator("#demo input[type=file]")
    .setInputFiles({
      name: "statement.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "Date,Narration,Debit,Credit,Balance\n2026-10-01,Office,200,0,800",
      ),
    });
  await expect(page).toHaveURL(/\/login\?mode=signup/);
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .first()
    .click();
  await page.locator('input[type="email"]').fill(user.email);
  await page.locator('input[type="password"]').fill("test-password-only");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/app\/jobs\/bank-to-tally/);
  await expect.poll(() => uploaded).toContain("statement.csv");
});

test("client switching retains navigation to all seven main screens", async ({
  page,
}) => {
  await workspace(page);
  await page.goto("/app/overview");
  await page
    .getByRole("combobox", { name: "Client", exact: true })
    .selectOption("3");
  await expect(page.locator(".fv-workspace-heading")).toContainText(
    "Studio North",
  );
  for (const [label, heading] of [
    ["Clients", "Clients"],
    ["Bank → Tally", "Bank Statement → Tally"],
    ["Bank ↔ Tally", "Bank ↔ Tally"],
    ["E-commerce GST", "E-commerce GST"],
    ["Invoice ↔ Bank", "Invoice ↔ Bank"],
    ["Reports", "Reports"],
    ["Activity", "Activity"],
  ]) {
    await page
      .locator("aside")
      .getByRole("button", { name: label, exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  }
  await page
    .locator("aside")
    .getByRole("button", { name: "Advanced", exact: true })
    .click();
  await expect(
    page.locator("aside").getByRole("button", { name: "History", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("aside")
      .getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
});

test("reports keep specialist exports available and handle blockers", async ({
  page,
}) => {
  await workspace(page);
  await page.route("**/api/reports/export-ca-pack", (route) =>
    route.fulfill({
      status: 409,
      json: { blockers: ["Review 2 open items before exporting."] },
    }),
  );
  await page.goto("/app/reports");
  await expect(
    page.getByRole("button", { name: "Download CA review pack", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download Invoices as CSV" }),
  ).toBeHidden();
  await page
    .getByRole("button", { name: "Download CA review pack", exact: true })
    .click();
  await expect(
    page.getByText("Review 2 open items before exporting."),
  ).toBeVisible();
  await page.locator(".fv-report-advanced summary").click();
  await expect(
    page.getByRole("button", { name: "Download Invoices as CSV" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Looking for a Tally file/ }).click();
  await expect(page).toHaveURL(/\/app\/history/);
});

for (const width of [360, 390, 768]) {
  test(`landing and workspace remain usable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("button", { name: "Solutions", exact: true })
      .click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
    await workspace(page);
    await page.goto("/app/overview");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page
      .locator("aside")
      .getByRole("button", { name: "Bank → Tally", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Bank Statement → Tally",
    );
    await expect(page.locator("aside")).toBeHidden();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
