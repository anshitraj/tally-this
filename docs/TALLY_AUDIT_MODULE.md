# Tally Audit & Ledger Scrutiny Module

The differentiating module of FinVerify OS: **20 CA tax-audit / ledger-scrutiny checks on one screen**, computed from Tally-style data (ledger masters + vouchers + voucher lines + fixed-asset register).

- **Frontend:** `artifacts/finverify-os/src/pages/app/tax-audit.tsx` → route `/app/tax-audit` (sidebar: **Tax Audit → Tax Audit & Scrutiny**)
- **API:** `artifacts/api-server/src/routes/taxAudit.ts`
  - `GET /api/tax-audit` — index: every check with flagged count + severity
  - `GET /api/tax-audit/:checkId` — full detail rows + columns for one check
- **Data model:** `tally_ledgers`, `tally_vouchers`, `tally_voucher_lines`, `tally_fixed_assets` (`lib/db/src/schema/finverify.ts`)
- **Migration:** `artifacts/api-server/scripts/add-tally-audit-tables.mjs`

### Data-source behaviour
The engine reads real imported data from the `tally_*` tables. **If those tables are empty or absent, it falls back to a built-in demo dataset** so the cockpit always renders meaningful numbers (the `source: "demo"` banner shows in the UI). This guarantees the screen works before any Tally import is wired.

---

## Requirement → Check mapping (all 20)

### A. Debtors & Creditors Analytics
| # | Requirement | Check `id` | Logic |
|---|---|---|---|
| A1 | Negative ledger balances (debtors with Cr, creditors with Dr) | `neg-balances` | Debtor closing < 0 OR creditor closing > 0 |
| A2 | Same opening & closing balance | `same-op-cl` | opening == closing ≠ 0 for debtor/creditor |
| A3 | Debtors & creditors ageing | `ageing` | balance bucketed by movement (bill-wise once imported) |
| A4 | Party ledgers with JV (non purchase/sale/cash/bank) | `party-jv` | Journal vouchers touching a debtor/creditor |
| A5 | Debtor hit by Purchase / Creditor hit by Sales | `cross-posting` | voucher with debtor line + Purchase group (or creditor + Sales) |

### B. Tax Audit Reporting
| # | Requirement | Check `id` | Logic |
|---|---|---|---|
| B1 | Clause 31 — 269SS & 269T (unsecured loans) | `clause-31` | cash-mode loan voucher ≥ ₹20,000; Receipt=269SS, Payment=269T |
| B2 | 269ST — cash receipts ≥ ₹2,00,000 (excl. capital) | `sec-269st` | cash receipt ≥ ₹2L, no capital-account line |
| B3 | Clause 40 — ratio analysis | `clause-40` | GP%, NP%, stock turnover, material/turnover |
| B4 | Clause 23 — material expenses party-wise | `clause-23` | salary/commission/rent/remuneration/interest + materiality |
| B5 | Cash Exposure Ratio (flag > 5%) | `cash-exposure` | cash Cr / total payments, cash Dr / total receipts |
| B6 | Creditors with opening balance & cash payments > ₹10k | `creditor-op-cash` | creditor with opening ≠ 0 AND cash paid > ₹10k |
| B7 | Creditors — cash payments > ₹10k during year | `creditor-cash` | aggregate cash payment to creditor > ₹10k (40A(3)) |
| B8 | Clause 44 — GST break-up of expenditure | `clause-44` | total exp split: registered / unregistered / composition / exempt |
| B9 | Clause 22 — MSME creditors (43B(h)) | `clause-22` | creditors flagged MSME, outstanding + >45-day check |
| B10 | Clause 18 — depreciation asset-wise + additions/deletions | `clause-18` | block-wise WDV, additions/deletions with dates, on one screen |

### C. Accounts Finalisation
| # | Requirement | Check `id` | Logic |
|---|---|---|---|
| C1 | Opening vs prior-year closing mismatch | `op-cl-mismatch` | PY closing ≠ CY opening per ledger |
| C2 | Partner dashboard (capital/interest/remuneration/share) | `partner-dashboard` | Capital-Account ledgers + remuneration/interest allocation |
| C3 | TDS/TCS dashboard | `tds-tcs` | Duties & Taxes ledgers matching TDS/TCS + balances |
| C4 | Grouping mismatch (LY vs CY) | `grouping-mismatch` | ledger group changed between years |
| C5 | JV after 31 March | `post-yearend-jv` | Journal vouchers dated > FY end |

> All 20 listed requirements are implemented. Severity and flagged-count are computed live; an auditor opens the cockpit and sees exactly which clauses fired.

---

## Thresholds (FY 2025-26, in `taxAudit.ts`)
- 269SS/269T: **₹20,000**
- 269ST: **₹2,00,000**
- 40A(3) cash expense: **₹10,000**
- Cash exposure flag: **5%**
- MSME due: **45 days**
- FY end: **2026-03-31**

These are constants at the top of the route — update per assessment year.

---

## Roadmap
1. **Real Tally import** — parse Tally XML export / Day Book into `tally_ledgers` + `tally_vouchers` + `tally_voucher_lines` (extend the Python `extraction-worker`). Today the engine reads these tables if present, else demo.
2. **Bill-wise ageing** — replace the movement heuristic in `ageing` with bill-date buckets once bill-wise data is imported.
3. **Evidence pack** — one-click Excel working paper per check (wire into `excelExport.ts`).
4. **26AS / 26Q matching** inside the TDS dashboard.
5. **Multi-client practice view** — aggregate flagged counts across all of a CA's clients.

## How to run the migration
```bash
node artifacts/api-server/scripts/add-tally-audit-tables.mjs
```
Requires `DATABASE_URL` in root `.env`. After migration, the engine will use real `tally_*` data when present.
