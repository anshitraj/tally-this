import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { addTeamMember } from "./db";
import { readWorkbook, savedDownload } from "./files";
import { PASSWORD, api, signedUpAccount, uniqueEmail, watchProblems } from "./helpers";
import { COMPANY_BOOKS, DAY_BOOK_ONLY, EXPECTED, MASTERS_ONLY } from "./tally-export";

/**
 * Tax Audit & Ledger Scrutiny (under Advanced), against the real worker, API and database: a Tally export goes in, the
 * twenty checks come out. The books are in tally-export.ts and every number here was worked out from them by hand.
 */

const exportFile = (xml: string, name = "company.xml") => ({ name, mimeType: "text/xml", buffer: Buffer.from(xml) });

async function importExport(page: Page, xml: string) {
  await page.locator("input[type=file]").first().setInputFiles(exportFile(xml));
}

/** The checks for the client that is open, as the page asks for them. */
async function taxAudit(page: Page) {
  const clients = await api(page, "GET", "/api/practice/clients?light=1");
  const clientId = clients.json.clients[0].companyId as number;
  const result = await api(page, "GET", "/api/tax-audit", { headers: { "X-Client-Company-Id": String(clientId) } });
  expect(result.status, result.text).toBe(200);
  return result.json as { source: string; summary: { id: string; count: number; severity: string; notRun?: string }[]; stats: { flagged: number; total: number; highSeverity: number; notRun: number } };
}

