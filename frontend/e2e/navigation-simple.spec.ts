import { test, expect, type Page } from "@playwright/test";
import { ACCOUNT_MENU, ADVANCED_GROUPS, ADVANCED_NAV } from "../src/lib/navigation";

/**
 * The side menu used to list about thirty pages once Advanced was opened. It is now eight short entries; the rest
 * are on one Advanced page, and Settings, History and Help are in the account menu. Every API answer is mocked.
 */
const user = { email: "menu@example.test", name: "Priya Shah", role: "ca", company: "Shah & Co.", companyId: 1 };

async function signIn(page: Page) {
  await page.addInitScript(value => {
    localStorage.setItem("finverify_auth", JSON.stringify({ user: value }));
    localStorage.setItem(`finverify_onboarding_complete:${value.email}`, "true");
  }, user);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("auth/me")) await route.fulfill({ json: { user, company: { name: user.company } } });
    else if (path.endsWith("practice/clients")) await route.fulfill({ json: { clients: [], source: "database" } });
    else await route.fulfill({ json: [] });
  });
}

const MENU = ["Clients", "Bank → Tally", "Bank ↔ Tally", "E-commerce GST", "Invoice ↔ Bank", "Reports", "Activity", "Advanced"];

async function menuLabels(page: Page, scope = 'nav[aria-label="Main"]') {
  return (await page.locator(`${scope} button`).allInnerTexts()).map(text => text.trim());
}

test("the side menu is eight short entries, not a list of every page", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/overview");
  const labels = await menuLabels(page);
  expect(labels).toEqual(MENU);
  for (const entry of ADVANCED_NAV) expect(labels, `${entry.label} should not be in the side menu`).not.toContain(entry.label);
  // Settings and History are in the account menu, not hidden behind Advanced and not in the list.
  await expect(page.locator("aside").getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
});

test("Advanced opens one page that lists every other job and page, each as a working link", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/overview");
  await page.locator("aside").getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/tools$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Advanced");

  for (const group of ADVANCED_GROUPS) {
    await expect(page.getByRole("heading", { level: 2, name: group.title })).toBeVisible();
  }
  const hrefs = ADVANCED_NAV.map(entry => entry.href);
  expect(new Set(hrefs).size, "every listed page has its own address").toBe(hrefs.length);
  for (const entry of ADVANCED_NAV) {
    await expect(page.locator(`main a[href="${entry.href}"]`), entry.label).toHaveCount(1);
  }

  await page.getByRole("link", { name: /^Trial balance/ }).click();
  await expect(page).toHaveURL(/\/app\/trial-balance$/);
});

test("the Advanced page can be searched", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/tools");
  const search = page.getByRole("searchbox", { name: "Find a job or page" });
  await search.fill("payroll");
  await expect(page.getByRole("link", { name: /^Payroll/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Trial balance/ })).toHaveCount(0);

  await search.fill("zzzz");
  await expect(page.getByText(/Nothing matches/)).toBeVisible();
  await expect(page.locator("main a[href^='/app/']")).toHaveCount(0);

  await search.fill("");
  await expect(page.locator("main a[href^='/app/']")).toHaveCount(ADVANCED_NAV.length);
});

test("a page under Advanced shows where it sits and the way back", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/transactions");
  await expect(page.locator("aside").getByRole("button", { name: "Advanced", exact: true })).toHaveAttribute("aria-current", "page");
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("button", { name: "Workspace" })).toBeVisible();
  await expect(crumbs.getByRole("button", { name: "Advanced" })).toBeVisible();
  await expect(crumbs.locator("strong")).toHaveText("Transactions");
  await crumbs.getByRole("button", { name: "Advanced" }).click();
  await expect(page).toHaveURL(/\/app\/tools$/);
});

test("Settings, History and Help are in the account menu, with Log out", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/overview");
  await page.getByRole("button", { name: "Account menu" }).click();
  for (const entry of ACCOUNT_MENU) await expect(page.getByRole("menuitem", { name: entry.label, exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Log out", exact: true })).toBeVisible();

  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/settings$/);
  // These pages are not "under" Advanced, so Advanced does not light up for them.
  await expect(page.locator("aside").getByRole("button", { name: "Advanced", exact: true })).not.toHaveAttribute("aria-current", "page");
});

test("Log out from the account menu signs the person out", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/overview");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => localStorage.getItem("finverify_auth"))).toBeNull();
});

test("every older page still opens from its own address", async ({ page }) => {
  await signIn(page);
  for (const href of ["/app/uploads", "/app/trial-balance", "/app/verify", "/app/tds-recon", "/app/gateway-settlements"]) {
    await page.goto(href);
    await expect(page.getByText("That page isn’t here.")).toHaveCount(0);
    await expect(page.locator("aside").getByRole("button", { name: "Advanced", exact: true })).toHaveAttribute("aria-current", "page");
  }
});

test("search (Ctrl K) still finds the older pages and the Advanced page", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/overview");
  await page.getByRole("button", { name: "Search jobs, pages and clients" }).click();
  await page.keyboard.type("vendor aging");
  await expect(page.getByRole("option", { name: /Vendor aging/ })).toBeVisible();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("advanced");
  await expect(page.getByRole("option", { name: /Advanced/ }).first()).toBeVisible();
});

for (const width of [360, 390]) {
  test(`the same short menu and the Advanced page work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await signIn(page);
    await page.goto("/app/overview");
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    const drawer = page.getByRole("complementary", { name: "Workspace navigation" });
    await expect(drawer).toBeVisible();
    expect(await menuLabels(page, 'aside[aria-label="Workspace navigation"] nav')).toEqual(MENU);

    await drawer.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/tools$/);
    await expect(drawer).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("link", { name: /^Trial balance/ })).toBeVisible();
  });
}
