# E-commerce workspaces: Meesho

The **E-commerce** menu entry (`/app/ecommerce`) lists marketplaces. Meesho is the only one that imports today
(`/app/ecommerce/meesho`); Amazon, Flipkart, Myntra, AJIO and Shopify are listed as *coming soon* and offer nothing.
The older one-off job (`/app/jobs/ecommerce-gst`, "E-commerce GST file") still works for any marketplace report and is
linked from the E-commerce page.

Data arrives only by **report upload**. TallyThis does not sign in to Meesho, has no API connection, and never says
"connected". Nothing updates until new files are uploaded.

## Files Meesho sellers upload

From the Meesho Supplier Panel:

| File | Where | What it holds | Required |
| --- | --- | --- | --- |
| `tcs_sales.xlsx` | GST Reports | One row per sold sub-order: taxable value, tax, invoice value, HSN, rate, customer state, operator GSTIN, month | yes |
| `tcs_sales_return.xlsx` | GST Reports | One row per return or cancellation, with `cancel_return_date` | yes, when there are returns |
| `Tax_invoice_details.xlsx` | Payments → Tax Invoice | Invoice and credit-note numbers per sub-order (used for GSTR-1 Table 13) | optional |

Accepted: XLSX, XLS, CSV, and ZIP files of those (no nested ZIPs, no encrypted entries). PDF reports are refused with a
note to download Excel. Several files and several months can go in one upload.

### Getting files in

Drop them; nothing else is asked. Each row's month comes from the row, and the seller GSTIN from the workspace.

- Anywhere on the Meesho workspace (the page shows a drop target while files are held over it), or on the drop box of
  the first-visit screen.
- On the Meesho card of the E-commerce page: the workspace opens and the import starts.
- On Home: files named like Meesho's own GST reports (`tcs_sales…`, `tcs_sales_return…`, `Tax_invoice_details…`) go to
  the Meesho workspace; anything else goes through the usual detection. In Incognito they go to the one-off job, because
  a workspace keeps what it imports (the workspace itself refuses Incognito uploads with that reason).
- **Upload reports** (or "Choose the month and GSTIN first") opens the same upload with the month and GSTIN to set by
  hand.

Also recognised: a combined "working" sheet with a `Sales Return` YES/NO column (as CAs often keep), and a CA's
HSN-wise pivot (HSN, taxable, integrated, central, state tax columns), which is used only for the comparison on the
GST & HSN tab.

### Columns read

`sub_order_num`, `order_date`, `hsn_code`, `quantity`, `gst_rate`, `total_taxable_sale_value`, `tax_amount`,
`total_invoice_value`, `taxable_shipping`, `end_customer_state_new`, `eco_tcs_gstin`, `gstin`, `financial_year`,
`month_number`, `cancel_return_date`, and the common variants of each (see `MEESHO_ALIASES` in
`backend/api/src/services/marketplace/adapters/meesho.ts`). The header row may be anywhere in the first 15 rows.
Every other column is kept, unread, with the row (Raw Transactions sheet and the transaction side panel). Repeated
header names are kept apart ("total_taxable_sale_value (2)").

If a required column (sub-order, taxable value, GST rate, customer state, HSN, quantity) is not recognised, nothing is
imported from that file until someone picks the column on the **Choose columns** screen. If neither a sub-order nor a
taxable-value column can be found, the file is reported as not a Meesho report.

## How rows are treated

- **Money** is read from the cell's text and kept as whole paise (numeric(16,2) in Postgres). It never goes through a
  floating-point sum. Values with more than two decimals are rounded once, half away from zero, and the file is noted.
- **Periods**: each row belongs to the month in its own `month_number`/`financial_year` (or its date); the month chosen
  at upload is used only for rows that carry none. A file holding several months is split by month.
- **Sales and returns**: a returns file gives returns; a working sheet's `Sales Return` flag decides; a negative sale row
  with no flag is read as a credit note and flagged. Returns are stored as positive amounts and subtracted once.
- **Returns reduce the month they are reported in**, even when the sale was earlier. Each return is linked to its sale by
  sub-order across every imported month; one without its sale is kept, still reduces its month, and is listed for review.
  A later import that brings the sale closes that item automatically.
- **Duplicates**: every row has an idempotency key (marketplace, seller GSTIN, type, sub-order, month, dates, quantity,
  taxable value, rate). A repeated row (the same file twice, or an August–September download over a September one) is
  stored for the record and never counted again. The same file is recognised by its SHA-256 and not read at all.
- **Same sale, different figures**: when a later row has the same sub-order (same return date, for returns) as one
  already imported but other figures, the earlier row keeps counting and the new one is **held back** with a blocking
  review item. A reviewer chooses "Keep the earlier row" or "Count this row instead"; the choice can be reopened.
  Found on a real CA workbook: one sale appeared with a slightly different taxable value in the month sheet and in the
  two-month sheet. Before this rule both were counted.
- **GST**: intra- or inter-State from the seller GSTIN's state against the customer's state. The tax in the report is
  kept; TallyThis also works it out from the rate and records the difference, the rule and the rounding when they
  disagree by more than a paisa. Rates are checked against the date (12% and 28% after 22 Sep 2025 are flagged;
  apparel under HSN 61/62 at ₹1,000/₹2,500 per piece). CGST and SGST are split evenly at group level so an odd paisa
  per line does not pile up on one side. Rounding can be switched between "each line as reported" and "once per group".
