import { expect, test, type Page } from "@playwright/test";
import { PURCHASE_LIST, PURCHASE_LIST_WITH_ERROR, SALARY_SHEET, SALES_REGISTER, SELLER_GSTIN, BUYER_GSTIN } from "./data";
import { parseVouchers, readWorkbook, savedDownload, unbalancedVouchers } from "./files";
import { settledText, signedUpAccount, watchProblems } from "./helpers";

/**
 * The three "books" jobs against the real backend: Sales → GSTR-1 & 3B, Bills → Tally and Payroll. Every figure below is
 * worked out by hand from the file the test uploads (the sums are in the comments).
 */

async function openJob(page: Page, path: string, heading: string | RegExp) {
  await page.goto(`/app/jobs/${path}`);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
}

async function upload(page: Page, name: string, content: string) {
  await page.locator("input[type=file]").first().setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(content) });
}

const stat = (page: Page, label: string | RegExp) => settledText(page.getByText(label, { exact: typeof label === "string" }).locator("xpath=preceding-sibling::*[1]"));

test.describe("Sales → GSTR-1 & 3B", () => {
  // S-001 B2B ₹1,00,000 + IGST 18,000; S-004 inter-state to consumers above ₹1 lakh (B2C Large) ₹1,50,000 + IGST 27,000;
  // S-002, S-003 and S-005 are B2C Small; S-006 has no tax; CN-001 is a credit note of ₹10,000 + IGST 1,800.
  // Taxable value: 100000 + 5000 + 2000 + 150000 + 40000 + 3000 - 10000 = 2,90,000.
  // GST: IGST 18000 + 27000 + 7200 - 1800 = 50,400; CGST 450 + 180 = 630; SGST 630; together 51,660.
  test("sorts the register into the GSTR-1 tables and the tables add up to the register", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "gs-main", "Sales Client");
    await openJob(page, "gst-sales", "Sales → GSTR-1 & 3B");
    await upload(page, "sales-register-oct-2026.csv", SALES_REGISTER);

    await expect(page.getByText("2026-10 · 7 documents")).toBeVisible();
    expect(await stat(page, "sorted into tables")).toBe("7");
    await expect(page.getByText(`Taxable value ₹2,90,000 · GST ₹51,660 · ${SELLER_GSTIN}`)).toBeVisible();
    await expect(page.getByText("A working copy for your CA.")).toBeVisible();
    await expect(page.getByText("It is not filed on the GST portal.")).toBeVisible();
    await expect(page.getByText("Potential risk — needs CA review.").first()).toBeVisible();

    const table = (name: RegExp) => page.getByRole("row", { name });
    await expect(table(/Sales to registered buyers \(B2B\)/)).toContainText(/1\s*₹1,00,000\s*₹18,000/);
    await expect(table(/Large inter-state sales to consumers \(B2C Large\)/)).toContainText(/1\s*₹1,50,000\s*₹27,000/);
    seen.expectNone();
  });

  test("the working copy workbook holds the same figures and a GSTR-3B that needs the CA to finish it", async ({ page }) => {
    await signedUpAccount(page, "gs-xlsx", "Workbook Client");
    await openJob(page, "gst-sales", "Sales → GSTR-1 & 3B");
    await upload(page, "sales-register-oct-2026.csv", SALES_REGISTER);
    await expect(page.getByText("2026-10 · 7 documents")).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download GSTR-1 & 3B working" }).click()]);
    const file = await savedDownload(download);
    expect(file.name).toMatch(/\.xlsx$/);
    const sheets = await readWorkbook(file.bytes);
    const numbers = sheets.flatMap(sheet => sheet.rows.flat()).filter((cell): cell is number => typeof cell === "number");
    // Net IGST, CGST and SGST across the register, to the rupee.
    for (const figure of [50400, 630, 290000]) expect(numbers, `the workbook should contain ${figure}`).toContain(figure);
    // The two sections the product cannot fill in alone are flagged for the CA, in its own wording.
    const text = sheets.flatMap(sheet => sheet.rows.flat()).filter(cell => typeof cell === "string").join(" | ");
    expect(text).toMatch(/GSTR-2B/);
    expect(text).not.toMatch(/filed|accepted by the GST portal/i);
  });

  test("a file that is not a sales register is refused", async ({ page }) => {
    await signedUpAccount(page, "gs-wrong", "Wrong Client");
    await openJob(page, "gst-sales", "Sales → GSTR-1 & 3B");
    await upload(page, "notes.csv", "Name,City\nAnita,Pune\n");
    await expect(page.getByText(/documents/)).toHaveCount(0);
    await expect(page.locator("div.rounded-xl.border-red-200").first()).toBeVisible();
  });
});

