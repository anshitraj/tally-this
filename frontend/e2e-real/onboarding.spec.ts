import { expect, test } from "@playwright/test";
import { PASSWORD, api, expectNoSidewaysScroll, newAccount, setUpWorkspace, signUp, watchProblems } from "./helpers";

/**
 * Sign-up and first-run setup against the real backend. Account creation is step 1 (the sign-up page), then two
 * screens: the first client, and the first job.
 */

test.describe("setting up a new account", () => {
  test("two screens after sign-up, then the chosen job opens", async ({ page }) => {
    const seen = watchProblems(page);
    await signUp(page, newAccount("setup"));

    await expect(page.getByRole("list", { name: "Step 2 of 3" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Add your first client" })).toBeVisible();
    // Nothing optional is asked up front: no GSTIN, PAN, state or industry.
    await expect(page.getByLabel(/gstin|pan\b|state|industry/i)).toHaveCount(0);

    await page.locator("#client-name").fill("Sharma Traders");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("list", { name: "Step 3 of 3" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What do you want to do first?" })).toBeVisible();
    await page.getByRole("button", { name: /Bank Statement/ }).click();

    await expect(page).toHaveURL(/\/app\/jobs\/bank-to-tally$/);
    await expect(page.getByRole("heading", { name: "Bank Statement → Tally" })).toBeVisible();
    // The chosen client is the one the job works on.
    await expect(page.getByLabel("Client", { exact: true }).locator("option:checked")).toHaveText("Sharma Traders");
    seen.expectNone();
  });

  test("the client is saved once, with the books software that was chosen", async ({ page }) => {
    await signUp(page, newAccount("saved"));
    await page.locator("#client-name").fill("Gupta Hardware");
    await page.getByRole("button", { name: "Zoho Books" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /take me home/i }).click();

    const clients = await api(page, "GET", "/api/practice/clients?light=1");
    expect(clients.status).toBe(200);
    expect(clients.json.clients.map((client: { name: string }) => client.name)).toEqual(["Gupta Hardware"]);
    const active = await page.evaluate(() => JSON.parse(localStorage.getItem("finverify_active_client") || "{}"));
    expect(active).toMatchObject({ name: "Gupta Hardware", accounting: "Zoho" });
  });

  test("a name and firm typed under More options are saved", async ({ page }) => {
    const account = newAccount("profile");
    await signUp(page, account);
    await page.getByRole("button", { name: /Your name and firm/ }).click();
    await page.locator("#full-name").fill("Meera Iyer");
    await page.locator("#firm-name").fill("Iyer & Partners");
    await page.locator("#client-name").fill("Kapoor Foods");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /take me home/i }).click();

    // The firm is the CA's own company; the client is a separate one.
    const company = await api(page, "GET", "/api/company");
    expect(company.json.name).toBe("Iyer & Partners");
    const me = await api(page, "GET", "/api/auth/me");
    expect(me.json.user.name).toBe("Meera Iyer");
    await expect(page.getByText("Meera Iyer").first()).toBeVisible();
  });

  test("refreshing in the middle keeps the step and what was typed", async ({ page }) => {
    await signUp(page, newAccount("refresh"));
    await page.locator("#client-name").fill("Verma Textiles");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Add your first client" })).toBeVisible();
    await expect(page.locator("#client-name")).toHaveValue("Verma Textiles");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "What do you want to do first?" })).toBeVisible();
    await page.reload();
    // Still on the last step, and the client was not added a second time.
    await expect(page.getByRole("heading", { name: "What do you want to do first?" })).toBeVisible();
    const clients = await api(page, "GET", "/api/practice/clients?light=1");
    expect(clients.json.clients).toHaveLength(1);
  });

  test("adding the same client again (a second tab, a cleared draft) does not make a copy", async ({ page }) => {
    await signUp(page, newAccount("twice"));
    await page.locator("#client-name").fill("Alpha Traders");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "What do you want to do first?" })).toBeVisible();

    // Setup starts over, as in a fresh tab.
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(page.getByRole("heading", { name: "Add your first client" })).toBeVisible();
    await page.locator("#client-name").fill("alpha traders");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "What do you want to do first?" })).toBeVisible();

    const clients = await api(page, "GET", "/api/practice/clients?light=1");
    expect(clients.json.clients).toHaveLength(1);
    expect(clients.json.clients[0].name).toBe("Alpha Traders");
  });

  test("a business owner names the business and needs no client", async ({ page }) => {
    await signUp(page, newAccount("owner", { firm: "Placeholder Name" }));
    await page.getByRole("button", { name: /my own business/i }).click();
    await expect(page.getByRole("heading", { name: "Confirm your business" })).toBeVisible();
    await expect(page.locator("#business-name")).toHaveValue("Placeholder Name");
    await page.locator("#business-name").fill("Joshi Exports Pvt Ltd");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /take me home/i }).click();

    const clients = await api(page, "GET", "/api/practice/clients?light=1");
    expect(clients.json.clients).toEqual([]);
    const company = await api(page, "GET", "/api/company");
    expect(company.json.name).toBe("Joshi Exports Pvt Ltd");
    await expect(page.getByText("Joshi Exports Pvt Ltd").first()).toBeVisible();
  });

  test("skipping the client still gets to the first job", async ({ page }) => {
    await signUp(page, newAccount("skip"));
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.getByRole("heading", { name: "What do you want to do first?" })).toBeVisible();
    await page.getByRole("button", { name: /Invoice ↔ Bank/ }).click();
    await expect(page).toHaveURL(/\/app\/jobs\/invoice-bank$/);
    const clients = await api(page, "GET", "/api/practice/clients?light=1");
    expect(clients.json.clients).toEqual([]);
  });

  test("Continue waits for a client name, and Enter submits", async ({ page }) => {
    await signUp(page, newAccount("enter"));
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
    await page.locator("#client-name").fill("Nair Pharma");
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    await page.locator("#client-name").press("Enter");
    await expect(page.getByRole("heading", { name: "What do you want to do first?" })).toBeVisible();
  });

  test("setup does not come back once it is done", async ({ page }) => {
    await page.goto("/");
    const account = newAccount("done");
    await signUp(page, account);
    await setUpWorkspace(page);

    // The Back button leaves setup behind instead of returning to it.
    await page.goBack();
    await expect(page).not.toHaveURL(/\/onboarding$/);
    await expect(page).not.toHaveURL(/\/login/);

    // An old link or a second visit goes straight to the app.
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/app\/overview$/);
  });
});

