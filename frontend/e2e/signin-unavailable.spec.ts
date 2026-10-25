import { expect, test, type Page } from "@playwright/test";

/**
 * When TallyThis cannot answer (it is down, restarting, or the website is not connected to it yet) the sign-up page says
 * so in plain words, and still shows a real message from TallyThis exactly as it was given.
 */

async function submitSignUp(page: Page) {
  await page.goto("/login?mode=signup");
  await page.locator("#name").fill("Test Person");
  await page.locator("#company").fill("Test Firm");
  await page.locator("#email").fill("someone@example.test");
  await page.locator("#password").fill("a-long-enough-password");
  await page.getByRole("button", { name: "Create account" }).click();
}

test.beforeEach(async ({ page }) => {
  // No Neon sign-in: the older form, which is what a visitor gets when the configuration cannot be read.
  await page.route("**/api/auth/neon/config", route => route.fulfill({ status: 404, contentType: "text/plain", body: "Application not found" }));
});

test("an answer with no message of its own is 'not available right now', not a vague failure", async ({ page }) => {
  await page.route("**/api/auth/register", route => route.fulfill({ status: 502, contentType: "text/html", body: "<h1>An error occurred with this application.</h1>" }));
  await submitSignUp(page);
  await expect(page.getByText("TallyThis is not available right now. Please try again in a few minutes.")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("an address that does not answer at all is 'could not be reached'", async ({ page }) => {
  await page.route("**/api/auth/register", route => route.abort("failed"));
  await submitSignUp(page);
  await expect(page.getByText("TallyThis could not be reached. Check your connection and try again.")).toBeVisible();
});

test("a message from TallyThis itself is shown as it is", async ({ page }) => {
  await page.route("**/api/auth/register", route => route.fulfill({ status: 409, json: { ok: false, error: "An account with this email already exists." } }));
  await submitSignUp(page);
  await expect(page.getByText("An account with this email already exists.")).toBeVisible();
});

test("a wrong password still says so in the plain way", async ({ page }) => {
  await page.route("**/api/auth/login", route => route.fulfill({ status: 401, json: { error: "Invalid credentials" } }));
  await page.goto("/login");
  await page.locator("#email").fill("someone@example.test");
  await page.locator("#password").fill("not-the-right-one");
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await expect(page.getByText("That email and password do not match.")).toBeVisible();
});