test.describe("Bills → Tally", () => {
  // Bill 1: ₹10,000 + CGST 900 + SGST 900 = 11,800. Bill 2: ₹20,000 + IGST 3,600 = 23,600.
  // Purchases 30,000, GST 5,400, total 35,400.
  test("two clean bills become balanced Purchase vouchers with the GST split", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "bt-main", "Bills Client");
    await openJob(page, "bills-tally", "Bills → Tally");
    await upload(page, "purchases-oct-2026.csv", PURCHASE_LIST);

    await expect(page.getByText("2 bills", { exact: true })).toBeVisible();
    expect(await stat(page, "ready for Tally")).toBe("2");
    await expect(page.getByText("Purchases ₹30,000 · GST ₹5,400 · Total ₹35,400")).toBeVisible();

    const downloads: Array<{ name: string; text: string }> = [];
    page.on("download", async download => {
      downloads.push({ name: download.suggestedFilename(), text: (await savedDownload(download)).bytes.toString("utf8") });
    });
    await page.getByRole("button", { name: "Download Tally File" }).click();
    await expect.poll(() => downloads.length, { timeout: 15000 }).toBeGreaterThan(0);

    const xml = downloads.map(item => item.text).join("\n");
    const vouchers = parseVouchers(xml).filter(voucher => voucher.type === "Purchase");
    expect(vouchers).toHaveLength(2);
    expect(unbalancedVouchers(vouchers)).toEqual([]);
    const byRef = Object.fromEntries(vouchers.map(voucher => [voucher.reference, voucher]));
    const paise = (ledger: string, ref: string) => byRef[ref].entries.find(entry => entry.ledger === ledger)?.paise;
    // Supplier credited with the invoice total; purchase and tax ledgers debited.
    expect(paise("Alpha Traders", "INV-001")).toBe(1180000);
    expect(paise("Input CGST", "INV-001")).toBe(-90000);
    expect(paise("Input SGST", "INV-001")).toBe(-90000);
    expect(paise("Beta Supplies", "BS-77")).toBe(2360000);
    expect(paise("Input IGST", "BS-77")).toBe(-360000);
    seen.expectNone();
  });

  test("a bill whose total does not add up is shown first with the reason, and no Tally file is made", async ({ page }) => {
    await signedUpAccount(page, "bt-error", "Bills Error Client");
    await openJob(page, "bills-tally", "Bills → Tally");
    await upload(page, "purchases-oct-2026.csv", PURCHASE_LIST_WITH_ERROR);

    await expect(page.getByText("2 bills", { exact: true })).toBeVisible();
    expect(await stat(page, "ready for Tally")).toBe("1");
    expect(await stat(page, /^needs? a fix$/)).toBe("1");
    // The file is held back: while a bill is blocked the main button is "Fix 1 bill", and there is no Tally download at all.
    await expect(page.getByRole("button", { name: "Download Tally File" })).toHaveCount(0);
    await page.getByRole("button", { name: "Fix 1 bill" }).click();
    await expect(page.getByText("BS-77").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Download Tally File" })).toHaveCount(0);
  });
});

test.describe("Bills → Tally: fixing a blocked bill", () => {
  test("correcting the total releases the Tally file, which then balances", async ({ page }) => {
    await signedUpAccount(page, "bt-fix", "Bills Fix Client");
    await openJob(page, "bills-tally", "Bills → Tally");
    await upload(page, "purchases-oct-2026.csv", PURCHASE_LIST_WITH_ERROR);
    expect(await stat(page, /^needs? a fix$/)).toBe("1");

    // BS-77 says ₹25,000 but 20,000 + IGST 3,600 is 23,600.
    await page.getByRole("button", { name: "Fix 1 bill" }).click();
    const bill = page.locator("div.px-4.py-3").filter({ hasText: "BS-77" });
    await bill.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Invoice total").fill("23600");
    await page.getByRole("button", { name: "Save and check again" }).click();
    expect(await stat(page, "ready for Tally")).toBe("2");
    await expect(page.getByRole("button", { name: "Fix 1 bill" })).toHaveCount(0);

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Tally File" }).click()]);
    const vouchers = parseVouchers((await savedDownload(download)).bytes.toString("utf8")).filter(voucher => voucher.type === "Purchase");
    expect(vouchers).toHaveLength(2);
    expect(unbalancedVouchers(vouchers)).toEqual([]);
    const beta = vouchers.find(voucher => voucher.reference === "BS-77")!;
    expect(beta.entries.find(entry => entry.ledger === "Beta Supplies")?.paise).toBe(2360000);
  });

  test("leaving a blocked bill out also releases the file, with only the good bill in it", async ({ page }) => {
    await signedUpAccount(page, "bt-leave", "Bills Leave Client");
    await openJob(page, "bills-tally", "Bills → Tally");
    await upload(page, "purchases-oct-2026.csv", PURCHASE_LIST_WITH_ERROR);
    await page.getByRole("button", { name: "Fix 1 bill" }).click();
    const bill = page.locator("div.px-4.py-3").filter({ hasText: "BS-77" });
    await bill.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Leave this bill out").check();
    await page.getByRole("button", { name: "Save and check again" }).click();
    expect(await stat(page, "left out")).toBe("1");

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Tally File" }).click()]);
    const vouchers = parseVouchers((await savedDownload(download)).bytes.toString("utf8")).filter(voucher => voucher.type === "Purchase");
    expect(vouchers.map(voucher => voucher.reference)).toEqual(["INV-001"]);
  });
});

