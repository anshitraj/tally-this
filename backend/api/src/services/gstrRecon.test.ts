import assert from "node:assert/strict";
import test from "node:test";
import { readRegisterFile } from "./gstrFiles";
import * as XLSX from "xlsx";
import {
  applySuggestions,
  canonicalDocNumber,
  gstinChecksumOk,
  linkItems,
  parsePortalJson,
  readDocsFromTable,
  readPortalWorkbook,
  reconcile,
  toPaise,
  type GstDoc,
  type Table,
} from "./gstrRecon";

// Two real-shaped GSTINs (state code 27 and 29) with valid checksum characters.
const SUPPLIER_A = "27AAPFU0939F1ZV";
const SUPPLIER_B = "29AABCT1332L1ZK";

function portalJson(body: unknown) {
  return JSON.stringify({ data: { gstin: "27ABCDE1234F1Z5", rtnprd: "102026", version: "1.0", docdata: body } });
}

const OCT_B2B = {
  b2b: [
    {
      ctin: SUPPLIER_A,
      trdnm: "Alpha Traders",
      supprd: "102026",
      inv: [
        { inum: "INV-001", typ: "R", dt: "05-10-2026", val: 11800, pos: "27", rev: "N", itcavl: "Y", txval: 10000, igst: 0, cgst: 900, sgst: 900, cess: 0 },
        { inum: "INV-002", typ: "R", dt: "09-10-2026", val: 5900, pos: "27", rev: "N", itcavl: "Y", txval: 5000, igst: 0, cgst: 450, sgst: 450, cess: 0 },
        { inum: "INV-003", typ: "R", dt: "11-10-2026", val: 2360, pos: "27", rev: "N", itcavl: "N", rsn: "Section 17(5)", txval: 2000, igst: 0, cgst: 180, sgst: 180, cess: 0 },
      ],
    },
    {
      ctin: SUPPLIER_B,
      trdnm: "Beta Metals",
      supprd: "102026",
      inv: [
        { inum: "BM/24-25/0042", typ: "R", dt: "12-10-2026", val: 118000, pos: "27", rev: "N", itcavl: "Y", items: [{ num: 1, rt: 18, txval: 60000, igst: 10800, cgst: 0, sgst: 0, cess: 0 }, { num: 2, rt: 18, txval: 40000, igst: 7200, cgst: 0, sgst: 0, cess: 0 }] },
      ],
    },
  ],
  cdnr: [
    { ctin: SUPPLIER_A, trdnm: "Alpha Traders", nt: [{ ntnum: "CN-9", typ: "C", dt: "20-10-2026", val: 1180, itcavl: "Y", txval: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 }] },
  ],
};

function books(rows: Array<Partial<GstDoc> & { docNumber: string; gstin: string }>): GstDoc[] {
  return rows.map((row, index) => {
    const taxable = row.taxable ?? 0;
    return {
      source: "books" as const,
      row: index + 2,
      gstinValid: true,
      supplierName: "",
      docKey: canonicalDocNumber(row.docNumber),
      docDate: "2026-10-05",
      kind: "invoice" as const,
      voucherNo: null,
      taxable,
      igst: 0,
      cgst: 0,
      sgst: 0,
      cess: 0,
      total: taxable,
      itcAvailable: null,
      itcReason: null,
      reverseCharge: false,
      ...row,
    };
  });
}

test("amounts are read exactly or refused, never rounded", () => {
  assert.equal(toPaise("1,23,456.50"), 12345650);
  assert.equal(toPaise("(450.00)"), -45000);
  assert.equal(toPaise("₹ 1,000 Dr"), 100000);
  assert.equal(toPaise(10.5), 1050);
  assert.equal(toPaise("100.005"), null);
  assert.equal(toPaise("twelve"), null);
  assert.equal(toPaise("-"), 0);
});

test("a valid GSTIN passes its checksum and a typo does not", () => {
  assert.equal(gstinChecksumOk(SUPPLIER_A), true);
  assert.equal(gstinChecksumOk("27AAPFU0939F1ZW"), false);
  assert.equal(gstinChecksumOk("NOTAGSTIN"), false);
});

