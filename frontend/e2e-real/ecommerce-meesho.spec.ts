import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { readWorkbook, savedDownload } from "./files";
import { api, settledText, signedUpAccount, watchProblems } from "./helpers";

/**
 * The Meesho workspace against the real backend: upload, background import, figures, review, approval, downloads,
 * repeated and overlapping imports, column choice and who may see what.
 *
 * The files are made here from synthetic rows (no real seller's data). Seller 07ABCDE1234F1Z2 is in Delhi.
 * August 2026, worked out by hand:
 *   sales     2001_1 Delhi 1,000.00 tax 50.00 | 2002_1 Karnataka 952.38 tax 47.62 (2 units) | 2003_1 Maharashtra 500.00
 *             tax 25.00 | 2004_1 Delhi 200.00 tax 10.00, NO HSN | 2005_1 Delhi 400.00 tax 25.00 (5% of 400 is 20.00)
 *             taxable 3,052.38, tax 157.62
 *   returns   2002_1 one of two units, 476.19 tax 23.81 (matches its August sale) | 1500_1 300.00 tax 15.00, sold in July,
 *             which was never imported (no sale to match)
 *             taxable 776.19
 *   net       taxable 2,276.19
 *   needs a person: the missing HSN (error), the 5.00 tax difference (warning), the return without its sale (warning) = 3
 */

const requireFromApi = createRequire(new URL("../../backend/api/package.json", import.meta.url));
const XLSX = requireFromApi("xlsx") as typeof import("xlsx");

const SELLER = "07ABCDE1234F1Z2";
const ECO = "07AAACT2727Q1ZY";
const HEAD = ["identifier", "sup_name", "gstin", "sub_order_num", "order_date", "hsn_code", "quantity", "gst_rate", "total_taxable_sale_value", "tax_amount", "total_invoice_value", "taxable_shipping", "end_customer_state_new", "eco_tcs_gstin", "financial_year", "month_number", "supplier_id"];
const RETURN_HEAD = [...HEAD.slice(0, 5), "cancel_return_date", ...HEAD.slice(5)];

function sale(sub: string, date: string, hsn: string, qty: string, taxable: string, tax: string, invoice: string, state: string, month: string) {
  return ["x1", "Synthetic Traders", SELLER, sub, date, hsn, qty, "5", taxable, tax, invoice, "0", state, ECO, "2026", month, "40001"];
}
function ret(sub: string, orderDate: string, returnDate: string, taxable: string, tax: string, invoice: string, state: string, month: string) {
  const row = sale(sub, orderDate, "610910", "1", taxable, tax, invoice, state, month);
  return [...row.slice(0, 5), returnDate, ...row.slice(5)];
}

function xlsxFile(name: string, rows: string[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return { name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer };
}

const AUGUST_SALES = [
  sale("2001_1", "2026-08-03", "610910", "1", "1000.00", "50.00", "1050.00", "Delhi", "8"),
  sale("2002_1", "2026-08-05", "620462", "2", "952.38", "47.62", "1000.00", "Karnataka", "8"),
  sale("2003_1", "2026-08-07", "610910", "1", "500.00", "25.00", "525.00", "Maharashtra", "8"),
  sale("2004_1", "2026-08-09", "", "1", "200.00", "10.00", "210.00", "Delhi", "8"),
  sale("2005_1", "2026-08-11", "610910", "1", "400.00", "25.00", "425.00", "Delhi", "8"),
];
const salesFile = () => xlsxFile("tcs_sales.xlsx", [HEAD, ...AUGUST_SALES]);
const returnsFile = () => xlsxFile("tcs_sales_return.xlsx", [RETURN_HEAD,
  ret("2002_1", "2026-08-05", "2026-08-20", "476.19", "23.81", "500.00", "Karnataka", "8"),
  ret("1500_1", "2026-07-25", "2026-08-22", "300.00", "15.00", "315.00", "Delhi", "8"),
]);
/** September, with one August row repeated exactly (as a two-month download would have it). */
const septemberFile = () => xlsxFile("tcs_sales_sep.xlsx", [HEAD,
  AUGUST_SALES[0],
  sale("3001_1", "2026-09-02", "610910", "1", "800.00", "40.00", "840.00", "Delhi", "9"),
]);

async function openWorkspace(page: Page) {
  await page.goto("/app/ecommerce");
  await expect(page.getByRole("heading", { name: "E-commerce", exact: true })).toBeVisible();
  await page.getByTestId("marketplace-meesho").getByRole("button", { name: /Meesho/ }).click();
  await expect(page).toHaveURL(/\/app\/ecommerce\/meesho/);
}

async function upload(page: Page, files: Array<ReturnType<typeof xlsxFile>>, month = "2026-08") {
  await page.getByRole("button", { name: /Upload (Meesho )?reports/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Upload Meesho reports" })).toBeVisible();
  await dialog.locator("input[type=file]").setInputFiles(files);
  await dialog.locator("input[type=month]").fill(month);
  await dialog.getByPlaceholder("Read from the reports").fill(SELLER);
  await dialog.getByRole("button", { name: /^Import \d+ files?$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("import-progress").getByText("Import finished")).toBeVisible({ timeout: 60_000 });
  return (await page.getByTestId("import-summary").textContent()) ?? "";
}

/** The API as the page calls it: on the client chosen in the app (sign-up makes one and selects it). */
async function call(page: Page, method: "GET" | "POST", path: string, body?: unknown) {
  const client = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("finverify_active_client") || "{}").id as number | undefined;
    } catch {
      return undefined;
    }
  });
  return api(page, method, path, { body, headers: client ? { "X-Client-Company-Id": String(client) } : {} });
}