test.describe("coming back", () => {
  test("someone already signed in is sent past the sign-in page", async ({ page }) => {
    await signUp(page, newAccount("signedin"));
    await setUpWorkspace(page);
    await page.goto("/login");
    await expect(page).toHaveURL(/\/app\/overview$/);
  });

  test("signing in on a new device goes to the app, not through setup again", async ({ page, context }) => {
    const account = newAccount("device");
    await signUp(page, account);
    await setUpWorkspace(page, "Chopra Motors");

    // A different browser: nothing is remembered locally.
    await context.clearCookies();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto("/login");
    await page.locator("#email").fill(account.email);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/overview$/);
    // Their client is still there.
    const clients = await api(page, "GET", "/api/practice/clients?light=1");
    expect(clients.json.clients.map((client: { name: string }) => client.name)).toEqual(["Chopra Motors"]);
  });

  test("a wrong password says so plainly, and so does an address that already has an account", async ({ page }) => {
    const account = newAccount("errors");
    const seen = watchProblems(page, [/401|409|Failed to load resource/]);
    await signUp(page, account);
    await setUpWorkspace(page);
    await page.evaluate(() => localStorage.clear());

    await page.goto("/login");
    await page.locator("#email").fill(account.email);
    await page.locator("#password").fill("not-the-password-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("That email and password do not match.");
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/login?mode=signup");
    await page.locator("#name").fill("Someone Else");
    await page.locator("#company").fill("Else & Co");
    await page.locator("#email").fill(account.email);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("alert")).toContainText("already exists");
    expect(seen.problems.filter(problem => /page error/.test(problem))).toEqual([]);
  });

  test("a password under 8 characters is stopped before anything is sent", async ({ page }) => {
    await page.goto("/login?mode=signup");
    await page.locator("#name").fill("Short Password");
    await page.locator("#company").fill("Short & Co");
    await page.locator("#email").fill(newAccount("short").email);
    await page.locator("#password").fill("short1");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/login/);
    const valid = await page.locator("#password").evaluate((input: HTMLInputElement) => input.validity.valid);
    expect(valid).toBe(false);
  });
});

test.describe("on a phone @phone", () => {
  test("setup fits the screen and can be finished with a thumb", async ({ page }) => {
    const seen = watchProblems(page);
    await signUp(page, newAccount("phone"));
    await expectNoSidewaysScroll(page);
    await page.locator("#client-name").fill("Phone Client");
    await expect(page.getByRole("button", { name: "Continue" })).toBeInViewport();
    await page.getByRole("button", { name: "Continue" }).click();
    await expectNoSidewaysScroll(page);
    await page.getByRole("button", { name: /Bank Statement/ }).click();
    await expect(page).toHaveURL(/\/app\/jobs\/bank-to-tally$/);
    await expectNoSidewaysScroll(page);
    seen.expectNone();
  });
});
