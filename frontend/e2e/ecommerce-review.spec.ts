import { test, expect, type Page } from "@playwright/test";

const user = { email: "gst@example.test", name: "Priya Shah", role: "ca", company: "Shah & Co.", companyId: 1 };
const sale = {
  platform: "amazon", orderId: "ORD-1", invoiceNumber: "INV-1", invoiceDate: "2026-05-01",
  gstin: null, buyerState: "Karnataka", placeOfSupply: "Karnataka", taxableValue: 100,
  cgst: 9, sgst: 9, igst: 0, cess: 0, grossAmount: 118, refundAmount: 0,
  marketplaceFees: 0, tcsAmount: 1, hsn: null as string | null, gstRate: 18,
  transactionType: "sale", sourceRow: 2, sourceFile: "amazon.csv", issues: ["Missing HSN. Potential risk — needs CA review."],
};

function pack(row = sale) {
  const issues = row.hsn ? [] : ["Missing HSN. Potential risk — needs CA review."];
  const reviewed = { ...row, issues };
  return {
    ok: true, runId: "local-1", privacy: false, platform: "amazon", files: ["amazon.csv"],
    sales: [reviewed], documents: [{ platform: "amazon", issued: 1, cancelled: 0, source: "uploaded reports" }],
    summary: { documents: 1, taxableValue: 100, gst: 18, gross: 118, refunds: 0, tcs: row.tcsAmount, b2b: 0, b2c: 1, errors: issues.length },
    tabs: { b2b: [], b2c: [reviewed], hsn: [{ supply: "B2C", hsn: row.hsn || "missing", gstRate: 18, taxableValue: 100, count: 1 }], tcs: [reviewed], table14: [], errors: issues.length ? [reviewed] : [] },
  };
}

async function setup(page: Page) {
  await page.addInitScript(userInfo => {
    localStorage.setItem("finverify_auth", JSON.stringify({ user: userInfo }));
    localStorage.setItem(`finverify_onboarding_complete:${userInfo.email}`, "true");
  }, user);
  const reviewed: unknown[] = [];
  let current = pack();
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("account/plan")) return route.fulfill({ json: { ok: true, plan: "free", privacyAvailable: false } });
    if (path.endsWith("practice/clients")) return route.fulfill({ json: { clients: [{ companyId: 1, linkId: 1, name: "Shah & Co." }] } });
    if (path.endsWith("auth/me")) return route.fulfill({ json: { user, company: { name: user.company } } });
    if (path.endsWith("jobs/history")) return route.fulfill({ json: { ok: true, runs: [] } });
    if (path.endsWith("jobs/ecommerce/normalize")) return route.fulfill({ json: current });
    if (path.endsWith("jobs/ecommerce/review")) {
      const body = route.request().postDataJSON();
      reviewed.push(body);
      current = { ...pack(body.sales[0]), documents: body.documents };
      return route.fulfill({ json: current });
    }
    if (path.endsWith("jobs/ecommerce/tcs-compare")) return route.fulfill({ json: { ok: true, source: "uploaded GST portal file", message: "Uploaded portal TCS amounts agree with the marketplace reports.", mismatches: 0, rows: [{ state: "Karnataka", code: "29", uploaded: 1, portal: 1, difference: 0 }] } });
    if (path.endsWith("jobs/ecommerce/gst-json")) return route.fulfill({ json: { ok: true, json: { schema: "finverify.gstr1.draft.v1" } } });
    if (path.endsWith("jobs/ecommerce/csv")) return route.fulfill({ json: { ok: true, csv: "invoice,total\nINV-1,118" } });
    return route.fulfill({ json: { ok: true } });
  });
  return reviewed;
}

test("accountant corrects HSN, compares uploaded TCS and downloads the draft on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const reviewed = await setup(page);
  await page.goto("/app/jobs/ecommerce-gst");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "amazon.csv", mimeType: "text/csv", buffer: Buffer.from("invoice,taxable\nINV-1,100") });
  await expect(page.getByRole("tab", { name: "GST report", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "GST report", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: /Review 1 item/ })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Download Excel", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Review 1 item/ })).toBeVisible();
  await page.getByRole("button", { name: /Review 1 item/ }).click();
  await page.getByRole("button", { name: "Correct row" }).click();
  await page.getByLabel("HSN", { exact: true }).fill("610910");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByRole("button", { name: "Compare portal TCS" }).first()).toBeVisible();
  expect((reviewed[0] as { sales: typeof sale[] }).sales[0].hsn).toBe("610910");
  await page.locator('input[aria-label="GST portal TCS summary"]').setInputFiles({ name: "portal.csv", mimeType: "text/csv", buffer: Buffer.from("State,TCS Amount\nKarnataka,1\n") });
  await expect(page.getByText("Uploaded portal TCS amounts agree", { exact: false })).toBeVisible();
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await page.getByLabel("Export format").selectOption("gst");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download GST draft" }).click();
  expect((await download).suggestedFilename()).toMatch(/gstr1-draft\.json$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "../tmp/ecommerce-review-390.png", fullPage: true });
});

