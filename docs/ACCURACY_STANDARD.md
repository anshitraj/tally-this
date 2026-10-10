# TallyThis financial accuracy standard

Product requirement: every financial value and automated decision must be supported by evidence. An uncertain or unsupported input must ask for review or stop. The present code has not met all gates below; this is an implementation and release standard, not a certification.

## Accuracy claims

The release target is exact source agreement for every relevant row and value in each supported test format, and zero known silent financial errors. Measure this across a defined corpus and publish its size, formats and limitations. A 100% pass result for a named test corpus does not mean 100% accuracy on every possible file.

Report both correctness and coverage. Refusing an unreadable file protects accuracy but reduces automation coverage; excluding those files from reporting would give a misleading picture. User corrections and AI extraction must be counted separately from automatic verified extraction.

## Required evidence per stage

| Stage | Requirement | Stop or review when |
| --- | --- | --- |
| Input completeness | Count every relevant sheet, page and dated/document row; record the applicable bank account or GSTIN and period. | A page/sheet is omitted, a dated row has unreadable data, the source belongs to another client or the period is inconsistent. |
| Extraction | Dates, identifiers, signs, paise and source row links match the independently checked source. | The OCR/parser disagrees, a value is inferred, or the layout has not been validated. |
| Bank totals | Running balance plus opening/closing and printed debit/credit/count totals agree where available. | Any check conflicts. Missing evidence requires review; successful arithmetic cannot verify narration, party or ledger classification. |
| Matching | Exact shared evidence, amount, direction and date checks; ambiguous candidates remain suggestions. | Similar names or unique amount/date are the only evidence; a short/partial reference, collision, duplicate or uncertain debit/credit convention remains. |
| GST calculation | Separate GST and cess; preserve source values; supported document types and taxpayer-period rules. | Returns, credit notes, cancellations, exemptions, tax rates or operator treatment lack necessary supporting data. |
| TCS and settlements | Compare the right taxpayer/operator/period; explain fees, refunds, timing and amendments. | A difference is unexplained. Do not rewrite taxable sales just to make a portal or payout total agree. |
| Review | Record source values, approved values, person, time and reason; regenerate all totals/sections/exports from the approved revision. | A correction is unsaved, invalid, applies to another client or leaves inconsistent values. |
| Export | Validate structure and amounts, show exclusions, use verified target masters/schema and prove actual import acceptance. | Output is unbalanced, unsupported, incomplete or unresolved. Working drafts remain distinctly labelled. |
| Retry | A repeated upload, export or posting batch has a stable identity and explicit handling. | A retry could silently create duplicate vouchers or overwrite a reviewed result. |

Financial calculations should use a documented paise/decimal rounding policy. Binary floating-point arithmetic, ₹1 matching tolerances or a rounded grand total must never establish exact agreement. Source-rounded GST amounts should not be overwritten by an inferred rate calculation; differences go to review.

## Release corpus and measurements

Each fixture must have a consented/redacted original, a versioned format identifier and independently checked expected rows, totals and outputs. Synthetic cases test individual rules but do not certify a real bank or marketplace format. Include scans, passwords, multi-page/multi-sheet files, wrapped rows, reverse order, cancelled and duplicate documents, partial/full refunds, credit notes, cess, amendments, mixed GSTINs, rate changes, blank/invalid fields and retries.

Track at least:

- Source row recall: every expected financial row is present, accounted for or explicitly blocked.
- Exact field agreement: date, identifier, sign, amount and tax fields match the answer file per row.
- Automatic-match precision: every confirmed pair is correct; separately record the suggested/reviewed share.
- Tax and voucher agreement: per-document values and section totals agree, including exclusions and rounding.
- Import acceptance and round trip: the target Tally company or GST utility/portal accepts the output, and exported results agree with the expected values.
- Idempotency: retries and re-imports do not silently duplicate books.
- Review effort and failure visibility: minutes, corrections, unsupported files and every blocked job remain visible in benchmark reporting.

One successful import cannot prove correct tax treatment, and a passing running balance cannot prove all source text is accurate. Release evidence needs the source comparison, accountant review and target-system result together.

## Current fixes and remaining gates

On 9 October 2026, the feature branch was tightened so cancelled marketplace rows do not enter active sales totals or Sales vouchers; returns/credit notes and signed adjustments remain under review; cess is carried separately into draft JSON/CSV/Excel and Sales XML. Invoice components must agree to the paise, and a one-paise TCS difference is flagged. Bank/Tally unique amount/date pairs without reliable shared references remain suggestions; automatic confirmation requires exact paise and a complete reference as well as direction/date/ambiguity checks.

Remaining gates include a real-format fixture corpus, immutable field-level correction history, verified money rounding rules, taxpayer/period/operator checks, credit-note and settlement accounting, current official GST JSON, TallyPrime import/retry evidence and deployed authorization/privacy tests. See [production readiness](PRODUCTION_READINESS.md) and [competitor gaps](COMPETITOR_REVIEW.md).

Official output references: [GST GSTR-1 guide](https://tutorial.gst.gov.in/userguide/returns/Creation_of_Outward_Supplies_Return_in_GSTR-1.htm), [GST offline utility](https://tutorial.gst.gov.in/downloads/invoiceuploadofflineutility.pdf), [Tally XML samples](https://help.tallysolutions.com/sample-xml/), and [Tally import documentation](https://help.tallysolutions.com/import-data-from-xml-or-json/). Validate against the current versions at release time.
