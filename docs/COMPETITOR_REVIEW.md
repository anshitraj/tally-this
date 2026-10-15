# TallyThis competitor review — 9 October 2026

The goal is to complete Repotic's useful workflows and improve the accountant's time, accuracy evidence and control. TallyThis does not yet have verified feature parity or demonstrated superiority.

This review uses vendors' public product pages and help documentation, plus the current TallyThis code. Vendor statements describe advertised features, including paid features; they are not independent tests. No paid account, customer document, posting session or GST filing was used. Public claims about bank counts, speed, security and “100% accuracy” do not establish measured accuracy. Pricing is deferred as requested.

## Alternatives worth benchmarking

| Product and primary source | Advertised workflow relevant to TallyThis | What to learn or test against |
| --- | --- | --- |
| [Repotic GST](https://www.repotic.in/products/e-commerce-gst) and [bank conversion](https://www.repotic.in/products/bank-statement-converter) | Bank-generated PDF conversion; section editing, state-wise TCS/taxable views, operator details, HSN/rate bulk changes, separate B2B/B2C HSN, document summaries, GST JSON, Tally XML and summary exports | Complete one client/period through review and both accounting and filing outputs. Repotic's page says scanned bank copies are not accepted; its FAQ restricts Tally compatibility to Prime 2.1+, despite broader wording elsewhere. |
| [Vyapar TaxOne, formerly Suvit: data automation](https://taxone.vyapar.com/data-entry-automation-feature) and [GST](https://taxone.vyapar.com/gst-reconciliation-feature) | Bulk bank/invoice reading, suggestions based on past data, sale/purchase posting to Tally; GST reconciliation and IMS workflow | Verified Tally master sync, clear posting outcomes and reusable client-specific mappings. Its homepage marks the chat/PMS product “Coming Soon”; do not treat every homepage scenario as confirmed released functionality. |
| [Vouchrit](https://www.vouchrit.com/) | Bank PDF/Excel extraction, grouped ledger suggestions and bulk Tally posting; GSTR-1 sales and 2A/2B purchase imports; itemized and non-itemized entries | Reduce repetitive ledger review, and test actual sales/purchase entry creation. Its ledger prediction percentage is a vendor claim, not an accounting guarantee. |
| [LedgerConnect e-commerce](https://ledgerconnect.in/ecommerce-converter), [TCS comparison](https://ledgerconnect.in/solutions/tcs-reconciliation) and [Tally connector](https://ledgerconnect.in/solutions/tally-connector) | Sales/returns, state/HSN/rate consolidation, multiple GSTINs, Shopify/WooCommerce exports, editable vouchers and TCS comparison; accounting export or approved connector posting | Handle a real month's returns and several seller registrations. Show the posting batch before approval. Taxable amounts must not be automatically changed merely to force a TCS match. |
| [Greenote](https://greenote.app/) | Windows application advertising on-device PDF/Excel/CSV processing, Tally posting, edits/deletion after posting and ledger audit summaries | Benchmark a genuine local-processing privacy option and reversible posting. TallyThis Incognito still processes on its servers; it does not provide Greenote's advertised offline model. |
| [QuickTally](https://quicktally.in/index.html) | Excel/templates to Tally, ledger/item/unit master creation, inventory and non-inventory entries, debit/credit notes, bill-wise/cost-centre allocations, marketplace templates | Match accounting depth where the CA needs it. Inventory, stock and allocation controls should appear only in Advanced. |
| [PagePro e-commerce](https://pagepro.in/ecommerce-gst-return) | Marketplace reports, B2CS aggregation by state/rate, portal JSON, TCS report comparison and state-wise Tally output | Verify complete return sections and client/period isolation. Its stated JSON version and “accepted” wording must be checked against the current official utility rather than copied as a specification. |
| [CAWork Suite](https://www.caworksuite.in/) | Public tools for marketplace GSTR-1, bank PDF to Tally and marketplace XML, naming Amazon/Flipkart/Meesho | Benchmark how few steps a first-time accountant needs. Public content did not establish acceptance results or depth of corrections. |
| [ClearGST](https://cleartax.in/gst) and [documented 2B/PR reconciliation](https://docs.cleartax.in/product-help-and-support/clear-finance-cloud/gst-compliance/gstr-2b-vs-pr-recon) | Broader GST suite: multi-registration reconciliation, purchase-register/2B review, IMS actions and filing workflows | An adjacent benchmark for review buckets, return periods, amendments and traceable decisions. It is broader than Repotic's two public products; full-suite parity is a separate expansion. |

[TallyPrime's own bank import](https://help.tallysolutions.com/bank-statement/) is also a baseline. Its documentation supports bank-downloaded CSV/Excel, with preview and reconciliation, and excludes PDF and CSV/Excel converted from PDF for this particular importer. Compare TallyThis against the accountant's existing option before adding another workflow.

### Repotic bank statement, observed 10 October 2026

Source: the user's Repotic trial account (one DBS Bank India statement, 60 rows) and Repotic's product-listing screenshots. The listing screenshots are vendor marketing, not tests.

| Repotic | Seen where | TallyThis now |
| --- | --- | --- |
| Opens straight into a full-width editor: back arrow, Opening/Closing Bal., Default / Bank toggle, Raise Query and a Download menu along the top; plain Date / Narration / Dr. / Cr. / Balance table | Trial account, 13 Oct 2026 | Built: after a statement is read it opens full screen (Default, Bank and Tally views) with the same top bar. The Excel download opens on the same layout (plus Chq/Ref, voucher, Tally ledger and review status) with a totals row. |
| Credit History: Date & time, File name, Bank name, Status, Pages, Charges, Balance, View, Raise a ticket; separate Query tab | Trial account, 13 Oct 2026 | Built for History: Date & time, File name, Details (bank, transactions, period), Status, View, Raise a ticket (opens an email about that item). **View** opens the saved statement in the same read-only viewer with Excel, CSV and Tally XML downloads. Not built: pages and charges (TallyThis has no credit system), the Query tab (client questions are not saved between visits yet). |
| Download menu: MCS, CSV, Tally XML | Trial account | Excel, CSV, Tally XML in the top-bar Download menu. "MCS" is most likely an export for MCS/MCSCA accounting software by [Mehta Computer Services, Surat](http://www.mcssurat.com/) (Repotic is also Surat-based); its import layout is not public, so it needs a sample file from the trial. |
| Desktop connector: choose Tally company, bank account and suspense account; map rows to the company's ledgers; one-click push | [Microsoft Store listing](https://apps.microsoft.com/detail/9nd71n2nr98b) | Built: Send to Tally lists open companies, loads the company's ledgers, preselects the matching bank and Suspense ledgers, and adds Tally's ledgers to every ledger list. Not tested against a live TallyPrime. |
| Default / Bank view toggle, per-row menu, Raise Query | Trial account | Built: Default / Bank / Tally toggle; row menu (confirm ledger, apply to party, money in/out, leave out, client query). Our Raise Query is a question to the client, copied as a list and exported as an Excel sheet; Repotic's may be a support ticket (not inspected). |
| Per-row voucher type and ledger dropdown | Listing screenshot | Built: per-row voucher (Receipt/Payment, Contra for cash) and ledger, carried into Tally XML, Excel and Send to Tally. Contra to another bank account is not offered yet. |
| "Connect to Tally" / "Send to Tally" direct posting | Listing screenshot | Built: Connect to Tally (lists open companies) and Send to Tally through TallyPrime's local XML server, with Tally's created/error counts and a duplicate-send warning. Not yet tested against a live TallyPrime. Works only when the API can reach Tally (same computer or network); a hosted deployment needs a local connector. |
| "Smart Suspense Solving" automatic categorisation | Listing screenshot | Rules, remembered choices and optional AI suggestions; unconfirmed parties stay in review. |

## TallyThis gap list

Statuses below refer to the feature branch, not a verified production deployment.

| Priority | Capability | Current evidence / remaining work | Acceptance evidence |
| --- | --- | --- | --- |
| P0 | Bank format coverage | 61 identities are recognized; synthetic PDF/CSV fixtures cover a few layouts. Logo recognition is not parsing support. | Redacted bank-generated examples for each released layout/account type; every row/date/sign/value compared with an independently checked answer file. |
| P0 | GST filing output | JSON is a proprietary review draft. Seller GSTIN, period, official section schema and acceptance are incomplete. | Current GST offline utility validation, processed portal result and CA-approved section totals, including amendments and errors. |
| P0 | Marketplace templates | Twelve names recognized; a shared column mapper and Amazon synthetic fixture do not prove twelve report layouts work. Multi-sheet completeness is unproven. | Versioned original report samples and expected answers for each marketplace/report type; all applicable sheets accounted for. |
| P0 | Returns, cancellations and adjustments | Cancelled/return/adjustment rows now excluded from active sales totals; source rows retained. Unlinked returns/adjustments stop Sales XML. | Correct linked credit notes, refunds, cancellations, fees, settlement amounts and tax dates, with no double counting. |
| P0 | GST registration and supply classification | Buyer GSTIN formatting and uploaded place of supply are reviewed; seller registration, period and operator mapping are incomplete. Table 14 is a draft heuristic. | Correct taxpayer and period; seller/buyer/operator distinction; documented treatment of section 52 versus section 9(5), B2B, B2CS/B2CL, exempt/nil/non-GST and cess. |
| P0 | TCS comparison | Uploaded state/TCS summary comparison works locally. Matching amounts do not verify the file's taxpayer, operator, period or source. | Actual portal reports; GSTIN/operator/period checks; explained timing/amendment differences and review sign-off. |
| P0 | Tally import and duplicates | Balanced XML and arithmetic tests; no actual Prime import or repeat-import proof. | Test-company import and re-export prove voucher/master/tax details; repeating a job cannot silently create duplicate books. |
| P0 | Reliable exception decisions | Amount/date alone now stay suggested. Complete shared references, exact paise, date window and ambiguity checks are required for the confirmed bucket. | Adversarial matching samples; zero incorrect confirmations in the release corpus; reference collisions and debit/credit conventions tested. |
| P1 | Accounting configuration | Sales XML assumes existing ledger names; B2B party mapping exists. State/rate-specific ledgers, bill-wise references and master compatibility are incomplete. | Real target-company master validation, preview and a complete supported voucher matrix. |
| P1 | Settlement-to-bank reconciliation | Bank/Tally and invoice/bank jobs exist; integrated order → return → fee/tax → payout → bank proof is missing. | A payout is explained completely, with differences shown to the CA rather than plugged. |
| P1 | Review history and reuse | Saved results and reviewed-pack artifacts exist. Immutable source values plus field-level old/new changes, actor/reason and correction reversal are incomplete. | Auditable edits across saved jobs; client isolation; all exports agree with the same approved revision. |
| P1 | Connector posting lifecycle | Customer-run Tally gateway code exists; the hosted upload workflows are not a verified direct integration. | Approved batch preview, company/master checks, import acknowledgements, partial-failure recovery and safe retry. |
| P1 | Multiple GSTINs and D2C | Client organization exists; multi-registration/period packs and verified Shopify/WooCommerce layouts do not. | Separate taxpayer-period results, correctly attributed transactions and consolidated working papers. |
| P2 | Broader CA tools | Inventory, purchase/2B/IMS and additional accounting-software outputs have varying prototype/upload support, not verified end-to-end parity. | Treat each as an explicit workflow with its own fixtures and acceptance test; keep it under Advanced until useful and reliable. |

## What “better” must mean

Run a head-to-head benchmark using the same authorized, redacted files and independently checked expected answers. Record every source row, each correction, accountant minutes, review items, clicks, exported voucher totals and actual Tally/GST acceptance results. Compare one workflow at a time; a larger feature list does not demonstrate a better product.

Maintain the five-step CA journey: select client → select job → upload → review exceptions → export. Keep seven main navigation items. The intended advantages are fewer review decisions, clearer source evidence, accurate and consistent exports, useful error messages and truthful privacy behavior.

Do not advertise feature parity until every Repotic row in the [existing comparison](REPOTIC_COMPARISON.md) has working implementation and acceptance evidence. Do not advertise universal “100% accuracy.” The [accuracy standard](ACCURACY_STANDARD.md) defines measurable release targets and the conditions under which a job must stop.

## REA assessment — 12 October 2026

The user identified [morluto/rea](https://github.com/morluto/rea). Its documentation supports website observation as well as native/application analysis. The [browser guide](https://rea.tools/guides/browser/) connects a user action to the selected page's requests, response shapes and delivered JavaScript. This could help investigate a specific competitor workflow through public pages or an authorized normal session.

REA is optional for the current result-view fix: TallyThis's source and Playwright already revealed that Excel was offered before the report sections, and tests verify the corrected tabs. For future research, capture one operation at a time—upload, correction, TCS comparison or export—and record evidence and limitations. Use synthetic/redacted examples and recreate the desired behavior in TallyThis with independent acceptance tests.

Observed client behavior does not expose a hosted service's private server code, full parser coverage or correctness on unobserved files. [MDN's client/server explanation](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Server-side/First_steps/Client-Server_overview) describes that separation. REA cannot establish GST accuracy or portal acceptance by inspecting a frontend.

No REA package, agent configuration or competitor session was installed or changed during this assessment. Its [setup documentation](https://github.com/morluto/rea/blob/main/docs/installation.md) describes client registration changes and distinguishes repository-main capabilities from the published package. Verify the chosen package and browser workflow before a scoped trial; the native decompiler setup is unnecessary for a website-only investigation.

## Conversion-first UX review — 12 October 2026

Evidence: the user's two Repotic screenshots show a simple upload page with three-step help, followed by a statement table with balances, Default/Bank views, Raise Query and Download. They prove the visible workflow, not parser accuracy or every paid feature. TallyThis previously opened the table, but forced ledger decisions into the primary conversion action. That interruption was a real usability gap.

Public vendor documentation reviewed in this pass:

| Product | Relevant workflow | TallyThis decision |
| --- | --- | --- |
| Repotic, user screenshots and [public website](https://www.repotic.in/) | Upload → readable statement → download; review tools beside the table | Keep the bank-format preview and direct Excel/XML buttons. Put ledger review in its own tab. |
| [LedgerConnect bank converter](https://ledgerconnect.in/bank-pdf-converter), [pricing](https://ledgerconnect.in/pricing) | One workspace for ledger choices, Excel/XML/connector outputs, search, client queries and reusable preferences | Add preview search and optional AI ledger suggestions. Keep the existing query worksheet, confirmed ledger preferences and connector under the appropriate workflow. Date-range exports and secure client response links remain candidates, not implemented claims. |
| [ClearGST reconciliation guide](https://docs.cleartax.in/product-help-and-support/clear-finance-cloud/gst-compliance/gstr-1-vs-sr-recon) | Select/upload datasets, reconcile and handle differences | Keep reconciliation as its own job. GST validation belongs in GST workflows, not in a bank conversion screen. |
| [Vyapar reconciliation page](https://vyaparapp.in/free/small-business-accounting-software/bank-reconciliation) | The page mixes reconciliation marketing with a notice that the reconciliation app is no longer provided | Do not treat marketing text as evidence of a currently available integration. |

These are vendor descriptions and supplied screenshots; no new competitor account or paid session was tested. Prices or feature names alone do not establish demand or correctness. Prioritise tasks that save repeated entry or client follow-up: statement conversion, remembered ledger choices, bulk corrections, exception reconciliation and query exports. Keep practice management and unrelated dashboards out of the conversion screen.

Implemented on the feature branch: bank-format preview by default; direct Excel and Tally XML downloads; separate Review; unchecked AI review; narration/date/amount search; three-step help; official DBS identity logo. Conversion-only XML uses Suspense and Receipt/Payment vouchers. Enabling reviewed choices uses only confirmed ledgers; unconfirmed AI suggestions remain in Suspense. Excel, XML, CSV and direct posting share these output choices. Uncertain source values still stop XML until checked, and conflicting closing/sequence checks require a better statement. Excel remains a working copy. Search never limits the download. These changes do not certify real bank-format coverage or TallyPrime import acceptance.

Browser evidence covers conversion-only exports on desktop/mobile, full export despite filtered preview, explicit AI opt-in, unconfirmed suggestion isolation, bank correction, row choices, queries, posting and source-check gates. Backend fixtures validate workbook values, XML balance/structure and Suspense posting; production import acceptance remains a separate gate.

## Prioritised delivery — 12 October 2026

The user prioritised reliable statement conversion/imports, complete marketplace GST outputs, and reusable ledger choices/client queries. This is the current evidence, not a declaration that all three are finished:

| Priority | Implemented and locally tested | Still required |
| --- | --- | --- |
| Statement conversion and imports | Exact integer-paise running/closing checks and totals; sub-paise/unreadable amounts stop; multi-table or truncated Excel sheets stop instead of silently losing rows; incomplete first-row proof stays unverified; XML rejects same-bank ledger lines, unsupported precision and control characters. Direct posting stops on unexplained master failures or missing acknowledgements. A real-engine preflight/read-back runner exists. | Real bank-format corpus, loaded disposable Tally company, successful actual import/read-back, repeat-import/partial-failure proof and deployed authorization tests. The official educational engine answered, but no company was loaded. See [acceptance record](TALLY_IMPORT_ACCEPTANCE.md). |
| Marketplace GST | Signed source values are retained; unreadable amounts stop a multi-file batch. Supported credit notes link to one original invoice row in the same upload, check buyer/state/HSN/rate, dates, signs and cumulative limits, reduce net/HSN totals, and reverse Sales/GST ledger lines in Credit Note XML. Excel and draft JSON retain credit-note evidence. | Multi-line/cross-period originals, amendments, seller/operator identity and period gates, actual platform templates, fees/settlements and verified portal JSON/Tally acceptance. Unlinked returns and unsupported adjustments still stop XML. |
| Ledger reuse and client questions | Exact-party preference matching; newer choices merge with previous parties rather than replacing the entire profile. Client questions download separately with an answer column. CSV strings that could become spreadsheet formulas are escaped. | Deployed persistence/client-isolation checks, field-level review history, secure client-response links and connector retry acceptance. |

No real samples were available from the user. Automated financial tests remain synthetic. The current [official GST return downloads](https://www.gst.gov.in/download/returns) were also inspected: the page displayed Returns Offline Tool V3.2.4 and linked its official package, containing separate B2B/B2CS/CDNR/CDNUR and B2B/B2C HSN CSV templates. The public example values are illustrative, not independently verified books. Downloading those templates does not prove that TallyThis's proprietary JSON is accepted by the utility or portal; no filing was performed.

## Purchase vouchers, GSTR-1/3B working and payroll — 15 October 2026

The user asked for the gaps found in the CA-workflow review to be built: purchase bills into Tally with party and ledger mapping, GSTR-1 and GSTR-3B working from a Tally sales register, payroll with the employer's details, History that shows all of it, and a measurable way to test on real CA files. Sources for what Vyapar TaxOne, Vouchrit and Tally themselves advertise are the pages listed above; nothing was run in a paid account.

| Capability | Competitor evidence (vendor pages, not tests) | TallyThis now | Not proved |
| --- | --- | --- | --- |
| Purchase bill → Tally Purchase voucher | [TaxOne](https://taxone.vyapar.com/data-entry-automation-feature) and [Vouchrit](https://www.vouchrit.com/) post purchase and sale entries to Tally; Tally has [its own AI invoice capture](https://tallysolutions.com/tally/tallyprime-ai-invoice-processing-indian-smes/) | PDF text, scans (AI, with consent) and purchase lists read; every bill checked in paise; supplier ledger and purchase ledger mapping remembered per client; Purchase XML with stable GUID; Send to Tally | Import into a live TallyPrime, GST register output, several rates on one invoice, repeat-import behaviour |
| Sales register → GSTR-1 tables | Tally's own GSTR-1 report exports JSON; TaxOne and ClearGST offer return workflows | Register sorted into B2B, B2C Large/Small, notes, exports/SEZ, nil, HSN, documents; tables proved against the register | Portal or offline-utility acceptance, amendments, exports detail, multi-rate invoices without item lines |
| GSTR-3B working | Tally and ClearGST fill 3B from 1 and 2B | 3.1, 3.2, 4 and 6.1 with the legal order of set-off, credit from a saved GSTR-2B ↔ Books result | Interest, late fee, RCM from books, reversals worked out; CA decides credit |
| Payroll | Tally has payroll; TaxOne has no equivalent page in the sources read | Employer details kept per client; per-employee checks; PF/ESI/PT/TDS working with computed figures marked; bank payment check; Tally journal | ECR, challan, Form 24Q, state PT slabs, real salary-software layouts |

What changed in the product: three new jobs under Advanced → More jobs (also offered on Home and in search), Home routes a dropped sales register, salary sheet or bill to the right job, every job ends with a "What next?" list, History and the month pack read the new run types, and the old Payroll page now redirects to the Payroll job.

Evidence still needed: real redacted files from at least three CAs run through `measure-corpus` with hand-checked answers, and the acceptance runner `verify-tally-books` passing against a disposable TallyPrime company. TallyPrime was installed on the development machine but no company was open and computer control of it was declined, so that check has not run.

## GST reconciliation and CA outputs — 15 October 2026

The user asked for a ClearGST-style check of what TallyThis was missing for a CA, and for every dead end to be fixed. Sources are the vendors' own help pages as read on this date; nothing was run in a paid account.

| Capability | ClearTax (documented) | TallyPrime (help pages) | TallyThis now |
| --- | --- | --- | --- |
| Match groups for GSTR-2B vs purchase register | [Exact, Suggested, Mismatch, Missing](https://docs.cleartax.in/product-help-and-support/clear-finance-cloud/gst-compliance/gstr-2b-vs-pr-recon) | [Reconciliation report grouped by status, with "Potential Matches" where amounts agree but section, GSTIN or document number differs](https://help.tallysolutions.com/gstr-2b-reconciliation/) | Matched, probable (suggested), amounts differ, missing on either side, entered twice, ITC not available. Built; tested on synthetic fixtures only. |
| Tolerance | ±₹1 on taxable or tax value | not stated | ₹1 per component, stated on the row ("agrees within ₹1, rounding"). |
| Fetch GSTR-2B from the portal with credentials | Yes | Import of the downloaded JSON | No. Upload-based; no portal login. |
| Several months, PAN-level (many GSTINs) | Multi-month and PAN level (higher plan) | Month by month | Several GSTR-2B files in one run. One GSTIN per run; files for different GSTINs are refused. |
| Vendor communication | Email results to vendors with remarks | not stated | A message per supplier to copy or email, and a supplier sheet in Excel. No bulk sending, no contact master. |
| Actions on a document | Claim (month, percentage), pend, reverse, ineligible, reject, link / delink | Accept / pending marks | Confirm, not a match, ask supplier, to be booked, not our purchase, and a manual link of two one-sided documents. No claim month or percentage. |
| Feeds GSTR-3B Table 4 | Yes, with a calculation trail | not stated | ITC by tax head (IGST, CGST, SGST, cess) in the result and Excel; no Table 4 auto-fill. |
| Bank reconciliation statement | not part of this page | not part of this page | Bank balance to books balance, with an optional Tally balance to prove it adds up, and the entries missing in Tally as vouchers. |

What was missing before this pass, and is now built, in order of effect on a CA:

1. **GSTR-2B ↔ Books** did not exist as a job. The only GSTR-2B screen compared uploaded 2B rows with invoices already imported into the old month-close tables, matched on an exact string, and read a JSON shape that is not the portal's. It is now a job on the same pattern as the other four, with a deterministic engine, a purchase-register reader that finds columns by their headings (Tally-style tax columns, Zoho-style headings, spreadsheet date serials), several months in one run, and an Excel working copy. When no heading is recognised, an optional AI step may name the columns from heading text and the share of GSTIN-, date- and amount-like cells (never the cells themselves); each suggestion is checked against the data, a low-confidence or mismatching one is dropped, and the result says which columns were matched that way. It is not used without an AI key, and in privacy mode only if the person allows it. It does not take part in matching.
2. **Bank ↔ Tally** ended at a list of differences. It now ends at a reconciliation statement and the missing vouchers.
3. **Invoice ↔ Bank** ended at "Not a match / Ask client". It now offers a copy-ready request for payments with no invoice, and an Excel file.
4. **Reports** led with a CA pack that is blocked for anyone who only uses the four jobs ("Reconciliation has not been run yet"). It now leads with a month pack built from the saved jobs, and the older pack names each blocker with a link to fix it.
5. **26AS TDS** accepted only a CSV with exact column names, and matched books lines to 26AS by TAN or name string, so a ledger with party names only showed everything as missing. It now reads the TRACES text file, Excel and CSV, finds headings anywhere in the first rows, and matches a name-only line through the TAN of the same tidied name. A PDF is refused with the way to get a readable copy.
6. **Dead ends**: a blank white page on any failed reply (about twenty pages), a 404 with a developer's sentence and no link, empty pages with no action, a Statutory calendar that called every past date "overdue", an action that reported "CA pack ready" when the server had failed, and no way to find a page other than a 24-item flat list.

Not built, and not claimed: portal login and automatic GSTR-2B download, Table 4 auto-fill, claim month and percentage, bulk email, e-invoice or e-way bill, filing, GSTR-1 preparation from a Tally sales register, and any statement that the output is accepted by the GST portal or by TallyPrime.

Evidence still needed: real GSTR-2B JSON and Excel downloads for several periods (item-level and invoice-level layouts, credit notes, amendments, reverse charge), real purchase-register exports from TallyPrime, Busy and Zoho Books, and a real TRACES text file. The portal Excel and TRACES text layouts were reconstructed from public descriptions and synthetic samples, so a layout that differs will stop with a message rather than be guessed.
