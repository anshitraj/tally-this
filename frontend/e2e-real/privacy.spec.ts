import { expect, test, type Page } from "@playwright/test";
import { MAY_STATEMENT } from "./data";
import { companyIdOf, runCount, setPlan, sql } from "./db";
import { api, sessionToken, signedUpAccount } from "./helpers";

/**
 * Incognito (privacy mode): a paid feature that saves nothing, and must never quietly fall back to saving.
 */

async function upload(page: Page) {
  await page.locator("input[type=file]").first().setInputFiles({ name: "private-statement.csv", mimeType: "text/csv", buffer: Buffer.from(MAY_STATEMENT.csv) });
}

async function clientCompany(email: string): Promise<number> {
  const [row] = await sql<{ id: number }>("select client_company_id as id from ca_client_links where ca_user_id = (select id from users where lower(email) = lower($1))", [email]);
  return row.id;
}

test.describe("Incognito", () => {
  test("is locked on the free plan, in the screen and in the server", async ({ page }) => {
    await signedUpAccount(page, "priv-free", "Free Client");
    await page.goto("/app/jobs/bank-to-tally");
    const incognito = page.getByRole("button", { name: /Incognito/ });
    await expect(incognito).toBeVisible();
    await expect(incognito).toHaveAccessibleName(/Premium locked/);
    await incognito.click();
    await expect(page.getByText(/Premium/).first()).toBeVisible();

    // Asking the server for it anyway is refused, and nothing is saved.
    const token = await sessionToken(page);
    const refused = await page.request.post("/api/jobs/bank-statement/normalize", {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { privacy: "1", file: { name: "s.csv", mimeType: "text/csv", buffer: Buffer.from(MAY_STATEMENT.csv) } },
    });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe("privacy_not_available");
  });

  test("on a paid plan nothing is saved: no run, no history, no audit of the work", async ({ page }) => {
    const account = await signedUpAccount(page, "priv-paid", "Paid Client");
    await setPlan(account.email, "starter");
    const own = await companyIdOf(account.email);
    const client = await clientCompany(account.email);
    const before = { runs: await runCount(client), audits: Number((await sql<{ n: number }>("select count(*)::int n from audit_logs where action like 'job.%' and company_id in ($1, $2)", [own, client]))[0].n) };

    await page.goto("/app/jobs/bank-to-tally");
    await page.getByRole("button", { name: "Incognito", exact: true }).click();
    await expect(page.getByRole("button", { name: "Incognito", exact: true })).toHaveAttribute("aria-pressed", "true");
    await upload(page);
    await expect(page.getByText("24 transactions detected")).toBeVisible();
    await expect(page.getByText(/Incognito · not saved/)).toBeVisible();

    // Nothing about this upload was written.
    expect(await runCount(client)).toBe(before.runs);
    expect(await runCount(own)).toBe(0);
    const after = Number((await sql<{ n: number }>("select count(*)::int n from audit_logs where action like 'job.%' and company_id in ($1, $2)", [own, client]))[0].n);
    expect(after).toBe(before.audits);
    const history = await api(page, "GET", "/api/jobs/history");
    expect(history.json.runs).toEqual([]);
    await page.goto("/app/history");
    await expect(page.getByText("private-statement.csv")).toHaveCount(0);
    await expect(page.getByText(/Incognito jobs aren.t saved/)).toBeVisible();
  });

  test("a plan that has ended stops Incognito instead of saving quietly", async ({ page }) => {
    const account = await signedUpAccount(page, "priv-lapsed", "Lapsed Client");
    await setPlan(account.email, "starter", "2020-01-01T00:00:00Z");
    const own = await companyIdOf(account.email);
    const client = await clientCompany(account.email);

    const token = await sessionToken(page);
    const refused = await page.request.post("/api/jobs/bank-statement/normalize", {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { privacy: "1", file: { name: "s.csv", mimeType: "text/csv", buffer: Buffer.from(MAY_STATEMENT.csv) } },
    });
    expect(refused.status()).toBe(403);
    expect(await runCount(client)).toBe(0);
    expect(await runCount(own)).toBe(0);
    const plan = await api(page, "GET", "/api/account/plan");
    expect(plan.json).toMatchObject({ plan: "free", privacyAvailable: false });
  });

  test("the plan belongs to the person's own workspace, not to the client that is open", async ({ page }) => {
    const account = await signedUpAccount(page, "priv-scope", "Scope Client");
    await setPlan(account.email, "starter");
    // A client's own plan is not what is checked: the signed-in person's is.
    const client = await clientCompany(account.email);
    await sql("update companies set plan = 'free' where id = $1", [client]);
    const plan = await api(page, "GET", "/api/account/plan", { headers: { "X-Client-Company-Id": String(client) } });
    expect(plan.json).toMatchObject({ plan: "starter", privacyAvailable: true });
  });
});
