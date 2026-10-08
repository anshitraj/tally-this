# Product workflows

FinVerify is accounting automation for CAs, accountants, and finance teams.

Promise: Upload. Verify. Export.

The live app is upload-based. Direct bank feeds, GST portal filing, and a hosted Tally connection are not live. A local Tally connector exists for a Tally instance the customer runs.

## Onboarding

Three steps: create account, add the first client (one name field; role and accounting software are tap choices), choose an automation. GSTIN, PAN, state and industry are never required up front.

## Home

One drop zone. `POST /api/jobs/detect` classifies each file (bank statement, Tally export, marketplace report, invoice list, invoice document) and opens the matching job with the files already loaded. Two-file jobs start as soon as both files are in.

## Jobs

1. Bank Statement → Tally. Upload PDF, scanned PDF, photo, CSV, or Excel. A locked PDF asks for its password as soon as it is dropped. Text PDFs are read by column position; the bank comes from the IFSC in the header, plus account (last four digits) and period. Every row must match the bank's running balance, and the printed opening/closing balance and row numbers when present; the page shows "Every row matches the bank's running balance" only when all of that holds. Scanned or unproven statements get a second, independent read by Gemini (Claude only if Gemini fails), scored by the same proof. Rows that break the chain go to review (Looks right / It's money in or out / Leave out). Parties are grouped and each gets a ledger from a fixed list (remembered choice → keyword rules → AI choosing from the list). The reviewer picks from chips or a list; nothing is typed. XML is returned only after structure checks pass and includes create-only ledger masters.
2. Bank ↔ Tally. Upload one bank file and one Tally export (Excel or CSV). Matching is rules-first: amount, date distance, name similarity, reference, and direction. The Tally debit/credit convention is detected per file. A pair with the only matching amount on both sides within two days is confirmed. Review actions are Confirm match / Not a match / Ask client (or Noted / Ignore / Ask client for one-sided items). Report downloads as CSV; draft and final JSON stay under More options.
3. E-commerce GST. Amazon, Flipkart, Meesho, Myntra, JioMart, or a generic file, CSV or Excel, several at once. The marketplace is detected from the file name or header. Review groups issues by type. Exports are a draft GST JSON plus an accounting CSV; Tally XML is under More options. The JSON is not GST portal validation. Wording for issues is "Potential risk — needs CA review."
4. Invoice ↔ Bank. Upload a bank file and an invoice list or invoice PDFs/photos (read by AI, pending review). Exact amount plus the invoice number in the narration is a match. Salary, cash, tax, loan and bank-charge rows are set aside as "no invoice expected". Suggestions stay pending review. The product does not say "Verified by AI."

## History

`/app/history` lists every run for the active client, newest first, with the person who ran it. Items open to the saved result: transactions and the running-balance proof with the Tally file for Bank → Tally; matched and attention items with the report for the two comparisons; totals and GST drafts for E-commerce GST. Older month-end and import runs appear under Older work. The four jobs do not store the uploaded file itself.

## Runs

`workflow_runs`, `run_sources`, `run_artifacts`, and `action_history` are created by `scripts/migrate-workflow-runs.sql`. Job results are stored on the run. Progress is `GET /api/workflow/runs/:id/progress`. `GET /api/workflow/runs` lists runs for the active client.

Activity is the workflow audit trail, shown in plain language. Upload history on the upload center is the file trail.

## Advanced

Payroll, gateway settlements, tax audit, evidence, and the older upload center stay under Advanced. `/app/uploads?view=advanced` opens the detailed parse view.

## AI

AI may help read a document or pick a ledger from a fixed list. It does not decide the books. Labels stay "AI extracted — pending review" and "Suggested match — needs review." Provider order is Gemini (main model, then fallback models), then Claude as a paid last resort, then rule-based.
