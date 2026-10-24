import { test, expect, type Page } from "@playwright/test";

/**
 * Screens that used to say more than they did: sending straight to Tally on the hosted site, and the
 * Settings page. Every API reply is mocked, so none of this touches a real server or database.
 */
const user = { email: "honesty@example.test", name: "Test Accountant", role: "founder", company: "Mehta & Co", companyId: 1 };

const statement = {
  ok: true, bankName: "DBS Bank India", bankOptions: ["DBS Bank India"], accountNumberMasked: "4321", periodLabel: "01 Apr 2025 – 31 Mar 2026",
  source: "pdf_layout",
  check: { rows: 2, checked: 2, passed: 2, failed: 0, failedRows: [], openingBalance: 5000, closingBalance: 3000, printedClosing: 3000, closingMatches: true, serialComplete: null, verified: true },
  transactions: [
    { date: "2025-04-03", valueDate: "2025-04-03", narration: "UPI 100000000001 ravisharma@ybl RAVI SHARMA", reference: null, debit: null, credit: 300, balance: 5300, counterparty: "RAVI SHARMA", confidence: 0.99, rowNumber: 1 },
    { date: "2025-04-09", valueDate: "2025-04-08", narration: "ATM WDL MAIN ROAD", reference: "S7313", debit: 2300, credit: null, balance: 3000, counterparty: null, confidence: 0.99, rowNumber: 2 },
  ],
  ledgerGroups: [
    { key: "RAVI SHARMA", label: "RAVI SHARMA", ledger: "Sundry Debtors", source: "remembered", count: 1, total: 300, direction: "in", sample: "UPI RAVI SHARMA" },
    { key: "ATM WDL MAIN ROAD", label: "ATM WDL MAIN ROAD", ledger: "Cash", source: "rule", count: 1, total: 2300, direction: "out", sample: "ATM WDL" },
  ],
  ledgerOptions: ["Sundry Debtors", "Sundry Creditors", "Cash", "Suspense"],
};

async function signIn(page: Page) {
  await page.addInitScript(value => {
    localStorage.setItem("finverify_auth", JSON.stringify({ user: value }));
    localStorage.setItem(`finverify_onboarding_complete:${value.email}`, "true");
  }, user);
}

async function openStatementViewer(page: Page, tallyStatus: Record<string, unknown>) {
  await signIn(page);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("bank-statement/normalize")) await route.fulfill({ json: statement });
    else if (path.endsWith("tally/status")) await route.fulfill({ json: tallyStatus });
    else if (path.endsWith("auth/me")) await route.fulfill({ json: { user, company: { name: user.company } } });
    else if (path.endsWith("practice/clients")) await route.fulfill({ json: { clients: [{ companyId: 2, linkId: 2, name: "Example Traders" }], source: "database" } });
    else await route.fulfill({ json: { ok: true, picks: [] } });
  });
  await page.goto("/app/jobs/bank-to-tally");
  await page.locator('input[type="file"]').setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Narration,Debit\n03/04/2025,UPI,300\n") });
  const viewer = page.getByTestId("statement-viewer");
  await expect(viewer).toBeVisible();
  return viewer;
}

const HOSTED = {
  ok: true,
  available: false,
  running: false,
  companies: [],
  message: "Sending straight to Tally only works when TallyThis runs on the same computer as TallyPrime. On this site, download the Tally XML file and import it in Tally instead.",
};