test.describe("Payroll", () => {
  // Gross 35,000 + 19,800 + 25,000 = 79,800; PF 1,800 + 1,440 + 1,800 = 5,040; ESI 149; TDS 1,000;
  // net pay 32,000 + 17,511 + 23,000 = 72,511. Meena has PF deducted but no UAN.
  test("reads the salary register and checks every employee", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "pr-main", "Payroll Client");
    await openJob(page, "payroll", "Payroll");
    await upload(page, "salary-oct-2026.csv", SALARY_SHEET);

    await expect(page.getByText("Sunrise Traders Pvt Ltd · October 2026")).toBeVisible();
    expect(await stat(page, /^employees?$/)).toBe("3");
    await expect(page.getByText("₹72,511").first()).toBeVisible();
    await expect(page.getByText("Gross ₹79,800 · PF ₹5,040 · ESI ₹149 · TDS ₹1,000")).toBeVisible();
    expect(await stat(page, /^needs? a look$/)).toBe("1");
    await expect(page.getByText("PF is deducted but there is no UAN. The PF return needs it.").filter({ visible: true }).first()).toBeVisible();
    for (const row of [/Anita Rao.*₹35,000.*₹3,000.*₹32,000/, /Ravi Kumar.*₹19,800.*₹2,289.*₹17,511/, /Meena Joshi.*₹25,000.*₹2,000.*₹23,000/]) {
      await expect(page.getByRole("row", { name: row })).toBeVisible();
    }
    seen.expectNone();
  });

  test("the register workbook lists each employee with exact figures", async ({ page }) => {
    await signedUpAccount(page, "pr-xlsx", "Payroll Excel Client");
    await openJob(page, "payroll", "Payroll");
    await upload(page, "salary-oct-2026.csv", SALARY_SHEET);
    await expect(page.getByText("Sunrise Traders Pvt Ltd · October 2026")).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Register" }).click()]);
    const sheets = await readWorkbook((await savedDownload(download)).bytes);
    const numbers = sheets.flatMap(sheet => sheet.rows.flat()).filter((cell): cell is number => typeof cell === "number");
    for (const figure of [35000, 19800, 25000, 79800, 32000, 17511, 23000, 72511, 5040]) {
      expect(numbers, `the register should contain ${figure}`).toContain(figure);
    }
  });

  test("the salary entry for Tally is a balanced journal", async ({ page }) => {
    await signedUpAccount(page, "pr-journal", "Payroll Journal Client");
    await openJob(page, "payroll", "Payroll");
    await upload(page, "salary-oct-2026.csv", SALARY_SHEET);
    await expect(page.getByText("Sunrise Traders Pvt Ltd · October 2026")).toBeVisible();

    await page.getByRole("button", { name: "Salary entry for Tally" }).click();
    const downloads: string[] = [];
    page.on("download", async download => downloads.push((await savedDownload(download)).bytes.toString("utf8")));
    const download = page.getByRole("button", { name: /Download.*(Tally|entry|XML)/i }).first();
    await download.click({ timeout: 10000 }).catch(() => {});
    await expect.poll(() => downloads.length, { timeout: 15000 }).toBeGreaterThan(0);
    const vouchers = parseVouchers(downloads.join("\n"));
    expect(vouchers.length).toBeGreaterThan(0);
    expect(unbalancedVouchers(vouchers)).toEqual([]);
  });
});