test("the portal JSON is read: invoices, item-level amounts and credit notes", () => {
  const read = parsePortalJson(portalJson(OCT_B2B));
  assert.equal(read.period, "2026-10");
  assert.equal(read.recipientGstin, "27ABCDE1234F1Z5");
  assert.equal(read.docs.length, 5);
  const beta = read.docs.find(doc => doc.docNumber === "BM/24-25/0042")!;
  assert.equal(beta.taxable, 10000000);
  assert.equal(beta.igst, 1800000);
  assert.equal(beta.docDate, "2026-10-12");
  const credit = read.docs.find(doc => doc.docNumber === "CN-9")!;
  assert.equal(credit.kind, "note");
  assert.equal(credit.taxable, -100000);
  assert.equal(credit.cgst, -9000);
  const blocked = read.docs.find(doc => doc.docNumber === "INV-003")!;
  assert.equal(blocked.itcAvailable, false);
  assert.equal(blocked.itcReason, "Section 17(5)");
});

test("a file that is not GSTR-2B says so plainly", () => {
  assert.throws(() => parsePortalJson("not json"), /not a GSTR-2B JSON/);
  assert.throws(() => parsePortalJson(JSON.stringify({ data: { docdata: {} } })), /No supplier invoices/);
});

test("an amount that cannot be read exactly stops the file", () => {
  const body = { b2b: [{ ctin: SUPPLIER_A, inv: [{ inum: "X1", dt: "01-10-2026", val: 100, txval: 99.999, igst: 0, cgst: 0, sgst: 0 }] }] };
  assert.throws(() => parsePortalJson(portalJson(body)), /could not be read exactly/);
});

test("matching: exact, rounding, value difference, missing on either side, and ITC not available", () => {
  const portal = parsePortalJson(portalJson(OCT_B2B));
  const register = books([
    { gstin: SUPPLIER_A, docNumber: "INV-001", taxable: 1000000, cgst: 90000, sgst: 90000, total: 1180000, supplierName: "Alpha Traders" },
    // 2 paise of rounding on CGST: still a rule match.
    { gstin: SUPPLIER_A, docNumber: "inv 002", taxable: 500000, cgst: 45001, sgst: 45000, total: 590000 },
    // The books show less taxable value than the supplier reported.
    { gstin: SUPPLIER_B, docNumber: "BM/24-25/0042", taxable: 9000000, igst: 1620000, total: 10620000 },
    // Booked, never reported by the supplier.
    { gstin: SUPPLIER_B, docNumber: "BM/9", taxable: 100000, igst: 18000, total: 118000, docDate: "2026-10-20" },
    // The portal says ITC is not available for this one.
    { gstin: SUPPLIER_A, docNumber: "INV-003", taxable: 200000, cgst: 18000, sgst: 18000, total: 236000 },
  ]);
  const result = reconcile(portal.docs, register, { period: portal.period });
  const byDoc = (number: string) => result.items.find(item => item.docNumber === number)!;

  assert.equal(byDoc("INV-001").bucket, "matched");
  assert.equal(byDoc("INV-001").confidence, "exact");
  assert.equal(byDoc("inv 002").bucket, "matched");
  assert.equal(byDoc("inv 002").confidence, "tolerance");
  assert.equal(byDoc("BM/24-25/0042").bucket, "value_mismatch");
  assert.equal(byDoc("BM/24-25/0042").diff?.taxable, -10000);
  assert.equal(byDoc("BM/24-25/0042").diff?.igst, -1800);
  assert.equal(byDoc("BM/9").bucket, "missing_in_2b");
  assert.equal(byDoc("BM/9").itcAtRisk, 180);
  assert.equal(byDoc("INV-003").bucket, "not_eligible");
  assert.match(byDoc("INV-003").why[0], /Section 17\(5\)/);
  assert.equal(byDoc("CN-9").bucket, "missing_in_books");
  assert.equal(byDoc("CN-9").kind, "note");

  assert.equal(result.counts.matched, 2);
  assert.equal(result.counts.value_mismatch, 1);
  assert.equal(result.counts.missing_in_2b, 1);
  assert.equal(result.counts.missing_in_books, 1);
  assert.equal(result.counts.not_eligible, 1);
  // The books claim ₹16,200 IGST against ₹18,000 in GSTR-2B: nothing at risk, ₹1,800 unclaimed.
  assert.equal(byDoc("BM/24-25/0042").itcAtRisk, 0);
  assert.equal(byDoc("BM/24-25/0042").itcUnclaimed, 1800);
  assert.equal(result.suppliers[0].gstin, SUPPLIER_B);
  assert.equal(result.suppliers[0].missing[0].docNumber, "BM/9");
});

