import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { MAY_STATEMENT, PURCHASE_LIST, SALARY_SHEET, SALES_REGISTER, mayTallyRows, tallyCsv } from "./data";
import { expectNoSidewaysScroll, signedUpAccount } from "./helpers";

/**
 * The job results on a phone (Pixel 7, 412 px wide): nothing wider than the screen, and the main action can be reached.
 * These run only in the phone project (see playwright.real.config.ts).
 */

const fixtureDir = new URL("../../fixtures/synthetic/", import.meta.url);
const csv = (name: string, content: string | Buffer) => ({ name, mimeType: "text/csv", buffer: Buffer.from(content) });

/** One drop zone takes every file (E-commerce GST); two-file jobs have one drop zone per file. */
async function job(page: Page, path: string, heading: string, ...files: Array<ReturnType<typeof csv>>) {
  await page.goto(`/app/jobs/${path}`);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  const inputs = page.locator("input[type=file]");
  await expect(inputs.first()).toBeAttached();
  if ((await inputs.count()) === 1) await inputs.first().setInputFiles(files);
  else for (const [index, file] of files.entries()) await inputs.nth(index).setInputFiles(file);
}

test.describe("results on a phone @phone", () => {
  test("Bank → Tally: the statement and its summary fit, and the download is reachable", async ({ page }) => {
    await signedUpAccount(page, "ph-b2t", "Phone Bank Client");
    await job(page, "bank-to-tally", "Bank Statement → Tally", csv("hdfc.csv", MAY_STATEMENT.csv));
    await expect(page.getByText("24 transactions detected")).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expect(page.getByRole("button", { name: /^Download$/ }).first()).toBeInViewport();
    await page.getByRole("button", { name: "Back to results" }).click();
    await expectNoSidewaysScroll(page);
    await expect(page.getByRole("button", { name: "Download Excel" })).toBeVisible();
  });

  test("Bank ↔ Tally: the counts and the review fit", async ({ page }) => {
    await signedUpAccount(page, "ph-bt", "Phone Compare Client");
    await job(page, "bank-tally", "Bank ↔ Tally", csv("bank.csv", MAY_STATEMENT.csv), csv("tally.csv", tallyCsv(mayTallyRows())));
    await expect(page.getByRole("button", { name: /^Review \d+ items$/ })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.getByRole("button", { name: /^Review \d+ items$/ }).click();
    await expectNoSidewaysScroll(page);
  });

  test("E-commerce GST: the report, the section tables and the export fit", async ({ page }) => {
    await signedUpAccount(page, "ph-ec", "Phone Seller Client");
    await job(page, "ecommerce-gst", "E-commerce GST", ...["amazon_sales_may_2026.csv", "flipkart_sales_may_2026.csv", "meesho_sales_may_2026.csv"].map(name => csv(name, fs.readFileSync(new URL(name, fixtureDir)))));
    await expect(page.getByText("sales rows read")).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.getByLabel("GST section").selectOption("B2B");
    await expectNoSidewaysScroll(page);
    await page.getByRole("tab", { name: "Export" }).click();
    await expectNoSidewaysScroll(page);
  });

  test("Sales → GSTR-1 & 3B, Bills → Tally and Payroll fit", async ({ page }) => {
    await signedUpAccount(page, "ph-books", "Phone Books Client");
    await job(page, "gst-sales", "Sales → GSTR-1 & 3B", csv("sales.csv", SALES_REGISTER));
    await expect(page.getByText("2026-10 · 7 documents")).toBeVisible();
    await expectNoSidewaysScroll(page);
    await job(page, "bills-tally", "Bills → Tally", csv("bills.csv", PURCHASE_LIST));
    await expect(page.getByText("2 bills", { exact: true })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await job(page, "payroll", "Payroll", csv("salary.csv", SALARY_SHEET));
    await expect(page.getByText("Sunrise Traders Pvt Ltd · October 2026")).toBeVisible();
    await expectNoSidewaysScroll(page);
  });

  test("Settings, Clients and History fit", async ({ page }) => {
    await signedUpAccount(page, "ph-ws", "Phone Workspace Client");
    for (const path of ["/app/settings", "/app/clients", "/app/history", "/app/activity", "/app/reports"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle").catch(() => {});
      await expectNoSidewaysScroll(page);
    }
  });
});
