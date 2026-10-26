import { expect, test, type Page } from "@playwright/test";
import { parseVouchers, parseLedgers, savedDownload, unbalancedVouchers } from "./files";
import { kotakRows, kotakStatement } from "./pdf";
import { signedUpAccount, watchProblems } from "./helpers";

/**
 * A text PDF statement (the most common thing a bank gives out) through the real worker and API: read by column position,
 * every row proved against the bank's own running balance, and locked PDFs asked for their password.
 *
 * Worked out by hand from kotakRows(): money in 50,000 + 1,18,000 + 1,815 + 2,10,000 = 3,79,815; money out
 * 18,250.50 + 30,000 + 2,300 + 14,500 = 65,050.50; opening 4,70,822.68 so closing 7,85,587.18.
 */

const paise = (value: number) => Math.round(value * 100);

async function openJob(page: Page) {
  await page.goto("/app/jobs/bank-to-tally");
  await expect(page.getByRole("heading", { name: "Bank Statement → Tally" })).toBeVisible();
}

async function closeViewer(page: Page) {
  const back = page.getByRole("button", { name: "Back to results" });
  if (await back.isVisible()) await back.click();
  await expect(back).toBeHidden();
}

test.describe("a text PDF statement", () => {
  test("is read, proved row by row, and needs no manual check before the Tally file", async ({ page }) => {
    const seen = watchProblems(page);
    const statement = await kotakStatement();
    await signedUpAccount(page, "pdf-main", "Pdf Client");
    await openJob(page);
    await page.locator("input[type=file]").first().setInputFiles({ name: "kotak-fy-2025-26.pdf", mimeType: "application/pdf", buffer: statement.pdf });

    await expect(page.getByText("8 transactions detected")).toBeVisible();
    await expect(page.getByText("Kotak Mahindra Bank").first()).toBeVisible();
    await expect(page.getByText("Money in ₹3,79,815 · Money out ₹65,050.50").first()).toBeVisible();
    // Every row agreed with the bank's running balance: no "could not be checked" warning, no hand check.
    await expect(page.getByText(/could not be checked against the balance/)).toHaveCount(0);
    await expect(page.getByText("Check source values")).toHaveCount(0);

    await closeViewer(page);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Tally XML" }).first().click()]);
    const xml = (await savedDownload(download)).bytes.toString("utf8");
    const vouchers = parseVouchers(xml);
    expect(vouchers).toHaveLength(8);
    expect(unbalancedVouchers(vouchers)).toEqual([]);
    const bank = parseLedgers(xml).find(ledger => ledger.parent === "Bank Accounts")?.name;
    expect(bank).toBe("Kotak Mahindra Bank");
    // Each row of the PDF has one voucher with the same date, reference and amount on the bank ledger.
    const months: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
    for (const row of kotakRows()) {
      const [day, month, year] = row.date.split(" ");
      const date = `${year}${months[month]}${day}`;
      const voucher = vouchers.find(item => item.date === date && (row.reference ? item.reference === row.reference : item.narration.includes(row.description.slice(0, 12))));
      expect(voucher, `${row.date} ${row.description}`).toBeTruthy();
      const bankLine = voucher!.entries.find(entry => entry.ledger === bank);
      expect(bankLine?.paise, `${row.date} ${row.description}`).toBe(paise(row.withdrawal ?? 0) - paise(row.deposit ?? 0));
    }
    const net = vouchers.reduce((sum, voucher) => sum - (voucher.entries.find(entry => entry.ledger === bank)?.paise ?? 0), 0);
    expect(net).toBe(statement.moneyIn - statement.moneyOut);
    seen.expectNone();
  });

  test("a balance that does not follow from the amounts is not passed off as proved", async ({ page }) => {
    // The balance printed on row 3 is ₹1 off, as on a damaged or edited statement.
    const statement = await kotakStatement({ misprint: { row: 2, by: 1 } });
    await signedUpAccount(page, "pdf-broken", "Pdf Broken Client");
    await openJob(page);
    await page.locator("input[type=file]").first().setInputFiles({ name: "kotak-misprint.pdf", mimeType: "application/pdf", buffer: statement.pdf });
    await expect(page.getByText(/transactions detected|cannot be|could not|needs/i).first()).toBeVisible();
    // Whatever the product decides to show, a Tally file is not offered as if the statement had been proved.
    await closeViewer(page).catch(() => {});
    const early = page.waitForEvent("download", { timeout: 3000 }).catch(() => null);
    await page.getByRole("button", { name: "Download Tally XML" }).first().click({ timeout: 5000 }).catch(() => {});
    expect(await early, "a Tally file was made from a statement whose balance does not follow").toBeNull();
  });

  test("a locked PDF asks for its password, refuses a wrong one and opens with the right one", async ({ page }) => {
    const statement = await kotakStatement({ password: "kotak-1990" });
    await signedUpAccount(page, "pdf-locked", "Pdf Locked Client");
    await openJob(page);
    await page.locator("input[type=file]").first().setInputFiles({ name: "kotak-locked.pdf", mimeType: "application/pdf", buffer: statement.pdf });

    await expect(page.getByText("This PDF is locked")).toBeVisible();
    await page.getByPlaceholder("PDF password").fill("not-the-password");
    await page.getByRole("button", { name: "Unlock and continue" }).click();
    await expect(page.getByText(/password/i).filter({ hasText: /wrong|incorrect|did not|not right/i }).first()).toBeVisible();
    await expect(page.getByText(/transactions detected/)).toHaveCount(0);

    await page.getByPlaceholder("PDF password").fill("kotak-1990");
    await page.getByRole("button", { name: "Unlock and continue" }).click();
    await expect(page.getByText("8 transactions detected")).toBeVisible();
  });

  test("a PDF with no text (a scan) is not reported as an empty success", async ({ page }) => {
    await signedUpAccount(page, "pdf-scan", "Pdf Scan Client");
    await openJob(page);
    // A valid PDF page with no text on it, which is what a scanned statement looks like to a text reader.
    const blank = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n",
    );
    await page.locator("input[type=file]").first().setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: blank });
    await expect(page.getByText(/transactions detected/)).toHaveCount(0);
    await expect(page.locator("div.rounded-xl.border-red-200, p.text-red-700").first().or(page.getByText(/scan|AI|read|Excel|CSV/i).first())).toBeVisible();
  });
});
