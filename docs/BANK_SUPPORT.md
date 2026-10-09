# Bank statement support evidence — 9 October 2026

Bank recognition, transaction extraction and Tally import are separate capabilities. A detected bank name or logo is **not** proof that its statement format is supported.

| Layer | Current evidence | Meaning |
| --- | --- | --- |
| Identity | 61 bank name patterns, some verified IFSC prefixes, and a manual bank choice. The directory includes the main RBI-listed public/private banks and selected small finance, payments, co-operative and foreign banks. | The bank can be named when the header or filename contains a known signal. A manual choice is needed for ambiguous or image-only headers. |
| Logo | Seven local bank logos; other banks show their exact name with a neutral bank icon. | A neutral icon avoids inventing or fetching third-party branding. |
| CSV/Excel parsing | Shared deterministic column parser; synthetic HDFC fixture and parser tests. | Coverage depends on each bank's actual column names, date and amount conventions. Recognition does not certify a file layout. |
| Text PDF parsing | Synthetic Kotak and IndusInd layouts, including a password and balance-break case. | Position-based extraction works for the tested synthetic layouts only. Scans need the optional reader and extra review. |
| Financial proof | Running balances, printed closing balance and row sequence are checked when present. Unreadable dated rows and invalid dates stop CSV/Excel export. | A missing balance chain requires a person to check totals. A closing or row-sequence conflict stops the Tally download. |
| Tally import | XML structure and arithmetic tests only. | No actual TallyPrime import result or repeat-import behavior has been verified. |

The [RBI banks list](https://www.rbi.org.in/commonman/english/scripts/banksinindia.aspx) is the reference for current Indian bank names. The Shivalik IFSC prefix is supported by its [official branch listing](https://shivalikbank.com/branch/ghaziabad-branch). Bank names that lack a verified prefix are deliberately recognized by printed name only. Changes to bank names and formats need periodic review.

For each bank format intended to be called supported, obtain a consented redacted bank download and record: source bank, account type, format, password behavior, header identity, expected row count, debit/credit totals, opening/closing balances, date range and statement version. Add a regression fixture and compare every normalized row with the source. Then import the generated XML into a test TallyPrime company and inspect voucher count, ledger posting and repeat-import behavior. Until this evidence exists, do not advertise an “all banks” count.

TallyPrime itself [documents bank-statement import for 145+ banks](https://help.tallysolutions.com/bank-statement/) using bank-downloaded CSV/Excel, with its own preview and reconciliation. When that works for the CA's bank and version, it is a useful baseline against which TallyThis should be judged.
