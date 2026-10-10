import { test, expect, type Page } from "@playwright/test";

const user = { email: "incognito@example.test", name: "Priya Shah", role: "ca", company: "Shah & Co.", companyId: 1 };
const file = { name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Narration,Debit\n01/05/2026,NEFT/ACME,500\n") };

async function setup(page: Page, options: { premium?: boolean; storedOn?: boolean; planError?: boolean } = {}) {
  await page.addInitScript(({ user, storedOn }) => {
    localStorage.setItem("finverify_auth", JSON.stringify({ user }));
    localStorage.setItem(`finverify_onboarding_complete:${user.email}`, "true");
    if (storedOn) localStorage.setItem(`finverify_privacy_mode:${user.email}`, "1");
  }, { user, storedOn: options.storedOn });
  const uploads: string[] = [];
  let planError = !!options.planError;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("account/plan")) {
      await route.fulfill(planError ? { status: 503, json: { ok: false } } : { json: { ok: true, plan: options.premium ? "growth" : "free", privacyAvailable: !!options.premium } });
    } else if (path.endsWith("bank-statement/normalize")) {
      uploads.push(route.request().postData() || "");
      if (!options.premium && options.storedOn) {
        await route.fulfill({ status: 403, json: { ok: false, code: "privacy_not_available", message: "Incognito needs an active Premium plan. This upload has not been saved." } });
        return;
      }
      await route.fulfill({ json: {
        ok: true, privacy: uploads.at(-1)?.includes('name="privacy"') || false, bankName: "HDFC Bank", bankOptions: ["HDFC Bank"],
        transactions: [{ date: "2026-05-01", narration: "NEFT/ACME", debit: 500, credit: null, balance: 1000, confidence: .99, rowNumber: 1 }],
        ledgerGroups: [{ key: "ACME", label: "ACME", ledger: "Office Expenses", source: "rule", count: 1, total: 500, direction: "out", sample: "NEFT/ACME" }],
        ledgerOptions: ["Office Expenses", "Suspense"], source: "sheet",
      } });
    } else if (path.endsWith("practice/clients")) {
      await route.fulfill({ json: { clients: [{ companyId: 2, linkId: 2, name: "Sharma Traders" }], source: "database" } });
    } else if (path.endsWith("auth/me")) {
      await route.fulfill({ json: { user, company: { name: user.company } } });
    } else if (path.endsWith("jobs/history")) {
      await route.fulfill({ json: { ok: true, runs: [], hasMore: false } });
    } else {
      await route.fulfill({ json: { ok: true, picks: [] } });
    }
  });
  return { uploads, recoverPlan: () => { planError = false; } };
}

test("Premium switches the workspace to Incognito, fixes the mode during review and leaves the landing light", async ({ page }) => {
  const { uploads } = await setup(page, { premium: true });
  await page.goto("/app/jobs/bank-to-tally");
  const normal = page.getByRole("button", { name: "Normal", exact: true });
  const incognito = page.getByRole("button", { name: "Incognito", exact: true });
  await expect(normal).toHaveAttribute("aria-pressed", "true");
  await incognito.click();
  await expect(page.locator(".fv-app-shell")).toHaveAttribute("data-upload-mode", "incognito");
  await expect(page.locator(".fv-app-shell")).toHaveCSS("color-scheme", "dark");
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText("HDFC Bank", { exact: true })).toBeVisible();
  expect(uploads[0]).toContain('name="privacy"');
  await expect(normal).toBeDisabled();
  await expect(incognito).toBeDisabled();
  await expect(page.getByText("Mode is fixed for this job.", { exact: false })).toBeVisible();
  await page.screenshot({ path: "../tmp/incognito-bank-result.png", fullPage: true });
  await page.getByText("More options", { exact: true }).click();
  await page.getByRole("button", { name: "Upload another statement" }).click();
  await expect(normal).toBeEnabled();
  await normal.click();
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText("HDFC Bank", { exact: true })).toBeVisible();
  expect(uploads[1]).not.toContain('name="privacy"');
  await page.getByText("More options", { exact: true }).click();
  await page.getByRole("button", { name: "Upload another statement" }).click();
  await incognito.click();
  await page.goto("/");
  await expect(page.locator(".is-incognito")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.locator(".fv-marketing")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Books, in order.");
});

