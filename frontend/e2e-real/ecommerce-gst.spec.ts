import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { readWorkbook, savedDownload } from "./files";
import { settledText, signedUpAccount, watchProblems } from "./helpers";

/**
 * E-commerce GST against the real backend, with the three marketplace files in fixtures/synthetic.
 *
 * Worked out by hand from the files (sales rows only; the Amazon refund row is an adjustment and is left out of the
 * sales totals):
 *   taxable value  10000 + 2000 + 5000 (Amazon) + 4000 + 800 (Flipkart) + 1500 + 900 (Meesho)   = 24,200
 *   GST            1800 + 360 + 900 + 720 + 144 + 270 + 162                                       = 4,356
 *   TCS            100 + 20 + 40 + 40 + 8                                                         = 208
 *   by head: CGST 900 + 360 + 135 = 1,395; SGST the same; IGST 360 + 900 + 144 + 162 = 1,566; invoice total 24,200 + 4,356 = 28,556
 *   B2B (a buyer GSTIN is given), grouped by buyer: 29ABCDE1234F1Z5 has two rows (10,000 + 4,000, GST 2,520, total 16,520) and
 *   27AABCU9603R1ZM one (5,000, GST 900, total 5,900); B2C: 2000 + 800 + 1500 + 900 = 5,200
 * Two rows need a person: the refund (no credit-note details) and the Meesho row with no HSN.
 */

const fixtureDir = new URL("../../fixtures/synthetic/", import.meta.url);
const fixture = (name: string) => ({ name, mimeType: "text/csv", buffer: fs.readFileSync(new URL(name, fixtureDir)) });
const ALL = ["amazon_sales_may_2026.csv", "flipkart_sales_may_2026.csv", "meesho_sales_may_2026.csv"].map(fixture);

async function openJob(page: Page) {
  await page.goto("/app/jobs/ecommerce-gst");
  await expect(page.getByRole("heading", { name: "E-commerce GST" })).toBeVisible();
}

async function uploadAll(page: Page) {
  await page.locator("input[type=file]").first().setInputFiles(ALL);
  await expect(page.getByText("sales rows read")).toBeVisible();
}

const stat = (page: Page, label: string) => settledText(page.getByText(label, { exact: true }).locator("xpath=preceding-sibling::*[1]"));

async function openExport(page: Page) {
  await page.getByRole("tab", { name: "Export" }).click();
  await expect(page.getByRole("heading", { name: "Export" }).or(page.getByText("Export format"))).toBeVisible();
}

