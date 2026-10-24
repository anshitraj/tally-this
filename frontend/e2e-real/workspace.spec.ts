import { expect, test, type Page } from "@playwright/test";
import { MAY_STATEMENT } from "./data";
import { companyIdOf, sql } from "./db";
import { api, newAccount, setUpWorkspace, signUp, signedUpAccount, watchProblems } from "./helpers";

/**
 * The parts of the workspace that sit around the jobs: Settings, Clients, History, Activity and Reports, against the
 * real backend.
 */

async function runBankToTally(page: Page, fileName = "hdfc-may-2026.csv") {
  await page.goto("/app/jobs/bank-to-tally");
  await page.locator("input[type=file]").first().setInputFiles({ name: fileName, mimeType: "text/csv", buffer: Buffer.from(MAY_STATEMENT.csv) });
  await expect(page.getByText("24 transactions detected")).toBeVisible();
}

const clientSwitcher = (page: Page) => page.getByLabel("Client", { exact: true });

test.describe("Settings", () => {
  test("shows and saves the person's own firm, not the client that is open", async ({ page }) => {
    // Regression: Settings used to read the open client's company but save to the signed-in person's own firm,
    // so a GSTIN typed for the client ended up on the CA's firm.
    const seen = watchProblems(page);
    const account = newAccount("settings", { firm: "Rao & Co" });
    await signUp(page, account);
    await setUpWorkspace(page, "Client One");
    await page.goto("/app/settings");

    await expect(page.getByLabel("Company Name")).toHaveValue("Rao & Co");
    await expect(page.getByText(account.email).first()).toBeVisible();
    await page.getByLabel("GSTIN").fill("27AAPFU0939F1ZV");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Your company details were updated.", { exact: true })).toBeVisible();

    const own = await api(page, "GET", "/api/company");
    expect(own.json).toMatchObject({ name: "Rao & Co", gstin: "27AAPFU0939F1ZV" });
    // The client's own record is untouched.
    const [client] = await sql<{ gstin: string | null }>(
      "select gstin from companies where id = (select client_company_id from ca_client_links where ca_user_id = (select id from users where email = $1))",
      [account.email],
    );
    expect(client.gstin).toBeNull();
    // The team list is the person's own team, not the (empty) client's.
    await expect(page.getByText("founder").first()).toBeVisible();
    seen.expectNone();
  });

  test("a GSTIN with a wrong check character is refused with the reason and nothing is saved", async ({ page }) => {
    const seen = watchProblems(page, [/400/, /Failed to load resource/]);
    await signedUpAccount(page, "settings-bad", "Bad Gstin Client");
    await page.goto("/app/settings");
    await page.getByLabel("GSTIN").fill("27AAPFU0939F1ZX");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
    const own = await api(page, "GET", "/api/company");
    expect(own.json.gstin).toBeNull();
    expect(seen.problems.filter(problem => /page error/.test(problem))).toEqual([]);
  });
});

