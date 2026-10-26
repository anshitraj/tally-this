import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { MAY_ROWS, MAY_STATEMENT } from "./data";
import { parseCsv, savedDownload } from "./files";
import { signedUpAccount, statValue, watchProblems } from "./helpers";

/**
 * Invoice ↔ Bank against the real backend, with the May statement and the three invoices in fixtures/synthetic.
 * Worked out by hand:
 *   - INV-100 (₹5,000) and BILL-77 (₹2,300) are in the bank with their number in the narration: 2 matched;
 *   - INV-404 (₹999) has no payment: 1 invoice not paid yet;
 *   - 6 bank rows never have an invoice (salary, ATM cash, GST, TDS, interest, SMS charge) and are set aside;
 *   - the other 16 bank rows have no invoice behind them.
 *   So 2 matched, 17 need attention (16 + 1), 6 set aside, out of 24 bank entries.
 */

const invoiceRegister = fs.readFileSync(new URL("../../fixtures/synthetic/invoice_register_may_2026.csv", import.meta.url));

async function openJob(page: Page) {
  await page.goto("/app/jobs/invoice-bank");
  await expect(page.getByRole("heading", { name: "Invoice ↔ Bank" })).toBeVisible();
}

async function uploadBoth(page: Page, invoices: Buffer | string = invoiceRegister) {
  const inputs = page.locator("input[type=file]");
  await inputs.nth(0).setInputFiles({ name: "bank-may-2026.csv", mimeType: "text/csv", buffer: Buffer.from(MAY_STATEMENT.csv) });
  await inputs.nth(1).setInputFiles({ name: "invoices-may-2026.csv", mimeType: "text/csv", buffer: Buffer.from(invoices) });
}

test.describe("Invoice ↔ Bank", () => {
  test("matches by amount and invoice number, and shows what has no partner", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "ib-main", "Invoice Client");
    await openJob(page);
    await uploadBoth(page);

    await expect(page.getByText("3 invoices · 24 bank entries")).toBeVisible();
    expect(await statValue(page, "matched")).toBe("2");
    expect(await statValue(page, "need attention")).toBe("17");
    await expect(page.getByText("6 salary, cash, tax or bank-charge entries were skipped")).toBeVisible();

    await page.getByRole("button", { name: "Review 17 items" }).click();
    await expect(page.getByText("Bank entries without an invoice (16)")).toBeVisible();
    await expect(page.getByText("Invoices not paid yet (1)")).toBeVisible();
    await expect(page.getByText("INV-404").first()).toBeVisible();
    // The two that matched are not offered for review.
    await expect(page.getByText("UPI-ACME Corp/INV-100/YESB0001234")).toHaveCount(0);
    await expect(page.getByText("UPI-Office Supplies Ltd/BILL-77")).toHaveCount(0);
    seen.expectNone();
  });

  test("the report lists every bank row and every invoice exactly once", async ({ page }) => {
    await signedUpAccount(page, "ib-report", "Report Client");
    await openJob(page);
    await uploadBoth(page);
    expect(await statValue(page, "matched")).toBe("2");

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Report" }).first().click()]);
    const rows = parseCsv((await savedDownload(download)).bytes.toString("utf8"));
    expect(rows[0]).toEqual(["Result", "Decision", "Bank date", "Bank narration", "Bank amount", "Invoice", "Vendor", "Invoice date", "Invoice total", "Source"]);
    const body = rows.slice(1).map(row => ({ result: row[0], bank: row[3], bankAmount: row[4], invoice: row[5], total: row[8] }));

    expect(body.filter(row => row.bank !== "")).toHaveLength(MAY_ROWS.length);
    expect(body.filter(row => row.invoice !== "")).toHaveLength(3);
    const matched = body.filter(row => row.result === "Matched");
    expect(matched.map(row => row.invoice).sort()).toEqual(["BILL-77", "INV-100"]);
    for (const row of matched) expect(Math.round(Number(row.bankAmount) * 100), row.invoice).toBe(Math.round(Number(row.total) * 100));
    expect(body.filter(row => row.result === "No invoice expected")).toHaveLength(6);
    const unpaid = body.find(row => row.invoice === "INV-404");
    expect(unpaid?.bank, "INV-404 has no bank row").toBe("");
  });

  test("an amount off by ₹1 is rounding and still matches; a bigger difference is shown as differing", async ({ page }) => {
    await signedUpAccount(page, "ib-amount", "Amount Client");
    await openJob(page);
    const original = invoiceRegister.toString("utf8");
    const line = "INV-100,01/05/2026,ACME Corp,29ABCDE1234F1Z5,NovaStack Labs,5000,900";
    expect(original).toContain(line);

    // ₹5,001 against the ₹5,000 paid: within the ₹1 round-off allowance, with the invoice number in the narration.
    await uploadBoth(page, original.replace(line, line.replace(",5000,900", ",5001,900")));
    expect(await statValue(page, "matched")).toBe("2");
    expect(await statValue(page, "need attention")).toBe("17");

    // ₹5,010 is not rounding: it is not counted as matched, and the review says the amount differs.
    await page.getByRole("button", { name: "Match other files" }).click();
    await uploadBoth(page, original.replace(line, line.replace(",5000,900", ",5010,900")));
    expect(await statValue(page, "matched")).toBe("1");
    expect(await statValue(page, "need attention")).toBe("18");
    await page.getByRole("button", { name: "Review 18 items" }).click();
    await expect(page.getByText("Amount differs (1)")).toBeVisible();
  });

  test("the request for missing invoices names every payment without one", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signedUpAccount(page, "ib-request", "Request Client");
    await openJob(page);
    await uploadBoth(page);
    expect(await statValue(page, "matched")).toBe("2");
    await page.getByRole("button", { name: /Copy request for 16 missing invoices/ }).click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    for (const row of MAY_ROWS.filter(row => ["Rent May", "Stationery Mart", "Courier Express", "Internet Broadband"].some(name => row.narration.includes(name)))) {
      expect(text, row.narration).toContain(row.narration.split("/")[1] ?? row.narration);
    }
    // Set-aside rows (salary, cash, tax, charges) are never asked of the client.
    expect(text).not.toContain("SAL2026");
    expect(text).not.toContain("SMS ALERT");
  });
});
