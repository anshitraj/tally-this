import { expect, test } from "@playwright/test";
import { MAY_STATEMENT } from "./data";
import { PASSWORD, expectNoSidewaysScroll, newAccount, watchProblems } from "./helpers";

/**
 * The public front door: the landing page, the way into sign-up and sign-in, a file dropped before signing in, and a
 * web address that does not exist.
 */

test.describe("the landing page", () => {
  test("opens cleanly and leads to sign-up and sign-in", async ({ page }) => {
    const seen = watchProblems(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /Get started/ }).first()).toBeVisible();
    // It does not claim a live connection to Tally, the GST portal or a bank.
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    expect(text).not.toMatch(/direct (tally|gst|bank) (integration|connection)|connected to (the )?GST portal|100% accurate/i);
    await expectNoSidewaysScroll(page);

    await page.getByRole("button", { name: /Get started/ }).first().click();
    await expect(page).toHaveURL(/\/login\?mode=signup$/);
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).first().click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in to TallyThis" })).toBeVisible();
    seen.expectNone();
  });

  test("a statement dropped before signing in is still there after sign-up and setup", async ({ page }) => {
    await page.goto("/");
    await page.locator("input[type=file]").first().setInputFiles({ name: "hdfc-may-2026.csv", mimeType: "text/csv", buffer: Buffer.from(MAY_STATEMENT.csv) });
    await expect(page).toHaveURL(/\/login\?mode=signup/);

    const account = newAccount("landing-drop");
    await page.locator("#name").fill(account.name);
    await page.locator("#company").fill(account.firm);
    await page.locator("#email").fill(account.email);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/onboarding$/);
    await page.locator("#client-name").fill("Dropped Client");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Bank Statement/ }).click();
    await expect(page).toHaveURL(/\/app\/jobs\/bank-to-tally$/);
    // The file they dropped on the front page has been read: they do not have to find it again.
    await expect(page.getByText("24 transactions detected")).toBeVisible({ timeout: 30_000 });
  });

  test("an address that does not exist is a clear not-found page, not a blank screen", async ({ page }) => {
    const response = await page.goto("/this-page-does-not-exist");
    // The test server answers like Vercel does for an address it has no page for.
    expect(response?.status()).toBe(404);
    expect((await page.locator("body").innerText()).length).toBeGreaterThan(0);
  });
});