test.describe("Clients", () => {
  test("add, rename, switch and remove a client; the same name twice is refused", async ({ page }) => {
    const seen = watchProblems(page, [/409/, /Failed to load resource/]);
    await signedUpAccount(page, "clients", "First Client");
    await page.goto("/app/clients");
    await expect(page.getByText("First Client").filter({ visible: true }).first()).toBeVisible();

    const addClient = async (name: string) => {
      await page.getByRole("button", { name: "Add client" }).click();
      await page.locator("#new-client").fill(name);
      await page.getByRole("button", { name: "Save client" }).click();
    };
    await addClient("Second Client");
    await expect(page.getByText("Now working on Second Client.")).toBeVisible();
    await expect(clientSwitcher(page).locator("option:checked")).toHaveText("Second Client");

    // The same name again, in other capitals, is not added.
    await addClient("second client");
    await expect(page.getByText("You already have a client with this name.")).toBeVisible();
    let clients = await api(page, "GET", "/api/practice/clients?light=1");
    expect(clients.json.clients.map((client: { name: string }) => client.name).sort()).toEqual(["First Client", "Second Client"]);

    // Rename.
    await page.getByRole("button", { name: "Rename Second Client" }).click();
    await page.getByLabel("Client name").fill("Second Client Ltd");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByText("Name updated")).toBeVisible();
    await expect(page.getByText("Second Client Ltd").filter({ visible: true }).first()).toBeVisible();

    // Remove from the list: the client's company and its work are kept.
    const secondId = clients.json.clients.find((client: { name: string }) => client.name === "Second Client").companyId as number;
    await page.getByRole("button", { name: "Remove Second Client Ltd" }).click();
    await page.getByRole("button", { name: "Yes, remove" }).click();
    await expect(page.getByText("Client removed from your list")).toBeVisible();
    clients = await api(page, "GET", "/api/practice/clients?light=1");
    expect(clients.json.clients.map((client: { name: string }) => client.name)).toEqual(["First Client"]);
    const kept = await sql("select id from companies where id = $1", [secondId]);
    expect(kept).toHaveLength(1);
    expect(seen.problems.filter(problem => /page error/.test(problem))).toEqual([]);
  });

  test("each client keeps its own history and activity", async ({ page }) => {
    await signedUpAccount(page, "per-client", "Client Alpha");
    // A second client through the API (the same call the Clients page makes), then work on each in turn.
    const second = await api(page, "POST", "/api/practice/clients", { body: { name: "Client Beta" } });
    expect(second.status).toBe(200);

    await runBankToTally(page);
    await page.goto("/app/history");
    await expect(page.getByText("hdfc-may-2026.csv")).toBeVisible();
    await page.goto("/app/activity");
    // Activity lists the work done on this client (it used to stay empty for a client's work).
    await expect(page.getByText("Nothing here yet.")).toHaveCount(0);

    await clientSwitcher(page).selectOption({ label: "Client Beta" });
    await page.goto("/app/history");
    await expect(page.getByText("hdfc-may-2026.csv")).toHaveCount(0);
    await page.goto("/app/activity");
    await expect(page.getByText("Nothing here yet.")).toBeVisible();

    await clientSwitcher(page).selectOption({ label: "Client Alpha" });
    await page.goto("/app/history");
    await expect(page.getByText("hdfc-may-2026.csv")).toBeVisible();
  });

  test("a client cannot be reached by someone who was not given it", async ({ page, browser }) => {
    await signedUpAccount(page, "owner-a", "Private Client");
    const owned = await api(page, "GET", "/api/practice/clients?light=1");
    const clientId = owned.json.clients[0].companyId as number;

    const other = await browser.newContext();
    const stranger = await other.newPage();
    await signedUpAccount(stranger, "stranger-b", "Their Own Client");
    const attempt = await api(stranger, "GET", "/api/jobs/history", { headers: { "X-Client-Company-Id": String(clientId) } });
    expect(attempt.status).toBe(403);
    const viaQuery = await api(stranger, "GET", `/api/jobs/history?client=${clientId}`);
    expect(viaQuery.status).toBe(403);
    await other.close();
  });
});

test.describe("History, Activity and Reports", () => {
  test("a saved run opens again with its result and downloads", async ({ page }) => {
    await signedUpAccount(page, "hist", "History Client");
    await runBankToTally(page);
    await page.goto("/app/history");
    await expect(page.getByText("HDFC Bank · 24 transactions · May 2026")).toBeVisible();
    await page.getByRole("button", { name: /^View / }).first().click();
    await expect(page).toHaveURL(/\/app\/history\/.+/);
    await expect(page.getByText(/24 transactions|HDFC Bank/).first()).toBeVisible();
  });

  test("work older than the history window is kept but not listed, and the person is told", async ({ page }) => {
    const account = await signedUpAccount(page, "old", "Old Work Client");
    const [client] = await sql<{ id: number }>("select client_company_id as id from ca_client_links where ca_user_id = (select id from users where email = $1)", [account.email]);
    await sql(
      `insert into workflow_runs (company_id, run_type, title, status, created_at, metadata_json)
       values ($1, 'bank_to_tally', 'Bank Statement → Tally — january.csv', 'completed', now() - interval '5 months', $2::jsonb)`,
      [client.id, JSON.stringify({ clientId: client.id })],
    );
    await runBankToTally(page, "this-month.csv");
    await page.goto("/app/history");
    await expect(page.getByText("this-month.csv")).toBeVisible();
    await expect(page.getByText("january.csv")).toHaveCount(0);
    await expect(page.getByText(/1 older item is kept safely/)).toBeVisible();
  });

  test("Activity lists the work in plain words, with who did it", async ({ page }) => {
    const account = await signedUpAccount(page, "activity", "Activity Client");
    await runBankToTally(page);
    await page.goto("/app/activity");
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
    await expect(page.getByText(account.email).first()).toBeVisible();
    // No internal names such as action codes are shown.
    await expect(page.getByText(/job\.bank_statement_parsed/)).toHaveCount(0);
  });

  test("Reports opens for the month and offers the month pack", async ({ page }) => {
    await signedUpAccount(page, "reports", "Reports Client");
    await runBankToTally(page);
    await page.goto("/app/reports");
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    await expect(page.getByText(/1 job saved in/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Download month pack" })).toBeVisible();
  });
});

test("the company id of an account is the one its work is saved under", async ({ page }) => {
  // Work done as a CA on a client is saved under the client's company, not the CA's own.
  const account = await signedUpAccount(page, "ids", "Ids Client");
  await runBankToTally(page);
  const own = await companyIdOf(account.email);
  const rows = await sql<{ company_id: number }>(
    "select company_id from workflow_runs where created_by = (select id from users where lower(email) = lower($1))",
    [account.email],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].company_id).not.toBe(own);
});