- **Not changed, ever**: the source row. Decisions (confirm, change type, accept a difference, choose figures, notes,
  reopen, approve) are separate records with the person and time, and figures are worked out from rows plus decisions.

## Review and approval

Only items that need a person are shown: missing or invalid HSN, unknown state or rate, other GSTIN, tax or invoice
differences, unclear sale/return, returns without their sale, returns above the sale, rows with different figures.
Information-only notes (earlier-month returns, duplicates, extra columns) never block.

A missing or wrong HSN and an unrecognised customer State are **fixed in place**: **Fix** opens the transaction with an
editor (HSN codes already used that month as one-tap choices, or typed; the State from a list). The correction is a
decision record: the imported row keeps the file's value, the summaries and downloads use the correction, a changed
State moves the tax between IGST and CGST + SGST without changing its amount, and the Excel notes say what changed.
Other items are confirmed, accepted with a note (one note can cover every item of a kind), reclassified or reopened.

Month status:

- **Draft**: nothing imported for the month.
- **Needs review**: at least one error or warning is open. Never shown as reconciled.
- **Reconciled**: nothing blocking is open.
- **Approved**: a person with `reconciliation.approve` (founder, admin, CA) approved it. The approval records a
  fingerprint of the month's counted rows, blocking items and decisions; any later change (a new row, a reopened item,
  a reclassification) makes it stop applying, and the page says so. A repeat upload that adds nothing does not.

Reviewing needs `reconciliation.run`, `ca_review.process` or `reconciliation.approve`; importing needs `uploads.create`;
removing an import needs `uploads.delete`; downloads need `reports.export`. A CA reaches a client's workspace only
through an active client link. Every action is written to Activity.

## Downloads

- **Excel working papers** (10 sheets): Summary, Raw Transactions (every source column), Normalized Sales, Sales
  Returns, HSN-wise Summary, State-wise GST, GSTR-1 Working, Exceptions, Reconciliation Audit, Source Metadata (file,
  sheet, SHA-256, columns used and kept). Frozen headers and filters on every table.
- **PDF summary**: figures, HSN and State summaries, open items.
- **Transactions CSV** and **Exceptions CSV** (cells that start like a formula are prefixed so a spreadsheet does not
  run them).

Downloads are built from the saved data each time, carry the month's status, and work for any earlier month.

The GSTR-1 working (Table 7 B2C others through the operator, Table 12 HSN, Table 13 documents, Table 14(a), B2C-Large
candidates, expected Section 52 TCS) is a **draft for CA review**. There is no GST JSON export and no portal filing:
the JSON stays off until it is built against the official schema and validated with the offline tool.

## Limits and safeguards

- Up to 20 files and 60 MB each per upload (`MAX_UPLOAD_MB`). ZIP: 50 entries, 60 MB per entry, 200 MB in total,
  compression ratio 200; encrypted, ZIP64, nested and path-escaping entries are refused. 250,000 rows per sheet.
- Password-protected Excel files are refused with a message.
- Uploads are stored with the existing private storage (local or R2) under the company; source rows and file contents
  are never logged. No AI is used anywhere in this module.
- Imports run in the background one at a time per company and marketplace, with real stages: reading, normalizing,
  checking duplicates, matching returns, GST summaries, report. A failed import removes what it wrote and can be
  retried; one left running by a restarted server is marked failed after two minutes.
- Removing an import deletes its rows, items and stored files; imports that had skipped rows because this one held
  them are read again so nothing they contained stops counting.

## Not done yet

- Settlements, payouts, fees and payment files: shown as *not available*; the figures are GST values, not cash.
- Table 12 B2B lines: Meesho reports carry no buyer GSTIN, so all supplies are B2C.
- Other marketplaces: the adapter interface (`MarketplaceAdapter` in `services/marketplace/types.ts`) and registry are
  shared; a new marketplace needs its adapter, aliases, tests and a switch to `available` in `registry.ts`.
- Measured against real data only for the layouts in one CA's workbook (three months, about 1,200 rows, kept off the
  repository): every month's sales, returns and tax agreed to the paisa with an independent sum of the sheets, and the
  two-month sheet added nothing twice. Its HSN pivot covers more rows than the sheets supplied, so it could not be
  used to prove totals. Returns whose sales were in months not supplied stayed open for review, as they should.

## Tests

- `backend/api/src/services/marketplace/marketplace.test.ts`: money parsing, GST engine and rate rules, GSTIN check,
  ZIP limits, readers, column detection and mapping, normalization, credit notes, returns, duplicates and overlaps,
  conflicting figures, determinism, summaries to the paisa, GSTR-1 working, CA comparison, workbook and PDF.
- `frontend/e2e-real/ecommerce-meesho.spec.ts` (real API, gateway and Postgres): upload with progress, figures,
  blocked approval, review, approval, Excel sheets, repeat and overlapping imports, column choice, held-back figures,
  bulk accept, other-company and signed-out access, phone layout.

## Database

Migration `lib/db/migrations/0005_marketplace.sql` adds `marketplace_import_jobs`, `marketplace_source_files`,
`marketplace_events`, `marketplace_exceptions`, `marketplace_reports` and `marketplace_reviews`. It must be applied
before a backend with this module is deployed.
