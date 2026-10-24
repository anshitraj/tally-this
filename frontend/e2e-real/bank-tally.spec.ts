import { expect, test, type Page } from "@playwright/test";
import { EXTRA_IN_TALLY, MAY_ROWS, MAY_STATEMENT, MISSING_FROM_TALLY, mayTallyRows, tallyCsv } from "./data";
import { parseCsv, savedDownload } from "./files";
import { signedUpAccount, watchProblems } from "./helpers";

/**
 * Bank ↔ Tally against the real backend. The Tally file is the bank statement's own rows minus three the books are
 * missing, plus one the bank never saw, so the right answer is known before the product is asked:
 *
 *   - 19 rows have a reference on both sides, the same amount, the same day: confirmed matches;
 *   - 2 rows (bank interest and an SMS charge) match in amount and date but have no reference to prove it: they are
 *     only suggestions, never confirmed on a unique amount and date alone;
 *   - 3 rows are in the bank but not in Tally; 1 row is in Tally but not in the bank.
 */

const missing = MISSING_FROM_TALLY.map(index => MAY_ROWS[index]);
const withoutReference = MAY_ROWS.filter(row => !row.ref);
const CONFIRMED = MAY_ROWS.length - missing.length - withoutReference.length; // 19
const ATTENTION = missing.length + withoutReference.length + 1; // 6

async function openJob(page: Page) {
  await page.goto("/app/jobs/bank-tally");
  await expect(page.getByRole("heading", { name: "Bank ↔ Tally" })).toBeVisible();
}

async function uploadBoth(page: Page, bankCsv: string, tally: string) {
  const inputs = page.locator("input[type=file]");
  await inputs.nth(0).setInputFiles({ name: "bank-may-2026.csv", mimeType: "text/csv", buffer: Buffer.from(bankCsv) });
  await inputs.nth(1).setInputFiles({ name: "tally-daybook-may-2026.csv", mimeType: "text/csv", buffer: Buffer.from(tally) });
}

const stat = (page: Page, label: string) => page.getByText(label, { exact: true }).locator("xpath=preceding-sibling::*[1]");

async function reportRows(page: Page) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Report" }).first().click()]);
  const rows = parseCsv((await savedDownload(download)).bytes.toString("utf8"));
  expect(rows[0]).toEqual(["Result", "Decision", "Bank date", "Bank narration", "Bank amount", "Tally date", "Tally ledger", "Tally amount", "Why"]);
  return rows.slice(1).map(row => ({ result: row[0], decision: row[1], bankDate: row[2], bank: row[3], bankAmount: row[4], tallyDate: row[5], tally: row[6], tallyAmount: row[7], why: row[8] }));
}

test.describe("Bank ↔ Tally", () => {
  test("shows how many matched and how many need a person, with the right ones in the review", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "bt-main", "Compare Client");
    await openJob(page);
    await uploadBoth(page, MAY_STATEMENT.csv, tallyCsv(mayTallyRows()));

    await expect(stat(page, "matched")).toHaveText(String(CONFIRMED));
    await expect(stat(page, "need attention")).toHaveText(String(ATTENTION));
    await page.getByRole("button", { name: `Review ${ATTENTION} items` }).click();
    const review = page.getByText("Review", { exact: true }).locator("xpath=ancestor::section[1]");
    for (const row of [...missing, ...withoutReference]) {
      await expect(review.getByText(row.narration).first(), row.narration).toBeVisible();
    }
    await expect(review.getByText(EXTRA_IN_TALLY.particulars).first()).toBeVisible();
    seen.expectNone();
  });

  test("the report puts every row in exactly one place", async ({ page }) => {
    await signedUpAccount(page, "bt-report", "Report Client");
    await openJob(page);
    await uploadBoth(page, MAY_STATEMENT.csv, tallyCsv(mayTallyRows()));
    await expect(stat(page, "matched")).toHaveText(String(CONFIRMED));

    const rows = await reportRows(page);
    const matched = rows.filter(row => row.decision === "Matched");
    const bankOnly = rows.filter(row => row.bank !== "" && row.tally === "");
    const tallyOnly = rows.filter(row => row.bank === "" && row.tally !== "");
    const suggested = rows.filter(row => row.bank !== "" && row.tally !== "" && row.decision !== "Matched");

    expect(matched).toHaveLength(CONFIRMED);
    expect(bankOnly.map(row => row.bank).sort()).toEqual(missing.map(row => row.narration).sort());
    expect(tallyOnly.map(row => row.tally)).toEqual([EXTRA_IN_TALLY.particulars]);
    expect(suggested.map(row => row.bank).sort()).toEqual(withoutReference.map(row => row.narration).sort());

    // Every bank row and every Tally row appears exactly once, none twice, none dropped.
    expect(rows.filter(row => row.bank !== "")).toHaveLength(MAY_ROWS.length);
    expect(rows.filter(row => row.tally !== "")).toHaveLength(mayTallyRows().length);
    // A matched pair agrees on the amount to the paise.
    for (const row of matched) expect(Math.round(Number(row.bankAmount) * 100), row.bank).toBe(Math.round(Number(row.tallyAmount) * 100));
  });

  test("a decision made in the review is kept in the report", async ({ page }) => {
    await signedUpAccount(page, "bt-decide", "Decide Client");
    await openJob(page);
    await uploadBoth(page, MAY_STATEMENT.csv, tallyCsv(mayTallyRows()));
    await expect(stat(page, "need attention")).toHaveText(String(ATTENTION));
    await page.getByRole("button", { name: `Review ${ATTENTION} items` }).click();

    // Settle the one row that exists only in Tally.
    const card = page.locator("div.space-y-3").filter({ hasText: EXTRA_IN_TALLY.particulars }).first();
    await card.getByRole("button", { name: "Ask client" }).click();
    await expect(page.getByText(`1 of ${ATTENTION} reviewed.`)).toBeVisible();

    const rows = await reportRows(page);
    expect(rows.find(row => row.tally === EXTRA_IN_TALLY.particulars)?.decision).toBe("Ask client");
  });

  test("files with nothing in common produce no confirmed match", async ({ page }) => {
    await signedUpAccount(page, "bt-none", "Nothing Client");
    await openJob(page);
    const unrelated = tallyCsv([
      { date: "03/05/2026", particulars: "Someone Else", type: "Payment", number: "PMT-1", debit: 1111.11, narration: "unrelated" },
      { date: "09/05/2026", particulars: "Another Party", type: "Receipt", number: "RCP-2", credit: 2222.22, narration: "unrelated" },
    ]);
    await uploadBoth(page, MAY_STATEMENT.csv, unrelated);
    await expect(stat(page, "matched")).toHaveText("0");
    await expect(stat(page, "need attention")).toHaveText(String(MAY_ROWS.length + 2));
  });

  test("the same amount on the same day, with no shared reference, is only a suggestion", async ({ page }) => {
    await signedUpAccount(page, "bt-suggest", "Suggest Client");
    await openJob(page);
    // One Tally entry with the amount and day of the ACME payment but a different party and no reference.
    const tally = tallyCsv([{ date: "01/05/2026", particulars: "Different Vendor", type: "Payment", number: "PMT-X", debit: 5000, narration: "misc" }]);
    await uploadBoth(page, MAY_STATEMENT.csv, tally);
    await expect(stat(page, "matched")).toHaveText("0");
    await expect(stat(page, "need attention")).toHaveText(String(MAY_ROWS.length));
  });
});