const kpi = (page: Page, label: string) => settledText(page.getByText(label, { exact: true }).locator("xpath=following-sibling::*[1]"));

test.describe("Meesho workspace", () => {
  test("import, review, approve and download a month; repeats and overlaps are not counted twice", async ({ page }) => {
    const problems = watchProblems(page);
    await signedUpAccount(page, "meesho");
    await openWorkspace(page);

    // Every other marketplace is listed honestly: coming soon, nothing to press, never "connected".
    await page.goto("/app/ecommerce");
    await expect(page.getByTestId("marketplace-amazon").getByText("Coming soon").first()).toBeVisible();
    await expect(page.getByTestId("marketplace-amazon").getByRole("button", { name: "Coming soon" })).toBeDisabled();
    await expect(page.getByText(/connected/i).filter({ hasNotText: /not connected/i })).toHaveCount(0);
    await openWorkspace(page);
    await expect(page.getByRole("heading", { name: "Connect your Meesho reports" })).toBeVisible();

    const summary = await upload(page, [salesFile(), returnsFile()]);
    expect(summary).toContain("7 transactions imported");
    expect(summary).toContain("Aug 2026");

    await expect(page.getByRole("tab", { name: /Overview/ })).toBeVisible();
    expect(await kpi(page, "Sales (taxable)")).toBe("₹3,052");
    expect(await kpi(page, "Returns & credit notes")).toBe("₹776");
    expect(await kpi(page, "Net taxable value")).toBe("₹2,276");
    expect(await kpi(page, "Need attention")).toBe("3");
    await expect(page.getByText("3 items need attention")).toBeVisible();

    // The figures behind the screen, to the paisa.
    const s = await call(page, "GET", "/api/ecommerce/meesho/summary?period=2026-08");
    expect(s.status).toBe(200);
    expect(s.json.overview.sales.taxable).toBe(305238);
    expect(s.json.overview.sales.tax).toBe(15762);
    expect(s.json.overview.returns.taxable).toBe(77619);
    expect(s.json.overview.net.taxable).toBe(227619);
    // Delhi is intra-State (CGST + SGST); Karnataka and Maharashtra are inter-State (IGST).
    expect(s.json.overview.sales.igst).toBe(4762 + 2500);
    expect(s.json.overview.sales.cgst + s.json.overview.sales.sgst).toBe(5000 + 1000 + 2500);

    // A month with open items cannot be approved, on screen or by asking the server directly.
    const early = await call(page, "POST", "/api/ecommerce/meesho/report/approve", { period: "2026-08" });
    expect(early.status).toBe(409);
    await page.getByRole("tab", { name: "Reports" }).click();
    await expect(page.getByTestId("report-status-text")).toContainText("3 item(s) still need review");
    await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);

    // Review: open each item, decide with a note.
    await page.getByRole("tab", { name: /Reconciliation/ }).click();
    const items = page.getByRole("list", { name: "Review items" }).getByRole("listitem");
    await expect(items).toHaveCount(3);
    for (const [kind, action] of [["Tax differs from rate", "Accept"], ["HSN missing", "Resolve"], ["Return without its sale", "Accept"]] as const) {
      await items.filter({ hasText: kind }).getByRole("button", { name: action, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Note").fill(`${kind}: checked with the client`);
      await dialog.getByRole("button", { name: action === "Accept" ? "Accept this item" : "Mark as resolved" }).click();
      await expect(dialog).toBeHidden();
      await expect(items.filter({ hasText: kind })).toHaveCount(0);
    }
    await expect(page.getByText("Nothing needs review")).toBeVisible();

    await page.getByRole("tab", { name: "Reports" }).click();
    await expect(page.getByTestId("report-status-text")).toContainText("Nothing needs review");
    await page.getByRole("button", { name: "Approve Aug 2026" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("report-status-text")).toContainText("Approved by");

    // The working papers: ten sheets, frozen headers, every source row traceable.
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Excel working papers/ }).click()]);
    const file = await savedDownload(download);
    expect(file.name).toBe("Meesho-2026-08-reconciliation.xlsx");
    const sheets = await readWorkbook(file.bytes);
    expect(sheets.map(sheet => sheet.name)).toEqual(["Summary", "Raw Transactions", "Normalized Sales", "Sales Returns", "HSN-wise Summary", "State-wise GST", "GSTR-1 Working", "Exceptions", "Reconciliation Audit", "Source Metadata"]);
    const sales = sheets.find(sheet => sheet.name === "Normalized Sales")!;
    expect(sales.rows.length - 1).toBe(5);
    const summarySheet = sheets.find(sheet => sheet.name === "Summary")!;
    expect(summarySheet.rows.some(row => row[0] === "Report status" && String(row[1]).startsWith("Approved"))).toBe(true);

    // The same two files again: read as already imported, nothing counted twice, the approval still stands.
    await page.getByRole("tab", { name: "Overview" }).click();
    const again = await upload(page, [salesFile(), returnsFile()]);
    expect(again).toContain("0 transactions imported");
    const after = await call(page, "GET", "/api/ecommerce/meesho/summary?period=2026-08");
    expect(after.json.overview.sales.taxable).toBe(305238);
    const report = await call(page, "GET", "/api/ecommerce/meesho/report?period=2026-08");
    expect(report.json.state.status).toBe("approved");

    // A September file that repeats one August row: September counts once, August does not change.
    const overlap = await upload(page, [septemberFile()], "2026-09");
    expect(overlap).toContain("1 transaction imported");
    expect(overlap).toContain("1 already imported and not counted again");
    const aug = await call(page, "GET", "/api/ecommerce/meesho/summary?period=2026-08");
    expect(aug.json.overview.sales.taxable).toBe(305238);
    expect((await call(page, "GET", "/api/ecommerce/meesho/report?period=2026-08")).json.state.status).toBe("approved");
    const sep = await call(page, "GET", "/api/ecommerce/meesho/summary?period=2026-09");
    expect(sep.json.overview.sales.taxable).toBe(80000);

    // Transactions: search on the server, and the side panel shows the row exactly as imported.
    await page.getByLabel("Month", { exact: true }).selectOption("2026-08");
    await page.getByRole("tab", { name: "Transactions" }).click();
    await page.getByLabel("Search transactions").fill("2005_1");
    await expect(page.getByText("1 transaction", { exact: true })).toBeVisible();
    await page.getByRole("row", { name: /Open transaction 2005_1/ }).click();
    const panel = page.getByRole("dialog");
    await expect(panel.getByText("Tax differs from rate", { exact: true })).toBeVisible();
    await panel.getByText("Source row as imported").click();
    await expect(panel.getByText("total_taxable_sale_value")).toBeVisible();
    await expect(panel.getByText("Item accepted")).toBeVisible();
    await expect(panel.getByText("Tax differs from rate: checked with the client").first()).toBeVisible();

    problems.expectNone();
  });

  test("a file with an unfamiliar column waits for the column to be chosen", async ({ page }) => {
    await signedUpAccount(page, "meesho-map");
    await openWorkspace(page);
    const renamed = HEAD.map(h => (h === "end_customer_state_new" ? "Buyer region" : h));
    const file = xlsxFile("tcs_sales.xlsx", [renamed, AUGUST_SALES[0], AUGUST_SALES[2]]);
    await page.getByRole("button", { name: /Upload Meesho reports/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("input[type=file]").setInputFiles([file]);
    await dialog.locator("input[type=month]").fill("2026-08");
    await dialog.getByRole("button", { name: "Import 1 file" }).click();
    const progress = page.getByTestId("import-progress");
    await expect(progress.getByText("Some columns need choosing")).toBeVisible({ timeout: 60_000 });
    await progress.getByRole("button", { name: "Choose columns" }).click();
    const mapping = page.getByRole("dialog");
    await mapping.getByLabel("Customer state").selectOption("Buyer region");
    await mapping.getByRole("button", { name: "Import with these columns" }).click();
    await expect(progress.getByText("Import finished")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("import-summary")).toContainText("2 transactions imported");
    const s = await call(page, "GET", "/api/ecommerce/meesho/summary?period=2026-08");
    expect(s.json.overview.sales.taxable).toBe(150000);
    expect(s.json.overview.sales.igst).toBe(2500); // Maharashtra
  });

  test("a later file with other figures for the same sale is held back until a reviewer chooses; one note can accept many", async ({ page }) => {
    await signedUpAccount(page, "meesho-conflict");
    await openWorkspace(page);
    await upload(page, [xlsxFile("tcs_sales.xlsx", [HEAD, AUGUST_SALES[0], AUGUST_SALES[2]])]);
    // The same sale of sub-order 2003_1 again, now at 510.00 instead of 500.00 (a corrected download, or a typo).
    const corrected = sale("2003_1", "2026-08-07", "610910", "1", "510.00", "25.50", "535.50", "Maharashtra", "8");
    const held = await upload(page, [xlsxFile("tcs_sales_corrected.xlsx", [HEAD, corrected])]);
    expect(held).toContain("0 transactions imported");
    expect(held).toContain("1 held back");
    expect((await call(page, "GET", "/api/ecommerce/meesho/summary?period=2026-08")).json.overview.sales.taxable).toBe(150000);
    expect((await call(page, "GET", "/api/ecommerce/meesho/report?period=2026-08")).json.state.status).toBe("needs_review");

    await page.getByRole("tab", { name: "Transactions" }).click();
    await page.getByLabel("Status", { exact: true }).selectOption("conflict");
    await expect(page.getByText("1 transaction", { exact: true })).toBeVisible();
    await page.getByRole("row", { name: /Open transaction 2003_1/ }).click();
    const panel = page.getByRole("dialog");
    await expect(panel.getByRole("heading", { name: "Which figures are right?" })).toBeVisible();
    await panel.getByLabel("Review note").fill("Client confirmed the corrected invoice value");
    await panel.getByRole("button", { name: "Count this row instead" }).click();
    await expect(panel.getByText("These figures counted instead")).toBeVisible();
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toBeHidden();
    const after = await call(page, "GET", "/api/ecommerce/meesho/summary?period=2026-08");
    expect(after.json.overview.sales.taxable).toBe(151000);
    expect(after.json.overview.sales.count).toBe(2);
    expect((await call(page, "GET", "/api/ecommerce/meesho/report?period=2026-08")).json.state.status).toBe("reconciled");

    // Two returns of July sales that were never imported: one decision with one note covers both.
    await upload(page, [xlsxFile("tcs_sales_return.xlsx", [RETURN_HEAD,
      ret("1500_1", "2026-07-25", "2026-08-22", "300.00", "15.00", "315.00", "Delhi", "8"),
      ret("1501_1", "2026-07-26", "2026-08-23", "200.00", "10.00", "210.00", "Delhi", "8"),
    ])]);
    await page.getByRole("tab", { name: /Reconciliation/ }).click();
    await page.getByRole("button", { name: /Return without its sale/ }).click();
    await page.getByRole("button", { name: "Accept all 2" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Note for all").fill("July sales were filed in July's return");
    await dialog.getByRole("button", { name: "Accept all 2" }).click();
    await expect(page.getByText("Nothing needs review")).toBeVisible();
    const done = await call(page, "GET", "/api/ecommerce/meesho/report?period=2026-08");
    expect(done.json.state.status).toBe("reconciled");
    expect((await call(page, "GET", "/api/ecommerce/meesho/summary?period=2026-08")).json.overview.net.taxable).toBe(151000 - 50000);
  });

  test("another workspace cannot read or change these books, and signed-out requests are refused", async ({ page, browser }) => {
    await signedUpAccount(page, "meesho-owner");
    const me = await api(page, "GET", "/api/auth/me");
    const ownerCompany = String(me.json.company.id);

    const other = await browser.newPage();
    await signedUpAccount(other, "meesho-other");
    for (const path of ["/api/ecommerce/meesho/workspace", "/api/ecommerce/meesho/transactions?period=2026-08", "/api/ecommerce/meesho/export?period=2026-08&format=xlsx"]) {
      const answer = await api(other, "GET", path, { headers: { "X-Client-Company-Id": ownerCompany } });
      expect(answer.status, path).toBe(403);
    }
    const approve = await api(other, "POST", "/api/ecommerce/meesho/report/approve", { body: { period: "2026-08" }, headers: { "X-Client-Company-Id": ownerCompany } });
    expect(approve.status).toBe(403);
    await other.close();

    const anonymous = await page.request.get("/api/ecommerce/meesho/workspace");
    expect(anonymous.status()).toBe(401);
    const unknown = await call(page, "GET", "/api/ecommerce/etsy/workspace");
    expect(unknown.status).toBe(404);
    const comingSoon = await api(page, "POST", "/api/ecommerce/amazon/imports", { body: {} });
    expect(comingSoon.status).toBe(409);
  });

  test("the marketplace pages fit a phone @phone", async ({ page }) => {
    await signedUpAccount(page, "meesho-phone");
    await page.goto("/app/ecommerce");
    await expect(page.getByTestId("marketplace-meesho")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    await page.getByTestId("marketplace-meesho").getByRole("button", { name: /Meesho/ }).click();
    await expect(page.getByRole("heading", { name: "Connect your Meesho reports" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(2);
  });
});
