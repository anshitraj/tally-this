import { expect, test, type Page } from "@playwright/test";
import { MAY_ROWS, MAY_STATEMENT } from "./data";
import { parseCsv, parseLedgers, parseVouchers, readWorkbook, savedDownload, unbalancedVouchers } from "./files";
import { signedUpAccount, watchProblems } from "./helpers";

/**
 * Bank Statement → Tally against the real backend, with a statement whose every figure is known. The right answer
 * is worked out here from the rows, not read back from the product.
 */

const paise = (value: number) => Math.round(value * 100);

async function openJob(page: Page) {
  await page.goto("/app/jobs/bank-to-tally");
  await expect(page.getByRole("heading", { name: "Bank Statement → Tally" })).toBeVisible();
}

async function upload(page: Page, name: string, content: string, mimeType = "text/csv") {
  await page.locator("input[type=file]").first().setInputFiles({ name, mimeType, buffer: Buffer.from(content) });
}

/** The statement opens full screen after an upload. "Back to results" returns to the summary and its buttons. */
async function closeViewer(page: Page) {
  const back = page.getByRole("button", { name: "Back to results" });
  if (await back.isVisible()) await back.click();
  await expect(back).toBeHidden();
}

async function confirmTotals(page: Page) {
  await page.getByRole("button", { name: "Check source values" }).first().click();
  await page.getByRole("button", { name: "I checked these totals" }).click();
}