test("an amount alone never confirms a match: a different invoice number is only a suggestion", () => {
  const portal = parsePortalJson(portalJson({ b2b: [{ ctin: SUPPLIER_A, inv: [{ inum: "A-77", dt: "03-10-2026", val: 1180, itcavl: "Y", txval: 1000, igst: 0, cgst: 90, sgst: 90 }] }] }));
  const register = books([{ gstin: SUPPLIER_A, docNumber: "SALE-4321", taxable: 100000, cgst: 9000, sgst: 9000, total: 118000, docDate: "2026-10-04" }]);
  const result = reconcile(portal.docs, register, { period: "2026-10" });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].bucket, "probable");
  assert.equal(result.items[0].confidence, "review");
  assert.equal(result.items[0].status, "suggested");
  assert.equal(result.counts.matched, 0);
});

test("a suggestion is withheld when two documents could be the same one", () => {
  const portal = parsePortalJson(portalJson({ b2b: [{ ctin: SUPPLIER_A, inv: [{ inum: "P-1", dt: "03-10-2026", val: 1180, itcavl: "Y", txval: 1000, igst: 0, cgst: 90, sgst: 90 }] }] }));
  const register = books([
    { gstin: SUPPLIER_A, docNumber: "Q-1", taxable: 100000, cgst: 9000, sgst: 9000, total: 118000 },
    { gstin: SUPPLIER_A, docNumber: "Q-2", taxable: 100000, cgst: 9000, sgst: 9000, total: 118000 },
  ]);
  const result = reconcile(portal.docs, register, { period: "2026-10" });
  assert.equal(result.counts.probable, 0);
  assert.equal(result.counts.missing_in_2b, 2);
  assert.equal(result.counts.missing_in_books, 1);
});

test("the same invoice number written differently is a suggestion; a mistyped GSTIN is flagged", () => {
  const portal = parsePortalJson(portalJson({
    b2b: [
      { ctin: SUPPLIER_A, inv: [{ inum: "INV0012", dt: "03-10-2026", val: 1180, itcavl: "Y", txval: 1000, igst: 0, cgst: 90, sgst: 90 }] },
      { ctin: SUPPLIER_B, inv: [{ inum: "SB-500", dt: "04-10-2026", val: 2360, itcavl: "Y", txval: 2000, igst: 360, cgst: 0, sgst: 0 }] },
    ],
  }));
  const register = books([
    { gstin: SUPPLIER_A, docNumber: "INV/12", taxable: 100000, cgst: 9000, sgst: 9000, total: 118000 },
    { gstin: "29AABCT1332L1ZX", docNumber: "SB-500", taxable: 200000, igst: 36000, total: 236000, docDate: "2026-10-04" },
  ]);
  const result = reconcile(portal.docs, register, { period: "2026-10" });
  const alike = result.items.find(item => item.docNumber === "INV/12")!;
  assert.equal(alike.bucket, "probable");
  assert.match(alike.why[0], /written differently/);
  const typo = result.items.find(item => item.docNumber === "SB-500")!;
  assert.equal(typo.bucket, "probable");
  assert.match(typo.why[0], /GSTIN differs/);
});

test("a bill entered twice is flagged once and its ITC is at risk", () => {
  const portal = parsePortalJson(portalJson({ b2b: [{ ctin: SUPPLIER_A, inv: [{ inum: "D-1", dt: "03-10-2026", val: 1180, itcavl: "Y", txval: 1000, igst: 0, cgst: 90, sgst: 90 }] }] }));
  const register = books([
    { gstin: SUPPLIER_A, docNumber: "D-1", taxable: 100000, cgst: 9000, sgst: 9000, total: 118000, voucherNo: "P/1" },
    { gstin: SUPPLIER_A, docNumber: "D-1", taxable: 100000, cgst: 9000, sgst: 9000, total: 118000, voucherNo: "P/2" },
  ]);
  const result = reconcile(portal.docs, register, { period: "2026-10" });
  assert.equal(result.counts.matched, 1);
  assert.equal(result.counts.duplicate, 1);
  assert.equal(result.items.find(item => item.bucket === "duplicate")!.itcAtRisk, 180);
});

