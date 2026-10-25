import { test, expect } from "@playwright/test";
import { signedIn } from "./signedIn";

/**
 * A file can go in while the page's own first request for "what has been uploaded" is still loading: the drop zone is
 * there from the first moment. The next-step panel must still end up knowing about the file, not keep the answer that
 * was worked out before it.
 */

const NOTHING_YET = {
  month: "2026-10", uploadedSources: [], parsedSources: [], importedSources: [], availableRecipes: [], recommendedRecipeId: null,
  recommendedAction: { id: "upload_files", label: "Upload Files", description: "Upload any finance files you have.", enabled: true },
  sourceSummary: [], actionHistory: [], blockers: [], createdRecordCounts: {},
};

const BATCH = { id: 7, sourceType: "bank_statement", fileName: "may.csv", status: "processed", uploadedAt: "2026-10-25T10:00:00.000Z", recordCount: 2 };

test("the next-step panel hears about a file that went in while it was still loading", async ({ page }) => {
  await signedIn(page);
  let uploaded = false;
  let slowAnswerSent: () => void = () => {};
  const slowAnswer = new Promise<void>(resolve => { slowAnswerSent = resolve; });
  const asked: string[] = [];

  await page.route("**/api/uploads", async route => {
    if (route.request().method() === "POST") {
      uploaded = true;
      await route.fulfill({
        status: 201,
        json: {
          ...BATCH,
          parsing: { documentId: 1, parser: "csv", status: "parsed", rowCount: 2, detectedColumns: ["Date", "Narration", "Debit", "Credit", "Balance"], notes: [] },
          imported: { table: "bank_transactions", inserted: 2, skipped: 0, notes: [] },
          reconciliation: null,
        },
      });
    } else {
      await route.fulfill({ json: uploaded ? [BATCH] : [] });
    }
  });

  // The first answer is slow and is worked out from the state before the upload; the one asked for afterwards is quick.
  await page.route("**/api/monthly-close/current/workflow", async route => {
    if (!uploaded) {
      asked.push("before the upload");
      await new Promise(resolve => setTimeout(resolve, 1500));
      await route.fulfill({ json: { ...NOTHING_YET, subtitle: "NOTHING-UPLOADED-YET" } });
      slowAnswerSent();
    } else {
      asked.push("after the upload");
      await route.fulfill({ json: { ...NOTHING_YET, parsedSources: ["bank_statement"], subtitle: "STATEMENT-IS-READY" } });
    }
  });

  await page.goto("/app/uploads");
  const statement = "Date,Narration,Debit,Credit,Balance\n01/05/2026,UPI-ACME,,500.00,1500.00\n02/05/2026,NEFT-RENT,200.00,,1300.00\n";
  await page.locator("input[type=file]").first().setInputFiles({ name: "may.csv", mimeType: "text/csv", buffer: Buffer.from(statement) });

  await expect(page.getByText("2 rows").first()).toBeVisible();
  await expect(page.getByText("STATEMENT-IS-READY")).toBeVisible();

  // The slow answer, which belongs to the time before the upload, arrives afterwards and must not replace it.
  await slowAnswer;
  await page.waitForTimeout(300);
  await expect(page.getByText("STATEMENT-IS-READY")).toBeVisible();
  await expect(page.getByText("NOTHING-UPLOADED-YET")).toHaveCount(0);
  expect(asked).toEqual(["before the upload", "after the upload"]);
});
