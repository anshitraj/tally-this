import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { MAY_STATEMENT, PURCHASE_LIST, SALARY_SHEET, SALES_REGISTER, mayTallyRows, tallyCsv } from "./data";
import { settledText, signedUpAccount, watchProblems } from "./helpers";

/**
 * The home page's one drop zone: whatever file is dropped, it should open the right job with the files already loaded.
 */

const fixtureDir = new URL("../../fixtures/synthetic/", import.meta.url);
const csv = (name: string, content: string | Buffer) => ({ name, mimeType: "text/csv", buffer: Buffer.from(content) });
const fixture = (name: string) => csv(name, fs.readFileSync(new URL(name, fixtureDir)));

async function drop(page: Page, ...files: Array<{ name: string; mimeType: string; buffer: Buffer }>) {
  await page.goto("/app/overview");
  await expect(page.getByText("Drop your files here, or browse")).toBeVisible();
  await page.locator("input[type=file]").first().setInputFiles(files);
}

test.describe("the home drop zone", () => {
  test("a bank statement opens Bank → Tally with the statement already read", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "home-bank", "Home Client");
    await drop(page, csv("hdfc-may-2026.csv", MAY_STATEMENT.csv));
    await expect(page).toHaveURL(/\/app\/jobs\/bank-to-tally$/);
    await expect(page.getByText("24 transactions detected")).toBeVisible();
    seen.expectNone();
  });

  test("a bank statement and a Tally export open Bank ↔ Tally and compare at once", async ({ page }) => {
    await signedUpAccount(page, "home-both", "Home Both Client");
    await drop(page, csv("hdfc-may-2026.csv", MAY_STATEMENT.csv), csv("tally-daybook.csv", tallyCsv(mayTallyRows())));
    await expect(page).toHaveURL(/\/app\/jobs\/bank-tally$/);
    expect(await settledText(page.getByText("matched", { exact: true }).locator("xpath=preceding-sibling::*[1]"))).toBe("19");
  });

  test("marketplace reports open E-commerce GST", async ({ page }) => {
    await signedUpAccount(page, "home-ecom", "Home Seller Client");
    await drop(page, fixture("amazon_sales_may_2026.csv"), fixture("flipkart_sales_may_2026.csv"));
    await expect(page).toHaveURL(/\/app\/jobs\/ecommerce-gst$/);
    await expect(page.getByText("sales rows read")).toBeVisible();
  });

  test("a bank statement and invoices open Invoice ↔ Bank", async ({ page }) => {
    await signedUpAccount(page, "home-inv", "Home Invoice Client");
    await drop(page, csv("hdfc-may-2026.csv", MAY_STATEMENT.csv), fixture("invoice_register_may_2026.csv"));
    await expect(page).toHaveURL(/\/app\/jobs\/invoice-bank$/);
    await expect(page.getByText("3 invoices · 24 bank entries")).toBeVisible();
  });

  test("a sales register, a purchase list and a salary sheet each open their own job", async ({ page }) => {
    await signedUpAccount(page, "home-books", "Home Books Client");
    await drop(page, csv("sales-register.csv", SALES_REGISTER));
    await expect(page).toHaveURL(/\/app\/jobs\/gst-sales$/);
    await expect(page.getByText("2026-10 · 7 documents")).toBeVisible();

    await drop(page, csv("purchases.csv", PURCHASE_LIST));
    await expect(page).toHaveURL(/\/app\/jobs\/bills-tally$/);
    await expect(page.getByText("2 bills", { exact: true })).toBeVisible();

    await drop(page, csv("salary.csv", SALARY_SHEET));
    await expect(page).toHaveURL(/\/app\/jobs\/payroll$/);
    await expect(page.getByText("Sunrise Traders Pvt Ltd · October 2026")).toBeVisible();
  });

  test("a file it cannot place stays on the home page and says so, without an error", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "home-unknown", "Home Unknown Client");
    await drop(page, csv("notes.csv", "Name,City\nAnita,Pune\n"));
    await expect(page.getByText(/could not match it to a job/)).toBeVisible();
    await expect(page).toHaveURL(/\/app\/overview$/);
    seen.expectNone();
  });
});
