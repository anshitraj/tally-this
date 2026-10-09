# Repotic public workflow comparison — 9 October 2026

This review uses Repotic's public [bank converter](https://www.repotic.in/products/bank-statement-converter), [e-commerce GST](https://www.repotic.in/products/e-commerce-gst), and [tutorials](https://www.repotic.in/tutorials) pages, plus TallyThis's code and synthetic tests. It does not verify Repotic's signed-in product, its claimed bank count, Tally imports, GST portal acceptance, or any real customer's statement.

Repotic's public [home page](https://www.repotic.in/) presents two products: bank PDF conversion and e-commerce GSTR-1. Its “800+ banks,” “10+ platforms” and accuracy figures are marketing claims, not independently measured results. TallyThis has four upload-based jobs, but the extra jobs do not replace the depth of Repotic's advertised GST workflow.

## CA verdict

For a real client today, I would use the workflow already proven with that client's statement and target TallyPrime company. On current evidence, I would trial Repotic first for e-commerce GSTR-1 because TallyThis lacks portal TCS comparison, editable HSN/document corrections and a portal-validated JSON export. For a bank that TallyPrime already accepts directly, I would also try [TallyPrime's own statement import](https://help.tallysolutions.com/bank-statement/). TallyThis's balance proof, exception review and Excel working copy are useful, but I would not rely on its XML for live books until the exact bank format and repeat import have passed an accountant's test.

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
| Upload | 10+ named marketplaces | Amazon, Flipkart, Meesho, Myntra and JioMart recognition, plus generic columns | Dedicated templates for GlowRoad, AJIO, CityMall, LimeRoad, Paytm, Snapdeal and Shop101 are missing. |
| Review | Editable GSTR-1 sections, TCS comparison with GST portal, HSN bulk fixes, document summaries | Draft B2B/B2C/HSN/TCS/Table 14 views and issue list | No in-app row correction, portal TCS comparison, HSN bulk edit/turnover rule, or editable document summary. Current TCS figures come only from uploaded files. |
| Export | GST JSON, Tally XML, CSV, Excel accounting summary | Draft JSON, CSV, Excel working summary, and a basic receipt XML under details | JSON is a TallyThis draft, not proven GST portal-ready. The XML uses Receipt entries and does not implement GST-ledger sales vouchers or settlement reconciliation. |

When GST issues exist, the TallyThis screen now leads with review and labels the download a working draft. The current review list cannot correct source rows in place; the user must fix the marketplace report and upload it again.

## Priorities before claiming feature parity

1. Test actual failing bank statements (redacted) and add one fixture for each format. Verify the detected bank, all rows, totals, balances, password path and XML import in TallyPrime.
2. Build an editable, revalidated e-commerce review model. Keep GST JSON as a draft until its schema and sample output are validated against the GST offline utility.
3. Add an uploaded GST portal TCS statement comparison, state-wise differences, and a clear unresolved-items gate.
4. Implement real marketplace sales vouchers with GST ledger splits, returns and settlement handling; validate them in TallyPrime before labelling the output as sales accounting.
5. Add dedicated marketplace templates and test them with licensed sample exports. Do not infer broad platform support from the generic parser.

TallyThis also has Bank ↔ Tally and Invoice ↔ Bank review flows beyond Repotic's public bank converter description. Those do not fill the e-commerce gaps above. All workflows remain upload-based; the optional local Tally gateway is separate from a hosted direct integration.
