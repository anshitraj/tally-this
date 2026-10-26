# Tax Audit & Ledger Scrutiny

Twenty ledger-scrutiny and tax-audit checks on one screen, worked out from a Tally XML export (ledger masters, vouchers and bill-wise detail). It lives under Advanced. Every finding is a **potential risk that needs CA review**: nothing here is an audit opinion, and what is reportable is the CA's call.

- **Page:** `frontend/src/pages/app/tax-audit.tsx`, route `/app/tax-audit`. The Practice page (`/app/practice`) shows the same checks across a CA's clients.
- **Routes** (`backend/api/src/routes/taxAudit.ts`):
  - `GET /api/tax-audit` the twenty checks with flagged count, severity and, where a check could not run, why
  - `GET /api/tax-audit/:checkId` one check in full (columns, rows, notes)
  - `POST /api/tax-audit/import` a Tally XML export, read by the Python worker (`POST /parse/tally`, `backend/worker/app/parsers/tally_xml.py`); replaces the company's earlier import
  - `DELETE /api/tax-audit/import` clears the import and goes back to demo
  - `POST /api/tax-audit/evidence-pack` an Excel workbook: a summary and one sheet per check
  - `POST /api/tax-audit/connector/sync` pulls a Day Book from a TallyPrime on the same computer or network (Experimental; refused on the hosted site)
- **Engine:** `backend/api/src/services/taxAuditEngine.ts`, pure and unit-tested. **Loader:** `taxAuditData.ts`.
- **Tables:** `tally_ledgers`, `tally_vouchers`, `tally_voucher_lines`, `tally_bills`, `tally_fixed_assets`, created by `lib/db/migrations/0001_base_tables.sql`.

## Whose data the page shows

- A company that has **imported nothing** sees the built-in demo company, with a banner saying so. On the Practice page a linked client with nothing imported shows "No Tally data imported yet", never the demo company's findings.
- Once a file with **ledgers or vouchers** is imported, the page shows that company's own data. A database error is an error, never a quiet fall back to demo figures.
- Each company's import is its own; a read-only team member can read the findings but cannot import, clear or use the connector.

## A check without its data is "Not run", never "Clear"

An export can lack what a check needs. A Day Book has vouchers but no ledger groups or balances; a masters export has no vouchers; a single-year export has no prior-year figures and no fixed-asset schedule. Such a check is marked **Not run** with the reason, and the page lists the reasons in a banner. It is never shown as clear or passed.

| Missing from the export | Checks that cannot run |
| --- | --- |
| Ledger masters (groups and balances) | everything that needs a group or a balance, including the cash checks, because cash is told from bank by the ledger's group |
| Closing balances (every ledger with entries shows closing = opening) | the balance checks: negative balances, same opening and closing, ageing estimate, ratios, expense heads, GST break-up, MSME, TDS/TCS, partners |
| Vouchers | party journals, cross-postings, 269SS/269T, 269ST, cash exposure, 40A(3), journals after 31 March |
| Prior-year balances or groups (a single-year export never has them) | opening vs prior-year closing, grouping mismatch |
| Fixed-asset schedule (the reader does not read one) | depreciation |
| Ledgers in the group Capital Account | partner dashboard |

The import also answers at once with what the file lacked, so it is said in the message after the upload and not only on the cards.

## The twenty checks