test("lines of one bill in the books are added together before matching", () => {
  const portal = parsePortalJson(portalJson({ b2b: [{ ctin: SUPPLIER_A, inv: [{ inum: "L-1", dt: "03-10-2026", val: 1770, itcavl: "Y", txval: 1500, igst: 0, cgst: 135, sgst: 135 }] }] }));
  const register = books([
    { gstin: SUPPLIER_A, docNumber: "L-1", taxable: 100000, cgst: 9000, sgst: 9000, total: 118000 },
    { gstin: SUPPLIER_A, docNumber: "L-1", taxable: 50000, cgst: 4500, sgst: 4500, total: 59000 },
  ]);
  const result = reconcile(portal.docs, register, { period: "2026-10" });
  assert.equal(result.counts.matched, 1);
  assert.equal(result.counts.duplicate, 0);
  assert.match(result.items[0].why.join(" "), /2 lines/);
});

test("a purchase register export is read by its headings, with Tally-style tax columns", () => {
  const table: Table = [
    ["Purchase Register"],
    ["Alpha Trading Co", "", "", "", "", "", "", "", ""],
    ["Date", "Particulars", "Voucher Type", "Voucher No.", "Supplier Invoice No.", "Supplier Invoice Date", "GSTIN/UIN", "Gross Total", "Purchase", "Input CGST @9%", "Input SGST @9%"],
    ["05-Oct-2026", "Alpha Traders", "Purchase", "P/101", "INV-001", "05-Oct-2026", SUPPLIER_A, "11,800.00", "10,000.00", "900.00", "900.00"],
    ["10-Oct-2026", "Beta Metals", "Debit Note", "DN/3", "BM-RET-1", "10-Oct-2026", SUPPLIER_B, "1,180.00", "1,000.00", "90.00", "90.00"],
    ["", "Cash purchase, no GSTIN", "Purchase", "P/102", "", "", "", "500.00", "500.00", "", ""],
    ["Grand Total", "", "", "", "", "", "", "13,480.00", "", "", ""],
  ];
  const read = readDocsFromTable(table, "books");
  assert.equal(read.docs.length, 2);
  const [invoice, note] = read.docs;
  assert.equal(invoice.docNumber, "INV-001");
  // "Supplier Invoice No." is a number, not the supplier's name; "Particulars" is the name.
  assert.equal(invoice.supplierName, "Alpha Traders");
  assert.equal(invoice.docDate, "2026-10-05");
  assert.equal(invoice.taxable, 1000000);
  assert.equal(invoice.cgst, 90000);
  assert.equal(invoice.total, 1180000);
  assert.equal(invoice.voucherNo, "P/101");
  // A debit note raised on the supplier (a purchase return) reduces ITC.
  assert.equal(note.kind, "note");
  assert.equal(note.taxable, -100000);
  assert.equal(note.cgst, -9000);
});

test("other billing software layouts: Zoho-style headings and spreadsheet date serials", () => {
  const table: Table = [
    ["Bill Date", "Bill#", "Vendor Name", "GST Identification Number (GSTIN)", "SubTotal", "CGST", "SGST", "IGST", "Total"],
    [46300, "ZB-17", "Gamma Supplies", SUPPLIER_A, 2000, 180, 180, 0, 2360],
    [46301.0, "ZB-18", "Gamma Supplies", SUPPLIER_A, "1,500.00", "(0)", "-", 270, 1770],
  ];
  const read = readDocsFromTable(table, "books");
  assert.equal(read.docs.length, 2);
  assert.equal(read.docs[0].supplierName, "Gamma Supplies");
  assert.equal(read.docs[0].docNumber, "ZB-17");
  // 46300 is 5 October 2026 in a spreadsheet's day count.
  assert.equal(read.docs[0].docDate, "2026-10-05");
  assert.equal(read.docs[0].taxable, 200000);
  assert.equal(read.docs[1].igst, 27000);
  assert.equal(read.docs[1].total, 177000);
});

