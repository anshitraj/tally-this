import { expect, test, type Page } from "@playwright/test";
import { signedIn } from "./signedIn";

/**
 * What a CA depends on beyond the first screen: finding things, never meeting a blank page, and
 * the GST and reconciliation outputs that come after a comparison.
 * Every API reply is a stand-in; these tests check the screens and what they send, not accuracy.
 */

const side = (docNumber: string, tax: number, total: number, date = "2026-10-05") => ({
  docNumber,
  docDate: date,
  row: 2,
  voucherNo: null,
  taxable: total - tax,
  igst: 0,
  cgst: tax / 2,
  sgst: tax / 2,
  cess: 0,
  tax,
  total,
});

const item = (key: string, bucket: string, extra: Record<string, unknown> = {}) => ({
  key,
  bucket,
  status: "suggested",
  confidence: "review",
  supplierGstin: "27AAPFU0939F1ZV",
  supplierName: "Alpha Traders",
  docNumber: key.toUpperCase(),
  docDate: "2026-10-05",
  kind: "invoice",
  why: ["Why this is flagged"],
  itcAtRisk: 0,
  itcUnclaimed: 0,
  ...extra,
});

const heads = (total: number) => ({ igst: 0, cgst: total / 2, sgst: total / 2, cess: 0, total });

const GSTR = {
  ok: true,
  runId: "run-1",
  privacy: false,
  period: "2026-10",
  periods: ["2026-10"],
  recipientGstin: "27AABCU9603R1ZX",
  files: { portal: "gstr2b.json", books: "register.xlsx" },
  portalCount: 3,
  booksCount: 3,
  counts: { matched: 1, value_mismatch: 0, probable: 0, missing_in_2b: 1, missing_in_books: 1, not_eligible: 0, duplicate: 0, portal: 3, books: 3 },
  totals: { portalTax: 540, booksTax: 360, matchedTax: 180, itcAtRisk: 180, itcUnclaimed: 360, notEligibleTax: 0 },
  byHead: { portal: heads(540), books: heads(360), matched: heads(180), atRisk: heads(180), unclaimed: heads(360), notEligible: heads(0) },
  suppliers: [{ gstin: "24AAHCD5847K1Z8", name: "Delta Stationers", missing: [{ docNumber: "DS-77", docDate: "2026-10-25", tax: 180, total: 1180 }], mismatched: 0, itcAtRisk: 180 }],
  vendors: [],
  notes: [],
  items: [
    item("a1", "matched", { books: side("A1", 180, 1180), portal: side("A1", 180, 1180), confidence: "exact" }),
    item("ds-77", "missing_in_2b", { supplierGstin: "24AAHCD5847K1Z8", supplierName: "Delta Stationers", books: side("DS-77", 180, 1180, "2026-10-25"), itcAtRisk: 180 }),
    item("cl-9982", "missing_in_books", { supplierGstin: "07AAACC1206D1ZI", supplierName: "Capital Logistics", portal: side("CL-9982", 360, 2360, "2026-10-23"), itcUnclaimed: 360 }),
  ],
};

async function workspace(page: Page) {
  await signedIn(page);
  await page.addInitScript(() => {
    localStorage.setItem("finverify_active_client", JSON.stringify({ id: 11, name: "Alpha Trading Co", accounting: "Tally", linkId: 1 }));
  });
}

