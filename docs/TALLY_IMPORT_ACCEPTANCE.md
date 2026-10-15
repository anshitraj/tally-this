# Actual Tally import acceptance

Status on 12 October 2026: **not passed**. Unit tests and a balanced XML file do not establish actual import acceptance.

## Browser and free test options

[TallyPrime Cloud Access](https://help.tallysolutions.com/getting-started-with-tallyprime-cloud-access/) can host the real application for browser access, but needs an account and a disposable company. The browser [API Explorer](https://tallysolutions.com/tallyprime-api-explorer/) is a client for a running Tally engine, not an independent hosted import simulator. It supplies a configured educational installation, sample company and connector. Educational dates are restricted to the first, second and last day of a month.

The official integration package was downloaded into ignored `tmp/tally-official/` and its executable signature was verified as valid, signed by Tally Solutions Pvt Ltd. ZIP SHA256: `EF8915384A33BDB70144960EF6AD30BBB818E7F099BD044BB7B30ED4F8AA380E`.

A temporary isolated process answered company-collection XML on local port 21959. Its loaded-company list was empty. The acceptance preflight returned `blocked`; no vouchers were imported. The owned test process was stopped after this check. No firewall rule, paid account or production company was changed. An educational/test company still needs to be loaded before the write test can run. The uncommitted preflight report is `tmp/tally-official/acceptance.json`.

## Repeatable acceptance command

Open a disposable company in the real engine and enable its private local XML server. Keep it separate from real books. Use the same engine/company for import and export read-back. Then, from the repository root:

```powershell
$env:TALLY_TEST_URL = 'http://127.0.0.1:9000'
$env:TALLY_TEST_COMPANY = 'TallyThis Test'
$env:TALLY_TEST_DATE = '2025-04-01'
pnpm --filter @workspace/api-server run verify-tally --allow-test-import
```

Without the flag, the runner performs only preflight. With the flag it creates synthetic Receipt and Payment vouchers and test ledger masters, then exports the vouchers back from the engine. It checks exact bank/Suspense amounts in paise, dates, voucher types and unique source references. The default report is in ignored API `dist/`; do not commit reports containing real company names.

The result is `passed_first_import` only when the real acknowledgement and read-back agree. It is deliberately **not** a repeat-import certification. Safe retries, partial imports, ledger-group compatibility, real bank formats and marketplace Sales/Credit Note GST behaviour remain separate release gates. Stop on any mismatch and inspect the test company's books. Do not run an import test against a live client company.

## Purchase and Journal vouchers, and repeat import

Status on 15 October 2026: **not passed, not run**. TallyPrime was installed on the development machine, but it was not running, the single company folder in its data directory is not known to be disposable, and computer control of the application was declined. Nothing was written to any company.

`pnpm --filter @workspace/api-server run verify-tally-books --allow-test-import` (with `TALLY_TEST_URL`, `TALLY_TEST_COMPANY`, `TALLY_TEST_DATE` as above) checks, against the real engine and a disposable company only:

1. A Purchase voucher with its supplier master and bill allocation is acknowledged and read back with the party, purchase, CGST, SGST and round-off lines agreeing to the paise, the voucher type and the date.
2. The same file sent a second time: what Tally acknowledged, and whether exactly one voucher still carries the reference. A result of two vouchers is recorded as failed, not retried quietly.
3. A salary Journal voucher with its ledgers is acknowledged.

Every check is recorded with what Tally answered in `dist/TallyThis_books_acceptance.json`. Passing does not certify a client's own masters (GST duty ledgers with their GST settings), several rates on one invoice, or the GST registers; those need a CA's test on that company.

Primary output references: [Tally XML examples](https://help.tallysolutions.com/sample-xml/) and [TallyPrime import configuration](https://help.tallysolutions.com/import-data-from-xml-or-json/).
