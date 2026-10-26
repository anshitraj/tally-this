import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, signedUpAccount, watchProblems } from "./helpers";

/**
 * Every page of the app, opened as a brand-new signed-in account against the real backend: it must load with something
 * on it, with no error in the console, no refused API call and no sideways scroll. Redirects land where the menu says.
 */

const PAGES: Array<{ path: string; heading: string | RegExp }> = [
  { path: "/app/overview", heading: /Good (morning|afternoon|evening)/ },
  { path: "/app/clients", heading: "Clients" },
  { path: "/app/tools", heading: "Advanced" },
  { path: "/app/jobs/bank-to-tally", heading: "Bank Statement → Tally" },
  { path: "/app/jobs/bank-tally", heading: "Bank ↔ Tally" },
  { path: "/app/jobs/ecommerce-gst", heading: "E-commerce GST" },
  { path: "/app/jobs/invoice-bank", heading: "Invoice ↔ Bank" },
  { path: "/app/jobs/gstr-2b", heading: "GSTR-2B ↔ Books" },
  { path: "/app/jobs/bills-tally", heading: "Bills → Tally" },
  { path: "/app/jobs/gst-sales", heading: "Sales → GSTR-1 & 3B" },
  { path: "/app/jobs/payroll", heading: "Payroll" },
  { path: "/app/reports", heading: "Reports" },
  { path: "/app/activity", heading: "Activity" },
  { path: "/app/history", heading: "History" },
  { path: "/app/settings", heading: "Settings" },
  { path: "/app/docs", heading: "TallyThis documentation" },
  // The older pages, reached from Advanced.
  { path: "/app/uploads", heading: "Upload Center" },
  { path: "/app/transactions", heading: "Bank Transactions" },
  { path: "/app/invoices", heading: "Invoices" },
  { path: "/app/ledger-match", heading: "Ledger Match" },
  { path: "/app/trial-balance", heading: "Trial Balance" },
  { path: "/app/tax-audit", heading: "Tax Audit & Ledger Scrutiny" },
  { path: "/app/practice", heading: "Practice Console" },
  { path: "/app/tds-recon", heading: "26AS vs Books — TDS Reconciliation" },
  { path: "/app/journal-entries", heading: "Journal Entries" },
  { path: "/app/gstr-2b-recon", heading: "GSTR-2B vs imported invoices" },
  { path: "/app/reconciliation", heading: "Reconciliation" },
  { path: "/app/gst-tds-risks", heading: "GST / TDS Risk Flags" },
  { path: "/app/payroll-register", heading: "Payroll Register" },
  { path: "/app/gateway-settlements", heading: "Gateway Settlements" },
  { path: "/app/verify", heading: "Verify" },
  { path: "/app/action-items", heading: "Action Items" },
  { path: "/app/statutory-calendar", heading: "Statutory Calendar" },
  { path: "/app/vendor-aging", heading: "Vendor Payment Aging" },
  { path: "/app/ca-review", heading: "CA Review Queue" },
  { path: "/app/integrations", heading: "Connections" },
  { path: "/app/admin", heading: "Admin Dashboard" },
];

const REDIRECTS: Array<[string, RegExp]> = [
  ["/app/payroll", /\/app\/jobs\/payroll$/],
  ["/app/ledger", /\/app\/ledger-match$/],
  ["/app/risks", /\/app\/gst-tds-risks$/],
  ["/app/gateway", /\/app\/gateway-settlements$/],
  ["/app/review", /\/app\/ca-review$/],
  ["/app", /\/app(\/overview)?$/],
];

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
}

test.describe("every page", () => {
  test("opens for a new account without errors", async ({ page }) => {
    test.setTimeout(240_000);
    const seen = watchProblems(page);
    await signedUpAccount(page, "pages", "Pages Client");
    const broken: string[] = [];
    for (const { path, heading } of PAGES) {
      const before = seen.problems.length;
      await open(page, path);
      const found = await page.getByRole("heading", { name: heading, level: 1 }).first().isVisible({ timeout: 5_000 }).catch(() => false);
      const text = (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ");
      if (!found) broken.push(`${path}: no heading "${heading}"`);
      if (text.length < 20) broken.push(`${path}: nothing on the page`);
      const bad = text.match(/something went wrong|unexpected error|undefined|\[object Object\]/i)?.[0] ?? text.match(/(^|[^A-Za-z])NaN([^A-Za-z]|$)/)?.[0];
      if (bad) broken.push(`${path}: shows "${bad}"`);
      const fresh = seen.problems.slice(before);
      if (fresh.length) broken.push(`${path}: ${fresh.join(" ; ")}`);
    }
    expect(broken, broken.join("\n")).toEqual([]);
  });

  test("old addresses and the app root go where the menu says", async ({ page }) => {
    await signedUpAccount(page, "redirects", "Redirect Client");
    for (const [from, to] of REDIRECTS) {
      await open(page, from);
      await expect(page, from).toHaveURL(to);
    }
  });

  test("the admin page shows this workspace's own people and actions, never invented ones", async ({ page }) => {
    // It used to open with made-up users, documents and audit entries until the real ones arrived.
    const account = await signedUpAccount(page, "admin", "Admin Client");
    await open(page, "/app/admin");
    await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toBeVisible();
    await expect(page.getByText(account.email).first()).toBeVisible();
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    for (const invented of ["novastack", "finverify.in", "Rahul Mehta", "Ananya Rao", "CA Priya", "HDFC bank statement - May", "Zoho invoices export", "GST 2B reconciliation.pdf"]) {
      expect(text, `the admin page shows "${invented}"`).not.toContain(invented);
    }
  });

  test("an address that does not exist inside the app says so and offers the way back", async ({ page }) => {
    await signedUpAccount(page, "missing", "Missing Client");
    await open(page, "/app/not-a-page");
    await expect(page.getByText("That page isn’t here.")).toBeVisible();
    await expect(page.getByRole("link", { name: /home|overview|back/i }).or(page.getByRole("button", { name: /home|overview|back/i })).first()).toBeVisible();
  });

  test("every item in the menu opens its page", async ({ page }) => {
    await signedUpAccount(page, "menu", "Menu Client");
    const entries: Array<[string, RegExp | string]> = [
      ["Clients", "Clients"], ["Bank → Tally", "Bank Statement → Tally"], ["Bank ↔ Tally", "Bank ↔ Tally"], ["E-commerce GST", "E-commerce GST"],
      ["Invoice ↔ Bank", "Invoice ↔ Bank"], ["Reports", "Reports"], ["Activity", "Activity"], ["Advanced", "Advanced"],
    ];
    for (const [label, heading] of entries) {
      await page.getByRole("complementary").getByRole("button", { name: label, exact: true }).click();
      await expect(page.getByRole("heading", { name: heading, level: 1 }).first(), label).toBeVisible();
    }
  });
});

test.describe("on a phone @phone", () => {
  test("the main pages fit the screen", async ({ page }) => {
    test.setTimeout(240_000);
    await signedUpAccount(page, "phone-pages", "Phone Client");
    const wide: string[] = [];
    for (const { path } of PAGES.slice(0, 16)) {
      await open(page, path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 2) wide.push(`${path} is ${overflow}px wider than the screen`);
    }
    expect(wide, wide.join("\n")).toEqual([]);
    await expectNoSidewaysScroll(page);
  });
});