test.describe("Bank Statement → Tally", () => {
  test("reads the bank, the period and the totals of a statement", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "b2t-read", "Reader Client");
    await openJob(page);
    await upload(page, "hdfc-may-2026.csv", MAY_STATEMENT.csv);

    await expect(page.getByText("24 transactions detected")).toBeVisible();
    await expect(page.getByText("HDFC Bank").first()).toBeVisible();
    await expect(page.getByText(/••1234/)).toBeVisible();
    await expect(page.getByText(/May 2026/).first()).toBeVisible();
    // Paise are always shown in full.
    await expect(page.getByText("Money in ₹4,01,412 · Money out ₹1,75,607.20").first()).toBeVisible();
    seen.expectNone();
  });

  test("the Tally file waits for the totals to be checked, then matches every source row to the paise", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "b2t-xml", "XML Client");
    await openJob(page);
    await upload(page, "hdfc-may-2026.csv", MAY_STATEMENT.csv);
    await expect(page.getByText("24 transactions detected")).toBeVisible();
    await closeViewer(page);

    // A sheet has no printed opening balance, so its first row cannot be proved: no file until a person has checked.
    const early = page.waitForEvent("download", { timeout: 2500 }).catch(() => null);
    await page.getByRole("button", { name: "Download Tally XML" }).first().click();
    expect(await early, "a Tally file was offered before the totals were checked").toBeNull();

    await confirmTotals(page);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Tally XML" }).first().click()]);
    const file = await savedDownload(download);
    expect(file.name).toMatch(/\.xml$/);

    const xml = file.bytes.toString("utf8");
    const vouchers = parseVouchers(xml);
    expect(vouchers).toHaveLength(MAY_ROWS.length);
    expect(unbalancedVouchers(vouchers), "every voucher must balance to the paise").toEqual([]);

    // Each source row has exactly one voucher, with the same date, reference and amount on the bank ledger.
    const bank = parseLedgers(xml).find(ledger => ledger.parent === "Bank Accounts")?.name;
    expect(bank).toBe("HDFC Bank");
    const used = new Set<number>();
    for (const row of MAY_ROWS) {
      const yyyymmdd = row.date.split("/").reverse().join("");
      const index = vouchers.findIndex((voucher, position) => !used.has(position) && voucher.date === yyyymmdd && voucher.narration.startsWith(row.narration));
      expect(index, `no voucher for ${row.date} ${row.narration}`).toBeGreaterThanOrEqual(0);
      used.add(index);
      const voucher = vouchers[index];
      // A debit to the bank (money in) is negative in Tally's file, a credit (money out) is positive.
      const expected = paise(row.debit ?? 0) - paise(row.credit ?? 0);
      const bankLine = voucher.entries.find(entry => entry.ledger === bank);
      expect(bankLine?.paise, `${row.date} ${row.narration}`).toBe(expected);
      if (row.ref) expect(voucher.reference).toBe(row.ref);
      expect(voucher.type).toBe(row.credit ? "Receipt" : voucher.type === "Contra" ? "Contra" : "Payment");
    }
    // The money that moved through the bank ledger is exactly what the statement says.
    const net = vouchers.reduce((sum, voucher) => sum - (voucher.entries.find(entry => entry.ledger === bank)?.paise ?? 0), 0);
    expect(net).toBe(MAY_STATEMENT.moneyIn - MAY_STATEMENT.moneyOut);
    seen.expectNone();
  });

  test("Excel and CSV carry every row with the exact amounts and balances", async ({ page }) => {
    await signedUpAccount(page, "b2t-sheet", "Sheet Client");
    await openJob(page);
    await upload(page, "hdfc-may-2026.csv", MAY_STATEMENT.csv);
    await expect(page.getByText("24 transactions detected")).toBeVisible();

    // The statement is open full screen; its Download menu offers Excel and CSV.
    const downloadFromViewer = async (item: RegExp) => {
      await page.getByRole("button", { name: /^Download$/ }).first().click();
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: item }).click()]);
      return savedDownload(download);
    };
    const sheets = await readWorkbook((await downloadFromViewer(/^Excel/)).bytes);
    const statement = sheets.find(sheet => sheet.name === "Statement");
    expect(statement, "a Statement sheet").toBeTruthy();
    const header = statement!.rows.findIndex(row => row[0] === "Transaction Date");
    const body = statement!.rows.slice(header + 1).filter(row => row[0] instanceof Date);
    expect(body).toHaveLength(MAY_ROWS.length);
    // The sheet ends with a totals line that agrees with the statement.
    const totals = statement!.rows.find(row => row[2] === "Total");
    expect(paise(Number(totals![4]))).toBe(MAY_STATEMENT.moneyOut);
    expect(paise(Number(totals![5]))).toBe(MAY_STATEMENT.moneyIn);
    let balance = MAY_STATEMENT.opening;
    body.forEach((row, index) => {
      const source = MAY_ROWS[index];
      balance += paise(source.credit ?? 0) - paise(source.debit ?? 0);
      expect(String(row[2]), `row ${index + 1} narration`).toBe(source.narration);
      expect(row[4] == null ? 0 : paise(Number(row[4])), `row ${index + 1} debit`).toBe(paise(source.debit ?? 0));
      expect(row[5] == null ? 0 : paise(Number(row[5])), `row ${index + 1} credit`).toBe(paise(source.credit ?? 0));
      expect(paise(Number(row[6])), `row ${index + 1} balance`).toBe(balance);
    });
    const opening = statement!.rows.find(row => row[0] === "Opening balance");
    const closing = statement!.rows.find(row => row[0] === "Closing balance");
    expect(paise(Number(opening![2]))).toBe(MAY_STATEMENT.opening);
    expect(paise(Number(closing![2]))).toBe(MAY_STATEMENT.closing);

    const csv = parseCsv((await downloadFromViewer(/^CSV/)).bytes.toString("utf8"));
    expect(csv[0].slice(0, 7)).toEqual(["Date", "Value date", "Narration", "Reference", "Paid", "Received", "Statement balance"]);
    expect(csv).toHaveLength(MAY_ROWS.length + 1);
    csv.slice(1).forEach((row, index) => {
      const source = MAY_ROWS[index];
      expect(row[2]).toBe(source.narration);
      expect(paise(Number(row[4] || 0))).toBe(paise(source.debit ?? 0));
      expect(paise(Number(row[5] || 0))).toBe(paise(source.credit ?? 0));
    });
  });

  test("a running balance that does not continue is flagged and no Tally file is made", async ({ page }) => {
    await signedUpAccount(page, "b2t-break", "Break Client");
    await openJob(page);
    const lines = MAY_STATEMENT.csv.split("\n");
    const cells = lines[5 + 10].split(",");
    cells[5] = (Number(cells[5]) + 500).toFixed(2);
    lines[5 + 10] = cells.join(",");
    await upload(page, "balance-break.csv", lines.join("\n"));

    await expect(page.getByText("24 transactions detected")).toBeVisible();
    await expect(page.getByText(/2 rows do not match the running balance/).first()).toBeVisible();
    await closeViewer(page);
    await confirmTotals(page);
    // Checking the totals does not clear a broken chain: the file is still held back.
    const blocked = page.waitForEvent("download", { timeout: 2500 }).catch(() => null);
    await page.getByRole("button", { name: "Download Tally XML" }).first().click();
    expect(await blocked, "a Tally file was made from a statement whose balance does not continue").toBeNull();
  });

  test("a row with an impossible date stops the whole statement instead of being dropped", async ({ page }) => {
    await signedUpAccount(page, "b2t-date", "Date Client");
    await openJob(page);
    const lines = MAY_STATEMENT.csv.split("\n");
    lines[5 + 4] = lines[5 + 4].replace("05/05/2026", "45/05/2026");
    await upload(page, "bad-date.csv", lines.join("\n"));
    await expect(page.getByText(/The statement cannot be exported: 1 row has an unreadable or invalid date/)).toBeVisible();
    await expect(page.getByText(/transactions detected/)).toHaveCount(0);
  });

  test("a dated row with no amount stops the whole statement", async ({ page }) => {
    await signedUpAccount(page, "b2t-amount", "Amount Client");
    await openJob(page);
    const lines = MAY_STATEMENT.csv.split("\n");
    const cells = lines[5 + 6].split(",");
    cells[3] = "";
    cells[4] = "";
    lines[5 + 6] = cells.join(",");
    await upload(page, "no-amount.csv", lines.join("\n"));
    await expect(page.getByText(/The statement cannot be exported: 1 dated row has no readable paid or received amount/)).toBeVisible();
  });

  test("a file that is not a bank statement is refused with a plain message", async ({ page }) => {
    await signedUpAccount(page, "b2t-wrong", "Wrong File Client");
    await openJob(page);
    await upload(page, "notes.csv", "Name,City\nAnita,Pune\nRahul,Delhi\n");
    await expect(page.getByText(/transactions detected/)).toHaveCount(0);
    await expect(page.getByText(/doesn.t look like a bank statement/)).toBeVisible();
  });

  test("a finished run appears in History and Activity for this client", async ({ page }) => {
    await signedUpAccount(page, "b2t-history", "History Client");
    await openJob(page);
    await upload(page, "hdfc-may-2026.csv", MAY_STATEMENT.csv);
    await expect(page.getByText("24 transactions detected")).toBeVisible();

    await page.goto("/app/history");
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(page.getByText(/Bank → Tally|Bank Statement/).first()).toBeVisible();
    await page.goto("/app/activity");
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  });
});