test("amounts with extra decimals are rounded to the paisa and the person is told", () => {
  const table: Table = [
    ["Invoice No", "Invoice Date", "Supplier GSTIN", "Taxable Value", "CGST", "SGST", "Total"],
    ["R-1", "05-10-2026", SUPPLIER_A, 1000, 90.0045, 90.0045, 1180.009],
  ];
  const read = readDocsFromTable(table, "books");
  assert.equal(read.docs[0].cgst, 9000);
  assert.match(read.notes.join(" "), /rounded to the nearest paisa/);
  const bad: Table = [
    ["Invoice No", "Invoice Date", "Supplier GSTIN", "Taxable Value", "CGST", "SGST", "Total"],
    ["R-2", "05-10-2026", SUPPLIER_A, "about 1000", 90, 90, 1180],
  ];
  assert.throws(() => readDocsFromTable(bad, "books"), /could not be read as an amount/);
});

test("a register without GSTIN or invoice number columns is refused with what to add", () => {
  const table: Table = [
    ["Date", "Particulars", "Amount"],
    ["05-Oct-2026", "Alpha Traders", "100"],
    ["06-Oct-2026", "Beta", "200"],
  ];
  assert.throws(() => readDocsFromTable(table, "books"), /could not find the columns|no column for/);
  const table2: Table = [
    ["Invoice No", "Date", "Taxable Value", "IGST", "Total"],
    ["A1", "05-10-2026", 100, 18, 118],
    ["A2", "06-10-2026", 200, 36, 236],
  ];
  assert.throws(() => readDocsFromTable(table2, "books"), /supplier GSTIN/);
});