| # | Check | `id` | What it does |
| --- | --- | --- | --- |
| A1 | Negative ledger balances | `neg-balances` | debtor closing below zero, creditor closing above zero |
| A2 | Same opening and closing balance | `same-op-cl` | opening equals closing and is not zero, for a debtor or creditor |
| A3 | Ageing | `ageing` | bill-wise from the bill date to 31 March when bills are imported; otherwise a ledger-level estimate, labelled as one |
| A4 | Party ledgers with journals | `party-jv` | journal vouchers touching a debtor or creditor |
| A5 | Debtor↔Purchase, Creditor↔Sales | `cross-posting` | a voucher with a debtor line and a Purchase Accounts line, or a creditor and Sales Accounts |
| B1 | Clause 31, 269SS and 269T | `clause-31` | a cash voucher of ₹20,000 or more that touches a loan group (receipt = 269SS, payment = 269T) |
| B2 | 269ST | `sec-269st` | a cash receipt or sale of ₹2,00,000 or more, with no Capital Account line |
| B3 | Clause 40 ratios | `clause-40` | gross profit, net profit, stock turnover, material used, from the groups Sales Accounts, Purchase Accounts, Stock-in-Hand and Indirect Expenses; `n/a` when a group has nothing |
| B4 | Clause 23 expense heads | `clause-23` | Indirect Expenses ledgers whose names mention salary, wages, commission, rent, interest or remuneration, with each one's share |
| B5 | Cash exposure | `cash-exposure` | cash payment vouchers over all payment vouchers, cash receipts over all receipts; flagged above 5% |
| B6 | Opening balance and cash over the daily limit | `creditor-op-cash` | creditors with an opening balance who were paid more than ₹10,000 in cash on one day |
| B7 | Cash over the daily limit | `creditor-cash` | creditors paid more than ₹10,000 in cash to one party on one day (several smaller payments on different days are not added) |
| B8 | Clause 44 GST break-up | `clause-44` | Purchase Accounts as registered, everything else as not; composition and exempt shown as nil |
| B9 | Clause 22 MSME | `clause-22` | creditors whose ledger carries an MSME registration type |
| B10 | Clause 18 depreciation | `clause-18` | the asset register, if the import has one |
| C1 | Opening vs prior-year closing | `op-cl-mismatch` | needs prior-year closing balances |
| C2 | Partner dashboard | `partner-dashboard` | Capital Account ledgers with interest and remuneration shared by opening capital |
| C3 | TDS/TCS | `tds-tcs` | Duties & Taxes ledgers named for TDS or TCS |
| C4 | Grouping mismatch | `grouping-mismatch` | needs last year's group per ledger |
| C5 | Journals after 31 March | `post-yearend-jv` | journals dated after the financial year end |

## What the checks assume

These are simplifications a CA must judge. Where one changes a number, that check's notes say so on the page:

- **Standard Tally groups.** Debtors, creditors, cash, bank, sales, purchases, stock, expenses and capital are told apart by Tally's standard group names. A ledger under a custom group is not counted.
- **Thresholds are per voucher or per party-day** (₹20,000 for 269SS/269T, ₹2,00,000 for 269ST, ₹10,000 for 40A(3)). The aggregation rules and exceptions in the Act (higher limits for some payees, Rule 6DD, the "single event" test for 269ST) are not applied.
- **Net profit** is sales less cost of goods less Indirect Expenses; direct expenses, other income and taxes are not included.
- **The GST break-up** treats Purchase Accounts as bought from registered suppliers. A ledger export cannot say which suppliers are registered.
- **MSME status** comes from the ledger's MSME registration type if the export carries it. An empty list does not show there are no MSME creditors.
- **Partners' interest and remuneration** are shared in proportion to opening capital; the deed may say otherwise.
- **The financial year is fixed** at the one ending 31 March 2026 (`FY_END` in the engine) and the thresholds are those of FY 2025-26. Change them for another year.
- **The amount of a voucher** is its largest ledger line, so a sale with GST is its invoice total, not the sum of its lines.
- **Voucher numbers.** Tally numbers each voucher type on its own ("1" is a Receipt, a Payment and a Journal). The reader keeps every voucher separate by adding the type (and, if that still repeats, the date), so a voucher shows as "Receipt 1".

## Evidence

- Engine: `taxAuditEngine.test.ts` (golden counts on the demo company that can be checked by hand, every threshold at its edge, each "not run" rule, mutation-checked).
- Reader: `backend/worker/tests/test_tally_xml.py` (sign conventions, cash or bank from the groups, bills, duplicate voucher numbers, what a file lacks).
- Whole path: `frontend/e2e-real/tax-audit.spec.ts` imports a small export through the real worker, API and database and checks the page, the evidence pack, the Practice page, other companies' data and a read-only role against figures worked out by hand from `tally-export.ts`.

**Not verified:** any export from a real TallyPrime. The tests use XML written to the layout the reader expects. Which menu in TallyPrime produces a file with both masters and vouchers, and whether its closing balances and ledger groups are written as the reader expects, has not been checked; try one real export and read the "could not run" banner before trusting a result. The live connector has only been tried against sample data.

## Applying the schema

The tables are part of the single migration path (`pnpm --filter @workspace/db run migrate`, see [DEPLOYMENT.md](DEPLOYMENT.md)). The older script `backend/api/scripts/add-tally-audit-tables.mjs` is superseded.