test("a clean upload opens GST sections and exports only when the accountant asks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const reviewed = await setup(page);
  const clean = pack({ ...sale, hsn: "610910", tcsAmount: 0, issues: [] });
  clean.summary.tcs = 0;
  await page.route("**/api/jobs/ecommerce/normalize", route => route.fulfill({ json: clean }));
  const exportRequests: string[] = [];
  page.on("request", request => { if (/\/ecommerce\/(excel|gst-json|csv|sales-xml)$/.test(new URL(request.url()).pathname)) exportRequests.push(request.url()); });
  await page.goto("/app/jobs/ecommerce-gst");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "amazon.csv", mimeType: "text/csv", buffer: Buffer.from("invoice,taxable\nINV-1,100") });
  await expect(page.getByRole("tab", { name: "GST report", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("GST section")).toHaveValue("B2C");
  await expect(page.getByLabel("GST section").locator("option")).toHaveText(["B2B", "B2C", "HSN", "TCS", "Documents", "Credit notes", "Table 14"]);
  await expect(page.getByRole("group", { name: "Choose upload mode" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Download/ })).toHaveCount(0);
  expect(exportRequests).toHaveLength(0);
  await page.screenshot({ path: "../tmp/gst-report-desktop.png", fullPage: true });
  await page.getByLabel("GST section").selectOption("HSN");
  await expect(page.getByRole("cell", { name: "610910", exact: true })).toBeVisible();
  await page.getByLabel("GST section").selectOption("Documents");
  await expect(page.getByText("Documents issued", { exact: true })).toBeVisible();
  await page.getByLabel("Issued", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Save document summary" }).click();
  await expect.poll(() => reviewed.length).toBe(1);
  expect((reviewed[0] as { documents: Array<{ issued: number }> }).documents[0].issued).toBe(2);
  await page.screenshot({ path: "../tmp/gst-documents-desktop.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("tab", { name: "GST report", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Export", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Download Excel", exact: true })).toBeVisible();
  expect(exportRequests).toHaveLength(0);
});

test("excluded marketplace documents are explained without overflowing the mobile result", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.route("**/api/jobs/ecommerce/normalize", route => route.fulfill({ json: {
    ...pack({ ...sale, hsn: "610910", issues: [] }),
    summary: { ...pack().summary, documents: 2, errors: 0, excludedSalesRows: 1 },
  } }));
  await page.goto("/app/jobs/ecommerce-gst");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "amazon.csv", mimeType: "text/csv", buffer: Buffer.from("invoice,taxable\nINV-1,100") });
  await expect(page.getByText("Sales totals exclude 1 cancelled, return or adjustment row", { exact: false })).toBeVisible();
  await expect(page.getByText("sales rows read", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "../tmp/ecommerce-exclusions-390.png", fullPage: true });
});

test("linked credit notes show their source amounts and original invoice on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const original = { ...sale, invoiceNumber: "INV-1", hsn: "610910", issues: [] };
  const note = { ...original, invoiceNumber: "CN-1", originalInvoiceNumber: "INV-1", transactionType: "credit_note", taxableValue: -50, cgst: -4.5, sgst: -4.5, grossAmount: -59, sourceRow: 3 };
  const result = pack(original);
  await page.route("**/api/jobs/ecommerce/normalize", route => route.fulfill({ json: { ...result, sales: [original, note], summary: { ...result.summary, documents: 2, taxableValue: 50, gst: 9, gross: 59 }, tabs: { ...result.tabs, creditNotes: [note] } } }));
  await page.goto("/app/jobs/ecommerce-gst");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "credits.csv", mimeType: "text/csv", buffer: Buffer.from("Invoice Number,Taxable Value\nCN-1,-50") });
  await page.getByLabel("GST section").selectOption("Credit notes");
  await expect(page.getByRole("cell", { name: "CN-1", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "INV-1", exact: true })).toBeVisible();
  await expect(page.getByText("Net taxable value", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "../tmp/gst-credit-notes-mobile.png", fullPage: true });
});
