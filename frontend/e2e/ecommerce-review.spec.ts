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
    summary: { documents: 1, taxableValue: 100, gst: 18, gross: 118, refunds: 0, tcs: 1, b2b: 0, b2c: 1, errors: issues.length },
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
  await expect(page.getByRole("button", { name: /Review 1 item/ })).toBeVisible();
  await page.getByRole("button", { name: /Review 1 item/ }).click();
  await page.getByRole("button", { name: "Correct row" }).click();
  await page.getByLabel("HSN", { exact: true }).fill("610910");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByRole("button", { name: "Compare portal TCS" }).first()).toBeVisible();
  expect((reviewed[0] as { sales: typeof sale[] }).sales[0].hsn).toBe("610910");
  await page.locator('input[aria-label="GST portal TCS summary"]').setInputFiles({ name: "portal.csv", mimeType: "text/csv", buffer: Buffer.from("State,TCS Amount\nKarnataka,1\n") });
  await expect(page.getByText("Uploaded portal TCS amounts agree", { exact: false })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download GST draft" }).click();
  expect((await download).suggestedFilename()).toMatch(/gstr1-draft\.json$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "../tmp/ecommerce-review-390.png", fullPage: true });
});