test("free account sees a locked Premium option and keeps Normal selected", async ({ page }) => {
  await setup(page);
  await page.goto("/app/jobs/bank-to-tally");
  await page.getByRole("button", { name: "Incognito — Premium locked" }).click();
  await expect(page.getByText("Incognito is included with Premium", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Contact us for Premium access" })).toHaveAttribute("href", /^mailto:/);
  await expect(page.locator(".fv-app-shell")).toHaveAttribute("data-upload-mode", "normal");
  expect(await page.evaluate(email => localStorage.getItem(`finverify_privacy_mode:${email}`), user.email)).toBeNull();
});

test("a second tab cannot switch an existing Incognito job to saved mode", async ({ page }) => {
  const { uploads } = await setup(page, { premium: true });
  await page.goto("/app/jobs/bank-to-tally");
  await page.getByRole("button", { name: "Incognito", exact: true }).click();
  const otherTab = await page.context().newPage();
  await setup(otherTab, { premium: true });
  await otherTab.goto("/app/jobs/bank-to-tally");
  await otherTab.getByRole("button", { name: "Normal", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText("HDFC Bank", { exact: true })).toBeVisible();
  expect(uploads[0]).toContain('name="privacy"');
  await expect(page.locator(".fv-app-shell")).toHaveAttribute("data-upload-mode", "incognito");
  await otherTab.close();
});

test("switching signed-in accounts clears cached Premium access", async ({ page }) => {
  await setup(page, { premium: true });
  await page.goto("/app/jobs/bank-to-tally");
  await expect(page.getByRole("button", { name: "Incognito", exact: true })).toBeEnabled();
  await page.route("**/api/account/plan", route => route.fulfill({ json: { ok: true, plan: "free", privacyAvailable: false } }));
  await page.evaluate(fixture => {
    localStorage.setItem("finverify_auth", JSON.stringify({ user: { ...fixture, companyId: 99, email: "free@example.test" } }));
  }, user);
  await page.getByRole("button", { name: "Bank ↔ Tally", exact: true }).click();
  await page.getByRole("button", { name: "Incognito — Premium locked" }).click();
  await expect(page.getByText("Incognito is included with Premium", { exact: true })).toBeVisible();
  await expect(page.locator(".fv-app-shell")).toHaveAttribute("data-upload-mode", "normal");
});

test("failed entitlement check stays visible and can be retried", async ({ page }) => {
  const fixture = await setup(page, { premium: true, planError: true });
  await page.goto("/app/jobs/bank-to-tally");
  await expect(page.getByText("Premium access couldn’t be checked.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Incognito — Premium locked" }).click();
  await expect(page.locator(".fv-app-shell")).toHaveAttribute("data-upload-mode", "normal");
  fixture.recoverPlan();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("button", { name: "Incognito", exact: true }).click();
  await expect(page.locator(".fv-app-shell")).toHaveAttribute("data-upload-mode", "incognito");
});

test("expired Premium never silently changes an Incognito upload into a saved upload", async ({ page }) => {
  const { uploads } = await setup(page, { storedOn: true });
  await page.goto("/app/jobs/bank-to-tally");
  await expect(page.getByText("Uploads are stopped so nothing is saved by mistake.", { exact: false })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText("Incognito needs an active Premium plan. This upload has not been saved.")).toBeVisible();
  expect(uploads[0]).toContain('name="privacy"');
  await expect(page.locator(".fv-app-shell")).toHaveAttribute("data-upload-mode", "incognito");
  await page.getByRole("button", { name: "Normal", exact: true }).click();
  await expect(page.locator(".fv-app-shell")).toHaveAttribute("data-upload-mode", "normal");
});

for (const width of [360, 390, 768, 1440]) {
  test(`Incognito upload controls fit ${width}px and stay above the file area`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await setup(page, { premium: true });
    await page.goto("/app/overview");
    await page.getByRole("button", { name: "Incognito", exact: true }).click();
    await expect(page.locator(".fv-dropzone")).toHaveCSS("background-color", "rgb(21, 27, 24)");
    const selector = await page.locator(".fv-mode-tabs").boundingBox();
    const upload = await page.locator(".fv-dropzone").boundingBox();
    expect(selector!.y + selector!.height).toBeLessThan(upload!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 390 || width === 1440) await page.screenshot({ path: `../tmp/incognito-${width}.png`, fullPage: true });
    for (const job of ["bank-to-tally", "bank-tally", "ecommerce-gst", "invoice-bank"]) {
      await page.goto(`/app/jobs/${job}`);
      await expect(page.locator(".fv-app-shell")).toHaveAttribute("data-upload-mode", "incognito");
      await expect(page.getByRole("group", { name: "Choose upload mode" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.goto("/app/uploads");
    await expect(page.getByRole("heading", { name: "Incognito uploads" })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Choose a job" })).toHaveAttribute("href", "/app/overview");
  });
}
