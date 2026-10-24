# Measuring TallyThis on real files

Synthetic fixtures prove that the code does what it was written to do. They do not prove that a
real bank, a real Tally or a real salary sheet reads correctly. This is how to find out, with three
or more CAs, without anything leaving the machine.

## What to ask each CA for

One client, one month, **redacted** (names, GSTINs, PANs, account numbers may be changed, but amounts,
dates, invoice numbers and the layout must stay as they are). For each file also ask for the
answer: the numbers the CA gets when they add the file up themselves.

| File | Why | Answer to write down |
| --- | --- | --- |
| Bank statement as the bank gave it (PDF, and Excel/CSV if the bank offers it) for 1–3 different banks | Bank formats are the biggest gap | Number of transactions, total debits, total credits, opening and closing balance |
| Tally sales register for the month (Excel export, GST columns shown) | GSTR-1 working | Number of vouchers, taxable value, IGST, CGST, SGST |
| Tally purchase register or a purchase-bill list for the month | Bills → Tally | Number of bills, total of invoice values |
| GSTR-2B JSON or Excel for the same month | GSTR-2B ↔ Books and the GSTR-3B working | Number of documents, total tax |
| A salary sheet for the month | Payroll | Number of employees, total net pay |
| Form 26AS from TRACES (text file) and the TDS ledger from books | 26AS TDS | Number of deduction entries |

Do not send anything with a password to the same person who is asked for the answer sheet. Real files
stay in a folder that is not committed (`testing-pdf/` and similar are already ignored).

## How to run it

Put the files in a folder, with an `answers.json` next to them:

```json
{
  "hdfc-oct.pdf":      { "kind": "bank_statement", "rows": 214, "debitTotal": 512340.5, "creditTotal": 610000, "openingBalance": 12000, "closingBalance": 109659.5 },
  "sales-oct.xlsx":    { "kind": "sales_register", "documents": 88, "taxable": 1250000, "igst": 90000, "cgst": 45000, "sgst": 45000 },
  "bills-oct.xlsx":    { "kind": "purchase_register", "bills": 51, "total": 702345.12 },
  "salary-oct.xlsx":   { "kind": "payroll_sheet", "employees": 32, "net": 845200 },
  "gstr2b-oct.json":   { "kind": "gstr2b", "documents": 140, "tax": 98000 }
}
```

```bash
pnpm --filter @workspace/api-server run measure-corpus -- ./corpus
```

A password-protected PDF can be opened with `CORPUS_PDF_PASSWORD=...` in the environment. Everything
runs on this computer; no file is uploaded and the folder is not changed. AI is switched off for the
run, so what is measured is the rule-based reading.

## How to read the result

* `AGREES`: every figure in the answer file equals what the reader returned. Money is compared exactly, in paise.
* `DIFFERS`: at least one figure is different. The line under it says which. This is the list to fix.
* `NO-ANS`: the reader produced numbers but there is no answer to compare. It says nothing about correctness.

A reader that returns numbers is not the same as a reader that returns the right numbers. A bank
statement also reports `balanceProved`: whether every row agrees with the bank's running balance.
`false` means the figures should not be trusted until a person has checked the totals.

## What a pass does and does not mean

A pass on three CAs' files is evidence for those layouts. It is not a claim for every bank, every
Tally version or every salary software, and it does not show that TallyPrime or the GST portal
accepts the output. The Tally side has its own acceptance check:
[`TALLY_IMPORT_ACCEPTANCE.md`](TALLY_IMPORT_ACCEPTANCE.md).

Record each run (date, who supplied the files, how many agreed, what differed) in
[`COMPETITOR_REVIEW.md`](COMPETITOR_REVIEW.md) next to the capability it supports.