async function openCheck(page: Page, title: string) {
  await page.getByRole("button", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
}

const closeCheck = (page: Page) => page.mouse.click(5, 5);

test.describe("Tax Audit", () => {
  test("a company that has imported nothing sees the demo company, labelled as demo, and every check ran", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "ta-demo", "Audit Demo Client");
    await page.goto("/app/tax-audit");
    await expect(page.getByRole("heading", { name: "Tax Audit & Ledger Scrutiny" })).toBeVisible();
    await expect(page.getByText("Showing demo data")).toBeVisible();
    await expect(page.getByText(/of 20 checks flagged/)).toBeVisible();
    await expect(page.getByTestId("not-run-banner")).toHaveCount(0);

    const audit = await taxAudit(page);
    expect(audit.source).toBe("demo");
    expect(audit.summary).toHaveLength(20);
    expect(audit.stats.notRun).toBe(0);
    seen.expectNone();
  });

  test("an export with ledger masters and vouchers gives the company's own findings, and says what could not run", async ({ page }) => {
    const seen = watchProblems(page);
    await signedUpAccount(page, "ta-own", "Audit Client");
    await page.goto("/app/tax-audit");
    await importExport(page, COMPANY_BOOKS);

    await expect(page.getByText("Tally data imported", { exact: true })).toBeVisible();
    await expect(page.getByText("Showing demo data")).toHaveCount(0);
    await expect(page.getByText(`${EXPECTED.flagged} of ${EXPECTED.total} checks flagged · ${EXPECTED.high} high-severity · ${EXPECTED.notRun} could not run`)).toBeVisible();

    // The numbers behind the cards, check by check.
    const audit = await taxAudit(page);
    expect(audit.source).toBe("tally");
    expect(audit.stats).toEqual({ flagged: EXPECTED.flagged, total: EXPECTED.total, highSeverity: EXPECTED.high, notRun: EXPECTED.notRun });
    const counts = Object.fromEntries(audit.summary.filter(c => !c.notRun).map(c => [c.id, c.count]));
    expect(counts).toEqual(EXPECTED.rows);
    expect(audit.summary.filter(c => c.notRun).map(c => c.id).sort()).toEqual(EXPECTED.notRunIds);

    // The page says the same: a banner with the reasons, and "Not run" where a card could not run (never "Clear").
    const banner = page.getByTestId("not-run-banner");
    await expect(banner).toContainText("4 of 20 checks could not run on this data");
    await expect(banner).toContainText("no fixed-asset schedule");
    await expect(banner).toContainText("no prior-year balances");
    await expect(banner).toContainText("No ledger in the group Capital Account");
    await expect(page.getByRole("button", { name: /Depreciation — Asset-wise/ })).toContainText("Not run");
    await expect(page.getByRole("button", { name: /Negative Ledger Balances/ })).toContainText("1 flagged");
    await expect(page.getByRole("button", { name: /MSME Creditors/ })).toContainText("Nothing to show");

    // One party, one day: Vendor B was paid 12,000 in cash on one day. Vendor A's two 6,000 payments were a month apart.
    await openCheck(page, "Creditors — Cash Payments > ₹10k in a Day");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("cell", { name: "Vendor B" })).toBeVisible();
    await expect(dialog.getByRole("cell", { name: "12,000" }).first()).toBeVisible();
    await expect(dialog.getByRole("cell", { name: "Vendor A" })).toHaveCount(0);
    await expect(dialog).toContainText("Potential risk — needs CA review.");
    await closeCheck(page);
    await expect(dialog).toHaveCount(0);

    // The vouchers keep their own numbers although Tally numbered a Receipt, a Payment and a Journal "1".
    await openCheck(page, "Cash Receipts ≥ ₹2,00,000");
    await expect(dialog.getByRole("cell", { name: "Receipt 1" })).toBeVisible();
    await expect(dialog.getByRole("cell", { name: "2,50,000" })).toBeVisible();
    await closeCheck(page);
    await expect(dialog).toHaveCount(0);

    // A check that could not run says so in its own window, and never "passed".
    await openCheck(page, "Depreciation — Asset-wise");
    await expect(dialog).toContainText("Not run on this data");
    await expect(dialog).not.toContainText(/passed/i);
    await closeCheck(page);
    await expect(dialog).toHaveCount(0);

    // Ratios worked out from the groups: sales 10,00,000, cost of goods 5,00,000, indirect expenses 3,60,000.
    await openCheck(page, "Ratio Analysis");
    const value = (ratio: RegExp) => dialog.getByRole("row", { name: ratio }).getByRole("cell").nth(1);
    await expect(value(/Gross Profit \/ Turnover/)).toHaveText("50");
    await expect(value(/Net Profit \/ Turnover/)).toHaveText("14");
    await expect(value(/Stock Turnover/)).toHaveText("3.33");
    await expect(value(/Material Consumed/)).toHaveText("60");
    await expect(dialog).toContainText("Direct expenses, other income and taxes are not included");
    seen.expectNone();
  });

  test("a Day Book alone (vouchers, no ledger masters) is the company's own data, and the cash checks say they could not run", async ({ page }) => {
    await signedUpAccount(page, "ta-daybook", "Day Book Client");
    await page.goto("/app/tax-audit");
    await importExport(page, DAY_BOOK_ONLY);

    // The import answers at once with what the file lacks.
    await expect(page.getByText(/no ledger masters/).first()).toBeVisible();
    await expect(page.getByText("Showing demo data")).toHaveCount(0);

    const audit = await taxAudit(page);
    expect(audit.source).toBe("tally");
    // Only the journal after 31 March can be judged from vouchers with no groups or balances.
    expect(audit.summary.filter(c => !c.notRun).map(c => c.id)).toEqual(["post-yearend-jv"]);
    expect(audit.stats.notRun).toBe(19);
    await expect(page.getByRole("button", { name: /Creditors — Cash Payments > ₹10k in a Day/ })).toContainText("Not run");
    await expect(page.getByRole("button", { name: /Cash Exposure Ratio/ })).toContainText("Not run");
    await expect(page.getByRole("button", { name: /Journal Vouchers After 31 March/ })).toContainText("1 flagged");
  });

  test("ledger masters alone leave the checks on vouchers not run, and the balance checks run", async ({ page }) => {
    await signedUpAccount(page, "ta-masters", "Masters Client");
    await page.goto("/app/tax-audit");
    await importExport(page, MASTERS_ONLY);
    await expect(page.getByText(/ledger masters but no vouchers/).first()).toBeVisible();

    const audit = await taxAudit(page);
    const ran = audit.summary.filter(c => !c.notRun).map(c => c.id);
    for (const id of ["neg-balances", "same-op-cl", "clause-40", "clause-23", "clause-44", "clause-22", "tds-tcs", "ageing"]) expect(ran, id).toContain(id);
    for (const id of ["creditor-cash", "cash-exposure", "clause-31", "sec-269st", "party-jv", "post-yearend-jv"]) expect(ran, id).not.toContain(id);
    expect(audit.summary.find(c => c.id === "neg-balances")?.count).toBe(1);
  });

  test("a file that is not a Tally export is refused in plain words and changes nothing", async ({ page }) => {
    await signedUpAccount(page, "ta-bad", "Bad File Client");
    await page.goto("/app/tax-audit");
    await importExport(page, "<html><body>this is a web page</body></html>", );
    await expect(page.getByText("Import failed")).toBeVisible();
    await expect(page.getByText("No ledgers or vouchers found in file.")).toBeVisible();
    await expect(page.getByText("Showing demo data")).toBeVisible();

    await importExport(page, "<ENVELOPE><BODY>");
    await expect(page.getByText("No ledgers or vouchers found in file.").first()).toBeVisible();
    expect((await taxAudit(page)).source).toBe("demo");
  });

  test("Reset to demo takes the imported books away, and importing again brings the same findings back", async ({ page }) => {
    await signedUpAccount(page, "ta-reset", "Reset Client");
    await page.goto("/app/tax-audit");
    await importExport(page, COMPANY_BOOKS);
    await expect(page.getByText(`${EXPECTED.flagged} of ${EXPECTED.total} checks flagged`)).toBeVisible();

    await page.getByRole("button", { name: "Reset to demo" }).click();
    await expect(page.getByText("Reverted to demo data")).toBeVisible();
    await expect(page.getByText("Showing demo data")).toBeVisible();
    expect((await taxAudit(page)).source).toBe("demo");

    // Importing the same file twice replaces the books rather than adding to them.
    await importExport(page, COMPANY_BOOKS);
    await expect(page.getByText(`${EXPECTED.flagged} of ${EXPECTED.total} checks flagged`)).toBeVisible();
    await importExport(page, COMPANY_BOOKS);
    await expect(page.getByText("Tally data imported").first()).toBeVisible();
    const audit = await taxAudit(page);
    expect(Object.fromEntries(audit.summary.filter(c => !c.notRun).map(c => [c.id, c.count]))).toEqual(EXPECTED.rows);
  });

  test("the evidence pack is a workbook with a summary and a sheet for each check, and says Not run where it could not", async ({ page }) => {
    await signedUpAccount(page, "ta-pack", "Pack Client");
    await page.goto("/app/tax-audit");
    await importExport(page, COMPANY_BOOKS);
    await expect(page.getByText(`${EXPECTED.flagged} of ${EXPECTED.total} checks flagged`)).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Evidence Pack (Excel)" }).click()]);
    const file = await savedDownload(download);
    expect(file.name).toBe("TallyThis_Tax_Audit_Pack_Client_2026-03-31.xlsx");
    const sheets = await readWorkbook(file.bytes);
    expect(sheets).toHaveLength(21);
    expect(sheets[0].name).toBe("Summary");

    const text = (rows: unknown[][]) => rows.map(row => row.map(cell => String(cell ?? "")).join(" | "));
    const summary = text(sheets[0].rows);
    expect(summary.some(row => row.includes("Imported Tally data"))).toBe(true);
    const summaryRow = (title: string) => summary.find(row => row.includes(title)) ?? "";
    expect(summaryRow("Creditors — Cash Payments > ₹10k in a Day")).toMatch(/\| 1$/);
    expect(summaryRow("Depreciation — Asset-wise (Additions & Deletions)")).toMatch(/Not run$/);

    const sheetFor = (prefix: string) => sheets.find(sheet => sheet.name.startsWith(prefix));
    expect(text(sheetFor("15 ")?.rows ?? []).join("\n")).toContain("Not run: This import has no fixed-asset schedule.");
    const cash = text(sheetFor("12 ")?.rows ?? []).join("\n");
    expect(cash).toContain("Vendor B");
    expect(cash).not.toContain("Vendor A");
  });

  test("the Practice page shows no findings for a client with nothing imported, then the client's own once it is", async ({ page }) => {
    await signedUpAccount(page, "ta-practice", "Practice Audit Client");
    await page.goto("/app/practice");
    const card = page.getByRole("button", { name: /Practice Audit Client/ });
    await expect(card).toContainText("No Tally data imported yet");
    await expect(card).not.toContainText("checks flagged");
    await expect(page.getByText("Showing demo clients")).toHaveCount(0);

    await page.goto("/app/tax-audit");
    await importExport(page, COMPANY_BOOKS);
    await expect(page.getByText(`${EXPECTED.flagged} of ${EXPECTED.total} checks flagged`)).toBeVisible();

    await page.goto("/app/practice");
    await expect(page.getByRole("button", { name: /Practice Audit Client/ })).toContainText(`${EXPECTED.flagged}/${EXPECTED.total} checks flagged`);
  });
});