test("Ctrl K finds any page or job and opens it", async ({ page }) => {
  await workspace(page);
  await page.goto("/app/overview");
  await page.keyboard.press("Control+k");
  const search = page.getByPlaceholder("Search jobs, pages or clients");
  await expect(search).toBeVisible();
  await search.fill("2b");
  await expect(page.getByRole("option", { name: /GSTR-2B ↔ Books/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/jobs\/gstr-2b$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("GSTR-2B ↔ Books");
});

test("an address that is not a page keeps the menu and offers a way back", async ({ page }) => {
  await workspace(page);
  await page.goto("/app/this-page-does-not-exist");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("That page isn’t here.");
  await expect(page.locator(".fv-app-sidebar")).toBeVisible();
  await page.getByRole("button", { name: "Back to your workspace" }).click();
  await expect(page).toHaveURL(/\/app\/overview$/);
});

test("an ended session returns to sign-in and comes back to the same page", async ({ page }) => {
  await workspace(page);
  await page.route("**/api/**", route => route.fulfill({ status: 401, json: { error: "Authentication required" } }));
  await page.goto("/app/transactions");
  await expect(page).toHaveURL(/\/login\?reason=expired&next=%2Fapp%2Ftransactions/);
  await expect(page.getByText(/Your session ended/)).toBeVisible();
});

test("a page that cannot be drawn says so and offers a retry, never a blank screen", async ({ page }) => {
  await workspace(page);
  await page.route("**/api/transactions", route => route.fulfill({ json: { unexpected: "an object where a list belongs" } }));
  await page.goto("/app/transactions");
  await expect(page.getByRole("heading", { name: "This page could not open." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.getByRole("button", { name: "Go to start" }).click();
  await expect(page).toHaveURL(/\/app\/overview$/);
});

test("clients can be added, renamed and removed from the list", async ({ page }) => {
  await workspace(page);
  let clients = [{ companyId: 11, linkId: 1, name: "Sharma Traders", source: "tally" }];
  await page.route("**/api/practice/clients**", async route => {
    const request = route.request();
    const method = request.method();
    if (method === "GET") return route.fulfill({ json: { ok: true, clients, source: "links" } });
    if (method === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      clients = [...clients, { companyId: 12, linkId: 2, name: body.name, source: "tally" }];
      return route.fulfill({ json: { ok: true, client: { companyId: 12, linkId: 2, name: body.name } } });
    }
    if (method === "PATCH") {
      const body = JSON.parse(request.postData() ?? "{}");
      clients = clients.map(client => (request.url().endsWith(`/${client.linkId}`) ? { ...client, name: body.name } : client));
      return route.fulfill({ json: { ok: true } });
    }
    clients = clients.filter(client => !request.url().endsWith(`/${client.linkId}`));
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/app/clients");
  // The menu's client list repeats every name, so these checks stay inside the page itself.
  const content = page.locator("#workspace-content");
  await expect(content.getByText("Sharma Traders")).toBeVisible();

  await page.getByRole("button", { name: "Add client" }).first().click();
  await page.getByLabel("Business name").fill("Mehta Exports");
  await page.getByRole("button", { name: "Save client" }).click();
  await expect(content.getByText("Mehta Exports", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Rename Mehta Exports" }).click();
  await page.getByLabel("Client name").fill("Mehta Exports LLP");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(content.getByText("Mehta Exports LLP", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Remove Mehta Exports LLP" }).click();
  await page.getByRole("button", { name: "Yes, remove" }).click();
  await expect(content.getByText("Mehta Exports LLP", { exact: true })).toHaveCount(0);
});

test("GSTR-2B ↔ Books: two files in, differences listed, supplier message and Excel out", async ({ page }) => {
  await workspace(page);
  let compareFiles = 0;
  let decisions = 0;
  await page.route("**/api/jobs/gstr-2b/compare", async route => {
    compareFiles = (route.request().postData() ?? "").includes('name="gstr2b"') ? 1 : 0;
    await route.fulfill({ json: GSTR });
  });
  await page.route("**/api/jobs/gstr-2b/runs/*/decision", async route => {
    decisions += 1;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/jobs/gstr-2b/excel", route =>
    route.fulfill({ status: 200, body: Buffer.from("xlsx"), headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }),
  );

  await page.goto("/app/jobs/gstr-2b");
  const inputs = page.locator("input[type=file]");
  await inputs.nth(0).setInputFiles({ name: "gstr2b.json", mimeType: "application/json", buffer: Buffer.from("{}") });
  await inputs.nth(1).setInputFiles({
    name: "register.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("x"),
  });
  await expect(page.getByText("need attention")).toBeVisible();
  expect(compareFiles).toBe(1);
  await expect(page.getByText("October 2026 · 3 in GSTR-2B · 3 in your books")).toBeVisible();
  await expect(page.getByText("ITC not supported by GSTR-2B")).toBeVisible();

  await page.getByRole("button", { name: "Review 2 items" }).click();
  await expect(page.getByRole("heading", { name: /In your books, not in GSTR-2B/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /In GSTR-2B, not in your books/ })).toBeVisible();
  await page.getByRole("button", { name: "Noted" }).first().click();
  await expect.poll(() => decisions).toBe(1);

  await expect(page.getByRole("button", { name: "Copy message" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Email" }).first()).toHaveAttribute("href", /^mailto:/);

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Excel" }).first().click()]);
  expect(download.suggestedFilename()).toBe("TallyThis_GSTR2B_Reconciliation.xlsx");
});

test("Bank ↔ Tally: the reconciliation statement adds up and the missing entries can be created", async ({ page }) => {
  await workspace(page);
  const bank = (rowNumber: number, date: string, narration: string, debit: number | null, credit: number | null) => ({
    date, valueDate: null, description: narration, narration, reference: `R${rowNumber}`, debit, credit, balance: null, counterparty: null,
    accountName: null, accountNumberMasked: null, bankName: "HDFC Bank", rowNumber, confidence: 0.95, sourceFile: "s.pdf", sourcePage: 1, sourceQuote: narration,
  });
  const compare = {
    ok: true, runId: "r1", privacy: false,
    bank: { bankName: "HDFC Bank", periodLabel: "October 2026", count: 4, check: { rows: 4, checked: 4, passed: 4, failed: 0, failedRows: [], openingBalance: 90000, closingBalance: 100000, printedClosing: 100000, closingMatches: true, serialComplete: true, verified: true } },
    tally: { source: "xml", count: 3, notes: [] },
    comparison: {
      counts: { bank: 4, tally: 3, confirmed: 1, suggested: 0, bankOnly: 2, tallyOnly: 1, amountDifferences: 0, duplicates: 0 },
      items: [
        { key: "b1", bucket: "bank_only", status: "suggested", confidence: 0.2, why: [], bank: bank(1, "2026-10-12", "NEFT-INTEREST", null, 2000) },
        { key: "b2", bucket: "bank_only", status: "suggested", confidence: 0.2, why: [], bank: bank(2, "2026-10-31", "SMS CHARGES", 500, null) },
        { key: "t1", bucket: "tally_only", status: "suggested", confidence: 0.2, why: [], tally: { id: "t1", date: "2026-10-30", ledgerName: "Sharma Traders", voucherNumber: "R/1", debit: 5000, credit: null, narration: "", rowNumber: 3 } },
        { key: "c1", bucket: "confirmed", status: "approved", confidence: 1, why: [], bank: bank(3, "2026-10-02", "OK", 10, null), tally: { id: "c1", date: "2026-10-02", ledgerName: "X", voucherNumber: null, debit: null, credit: 10, narration: "", rowNumber: 4 } },
      ],
    },
  };
  let sent: { transactions?: unknown[]; bankLedger?: string } = {};
  await page.route("**/api/jobs/bank-tally/compare", route => route.fulfill({ json: compare }));
  await page.route("**/api/jobs/bank-tally/brs-preview", async route => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const computed = body.bankClosing == null ? null : body.bankClosing + 5000 - 2000 + 500;
    await route.fulfill({
      json: { ok: true, figures: { bankClosing: body.bankClosing, depositsNotCredited: 5000, paymentsNotPresented: 0, creditsNotBooked: 2000, debitsNotBooked: 500, differences: 0, computedBooks: computed, booksClosing: body.booksClosing, gap: computed != null && body.booksClosing != null ? computed - body.booksClosing : null, unresolved: 0 } },
    });
  });
  await page.route("**/api/jobs/bank-tally/brs", route =>
    route.fulfill({ status: 200, body: Buffer.from("xlsx"), headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }),
  );
  await page.route("**/api/jobs/bank-to-tally/xml", async route => {
    sent = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({ json: { ok: true, xml: "<ENVELOPE/>", fileName: "missing.xml", voucherCount: 2 } });
  });

  await page.goto("/app/jobs/bank-tally");
  const inputs = page.locator("input[type=file]");
  await inputs.nth(0).setInputFiles({ name: "s.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
  await inputs.nth(1).setInputFiles({ name: "ledger.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("x") });
  await expect(page.getByText("need attention")).toBeVisible();

  // The bank's own closing balance is already in the box, and the books balance is worked out.
  await expect(page.getByPlaceholder("e.g. 1,25,000.00")).toHaveValue("100000");
  await expect(page.getByText("Balance as per books, worked out")).toBeVisible();
  await expect(page.getByText("₹1,03,500")).toBeVisible();
  await page.getByPlaceholder("to check the statement adds up").fill("103000");
  await expect(page.getByText("Difference from the Tally balance")).toBeVisible();

  const [statement] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download statement/ }).click()]);
  expect(statement.suggestedFilename()).toBe("TallyThis_Bank_Reconciliation.xlsx");

  await expect(page.getByText("2 entries are missing in Tally")).toBeVisible();
  const [entries] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download Tally entries/ }).click()]);
  expect(entries.suggestedFilename()).toBe("missing.xml");
  expect(sent.transactions).toHaveLength(2);
  expect(sent.bankLedger).toBe("HDFC Bank");
});

test("Invoice ↔ Bank: a request for the missing invoices is one press away", async ({ page }) => {
  await workspace(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/jobs/invoice-bank/compare", route =>
    route.fulfill({
      json: {
        ok: true, runId: null, privacy: true, invoiceCount: 2, bankCount: 3, aiRead: 0, pdfRead: 0, unreadable: [],
        comparison: {
          items: [
            { key: "a", bucket: "payment_without_invoice", status: "suggested", confidence: 0.1, why: [], bank: { narration: "NEFT-DELTA STATIONERS", date: "2026-10-04", debit: 5900, credit: null } },
            { key: "b", bucket: "matched", status: "approved", confidence: 1, why: [], bank: { narration: "NEFT-ALPHA", date: "2026-10-06", debit: 118000, credit: null }, invoice: { invoiceNumber: "ALP-1", vendorName: "Alpha", total: 118000, invoiceDate: "2026-10-05" } },
          ],
        },
      },
    }),
  );
  await page.route("**/api/jobs/invoice-bank/excel", route =>
    route.fulfill({ status: 200, body: Buffer.from("xlsx"), headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }),
  );
  await page.goto("/app/jobs/invoice-bank");
  const inputs = page.locator("input[type=file]");
  await inputs.nth(0).setInputFiles({ name: "s.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
  await inputs.nth(1).setInputFiles({ name: "inv.csv", mimeType: "text/csv", buffer: Buffer.from("a,b") });
  await expect(page.getByText("need attention")).toBeVisible();
  await page.getByRole("button", { name: /Copy request for 1 missing invoice/ }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("NEFT-DELTA STATIONERS");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Excel" }).first().click()]);
  expect(download.suggestedFilename()).toBe("TallyThis_Invoice_Bank.xlsx");
});

test("empty advanced pages point to the file or job that fills them", async ({ page }) => {
  await workspace(page);
  for (const [path, button] of [
    ["/app/payroll", "Open Upload center"],
    ["/app/gateway-settlements", "Open Upload center"],
    ["/app/invoices", "Match invoices with the bank"],
    ["/app/ledger-match", "Compare bank with Tally"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: button })).toBeVisible();
  }
  await page.goto("/app/activity");
  await expect(page.getByRole("button", { name: "Start a job" })).toBeVisible();
});
