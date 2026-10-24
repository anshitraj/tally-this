import { expect, test, type Page } from "@playwright/test";
import { GSTR2B_BOOKS, GSTR2B_PORTAL_JSON, SELLER_GSTIN } from "./data";
import { readWorkbook, savedDownload } from "./files";
import { settledText, signedUpAccount, watchProblems } from "./helpers";

/**
 * GSTR-2B ↔ Books against the real backend. Worked out by hand:
 *   - Beta Supplies BS-77 (₹23,600, IGST ₹3,600) is in both: 1 matched;
 *   - Alpha Traders INV-001 (GST ₹900 + ₹900 = ₹1,800) is in the books but the supplier has not reported it: ITC not supported;
 *   - Gamma Traders GX-1 (GST ₹1,800) is in GSTR-2B but not in the books.
 * So 1 matched and 2 that need attention, ₹1,800 of credit at risk and ₹1,800 not booked.
 */

const stat = (page: Page, label: string) => settledText(page.getByText(label, { exact: true }).locator("xpath=preceding-sibling::*[1]"));

async function openJob(page: Page) {
  await page.goto("/app/jobs/gstr-2b");
  await expect(page.getByRole("heading", { name: "GSTR-2B ↔ Books" })).toBeVisible();
}

async function uploadBoth(page: Page, order: "normal" | "swapped" = "normal") {
  const portal = { name: "gstr2b-102026.json", mimeType: "application/json", buffer: Buffer.from(GSTR2B_PORTAL_JSON) };
  const books = { name: "purchase-register-oct-2026.csv", mimeType: "text/csv", buffer: Buffer.from(GSTR2B_BOOKS) };
  const inputs = page.locator("input[type=file]");
  await expect(inputs.first()).toBeAttached();
  await inputs.nth(0).setInputFiles(order === "normal" ? portal : books);
  await inputs.nth(1).setInputFiles(order === "normal" ? books : portal);
}

test.describe("GSTR-2B ↔ Books", () => {
  test("shows what the portal supports, what it does not, and what is not in the books", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "g2b-main", "2B Client");
    await openJob(page);
    await uploadBoth(page);

    await expect(page.getByText("October 2026 · 2 in GSTR-2B · 2 in your books")).toBeVisible();
    expect(await stat(page, "matched")).toBe("1");
    expect(await stat(page, "need attention")).toBe("2");
    await expect(page.getByText("ITC not supported by GSTR-2B")).toBeVisible();
    await expect(page.getByText("₹1,800").first()).toBeVisible();
    await expect(page.getByText("In GSTR-2B, not in books")).toBeVisible();
    // It compares two files and says so; it does not decide eligibility.
    await expect(page.getByText("This compares your two files; it does not decide whether ITC can be claimed.")).toBeVisible();
    await expect(page.getByText("Potential risk — needs CA review.").first()).toBeVisible();
    // The supplier to chase is named with the invoice and the tax at risk.
    await expect(page.getByText(`Alpha Traders`).first()).toBeVisible();
    await expect(page.getByText(`${SELLER_GSTIN} · 1 invoice · GST ₹1,800`)).toBeVisible();
    seen.expectNone();
  });

  test("the two files can be dropped in either order", async ({ page }) => {
    await signedUpAccount(page, "g2b-swap", "2B Swap Client");
    await openJob(page);
    await uploadBoth(page, "swapped");
    expect(await stat(page, "matched")).toBe("1");
    expect(await stat(page, "need attention")).toBe("2");
  });

  test("the Excel carries the same figures", async ({ page }) => {
    await signedUpAccount(page, "g2b-xlsx", "2B Excel Client");
    await openJob(page);
    await uploadBoth(page);
    expect(await stat(page, "matched")).toBe("1");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Excel" }).click()]);
    const sheets = await readWorkbook((await savedDownload(download)).bytes);
    const cells = sheets.flatMap(sheet => sheet.rows.flat());
    const numbers = cells.filter((cell): cell is number => typeof cell === "number");
    expect(numbers).toContain(1800);
    const text = cells.filter(cell => typeof cell === "string").join(" | ");
    expect(text).toContain("Alpha Traders");
    expect(text).toContain("Gamma Traders");
    expect(text).toContain("INV-001");
    expect(text).toContain("GX-1");
  });

  test("a file that is neither is refused with a plain message", async ({ page }) => {
    await signedUpAccount(page, "g2b-wrong", "2B Wrong Client");
    await openJob(page);
    const inputs = page.locator("input[type=file]");
    await expect(inputs.first()).toBeAttached();
    await inputs.nth(0).setInputFiles({ name: "notes.csv", mimeType: "text/csv", buffer: Buffer.from("Name,City\nAnita,Pune\n") });
    await inputs.nth(1).setInputFiles({ name: "notes2.csv", mimeType: "text/csv", buffer: Buffer.from("Name,City\nRahul,Delhi\n") });
    await expect(page.locator("div.rounded-xl.border-red-200").first()).toBeVisible();
    await expect(page.getByText("need attention")).toHaveCount(0);
  });
});