test.describe("E-commerce GST", () => {
  test("reads three marketplaces and adds up to the hand-worked totals", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "ec-totals", "Seller Client");
    await openJob(page);
    await uploadAll(page);

    await expect(page.getByText("Amazon + Flipkart + Meesho · 3 reports")).toBeVisible();
    expect(await stat(page, "sales rows read")).toBe("8");
    expect(await stat(page, "need review")).toBe("2");
    await expect(page.getByText("Taxable value").first()).toBeVisible();
    await expect(page.getByText("₹24,200").first()).toBeVisible();
    await expect(page.getByText("₹4,356").first()).toBeVisible();
    await expect(page.getByText("₹208").first()).toBeVisible();
    // The return is left out of the totals and says so, in the product's standard wording.
    await expect(page.getByText(/Sales totals exclude 1 cancelled, return or adjustment row/)).toBeVisible();
    await expect(page.getByText("Potential risk — needs CA review.").first()).toBeVisible();
    // Opening the result downloads nothing by itself.
    await expect(page.getByText(/downloaded/i)).toHaveCount(0);
    seen.expectNone();
  });

  test("B2B and B2C each add up, and together make the whole", async ({ page }) => {
    await signedUpAccount(page, "ec-sections", "Sections Client");
    await openJob(page);
    await uploadAll(page);

    const section = page.getByLabel("GST section");
    const row = (name: RegExp) => page.getByRole("row", { name });
    await section.selectOption("B2B");
    // One line per buyer GSTIN, place of supply and rate: rows, taxable value, GST, invoice total.
    await expect(row(/29ABCDE1234F1Z5/)).toContainText(/Karnataka\s*18%\s*2\s*₹14,000\s*₹2,520\s*₹16,520/);
    await expect(row(/27AABCU9603R1ZM/)).toContainText(/Karnataka\s*18%\s*1\s*₹5,000\s*₹900\s*₹5,900/);
    await section.selectOption("B2C");
    await expect(row(/Maharashtra/)).toContainText(/18%\s*2\s*₹2,900\s*₹522\s*₹3,422/);
    await expect(row(/Delhi/)).toContainText(/18%\s*1\s*₹800\s*₹144\s*₹944/);
    await expect(row(/Gujarat/)).toContainText(/18%\s*1\s*₹1,500\s*₹270\s*₹1,770/);
    await section.selectOption("TCS");
    await expect(page.getByText("₹208").first()).toBeVisible();
  });

  test("the review lists the two flagged rows and a correction recalculates", async ({ page }) => {
    await signedUpAccount(page, "ec-review", "Review Client");
    await openJob(page);
    await uploadAll(page);

    await page.getByRole("button", { name: "Review 2 items" }).click();
    await expect(page.getByText("Return or adjustment needs supporting credit-note or settlement details.")).toBeVisible();
    await expect(page.getByText("Missing HSN.")).toBeVisible();
    await expect(page.getByText("INV-A-1").first()).toBeVisible();
    await expect(page.getByText("INV-M-2").first()).toBeVisible();

    // Give the Meesho row its HSN.
    const row = page.locator("div.justify-between").filter({ hasText: "INV-M-2" });
    await row.getByRole("button", { name: "Correct row" }).click();
    await page.getByLabel("HSN", { exact: true }).fill("6204");
    await page.getByRole("button", { name: "Save correction" }).click();
    await expect(page.getByRole("tab", { name: "Review (1)" })).toBeVisible();
    await expect(page.getByText("Missing HSN.")).toHaveCount(0);
    // The refund still needs credit-note details, so one item remains.
    await expect(page.getByText("Return or adjustment needs supporting credit-note or settlement details.")).toBeVisible();
  });

  test("the Excel working copy carries the same totals, and says it is only a working copy", async ({ page }) => {
    await signedUpAccount(page, "ec-excel", "Excel Client");
    await openJob(page);
    await uploadAll(page);
    await openExport(page);
    await expect(page.getByText(/working copy/i).first()).toBeVisible();
    await expect(page.getByText(/2 items still need review/)).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Excel" }).click()]);
    const sheets = await readWorkbook((await savedDownload(download)).bytes);
    expect(sheets.length).toBeGreaterThan(0);
    const numbers = sheets.flatMap(sheet => sheet.rows.flat()).filter((cell): cell is number => typeof cell === "number");
    // Taxable value, CGST, SGST, IGST, invoice total and TCS, each worked out by hand from the three files.
    for (const total of [24200, 1395, 1566, 28556, 208]) {
      expect(numbers, `the workbook should contain ${total}`).toContain(total);
    }
    expect(numbers.filter(value => value === 1395).length, "CGST and SGST are both 1,395").toBeGreaterThanOrEqual(2);
  });

  test("the GST draft downloads as a draft", async ({ page }) => {
    await signedUpAccount(page, "ec-json", "Draft Client");
    await openJob(page);
    await uploadAll(page);
    await openExport(page);
    await page.getByLabel("Export format").selectOption("gst");
    await expect(page.getByText(/review draft/i).first()).toBeVisible();

    const downloads: string[] = [];
    page.on("download", download => downloads.push(download.suggestedFilename()));
    await page.getByRole("button", { name: "Download GST draft" }).click();
    await expect(page.getByText(/GSTR-1 draft \(JSON\) and sales summary \(CSV\) downloaded/)).toBeVisible();
    expect(downloads.some(name => name.endsWith(".json"))).toBe(true);
    expect(downloads.some(name => name.endsWith(".csv"))).toBe(true);
    // The wording never claims the portal accepts it.
    await expect(page.getByText(/Potential risk — needs CA review before filing/)).toBeVisible();
  });

  test("Tally Sales XML is held back while a return has no credit-note details", async ({ page }) => {
    await signedUpAccount(page, "ec-xml", "Xml Client");
    await openJob(page);
    await uploadAll(page);
    await openExport(page);
    await page.getByLabel("Export format").selectOption("tally");

    const early = page.waitForEvent("download", { timeout: 3000 }).catch(() => null);
    await page.getByRole("button", { name: "Download Sales XML" }).click();
    expect(await early, "a Sales XML was produced although a return is unresolved").toBeNull();
    await expect(page.getByRole("alert").or(page.locator("div.rounded-xl.border-red-200")).first()).toBeVisible();
  });

  test("a report that is not a marketplace report is refused", async ({ page }) => {
    await signedUpAccount(page, "ec-wrong", "Wrong Client");
    await openJob(page);
    await page.locator("input[type=file]").first().setInputFiles({ name: "notes.csv", mimeType: "text/csv", buffer: Buffer.from("Name,City\nAnita,Pune\n") });
    await expect(page.getByText(/sales rows read/)).toHaveCount(0);
    await expect(page.locator("div.rounded-xl.border-red-200").first()).toBeVisible();
  });
});
