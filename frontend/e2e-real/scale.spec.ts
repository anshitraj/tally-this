import { expect, test, type APIRequestContext } from "@playwright/test";
import { hdfcStatement, type BankRow } from "./data";
import { parseCsv, readWorkbook, savedDownload } from "./files";
import { PASSWORD, signedUpAccount, uniqueEmail } from "./helpers";

/**
 * Size and simultaneous use, against the real backend: a long statement, and several people reading different
 * statements at the same moment must each get their own answer.
 */

function manyRows(count: number, seed = 1): BankRow[] {
  const rows: BankRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const day = String((index % 28) + 1).padStart(2, "0");
    const month = String(((Math.floor(index / 28) + seed) % 12) + 1).padStart(2, "0");
    const amount = ((index * 37 + seed * 11) % 9000) + 100 + ((index % 100) / 100);
    rows.push(index % 3 === 0
      ? { date: `${day}/${month}/2026`, narration: `NEFT CR-Customer ${index}/INV-${seed}-${index}`, ref: `UTR${seed}${String(index).padStart(7, "0")}`, credit: amount }
      : { date: `${day}/${month}/2026`, narration: `UPI-Vendor ${index}/BILL-${seed}-${index}`, ref: `UTR${seed}${String(index).padStart(7, "0")}`, debit: amount });
  }
  // The statement must run oldest to newest for its balance to follow.
  return rows.sort((a, b) => a.date.split("/").reverse().join("").localeCompare(b.date.split("/").reverse().join("")));
}

test("a statement of 5,000 rows is read, shown and exported in reasonable time with every row intact", async ({ page }) => {
  test.setTimeout(180_000);
  const rows = manyRows(5000);
  const statement = hdfcStatement(250000, rows, "FY 2026");
  await signedUpAccount(page, "scale-big", "Big Client");
  await page.goto("/app/jobs/bank-to-tally");
  const started = Date.now();
  await page.locator("input[type=file]").first().setInputFiles({ name: "big.csv", mimeType: "text/csv", buffer: Buffer.from(statement.csv) });
  await expect(page.getByText("5000 transactions detected")).toBeVisible({ timeout: 90_000 });
  const seconds = (Date.now() - started) / 1000;
  expect(seconds, `reading 5,000 rows took ${seconds}s`).toBeLessThan(60);

  // The Excel and CSV carry every row.
  await page.getByRole("button", { name: /^Download$/ }).first().click();
  const [csvDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /^CSV/ }).click()]);
  const csv = parseCsv((await savedDownload(csvDownload)).bytes.toString("utf8"));
  expect(csv.length - 1).toBe(5000);
  await page.getByRole("button", { name: /^Download$/ }).first().click();
  const [excelDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /^Excel/ }).click()]);
  const sheets = await readWorkbook((await savedDownload(excelDownload)).bytes);
  const body = sheets.find(sheet => sheet.name === "Statement")!.rows.filter(row => row[0] instanceof Date);
  expect(body).toHaveLength(5000);
  // The totals line adds up to the statement, to the paise.
  const totals = sheets.find(sheet => sheet.name === "Statement")!.rows.find(row => row[2] === "Total")!;
  expect(Math.round(Number(totals[4]) * 100)).toBe(statement.moneyOut);
  expect(Math.round(Number(totals[5]) * 100)).toBe(statement.moneyIn);
});

test("people reading different statements at the same moment each get their own answer", async ({ playwright }) => {
  test.setTimeout(180_000);
  const people = 6;
  const contexts: APIRequestContext[] = [];
  const results = await Promise.all(
    Array.from({ length: people }, async (_, index) => {
      const request = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${process.env.STACK_WEB_PORT || "14173"}` });
      contexts.push(request);
      const email = uniqueEmail(`parallel-${index}`);
      const registered = await request.post("/api/auth/register", { data: { name: `Person ${index}`, email, password: PASSWORD, companyName: `Parallel ${index} Co` } });
      expect(registered.status()).toBe(201);
      const token = (await registered.json()).token as string;
      // Each person's statement has a different number of rows, so a mix-up cannot go unseen.
      const count = 40 + index * 25;
      const statement = hdfcStatement(100000, manyRows(count, index + 1));
      const response = await request.post("/api/jobs/bank-statement/normalize", {
        headers: { Authorization: `Bearer ${token}` },
        multipart: { file: { name: `statement-${index}.csv`, mimeType: "text/csv", buffer: Buffer.from(statement.csv) } },
      });
      return { index, count, status: response.status(), body: await response.json(), moneyIn: statement.moneyIn / 100, moneyOut: statement.moneyOut / 100 };
    }),
  );
  for (const result of results) {
    expect(result.status, `person ${result.index}`).toBe(200);
    const summary = result.body.summary ?? result.body;
    const text = JSON.stringify(result.body);
    expect(text, `person ${result.index} got another person's statement`).toContain(`statement-${result.index}.csv`);
    for (const other of results.filter(item => item.index !== result.index)) expect(text).not.toContain(`statement-${other.index}.csv`);
    expect(Number(summary.transactions?.length ?? summary.count ?? result.body.count)).toBe(result.count);
  }
  await Promise.all(contexts.map(context => context.dispose()));
});
