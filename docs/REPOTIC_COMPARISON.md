# Repotic public workflow comparison — 9 October 2026

This review uses Repotic's public [bank converter](https://www.repotic.in/products/bank-statement-converter), [e-commerce GST](https://www.repotic.in/products/e-commerce-gst), and [tutorials](https://www.repotic.in/tutorials) pages, plus TallyThis's code and synthetic tests. It does not verify Repotic's signed-in product, its claimed bank count, Tally imports, GST portal acceptance, or any real customer's statement.

Repotic's public [home page](https://www.repotic.in/) presents two products: bank PDF conversion and e-commerce GSTR-1. Its “800+ banks,” “10+ platforms” and accuracy figures are marketing claims, not independently measured results. TallyThis has four upload-based jobs, but the extra jobs do not replace the depth of Repotic's advertised GST workflow.

## CA verdict

For a real client today, I would use the workflow already proven with that client's statement and target TallyPrime company. On current evidence, I would trial Repotic first for e-commerce GSTR-1 because its public site advertises portal-oriented output, while TallyThis's GST JSON remains a proprietary draft and its broader marketplace layouts are unverified. TallyThis now offers editable HSN/document corrections and uploaded TCS comparison, but those local features have synthetic tests only. For a bank that TallyPrime already accepts directly, I would also try [TallyPrime's own statement import](https://help.tallysolutions.com/bank-statement/). TallyThis's balance proof, exception review and Excel working copy are useful, but I would not rely on its XML for live books until the exact bank format and repeat import have passed an accountant's test.

The TallyThis bank screen now makes review the next action when rows, ledgers or unproved totals need attention. A failed printed closing balance or incomplete row sequence stops the Tally download. This reduces accidental use of an unreviewed export; it does not establish import compatibility.

## Bank statement → Tally

| Step | Repotic public description | TallyThis now | Remaining gap |
| --- | --- | --- | --- |
| Upload | Bank-generated PDF; password prompt; bank selector in public demo | PDF, CSV, Excel and image upload; password prompt; detected bank can be corrected after reading | No tested coverage claim for Repotic's advertised 800+ banks. Add real, redacted statement fixtures bank by bank. |
| Identify bank | User can select a bank | Header IFSC first, printed name or short wordmark next, file name last; seven official logos shown when available | Other banks show their name with a generic bank icon. An image-only logo or header without identifying text still needs manual choice. |
| Check transactions | Public site describes conversion and accuracy but does not expose its internal checks | Row extraction, running-balance proof where printed balances exist, review of uncertain rows and ledger choices | Some layouts and scans still need additional parser fixtures or optional AI/OCR. Review can be completed without editing dates or amounts. |
| Export | Tally XML; tutorial also describes CSV | Tally XML, CSV and a real Excel workbook with numeric/date cells, review status and left-out rows | Tally import compatibility needs testing with real TallyPrime versions and sample companies. |

The current identity directory recognizes 61 names, and seven have local logos. The [bank evidence matrix](BANK_SUPPORT.md) distinguishes these from tested statement layouts.

## E-commerce GST

| Step | Repotic public description | TallyThis now | Remaining gap |
| --- | --- | --- | --- |
| Upload | 10+ named marketplaces | Recognizes Amazon, Flipkart, Meesho, Myntra, JioMart, GlowRoad, Shop101, Paytm, Snapdeal, AJIO, CityMall and LimeRoad by file name or header, plus generic columns | Recognition is not verified layout support. Only existing Amazon synthetic fixtures have exercised the GST row mapper; obtain redacted exports and implement/test each real report layout. |
| Review | Editable GSTR-1 sections, TCS comparison with GST portal, HSN bulk fixes, document summaries | Editable sales rows and document counts; B2B/B2C HSN summaries; bulk HSN/rate correction; HSN-length review for turnover above ₹5 crore; state-wise comparison with an uploaded State/TCS CSV or spreadsheet | Current comparison accepts only a state-wise TCS summary with recognizable State and TCS columns. It does not fetch GST data or verify the return period or GSTIN. Refunds need linked credit-note handling. |
| Export | GST JSON, Tally XML, CSV, Excel accounting summary | Draft JSON and CSV; Excel working summary including document counts; balanced Tally Sales voucher XML with Sales and GST ledger lines for reviewed sales | JSON remains a TallyThis draft, not GST portal-ready. Sales XML needs existing party/GST ledgers and a test import into TallyPrime; settlement, fees, returns and repeat-import behavior are unverified. |

When GST issues exist, the TallyThis screen leads with review, recalculates sections after correction and labels downloads as working drafts. An accountant must check corrected rows against source evidence.

## Priorities before claiming feature parity

1. Test actual failing bank statements (redacted) and add one fixture for each format. Verify the detected bank, all rows, totals, balances, password path and XML import in TallyPrime.
2. Validate the GST JSON schema and a sample output against the current official GST offline utility and portal; the current proprietary draft must not be uploaded as if it were accepted. Verify B2B/B2C, Table 12 HSN, Table 13 documents, Table 14, GSTIN and period behavior.
3. Test the uploaded portal TCS comparison on redacted real portal files, including amendments, negative adjustments, period and taxpayer checks. Resolve mismatches before export.
4. Import marketplace Sales vouchers in a TallyPrime test company. Add linked credit notes, fees and settlement accounting, then verify duplicate/repeat import behavior.
5. Add dedicated marketplace templates and test them with licensed sample exports. Do not infer broad platform support from the generic parser.

TallyThis also has Bank ↔ Tally and Invoice ↔ Bank review flows beyond Repotic's public bank converter description. Those do not fill the e-commerce gaps above. All workflows remain upload-based; the optional local Tally gateway is separate from a hosted direct integration.
