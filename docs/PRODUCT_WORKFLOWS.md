# Product workflows

FinVerify is accounting automation for CAs, accountants, and finance teams.

Promise: Upload. Verify. Export.

The live app is upload-based. Direct bank feeds, GST portal filing, and a hosted Tally connection are not live. A local Tally connector exists for a Tally instance the customer runs.

## Onboarding

Three steps: create account, add the first client (one name field; role and accounting software are tap choices), choose an automation. GSTIN, PAN, state and industry are never required up front.

## Home

One drop zone. `POST /api/jobs/detect` classifies each file (bank statement, Tally export, marketplace report, invoice list, invoice document) and opens the matching job with the files already loaded. Two-file jobs start as soon as both files are in.

## Jobs

After a bank upload, Statement opens with the detected bank, totals and the bank-format transaction table, including opening/closing balances. Download Excel and Download Tally XML are available directly; Review is a separate tab. Conversion-only exports use Suspense without requiring ledger assignments. Confirmed ledger choices can be enabled in Review; unconfirmed suggestions remain in Suspense. Search filters the preview, never the exported rows. AI ledger review is an unchecked opt-in and is unavailable in Incognito. Actual uncertain amounts and unproven totals still require source checks before XML; Excel stays available as a working copy. Successful balance-check detail and settings stay under More options. How it works explains upload → preview → download.

After a marketplace upload, GST report opens with a single section selector for B2B, B2C, HSN, TCS, Documents and Table 14; corrections live in Review and downloads live in Export. Opening a report or switching tabs never downloads a file. Compact totals and one next action lead the result; the upload mode becomes a small indicator once the job starts. GST summaries are readable business reports; source rows stay under Show source rows and configuration stays under More options. Financial warnings and export checks remain visible.

1. Bank Statement → Tally. Upload PDF, scanned PDF, photo, CSV, or Excel. A locked PDF asks for its password as soon as it is dropped. Text PDFs are read by column position; bank identity comes from header IFSC or printed name, with masked account and period when found. Running-balance, opening/closing and sequence checks run automatically. A complete proof requires every transaction amount to pass; partial checks do not become a complete proof. Scanned or unproven statements may need an independent AI reading, subject to the existing privacy consent policy. This reading is separate from optional AI ledger review. Rows that break the chain go to Review (Looks right / It's money in or out / Leave out). Conversion-only XML uses Receipt/Payment vouchers against Suspense. Users may choose ledgers from rules, remembered choices or opt-in AI suggestions; only confirmed choices enter mapped exports. Excel, XML, CSV and direct posting use the same selected ledger/voucher choices. XML is returned only after structure checks; actual TallyPrime acceptance remains unverified.
2. Bank ↔ Tally. Upload one bank file and one Tally export (Excel or CSV). Matching is rules-first: amount, date distance, name similarity, reference, and direction. The Tally debit/credit convention is inferred per file. Unique amount/date pairs and high similarity alone stay as suggestions. The confirmed bucket requires exact paise, a complete shared reference, matching direction, a two-day window and no competing amount/date candidates. Review actions are Confirm match / Not a match / Ask client (or Noted / Ignore / Ask client for one-sided items). Report downloads as CSV; draft and final JSON stay under More options.
3. E-commerce GST. Upload several CSV/Excel marketplace reports. Twelve marketplace names plus generic columns are recognized, but real report-layout coverage remains unverified. Review flagged rows, correct HSN/rates in bulk, edit document counts and compare an uploaded state/TCS summary. Signed source amounts and cess are preserved. A supported credit note must identify one original invoice row in the same upload, match buyer/place/HSN/rate, have consistent signs and dates, and not exceed the original values cumulatively. Valid linked notes reduce net totals and HSN; the Credit notes section and workbook sheet retain their original amounts. XML creates reversed Credit Note ledger lines. Unlinked returns, unsupported adjustments and invalid notes stop XML; cancelled rows are explicitly left out. The Export tab offers a proprietary GST review draft with CSV, an Excel working copy, or Sales/Credit Note XML for a test Tally import. Multi-line/cross-period links, settlements, portal acceptance and actual TallyPrime import remain unverified. Wording for issues is "Potential risk — needs CA review."
4. Invoice ↔ Bank. Upload a bank file and an invoice list or invoice PDFs/photos (read by AI, pending review). Exact amount plus the invoice number in the narration is a match. Salary, cash, tax, loan and bank-charge rows are set aside as "no invoice expected". Suggestions stay pending review. The product does not say "Verified by AI."

## History

`/app/history` lists the last three months of runs (`HISTORY_MONTHS`) for the active client, newest first, with the person who ran it. Older runs are kept in the database and are not shown: the page tells the person how many are waiting and to email us, and a direct link to one returns "older than 3 months, email us". Items open to the saved result: transactions and the running-balance proof with the Tally file for Bank → Tally; matched and attention items with the report for the two comparisons; totals and GST drafts for E-commerce GST. Month-end and import runs appear under Other. The four jobs do not store the uploaded file itself.

## Privacy mode

A switch at the top of each job, for paid plans. On: nothing from the upload is saved (no run, result, history entry, audit or AI-usage row, remembered ledger choice, or file) and the result lives only on the page until the person downloads it. Off for free accounts: a short line says it is part of the paid plans and how to ask for it. A person whose plan lapsed while the switch was on is stopped with a clear message rather than saved quietly.

A scan or photo cannot be read without AI. Privacy mode asks first ("This scan needs AI to be read"), one file at a time, then sends it to Gemini only, when the operator has confirmed a paid Google key with `PRIVACY_AI_ALLOWED=true`. If AI is not available the person is told to use the bank's Excel/CSV or a net-banking PDF. It is not zero data retention: Google may log requests for a limited time to prevent abuse.

## Runs

`workflow_runs`, `run_sources`, `run_artifacts`, and `action_history` are created by `scripts/migrate-workflow-runs.sql`. Job results are stored on the run. Progress is `GET /api/workflow/runs/:id/progress`. `GET /api/workflow/runs` lists runs for the active client.

Activity is the workflow audit trail, shown in plain language. Upload history on the upload center is the file trail.

## Advanced

Payroll, gateway settlements, tax audit, evidence, and the older upload center stay under Advanced. `/app/uploads?view=advanced` opens the detailed parse view.

## AI

AI may help read a document or pick a ledger from a fixed list. It does not decide the books. Labels stay "AI extracted — pending review" and "Suggested match — needs review." Provider order is Gemini (main model, then fallback models), then Claude as a paid last resort, then rule-based.
