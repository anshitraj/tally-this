import { test, expect } from "@playwright/test";

/**
 * Workflow-level e2e for upload-management UX and reconciliation finalize flow.
 * These tests only verify static text/elements that render unauthenticated or with
 * placeholder data so they can run against a fresh dev server without seed data.
 */

test.describe("Uploads management UI", () => {
  test("Current Uploaded Files panel renders under drop zone", async ({ page }) => {
    await page.goto("/app/uploads");
    await expect(page.getByText(/Current Uploaded Files/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Active files grouped by destination folder/i)).toBeVisible();
  });

  test("Smart Next Step subtitle copy is present", async ({ page }) => {
    await page.goto("/app/uploads");
    await expect(page.getByText(/Smart Next Step/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("Advanced Upload View toggle button is hidden until a file is uploaded", async ({ page }) => {
    await page.goto("/app/uploads");
    await expect(page.getByRole("button", { name: /Open Advanced Upload View/i })).toHaveCount(0);
  });
});

test.describe("Reconciliation review UI", () => {
  test("Generate CA-ready Report button visible on Reconciliation page", async ({ page }) => {
    await page.goto("/app/reconciliation");
    await expect(page.getByRole("button", { name: /Generate CA-ready Report/i })).toBeVisible({ timeout: 10000 });
  });

  test("Filter chips include needs_info", async ({ page }) => {
    await page.goto("/app/reconciliation");
    await expect(page.getByRole("button", { name: /needs[_ ]info/i })).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Route redirects", () => {
  test("/app/ledger redirects to /app/ledger-match", async ({ page }) => {
    await page.goto("/app/ledger");
    await expect(page).toHaveURL(/\/app\/ledger-match/);
  });

  test("/app/risks redirects to /app/gst-tds-risks", async ({ page }) => {
    await page.goto("/app/risks");
    await expect(page).toHaveURL(/\/app\/gst-tds-risks/);
  });

  test("/app/gateway redirects to /app/gateway-settlements", async ({ page }) => {
    await page.goto("/app/gateway");
    await expect(page).toHaveURL(/\/app\/gateway-settlements/);
  });

  test("/app/review redirects to /app/ca-review", async ({ page }) => {
    await page.goto("/app/review");
    await expect(page).toHaveURL(/\/app\/ca-review/);
  });
});

test.describe("Docs", () => {
  test("Docs page covers Normal vs Advanced Upload", async ({ page }) => {
    await page.goto("/app/docs");
    await expect(page.getByText(/Normal Upload vs Advanced Upload/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Upload vs Parsing vs Import vs Reconciliation vs Report/i)).toBeVisible();
  });
});