test("on the hosted site, sending straight to Tally is not offered and the way forward is explained", async ({ page }) => {
  const viewer = await openStatementViewer(page, HOSTED);
  // The editor's top bar offers Export, not a Send button that could not work.
  await expect(viewer.getByRole("button", { name: "Send to Tally", exact: true })).toHaveCount(0);
  await viewer.getByRole("button", { name: "Export", exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await expect(page.getByText(/Sending straight to Tally is not available on this site/)).toBeVisible();
  await expect(page.getByText(/Import → Vouchers/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send straight to Tally" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect to Tally" })).toHaveCount(0);
  await expect(page.getByText("Connected to Tally")).toHaveCount(0);
});

test("where it can work, direct sending is offered and marked experimental", async ({ page }) => {
  const viewer = await openStatementViewer(page, { ok: true, available: true, running: true, companies: ["Example Traders"], message: "Connected to Tally." });
  await viewer.getByRole("button", { name: "Send to Tally", exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await expect(page.getByText("Experimental", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/not yet with a live TallyPrime/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect to Tally" })).toBeVisible();
});

test("the Connections page does not show Tally set-up steps on a site that cannot reach Tally", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("tally/status")) await route.fulfill({ json: HOSTED });
    else if (path.endsWith("auth/me")) await route.fulfill({ json: { user, company: { name: user.company } } });
    else if (path.endsWith("practice/clients")) await route.fulfill({ json: { clients: [], source: "database" } });
    else await route.fulfill({ json: [] });
  });
  await page.goto("/app/integrations");
  await expect(page.getByText("Experimental", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByText(/only works when TallyThis runs on the same computer as TallyPrime/)).toBeVisible();
  await expect(page.getByText("Open TallyPrime and the company you want to post into.")).toHaveCount(0);
});

// ── Settings ────────────────────────────────────────────────────────────────

const stored = { id: 1, name: "Mehta & Co", gstin: "27AAPFU0939F1ZV", pan: "AAPFU0939F", caEmail: "ca@firm.in", financialYearStart: "April", currency: "INR", dataRetentionDays: 365, createdAt: "2026-01-01T00:00:00.000Z" };

async function openSettings(page: Page, patches: Array<Record<string, unknown>>, replies: Array<{ status: number; body: unknown }>) {
  await signIn(page);
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/company") && request.method() === "PATCH") {
      patches.push(request.postDataJSON());
      const reply = replies.shift() ?? { status: 500, body: { ok: false, error: "unexpected" } };
      await route.fulfill({ status: reply.status, json: reply.body });
    } else if (path.endsWith("/company")) await route.fulfill({ json: stored });
    else if (path.endsWith("security/posture")) {
      await route.fulfill({ json: { roleBasedAccessDesign: true, activeUsers: 1, auditLogsEnabled: true, fileStorageMode: "r2", aiMode: "rule-based", directIntegrationsLive: false, notes: [] } });
    } else if (path.endsWith("auth/me")) await route.fulfill({ json: { user, company: { name: user.company } } });
    else if (path.endsWith("practice/clients")) await route.fulfill({ json: { clients: [], source: "database" } });
    else await route.fulfill({ json: [] });
  });
  await page.goto("/app/settings");
  await expect(page.getByText("Company Details")).toBeVisible();
}

const field = (page: Page, label: string) => page.getByText(label, { exact: true }).locator("xpath=../input");

test("Settings saves for real, and says Saved only after the server confirms", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  await openSettings(page, patches, [
    { status: 400, body: { ok: false, error: "That GSTIN is not valid. Check all 15 characters, for example 29ABCDE1234F1Z5." } },
    { status: 200, body: { ok: true, company: { ...stored, name: "Mehta & Co Pvt Ltd", gstin: "27AAPFU0939F1ZV" } } },
  ]);
  const save = page.getByRole("button", { name: "Save changes" });

  // Nothing to save yet, so the button is off and no confirmation can appear.
  await expect(field(page, "Company Name")).toHaveValue("Mehta & Co");
  await expect(field(page, "GSTIN")).toHaveValue("27AAPFU0939F1ZV");
  await expect(save).toBeDisabled();

  // A refused save is shown as refused, with the reason.
  await field(page, "GSTIN").fill("123");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  await expect(page.getByText(/That GSTIN is not valid/).first()).toBeVisible();
  await expect(page.getByText("Your company details were updated.")).toHaveCount(0);
  expect(patches[0]).toMatchObject({ gstin: "123" });

  // A confirmed save says Saved and sends only the fields the company record stores.
  await field(page, "GSTIN").fill("27AAPFU0939F1ZV");
  await field(page, "Company Name").fill("Mehta & Co Pvt Ltd");
  await save.click();
  await expect(page.getByText("Your company details were updated.").first()).toBeVisible();
  expect(Object.keys(patches[1]).sort()).toEqual(["caEmail", "financialYearStart", "gstin", "name", "pan"]);
  expect(patches[1]).toMatchObject({ name: "Mehta & Co Pvt Ltd" });
});

test("Settings no longer shows made-up values or controls that do nothing", async ({ page }) => {
  await openSettings(page, [], []);
  for (const invented of ["U72900KA2022PTC160000", "Karnataka", "Bengaluru"]) await expect(page.getByText(invented)).toHaveCount(0);
  await expect(page.getByText("CIN", { exact: true })).toHaveCount(0);
  await expect(page.getByText("CA Name", { exact: true })).toHaveCount(0);

  // Notifications: nothing sends email yet, so there are no switches.
  await expect(page.getByText(/Email alerts are not switched on yet/)).toBeVisible();
  await expect(page.getByText("Coming soon", { exact: true })).toHaveCount(4);

  // Two-factor sign-in is not built: the button is off and says so. Data export is a real email link.
  await expect(page.getByRole("button", { name: /Two-factor sign-in: coming soon/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Request data export" })).toHaveCount(0);
  const mail = page.getByRole("link", { name: /^Email .*@/ });
  await expect(mail).toHaveAttribute("href", /^mailto:.+@.+\?subject=/);
});