// ── who can import, and whose books ─────────────────────────────────────────

interface Person { token: string; email: string }

async function register(request: APIRequestContext, label: string): Promise<Person> {
  const email = uniqueEmail(label);
  const response = await request.post("/api/auth/register", { data: { name: "Test Person", email, password: PASSWORD, companyName: `${label} Co` } });
  expect(response.status(), await response.text()).toBe(201);
  return { token: (await response.json()).token, email };
}

const as = (person: Pick<Person, "token">) => ({ Authorization: `Bearer ${person.token}` });
const upload = (request: APIRequestContext, person: Person, xml: string) =>
  request.post("/api/tax-audit/import", { headers: as(person), multipart: { file: { name: "company.xml", mimeType: "text/xml", buffer: Buffer.from(xml) } } });

test.describe("Tax Audit: whose books", () => {
  test("one company's import is invisible to another, and clearing it clears only the caller's", async ({ request }) => {
    const first = await register(request, "ta-iso-a");
    const second = await register(request, "ta-iso-b");
    expect((await upload(request, first, COMPANY_BOOKS)).status()).toBe(200);

    const mine = await (await request.get("/api/tax-audit", { headers: as(first) })).json();
    const theirs = await (await request.get("/api/tax-audit", { headers: as(second) })).json();
    expect([mine.source, theirs.source]).toEqual(["tally", "demo"]);

    expect((await request.delete("/api/tax-audit/import", { headers: as(second) })).status()).toBe(200);
    expect((await (await request.get("/api/tax-audit", { headers: as(first) })).json()).source).toBe("tally");
    expect((await (await request.delete("/api/tax-audit/import", { headers: as(first) })).json()).source).toBe("demo");
  });

  test("a read-only team member can read the findings but not import, clear or ask the connector", async ({ request }) => {
    const owner = await register(request, "ta-role");
    expect((await upload(request, owner, COMPANY_BOOKS)).status()).toBe(200);
    const viewerEmail = uniqueEmail("ta-viewer");
    await addTeamMember(owner.email, viewerEmail, "viewer");
    const login = await request.post("/api/auth/login", { data: { email: viewerEmail, password: PASSWORD } });
    expect(login.status(), await login.text()).toBe(200);
    const viewer: Person = { token: (await login.json()).token, email: viewerEmail };

    expect((await request.get("/api/tax-audit", { headers: as(viewer) })).status()).toBe(200);
    expect((await upload(request, viewer, COMPANY_BOOKS)).status()).toBe(403);
    expect((await request.delete("/api/tax-audit/import", { headers: as(viewer) })).status()).toBe(403);
    expect((await request.post("/api/tax-audit/connector/sync", { headers: as(viewer), data: { company: "X" } })).status()).toBe(403);
    // Nothing the viewer tried changed the books.
    expect((await (await request.get("/api/tax-audit", { headers: as(owner) })).json()).source).toBe("tally");
  });

  test("the live Tally connector refuses an address that is not this computer, and is not offered a cloud address", async ({ request }) => {
    const person = await register(request, "ta-conn");
    const refused = await request.post("/api/tax-audit/connector/sync", { headers: as(person), data: { company: "Test Co", host: "169.254.169.254", port: 9000 } });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).ok).toBe(false);
    const missing = await request.post("/api/tax-audit/connector/sync", { headers: as(person), data: {} });
    expect(missing.status()).toBe(400);
  });
});
