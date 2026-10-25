import { expect, test } from "@playwright/test";
import { MAY_ROWS, MAY_STATEMENT } from "./data";
import { api, signedUpAccount, watchProblems } from "./helpers";
import type { Page } from "@playwright/test";

/** The rows saved for the client that is open (the page sends the client with every call; a bare call would ask about the firm). */
async function savedTransactions(page: Page) {
  const clients = await api(page, "GET", "/api/practice/clients?light=1");
  const clientId = clients.json.clients[0].companyId as number;
  const response = await api(page, "GET", "/api/transactions", { headers: { "X-Client-Company-Id": String(clientId) } });
  expect(response.status).toBe(200);
  return (Array.isArray(response.json) ? response.json : response.json.transactions ?? []) as unknown[];
}

/**
 * The older Upload Center (under Advanced): a file goes in, is read, and its rows reach the Bank Transactions page.
 */

test.describe("Upload Center", () => {
  test("a bank statement is read, listed, and its rows reach Bank Transactions", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "upc", "Upload Client");
    await page.goto("/app/uploads");
    await page.locator("input[type=file]").first().setInputFiles({ name: "hdfc-may-2026.csv", mimeType: "text/csv", buffer: Buffer.from(MAY_STATEMENT.csv) });

    await expect(page.getByText(/^Uploaded successfully to Bank Statement folder/)).toBeVisible();
    await expect(page.getByText("24 rows").first()).toBeVisible();
    // Without a reload, the panels beside it know about the file (they used to keep saying "nothing yet"; the file went in
    // while the panel's own first request was still loading, which e2e/upload-refresh.spec.ts pins down exactly).
    await expect(page.getByText("Bank Statement not uploaded or not parsed yet.")).toHaveCount(0);
    await expect(page.getByText("Parsed upload", { exact: true }).first()).toBeVisible();

    expect(await savedTransactions(page)).toHaveLength(MAY_ROWS.length);
    await page.goto("/app/transactions");
    await expect(page.getByText("UPI-ACME Corp/INV-100/YESB0001234")).toBeVisible();
    seen.expectNone();
  });

  test("removing an upload asks twice when its rows were already imported, then takes them out, and keeps the audit trail", async ({ page }) => {
    await signedUpAccount(page, "upc-remove", "Upload Remove Client");
    await page.goto("/app/uploads");
    await page.locator("input[type=file]").first().setInputFiles({ name: "to-remove.csv", mimeType: "text/csv", buffer: Buffer.from(MAY_STATEMENT.csv) });
    await expect(page.getByText(/^Uploaded successfully to Bank Statement folder/)).toBeVisible();
    expect(await savedTransactions(page)).toHaveLength(MAY_ROWS.length);

    await page.getByRole("button", { name: "Remove", exact: true }).first().click();
    await expect(page.getByText("Remove from active uploads?")).toBeVisible();
    await page.getByRole("button", { name: "Remove", exact: true }).last().click();
    // The 24 imported rows are not deleted without a second, explicit yes.
    await expect(page.getByText("Records already imported — cascade delete?")).toBeVisible();
    expect(await savedTransactions(page)).toHaveLength(MAY_ROWS.length);
    await page.getByRole("button", { name: /Yes, delete upload \+ imported rows/ }).click();

    await expect(page.getByText("No active files. Upload any finance file to begin.")).toBeVisible();
    expect(await savedTransactions(page)).toHaveLength(0);
    // The upload history still lists the file.
    await expect(page.getByText("to-remove.csv").first()).toBeVisible();
  });
});
