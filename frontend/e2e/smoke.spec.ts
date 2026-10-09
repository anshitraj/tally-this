import { test, expect } from "@playwright/test";

/**
 * Smoke tests for FinVerify OS.
 * These run against a live dev server (BASE_URL env or http://localhost:5173).
 * They verify navigation, key pages load, and the Smart Next Step Panel is present.
 */

test.describe("FinVerify OS — smoke", () => {
  test("root redirects to app", async ({ page }) => {
    await page.goto("/");
    // Should land somewhere in /app
    await expect(page).toHaveURL(/\/app\//);
  });

  test("uploads page loads with Smart Next Step Panel", async ({ page }) => {
    await page.goto("/app/uploads");
    // Month Close Command Center header is visible
    await expect(page.getByText(/Month Close|Command Center|What you uploaded/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("transactions page loads", async ({ page }) => {
    await page.goto("/app/transactions");
    await expect(page.locator("body")).toBeVisible();
    // No hard crash — page renders something
    await expect(page.locator("h1, h2, [data-page-header]").first()).toBeVisible({ timeout: 10000 });
  });

  test("invoices page loads", async ({ page }) => {
    await page.goto("/app/invoices");
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("h1, h2, [data-page-header]").first()).toBeVisible({ timeout: 10000 });
  });

  test("reconciliation page loads", async ({ page }) => {
    await page.goto("/app/reconciliation");
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("h1, h2, [data-page-header]").first()).toBeVisible({ timeout: 10000 });
  });

  test("reports page loads", async ({ page }) => {
    await page.goto("/app/reports");
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("h1, h2, [data-page-header]").first()).toBeVisible({ timeout: 10000 });
  });

  test("no JS errors on uploads page", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/app/uploads");
    await page.waitForTimeout(2000);
    expect(errors.filter((e) => !e.includes("ResizeObserver"))).toHaveLength(0);
  });
});