test("portal Excel: one line per tax rate becomes one document; credit notes reduce ITC", () => {
  const b2b: Table = [
    ["Goods and Services Tax - GSTR-2B"],
    ["", "", "", "", "", "", "Taxable Value (₹)", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)"],
    ["GSTIN of supplier", "Trade/Legal name", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "Taxable Value (₹)", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", "Rate(%)", "ITC Availability", "Reason"],
    [SUPPLIER_A, "Alpha Traders", "INV-9", "Regular", "07-10-2026", 17700, 10000, 0, 900, 900, 0, 18, "Yes", ""],
    [SUPPLIER_A, "Alpha Traders", "INV-9", "Regular", "07-10-2026", 17700, 5000, 0, 225, 225, 0, 9, "Yes", ""],
  ];
  const cdnr: Table = [
    ["GSTIN of supplier", "Trade/Legal name", "Note number", "Note type", "Note date", "Note value (₹)", "Taxable Value (₹)", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", "ITC Availability"],
    [SUPPLIER_A, "Alpha Traders", "CN-1", "Credit note", "20-10-2026", 1180, 1000, 0, 90, 90, 0, "Yes"],
    [SUPPLIER_A, "Alpha Traders", "DN-1", "Debit note", "21-10-2026", 590, 500, 0, 45, 45, 0, "Yes"],
  ];
  const read = readPortalWorkbook([
    { name: "Read me", table: [["Financial Year", "2026-27"], ["Tax Period", "October"], ["GSTIN", "27ABCDE1234F1Z5"]] },
    { name: "B2B", table: b2b },
    { name: "B2B-CDNR", table: cdnr },
  ]);
  assert.equal(read.period, "2026-10");
  const invoice = read.docs.find(doc => doc.docNumber === "INV-9")!;
  assert.equal(invoice.taxable, 1500000);
  assert.equal(invoice.cgst, 112500);
  assert.equal(invoice.total, 1770000);
  const credit = read.docs.find(doc => doc.docNumber === "CN-1")!;
  assert.equal(credit.cgst, -9000);
  const debit = read.docs.find(doc => doc.docNumber === "DN-1")!;
  assert.equal(debit.cgst, 4500);
});

test("the period explains documents dated outside it", () => {
  const portal = parsePortalJson(portalJson({ b2b: [{ ctin: SUPPLIER_A, inv: [{ inum: "Z-1", dt: "03-10-2026", val: 118, itcavl: "Y", txval: 100, igst: 18 }] }] }));
  const register = books([{ gstin: SUPPLIER_A, docNumber: "Y-9", taxable: 20000, igst: 3600, total: 23600, docDate: "2026-09-15" }]);
  const result = reconcile(portal.docs, register, { period: "2026-10" });
  const item = result.items.find(entry => entry.docNumber === "Y-9")!;
  assert.equal(item.bucket, "missing_in_2b");
  assert.match(item.why.join(" "), /another month/);
});

test("tax split between heads is called out; totals are also given by head", () => {
  const portal = parsePortalJson(portalJson({ b2b: [{ ctin: SUPPLIER_A, inv: [{ inum: "S-1", dt: "03-10-2026", val: 1180, itcavl: "Y", txval: 1000, igst: 180, cgst: 0, sgst: 0 }] }] }));
  const register = books([{ gstin: SUPPLIER_A, docNumber: "S-1", taxable: 100000, cgst: 9000, sgst: 9000, total: 118000 }]);
  const result = reconcile(portal.docs, register, { period: "2026-10" });
  const item = result.items[0];
  assert.equal(item.bucket, "value_mismatch");
  assert.match(item.why[0], /split differently between IGST and CGST\/SGST/);
  // Books claim CGST and SGST that GSTR-2B shows as IGST: the books' heads are at risk, the portal's are not in books.
  assert.equal(result.byHead.atRisk.cgst, 90);
  assert.equal(result.byHead.atRisk.sgst, 90);
  assert.equal(result.byHead.unclaimed.igst, 180);
  assert.equal(result.byHead.portal.total, 180);
  assert.equal(result.byHead.books.total, 180);
});

test("several GSTR-2B months are compared together", () => {
  const oct = parsePortalJson(portalJson({ b2b: [{ ctin: SUPPLIER_A, inv: [{ inum: "O-1", dt: "03-10-2026", val: 118, itcavl: "Y", txval: 100, igst: 18 }] }] }));
  const nov = parsePortalJson(JSON.stringify({ data: { gstin: "27ABCDE1234F1Z5", rtnprd: "112026", docdata: { b2b: [{ ctin: SUPPLIER_A, inv: [{ inum: "N-1", dt: "03-11-2026", val: 236, itcavl: "Y", txval: 200, igst: 36 }] }] } } }));
  const register = books([
    { gstin: SUPPLIER_A, docNumber: "O-1", taxable: 10000, igst: 1800, total: 11800, docDate: "2026-10-03" },
    { gstin: SUPPLIER_A, docNumber: "N-1", taxable: 20000, igst: 3600, total: 23600, docDate: "2026-11-03" },
    { gstin: SUPPLIER_A, docNumber: "D-1", taxable: 30000, igst: 5400, total: 35400, docDate: "2026-12-03" },
    { gstin: SUPPLIER_A, docNumber: "X-1", taxable: 40000, igst: 7200, total: 47200, docDate: "2026-11-20" },
  ]);
  const result = reconcile([...oct.docs, ...nov.docs], register, { periods: [oct.period!, nov.period!] });
  assert.deepEqual(result.periods, ["2026-10", "2026-11"]);
  assert.equal(result.counts.matched, 2);
  const december = result.items.find(item => item.docNumber === "D-1")!;
  assert.match(december.why.join(" "), /outside the GSTR-2B months uploaded/);
  const inPeriod = result.items.find(item => item.docNumber === "X-1")!;
  assert.match(inPeriod.why.join(" "), /may not have filed/);
});

test("a manual link turns two one-sided documents into one and updates the totals", () => {
  const portal = parsePortalJson(portalJson({ b2b: [{ ctin: SUPPLIER_A, inv: [{ inum: "AB-7", dt: "03-10-2026", val: 1180, itcavl: "Y", txval: 1000, igst: 0, cgst: 90, sgst: 90 }] }] }));
  // A different number, a different date more than a month away and a different amount: no rule links them.
  const register = books([{ gstin: SUPPLIER_A, docNumber: "Z/2026/9", taxable: 100000, cgst: 9000, sgst: 9000, total: 118000, docDate: "2026-08-01" }]);
  const result = reconcile(portal.docs, register, { period: "2026-10" });
  assert.equal(result.counts.missing_in_2b, 1);
  assert.equal(result.counts.missing_in_books, 1);
  const bookKey = result.items.find(item => item.bucket === "missing_in_2b")!.key;
  const portalKey = result.items.find(item => item.bucket === "missing_in_books")!.key;

  const linked = linkItems(result, bookKey, portalKey);
  assert.equal(linked.ok, true);
  if (!linked.ok) return;
  assert.equal(linked.items.length, 1);
  assert.equal(linked.items[0].bucket, "matched");
  assert.equal(linked.items[0].status, "approved");
  assert.match(linked.items[0].why[0], /Linked by you/);
  assert.equal(linked.summary.counts.matched, 1);
  assert.equal(linked.summary.counts.missing_in_2b, 0);
  assert.equal(linked.summary.totals.itcAtRisk, 0);
  assert.equal(linked.summary.totals.matchedTax, 180);

  // Two documents that are both in the books cannot be linked.
  const both = linkItems(result, bookKey, bookKey);
  assert.equal(both.ok, false);
});

test("headings nobody recognises are named by an assistant, and the data checks the answer", async () => {
  const rows = [
    ["Ref", "Dt", "Vendor", "Tax ID", "Net", "Tax1", "Tax2", "Gross"],
    ["A-1", "05-10-2026", "Alpha Traders", SUPPLIER_A, 1000, 90, 90, 1180],
    ["A-2", "06-10-2026", "Alpha Traders", SUPPLIER_A, 500, 45, 45, 590],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Register");
  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;

  // Without an assistant the file is refused with what is missing.
  await assert.rejects(() => readRegisterFile({ originalname: "register.xlsx", buffer }), /no column for|could not find the columns/);

  const asked: string[][] = [];
  const read = await readRegisterFile({ originalname: "register.xlsx", buffer }, async columns => {
    asked.push(columns.map(column => column.header));
    return [
      { originalColumn: "Ref", mappedField: "invoice_number", confidence: 0.9 },
      { originalColumn: "Dt", mappedField: "invoice_date", confidence: 0.9 },
      { originalColumn: "Vendor", mappedField: "supplier_name", confidence: 0.9 },
      { originalColumn: "Tax ID", mappedField: "supplier_gstin", confidence: 0.95 },
      { originalColumn: "Net", mappedField: "taxable_value", confidence: 0.8 },
      { originalColumn: "Tax1", mappedField: "cgst", confidence: 0.8 },
      { originalColumn: "Tax2", mappedField: "sgst", confidence: 0.8 },
      { originalColumn: "Gross", mappedField: "invoice_total", confidence: 0.8 },
      // An invented heading and a wrong answer about a text column are both ignored.
      { originalColumn: "Made up", mappedField: "igst", confidence: 0.99 },
    ];
  });
  assert.deepEqual(asked[0], ["Ref", "Dt", "Vendor", "Tax ID", "Net", "Tax1", "Tax2", "Gross"]);
  assert.equal(read.docs.length, 2);
  assert.equal(read.docs[0].docNumber, "A-1");
  assert.equal(read.docs[0].taxable, 100000);
  assert.equal(read.docs[0].cgst, 9000);
  assert.match(read.notes[0], /checked against the data/);
});

test("an assistant's answer that the data does not support is dropped", () => {
  const profile = [
    { index: 0, header: "Vendor", gstin: 0, date: 0, amount: 0, text: 1 },
    { index: 1, header: "Tax ID", gstin: 1, date: 0, amount: 0, text: 0 },
    { index: 2, header: "Net", gstin: 0, date: 0, amount: 1, text: 0 },
  ];
  const { override, used } = applySuggestions(profile, [
    { originalColumn: "Vendor", mappedField: "supplier_gstin", confidence: 0.99 }, // text is not a GSTIN
    { originalColumn: "Tax ID", mappedField: "supplier_gstin", confidence: 0.9 },
    { originalColumn: "Net", mappedField: "taxable_value", confidence: 0.4 }, // too unsure
    { originalColumn: "Net", mappedField: "not_a_field", confidence: 0.9 }, // not offered
  ]);
  assert.equal(override.gstin, 1);
  assert.equal(override.taxable, undefined);
  assert.deepEqual(used, [{ field: "supplier_gstin", header: "Tax ID" }]);
});
