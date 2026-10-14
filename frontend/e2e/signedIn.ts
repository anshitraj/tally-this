import type { Page } from "@playwright/test";

const user = { email: "e2e-user@example.test", name: "Test Accountant", role: "ca", company: "Test Practice", companyId: 1 };

/**
 * Gives a page a signed-in test session and answers every API call with an empty, harmless reply,
 * (an empty list) so page-level checks run against a fresh dev server without a real account or seed data.
 * Specs that care about specific API replies register their own routes afterwards.
 */
export async function signedIn(page: Page) {
  await page.addInitScript(value => {
    localStorage.setItem("finverify_auth", JSON.stringify({ user: value }));
    localStorage.setItem(`finverify_onboarding_complete:${value.email}`, "true");
  }, user);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("auth/me")) await route.fulfill({ json: { user, company: { name: user.company } } });
    else if (path.endsWith("practice/clients")) await route.fulfill({ json: { clients: [], source: "database" } });
    else if (path.endsWith("monthly-close/current/workflow")) {
      await route.fulfill({ json: {
        month: "2026-10", uploadedSources: [], parsedSources: [], importedSources: [], availableRecipes: [], recommendedRecipeId: null,
        recommendedAction: { id: "upload_files", label: "Upload Files", description: "Upload any finance files you have. You do not need every file to start.", enabled: true },
        sourceSummary: [], actionHistory: [], blockers: [], createdRecordCounts: {},
        subtitle: "Upload any files you have. TallyThis will show matching options based on uploaded sources.",
      } });
    } else if (path.endsWith("reports/summary")) {
      await route.fulfill({ json: {
        companyName: user.company, month: "October 2026", verificationScore: 0, caReadyStatus: "Not started", generatedAt: "2026-10-14T00:00:00.000Z",
        totalTransactions: 0, verifiedTransactions: 0, totalInvoices: 0, missingInvoices: 0, totalRisks: 0, highRisks: 0, totalPayroll: 0,
      } });
    } else await route.fulfill({ json: [] });
  });
}
