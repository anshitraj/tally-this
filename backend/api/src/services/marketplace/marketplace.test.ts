import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";
import { meeshoAdapter, isoDate } from "./adapters/meesho";
import { aggregateTax, checkTax, expectedApparelRate, financialYearOf, isValidGstin, parseRate, rateStatus, splitTax, supplyType, taxOn } from "./gstEngine";
import { formatInr, paiseToText, readAmount, readDecimal } from "./money";
import { attachDocuments, keyEvents, prepareTables } from "./pipeline";
import { matchReturns } from "./returns";
import { compareWithCa, gstr1Working, hsnSummary, overview, stateSummary, type SummaryEvent } from "./summaries";
import { readReports, type SourceTable } from "./tables";
import { readZip, ZipError } from "./zip";
import { buildPdf, buildWorkbook, type ReportData } from "./exports";
import type { DraftEvent } from "./types";

// ── fixtures: synthetic Meesho reports (no real seller's data) ─────────────────────────────────────────────────────

const SELLER = "07ABCDE1234F1Z2"; // Delhi, valid check character
const ECO = "07AAACT2727Q1ZY";
const HEAD = ["identifier", "sup_name", "gstin", "sub_order_num", "order_date", "hsn_code", "quantity", "gst_rate", "total_taxable_sale_value", "tax_amount", "total_invoice_value", "taxable_shipping", "end_customer_state_new", "eco_tcs_gstin", "financial_year", "month_number", "supplier_id"];

function saleRow(sub: string, date: string, hsn: string, qty: string, rate: string, taxable: string, tax: string, invoice: string, state: string, month = "9", shipping = "0") {
  return ["x1", "Test Traders", SELLER, sub, date, hsn, qty, rate, taxable, tax, invoice, shipping, state, ECO, "2026", month, "40001"];
}

const SALES_ROWS = [
  saleRow("1001_1", "2026-09-05", "610910", "1", "5.00", "441.02", "22.05", "463.07", "DELHI", "9", "40.00"),
  saleRow("1001_2", "2026-09-05", "620462", "1", "5.00", "558.10", "27.90", "586.00", "Karnataka"),
  saleRow("1002_1", "2026-09-10", "610910", "2", "5.00", "476.19", "23.81", "500.00", "Maharashtra"),
  saleRow("1003_1", "2026-09-12", "610910", "1", "5.00", "229.66101694915255", "11.48", "241.14", "Delhi"),
  saleRow("1004_1", "2026-09-15", "960329", "1", "18.00", "101.69", "18.31", "120.00", "Delhi"),
  saleRow("1005_1", "2026-09-20", "610910", "1", "5.00", "3000.00", "150.00", "3150.00", "Delhi"),
  saleRow("1006_1", "2026-09-21", "610910", "1", "5.00", "200.00", "15.00", "215.00", "Delhi"),
  saleRow("1007_1", "2026-09-22", "", "1", "5.00", "100.00", "5.00", "105.00", "Delhi"),
  saleRow("1008_1", "2026-09-23", "610910", "1", "5.00", "100.00", "5.00", "105.00", "Atlantis"),
  saleRow("1009_1", "2026-09-24", "610910", "1", "5.00", "-50.00", "-2.50", "-52.50", "Delhi"),
];

function table(fileName: string, rows: string[][], sheetName: string | null = null, sha = fileName): SourceTable {
  return { fileName, containerName: null, sheetName, sha256: sha, sizeBytes: 1, rows, rowNumbers: rows.map((_, i) => i + 1) };
}

const salesTable = () => table("tcs_sales.xlsx", [HEAD, ...SALES_ROWS, ["", "", "", "", "", "", "", "", "4999.99"]]);
const RETURN_HEAD = [...HEAD.slice(0, 5), "cancel_return_date", ...HEAD.slice(5)];
function returnRow(sub: string, orderDate: string, returnDate: string, qty: string, taxable: string, tax: string, invoice: string, state: string) {
  const sale = saleRow(sub, orderDate, "610910", qty, "5.00", taxable, tax, invoice, state, "10");
  return [...sale.slice(0, 5), returnDate, ...sale.slice(5)];
}
const returnsTable = () => table("tcs_sales_return.xlsx", [RETURN_HEAD,
  returnRow("1001_1", "2026-09-05", "2026-10-03", "1", "441.02", "22.05", "463.07", "DELHI"),
  returnRow("9999_1", "2026-08-01", "2026-10-04", "1", "300.00", "15.00", "315.00", "Delhi"),
  returnRow("1002_1", "2026-09-10", "2026-10-05", "1", "238.10", "11.90", "250.00", "Maharashtra"),
]);

const ctx = { sellerGstin: SELLER, period: "2026-09" };

function read(t: SourceTable) {
  const detection = meeshoAdapter.detect(t);
  return { detection, result: meeshoAdapter.normalize(t, detection, ctx) };
}

let nextId = 1;
function toSummary(e: DraftEvent): SummaryEvent {
  const tax = e.sourceTax ?? e.computedTax ?? 0;
  return {
    id: nextId++, eventType: e.eventType, sellerGstin: e.sellerGstin, orderId: e.orderId, subOrderId: e.subOrderId, reportPeriod: e.reportPeriod,
    hsn: e.hsn, description: e.description, uqc: e.uqc, quantity: Number(e.quantity ?? 0), taxable: e.taxable, rateMilli: e.rateMilli,
    igst: e.igst, cgst: e.cgst, sgst: e.sgst, cess: e.cess, invoiceValue: e.invoiceValue, placeOfSupply: e.placeOfSupply, supplyType: e.supplyType,
    ecoGstin: e.ecoGstin, documentNumber: e.documentNumber, unsplitTax: e.supplyType === "unknown" ? tax : 0,
  };
}

// ── money ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("amounts are read from their text, rounded once to the paisa, half away from zero", () => {
  assert.deepEqual(readAmount("229.66101694915255"), { paise: 22966, exact: false });
  assert.deepEqual(readAmount("1,23,456.78"), { paise: 12345678, exact: true });
  assert.deepEqual(readAmount("₹ 1,000"), { paise: 100000, exact: true });
  assert.deepEqual(readAmount("(52.50)"), { paise: -5250, exact: true });
  assert.deepEqual(readAmount("-0.005"), { paise: -1, exact: false });
  assert.deepEqual(readAmount("0.125"), { paise: 13, exact: false });
  assert.deepEqual(readAmount("1.5E+3"), { paise: 150000, exact: true });
  assert.deepEqual(readAmount(0.1 + 0.2), { paise: 30, exact: false });
  assert.equal(readAmount("-"), null);
  assert.equal(readAmount(""), null);
  assert.equal(readAmount("abc"), null);
  assert.equal(readDecimal("1.00"), "1");
  assert.equal(readDecimal("2.5000"), "2.5");
  assert.equal(paiseToText(-5), "-0.05");
  assert.equal(formatInr(12345678), "₹1,23,456.78");
});

// ── GST engine ────────────────────────────────────────────────────────────────────────────────────────────────────

test("tax is worked out in whole paise and split so the parts add back to the total", () => {
  assert.equal(taxOn(44102, 5000), 2205); // 22.051
  assert.equal(taxOn(55810, 5000), 2791); // 27.905 rounds up
  assert.deepEqual(splitTax(2205, "intra"), { igst: 0, cgst: 1103, sgst: 1102 });
  assert.deepEqual(splitTax(-2205, "intra"), { igst: 0, cgst: -1103, sgst: -1102 });
  assert.deepEqual(splitTax(2790, "inter"), { igst: 2790, cgst: 0, sgst: 0 });
  assert.deepEqual(splitTax(500, "unknown"), { igst: 0, cgst: 0, sgst: 0 });
  assert.deepEqual(aggregateTax(52900737, 5000, "intra"), { igst: 0, cgst: 1322518, sgst: 1322518 });
  assert.deepEqual(checkTax(55810, 5000, 2790), { computed: 2791, source: 2790, difference: -1, withinTolerance: true });
  assert.equal(checkTax(20000, 5000, 1500).withinTolerance, false);
  assert.equal(parseRate("5.00"), 5000);
  assert.equal(parseRate("0.25%"), 250);
  assert.equal(parseRate("five"), null);
});

test("place of supply decides IGST or CGST and SGST, never the customer's name alone", () => {
  assert.equal(supplyType(SELLER, "07"), "intra");
  assert.equal(supplyType(SELLER, "29"), "inter");
  assert.equal(supplyType(SELLER, null), "unknown");
  assert.equal(supplyType(null, "07"), "unknown");
});

test("rates are checked against the date: 12% and 28% are rare after 22 September 2025, 40% is new", () => {
  assert.equal(rateStatus(12000, "2025-09-21"), "valid");
  assert.equal(rateStatus(12000, "2025-09-22"), "check");
  assert.equal(rateStatus(40000, "2025-09-22"), "valid");
  assert.equal(rateStatus(40000, "2025-09-21"), "unknown");
  assert.equal(rateStatus(5000, "2026-09-01"), "valid");
  assert.equal(rateStatus(7000, "2026-09-01"), "unknown");
});

test("apparel is taxed by value per piece, with the thresholds that changed on 22 September 2025", () => {
  assert.equal(expectedApparelRate("610910", 250_000, "2026-09-01"), 5000);
  assert.equal(expectedApparelRate("610910", 250_001, "2026-09-01"), 18000);
  assert.equal(expectedApparelRate("620462", 100_001, "2025-09-01"), 12000);
  assert.equal(expectedApparelRate("620462", 100_000, "2025-09-01"), 5000);
  assert.equal(expectedApparelRate("960329", 1_000_000, "2026-09-01"), null);
});

test("GSTIN check characters are verified (27AAPFU0939F1ZV is the GSTN's published example)", () => {
  assert.equal(isValidGstin("27AAPFU0939F1ZV"), true);
  assert.equal(isValidGstin("27AAPFU0939F1ZW"), false);
  assert.equal(isValidGstin(SELLER), true);
  assert.equal(isValidGstin("07ABCDE1234F1Z3"), false);
  assert.equal(financialYearOf("2026-03"), "2025-26");
  assert.equal(financialYearOf("2026-04"), "2026-27");
});

// ── ZIP and file reading ─────────────────────────────────────────────────────────────────────────────────────────

function makeZip(entries: Array<{ name: string; data: Buffer; method?: 0 | 8; flags?: number; declaredSize?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE((entry.flags ?? 0) | 0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.declaredSize ?? entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE((entry.flags ?? 0) | 0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.declaredSize ?? entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("a ZIP is read member by member; traversal, nested ZIPs, encryption and bombs are refused", () => {
  const csv = Buffer.from(`${HEAD.join(",")}\n${SALES_ROWS[0].join(",")}\n`);
  const ok = readZip(makeZip([{ name: "gst/tcs_sales.csv", data: csv }, { name: "../evil.csv", data: csv }, { name: "inner.zip", data: csv, method: 0 }]));
  assert.deepEqual(ok.entries.map(e => e.name), ["tcs_sales.csv"]);
  assert.equal(ok.skipped.length, 2);
  assert.throws(() => readZip(makeZip([{ name: "a.csv", data: csv, flags: 1 }])), ZipError);
  assert.throws(() => readZip(makeZip([{ name: "bomb.csv", data: Buffer.alloc(5_000_000) }])), /expands too much/);
  assert.throws(() => readZip(makeZip([{ name: "liar.csv", data: Buffer.alloc(10), declaredSize: 5 }])), ZipError);
  assert.throws(() => readZip(Buffer.from("not a zip at all, just text, long enough to search")), /damaged/);
});

test("reports are read from CSV, Excel and ZIP; long sub-order numbers stay text; PDFs are refused", () => {
  const csvText = `${HEAD.join(",")}\n${saleRow("900000000000000123", "2026-09-05", "610910", "1", "5.00", "441.02", "22.05", "463.07", "DELHI").join(",")}\n`;
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([HEAD, [...saleRow("1001_1", "", "610910", "1", "5.00", "", "", "", "DELHI").slice(0, 4), new Date(Date.UTC(2026, 8, 5)), "610910", 1, 5, 441.02, 22.05, 463.07, 0, "DELHI", ECO, 2026, 9, 40001]], { cellDates: true });
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  const xlsx = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const { tables, problems } = readReports([
    { name: "tcs_sales.csv", buffer: Buffer.from(csvText) },
    { name: "tcs_sales.xlsx", buffer: xlsx },
    { name: "bundle.zip", buffer: makeZip([{ name: "tcs_sales_return.csv", data: Buffer.from(csvText) }]) },
    { name: "summary.pdf", buffer: Buffer.from("%PDF-1.4") },
    { name: "locked.xlsx", buffer: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from("E\0n\0c\0r\0y\0p\0t\0i\0o\0n\0I\0n\0f\0o", "latin1")]) },
  ]);
  assert.equal(tables.length, 3);
  assert.equal(tables[0].rows[1][3], "900000000000000123");
  assert.equal(tables[1].rows[1][4], "2026-09-05");
  assert.equal(tables[1].rows[1][8], "441.02");
  assert.equal(tables[2].containerName, "bundle.zip");
  assert.equal(problems.length, 2);
  assert.match(problems[0].message, /PDFs are not read/);
  assert.match(problems[1].message, /password-protected/);
});

// ── detection and column mapping ─────────────────────────────────────────────────────────────────────────────────

test("report types are told apart by their columns and names", () => {
  assert.equal(meeshoAdapter.detect(salesTable()).reportType, "sales");
  assert.equal(meeshoAdapter.detect(returnsTable()).reportType, "returns");
  const combined = table("working.xlsx", [["", "", "", "", "", "", "", "", "Shipping Included", "", "", "Shipping Charges"], [...HEAD.slice(0, 7), "Sales Return", ...HEAD.slice(7, 11), "total_taxable_sale_value", ...HEAD.slice(12)]]);
  const detection = meeshoAdapter.detect(combined);
  assert.equal(detection.reportType, "combined");
  assert.equal(detection.headerIndex, 1);
  assert.equal(detection.columnMap.taxable, "total_taxable_sale_value");
  assert.ok(detection.unknownColumns.includes("total_taxable_sale_value (2)"), "a second column of the same name is kept, not used");
  assert.equal(meeshoAdapter.detect(table("Tax_invoice_details.xlsx", [["Order Date", "Suborder No.", "Type", "Invoice No."]])).reportType, "invoice_details");
  assert.equal(meeshoAdapter.detect(table("pivot.xlsx", [["HSN", "Count of Total Quantity", "Sum of Total Taxable Value(₹)", "Sum of Integrated Tax(₹)", "Sum of Central Tax(₹)", "Sum of State/UT Tax(₹)"]])).reportType, "ca_hsn_summary");
  assert.equal(meeshoAdapter.detect(table("other.csv", [["Date", "Narration", "Amount"]])).reportType, "unknown");
});

test("a report missing a required column waits for a mapping, and a chosen mapping is applied", () => {
  const rows = [HEAD.map(h => (h === "end_customer_state_new" ? "ship_to" : h)), ...SALES_ROWS.slice(0, 1)];
  const [first] = prepareTables(meeshoAdapter, [table("tcs_sales.csv", rows)], ctx);
  assert.equal(first.status, "needs_mapping");
  assert.deepEqual(first.detection.missing, ["customerState"]);
  const [mapped] = prepareTables(meeshoAdapter, [table("tcs_sales.csv", rows)], ctx, { mappings: { [first.key]: { customerState: "ship_to" } } });
  assert.equal(mapped.status, "read");
  assert.equal(mapped.result?.events[0].placeOfSupply, "07");
  assert.throws(() => prepareTables(meeshoAdapter, [table("tcs_sales.csv", rows)], ctx, { mappings: { [first.key]: { customerState: "nope" } } }), /not a column/);
});

// ── normalization ────────────────────────────────────────────────────────────────────────────────────────────────

test("sales rows become events with exact amounts, a tax split, provenance and every column kept", () => {
  const { result } = read(salesTable());
  assert.equal(result.events.length, 10);
  const [s1, s2, s3, s4] = result.events;
  assert.equal(s1.eventType, "sale");
  assert.equal(s1.sourceRow, 2);
  assert.equal(s1.orderId, "1001");
  assert.equal(s1.lineId, "1");
  assert.equal(s1.reportPeriod, "2026-09");
  assert.equal(s1.financialYear, "2026-27");
  assert.deepEqual([s1.taxable, s1.cgst, s1.sgst, s1.igst], [44102, 1103, 1102, 0]);
  assert.equal(s1.raw.taxable_shipping, "40.00");
  assert.ok(s1.notes.some(n => /already inside the taxable value/.test(n)));
  assert.deepEqual([s2.supplyType, s2.igst, s2.placeOfSupply, s2.computedTax], ["inter", 2790, "29", 2791]);
  assert.equal(s2.issues.length, 0, "one paisa of rounding is not a mismatch");
  assert.equal(s3.quantity, "2");
  assert.equal(s4.taxable, 22966);
  assert.ok(result.issues.some(i => i.kind === "rounded_amounts"));
  assert.ok(result.issues.some(i => i.kind === "skipped_rows" && i.details?.rows === 1));
});

test("every row that needs a look says why", () => {
  const { result } = read(salesTable());
  const kinds = (sub: string) => result.events.find(e => e.subOrderId === sub)?.issues.map(i => i.kind) ?? [];
  assert.deepEqual(kinds("1005_1"), ["rate_check"]);
  assert.deepEqual(kinds("1006_1"), ["tax_mismatch"]);
  assert.deepEqual(kinds("1007_1"), ["missing_hsn"]);
  assert.deepEqual(kinds("1008_1"), ["unknown_state"]);
  assert.equal(result.events.find(e => e.subOrderId === "1008_1")?.supplyType, "unknown");
  const mismatch = result.events.find(e => e.subOrderId === "1006_1")?.issues[0];
  assert.deepEqual(mismatch?.details && { source: mismatch.details.source, computed: mismatch.details.computed, difference: mismatch.details.difference }, { source: 1500, computed: 1000, difference: 500 });
});

test("a negative sale with no return flag is a credit note: value off, quantity not", () => {
  const { result } = read(salesTable());
  const cn = result.events.find(e => e.subOrderId === "1009_1");
  assert.equal(cn?.eventType, "credit_note");
  assert.equal(cn?.taxable, 5000);
  assert.equal(cn?.quantity, "0");
  assert.deepEqual(cn?.issues.map(i => i.kind), ["credit_note_without_return"]);
});

test("returns are counted once, whether they arrive positive or already negative", () => {
  const { result } = read(returnsTable());
  assert.deepEqual(result.events.map(e => [e.eventType, e.reportPeriod, e.taxable, e.returnDate]), [
    ["return", "2026-10", 44102, "2026-10-03"],
    ["return", "2026-10", 30000, "2026-10-04"],
    ["return", "2026-10", 23810, "2026-10-05"],
  ]);
  const combined = table("working.xlsx", [[...HEAD.slice(0, 7), "Sales Return", ...HEAD.slice(7)],
    [...SALES_ROWS[0].slice(0, 7), "YES", ...SALES_ROWS[0].slice(7).map((v, i) => (i >= 1 && i <= 3 ? `-${v}` : v))],
    [...SALES_ROWS[1].slice(0, 7), "NO", ...SALES_ROWS[1].slice(7)],
  ]);
  const { result: c } = read(combined);
  assert.deepEqual(c.events.map(e => [e.eventType, e.taxable, e.cgst + e.sgst + e.igst]), [["return", 44102, 2205], ["sale", 55810, 2790]]);
});

test("rows for another GSTIN are flagged, not merged", () => {
  const other = table("tcs_sales.csv", [HEAD, saleRow("2001_1", "2026-09-05", "610910", "1", "5.00", "100.00", "5.00", "105.00", "Delhi").map(v => (v === SELLER ? "29ABCDE1234F1ZW" : v))]);
  const { result } = read(other);
  assert.ok(result.events[0].issues.some(i => i.kind === "other_gstin"));
});

test("dates in the usual Indian forms are read", () => {
  assert.equal(isoDate("24/08/2026"), "2026-08-24");
  assert.equal(isoDate("2026-08-24 10:30:00"), "2026-08-24");
  assert.equal(isoDate("24-Aug-2026"), "2026-08-24");
  assert.equal(isoDate("31/02/2026"), null);
});

// ── duplicates and identity ──────────────────────────────────────────────────────────────────────────────────────

test("a month inside a two-month file is counted once; two items of one order are not duplicates", () => {
  const sep = table("tcs_sales_sep.csv", [HEAD, ...SALES_ROWS.slice(0, 3)], null, "sep");
  const augSep = table("tcs_sales_aug_sep.csv", [HEAD, saleRow("0901_1", "2026-08-20", "610910", "1", "5.00", "100.00", "5.00", "105.00", "Delhi", "8"), ...SALES_ROWS.slice(0, 3)], null, "augsep");
  const prepared = prepareTables(meeshoAdapter, [sep, augSep], ctx);
  const { events } = keyEvents("meesho", prepared);
  assert.equal(events.length, 7);
  assert.deepEqual(events.map(e => e.duplicateOfIndex), [null, null, null, null, 0, 1, 2]);
  assert.notEqual(events[0].key, events[1].key, "1001_1 and 1001_2 are different items of one order");
});

test("the same file twice is not read twice, and repeated processing gives the same keys", () => {
  const prepared = prepareTables(meeshoAdapter, [salesTable(), salesTable()], ctx);
  assert.deepEqual(prepared.map(p => p.status), ["read", "duplicate_file"]);
  const again = prepareTables(meeshoAdapter, [salesTable()], ctx, { knownTableKeys: new Set([prepared[0].key]) });
  assert.equal(again[0].status, "duplicate_file");
  const a = keyEvents("meesho", prepareTables(meeshoAdapter, [salesTable()], ctx)).events.map(e => e.key);
  const b = keyEvents("meesho", prepareTables(meeshoAdapter, [salesTable()], ctx)).events.map(e => e.key);
  assert.deepEqual(a, b);
});

test("two sale rows for one sub-order with different figures: the first counts, the second is held back and flagged", () => {
  const t = table("tcs_sales.csv", [HEAD, SALES_ROWS[0], saleRow("1001_1", "2026-09-05", "610910", "1", "5.00", "450.00", "22.50", "472.50", "DELHI")]);
  const { events, issues } = keyEvents("meesho", prepareTables(meeshoAdapter, [t], ctx));
  assert.deepEqual(events.map(e => [e.duplicateOfIndex, e.conflict]), [[null, false], [0, true]]);
  assert.deepEqual(issues.map(i => [i.kind, i.severity, i.eventIndex]), [["conflicting_rows", "warning", 1]]);
  assert.match(issues[0].message, /441\.02.*450\.00/);
});

test("a sub-order returned on two dates is two returns, not a conflict; a repeat with '1' and '1.00' is the same row", () => {
  const r = (date: string, qty: string) => [...saleRow("1001_1", "2026-09-05", "610910", qty, "5.00", "100.00", "5.00", "105.00", "DELHI").slice(0, 5), date, ...saleRow("1001_1", "2026-09-05", "610910", qty, "5.00", "100.00", "5.00", "105.00", "DELHI").slice(5)];
  const t = table("tcs_sales_return.xlsx", [RETURN_HEAD, r("2026-09-10", "1"), r("2026-09-20", "1"), r("2026-09-20", "1.00")]);
  const { events, issues } = keyEvents("meesho", prepareTables(meeshoAdapter, [t], ctx));
  assert.deepEqual(events.map(e => [e.duplicateOfIndex, e.conflict]), [[null, false], [null, false], [1, false]]);
  assert.deepEqual(issues, []);
});

test("invoice and credit-note numbers are attached from Tax_invoice_details", () => {
  const docs = table("Tax_invoice_details.xlsx", [["Order Date", "Suborder No.", "Type", "Invoice No.", "Invoice Date"], ["2026-09-05", "1001_1", "INVOICE", "INV-07-0001", "05/09/2026"], ["2026-10-03", "1001_1", "CREDIT NOTE", "CN-07-0001", "03/10/2026"]], null, "docs");
  const prepared = prepareTables(meeshoAdapter, [salesTable(), returnsTable(), docs], ctx);
  const { events } = keyEvents("meesho", prepared);
  assert.equal(attachDocuments(events, prepared), 2);
  assert.equal(events.find(e => e.event.subOrderId === "1001_1" && e.event.eventType === "sale")?.event.documentNumber, "INV-07-0001");
  assert.equal(events.find(e => e.event.subOrderId === "1001_1" && e.event.eventType === "return")?.event.documentNumber, "CN-07-0001");
});

// ── returns ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("returns are matched to sales: full, partial, across months, more than sold, or not found", () => {
  const sales = [
    { id: 1, subOrderId: "1001_1", period: "2026-09", quantity: 1, taxable: 44102 },
    { id: 2, subOrderId: "1002_1", period: "2026-09", quantity: 2, taxable: 47619 },
    { id: 3, subOrderId: "1003_1", period: "2026-10", quantity: 1, taxable: 10000 },
  ];
  const returns = [
    { id: 10, subOrderId: "1001_1", period: "2026-10", quantity: 1, taxable: 44102 },
    { id: 11, subOrderId: "1002_1", period: "2026-10", quantity: 1, taxable: 23810 },
    { id: 12, subOrderId: "9999_1", period: "2026-10", quantity: 1, taxable: 30000 },
    { id: 13, subOrderId: "1003_1", period: "2026-10", quantity: 1, taxable: 20000 },
  ];
  const result = matchReturns(returns, sales);
  assert.deepEqual(result.map(r => [r.returnId, r.status, "crossPeriod" in r ? r.crossPeriod : null]), [
    [10, "matched", true],
    [11, "partial", true],
    [12, "unmatched", null],
    [13, "exceeds_sale", false],
  ]);
});

// ── summaries and GSTR-1 working ─────────────────────────────────────────────────────────────────────────────────

test("the period's sales, credit notes and net come out to the paisa", () => {
  nextId = 1;
  const events = read(salesTable()).result.events.map(toSummary);
  const o = overview(events, "2026-09");
  assert.deepEqual([o.sales.count, o.sales.quantity, o.sales.taxable], [9, 10, 520666]);
  // CGST + SGST (221.84) split once, evenly, not line by line (which gave 110.93 / 110.91).
  assert.deepEqual([o.sales.igst, o.sales.cgst, o.sales.sgst, o.sales.unassignedTax, o.sales.tax], [5171, 11092, 11092, 500, 27855]);
  assert.deepEqual([o.creditNotes.count, o.creditNotes.quantity, o.creditNotes.taxable, o.creditNotes.tax], [1, 0, 5000, 250]);
  assert.equal(o.net.taxable, 515666);
  assert.equal(o.net.quantity, 10);
});

test("HSN and State summaries net returns in the period they are reported", () => {
  nextId = 1;
  const oct = read(returnsTable()).result.events.map(toSummary);
  const rows = hsnSummary(oct);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].hsn, rows[0].returns.count, rows[0].returns.taxable, rows[0].net.taxable, rows[0].net.quantity], ["610910", 3, 97912, -97912, -3]);
  const states = stateSummary(oct);
  assert.deepEqual(states.map(s => [s.pos, s.supplyType, s.net.taxable]), [["07", "intra", -74102], ["27", "inter", -23810]]);
});

test("GSTR-1 working: B2C Others as e-commerce supplies, Table 14(a) repeating the net, documents and TCS kept apart", () => {
  nextId = 1;
  const events = read(salesTable()).result.events.map(toSummary).filter(e => e.supplyType !== "unknown");
  const w = gstr1Working(events, "2026-09");
  assert.ok(w.b2cs.every(row => row.type === "E" && row.ecoGstin === ECO));
  const delhi5 = w.b2cs.find(row => row.pos === "07" && row.rate === "5");
  // Delhi at 5%: 441.02 + 229.66 + 3000 + 200 + 100 (no HSN, still a sale) − 50 credit note.
  assert.equal(delhi5?.taxable, 392068);
  const totalB2cs = w.b2cs.reduce((s, r) => s + r.taxable, 0);
  assert.equal(w.table14a.length, 1);
  assert.equal(w.table14a[0].taxable, totalB2cs, "Table 14(a) repeats Table 7; it adds nothing");
  assert.equal(w.tcs.rate, "0.5");
  assert.equal(w.tcs.expected, Math.round(totalB2cs * 0.005));
  assert.equal(w.table13.available, false);
  assert.equal(w.b2clCandidates.length, 0);
  const big = gstr1Working([{ ...events[1], id: 99, invoiceValue: 10_000_100, taxable: 9_523_900, orderId: "BIG" }], "2026-09");
  assert.equal(big.b2clCandidates.length, 1);
});

test("aggregate rounding works tax out once per group; line rounding adds each line's tax", () => {
  const e = (id: number, taxable: number, tax: number): SummaryEvent => ({ id, eventType: "sale", sellerGstin: SELLER, orderId: String(id), subOrderId: `${id}_1`, reportPeriod: "2026-09", hsn: "610910", description: null, uqc: "PCS", quantity: 1, taxable, rateMilli: 5000, igst: 0, cgst: tax - Math.floor(tax / 2), sgst: Math.floor(tax / 2), cess: 0, invoiceValue: taxable + tax, placeOfSupply: "07", supplyType: "intra", ecoGstin: ECO, documentNumber: null, unsplitTax: 0 });
  const events = [e(1, 23657, 1183), e(2, 23658, 1183), e(3, 23657, 1183)];
  const line = hsnSummary(events, "line")[0];
  const aggregate = hsnSummary(events, "aggregate")[0];
  // Line rounding keeps the reported tax (3 × 11.83 = 35.49) and splits it evenly; aggregate works it out again (35.48).
  assert.deepEqual([line.sales.cgst, line.sales.sgst], [1775, 1774]);
  assert.deepEqual([aggregate.sales.cgst, aggregate.sales.sgst], [1774, 1774]); // 709.72 × 2.5% = 17.743
});

test("a CA's HSN pivot is compared with gross sales, and differences are shown, not forced away", () => {
  nextId = 1;
  const rows = hsnSummary(read(salesTable()).result.events.map(toSummary));
  const ca = [{ hsn: "620462", count: 1, taxable: 55810, igst: 2790, cgst: 0, sgst: 0 }, { hsn: "610910", count: 7, taxable: 400000, igst: 0, cgst: 1, sgst: 1 }, { hsn: "Grand Total", count: null, taxable: 0, igst: 0, cgst: 0, sgst: 0 }];
  const result = compareWithCa(ca, rows);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].difference, { taxable: 0, igst: 0, cgst: 0, sgst: 0 });
  assert.notEqual(result[1].difference?.taxable, 0);
});

// ── exports ───────────────────────────────────────────────────────────────────────────────────────────────────────

function reportData(): ReportData {
  nextId = 1;
  const drafts = read(salesTable()).result.events;
  const summary = drafts.map(toSummary);
  return {
    companyName: "Synthetic Traders",
    marketplaceName: "Meesho",
    sellerGstin: SELLER,
    period: "2026-09",
    financialYear: "2026-27",
    status: "Needs review",
    approvedBy: null,
    approvedAt: null,
    generatedAt: new Date("2026-10-05T10:00:00Z"),
    rounding: "line",
    overview: overview(summary, "2026-09"),
    hsn: hsnSummary(summary),
    states: stateSummary(summary),
    gstr1: gstr1Working(summary, "2026-09"),
    exceptions: [{ id: 1, eventId: 8, kind: "missing_hsn", severity: "error", status: "open", message: "=HYPERLINK(\"x\") HSN missing", note: null, sourceRef: "tcs_sales.xlsx row 9" }],
    events: drafts.map((e, i) => ({
      id: i + 1, eventType: e.eventType, orderId: e.orderId, subOrderId: e.subOrderId, orderDate: e.orderDate, returnDate: e.returnDate, documentNumber: e.documentNumber,
      reportPeriod: e.reportPeriod, hsn: e.hsn, quantity: Number(e.quantity ?? 0), taxable: e.taxable, rateMilli: e.rateMilli, igst: e.igst, cgst: e.cgst, sgst: e.sgst, cess: e.cess,
      invoiceValue: e.invoiceValue, sourceTax: e.sourceTax, computedTax: e.computedTax, placeOfSupply: e.placeOfSupply, supplyType: e.supplyType, ecoGstin: e.ecoGstin,
      status: "ok", duplicateOf: null, relatedEventId: null, fileName: "tcs_sales.xlsx", sheetName: null, sourceRow: e.sourceRow, raw: e.raw, notes: e.notes,
    })),
    reviews: [],
    files: [{ fileName: "tcs_sales.xlsx", containerName: null, sheetName: null, sha256: "ab".repeat(32), reportType: "sales", status: "read", rowCount: drafts.length, periods: ["2026-09"], columnMap: { taxable: "total_taxable_sale_value" }, unknownColumns: [], importedAt: "2026-10-05T10:00:00.000Z" }],
    openBlocking: 1,
  };
}

test("the Excel working papers have the ten sheets, frozen headers, every source row and figures that agree", async () => {
  const data = reportData();
  const wb = XLSX.read(await buildWorkbook(data), { type: "buffer" });
  assert.deepEqual(wb.SheetNames, ["Summary", "Raw Transactions", "Normalized Sales", "Sales Returns", "HSN-wise Summary", "State-wise GST", "GSTR-1 Working", "Exceptions", "Reconciliation Audit", "Source Metadata"]);
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets["Raw Transactions"]);
  assert.equal(raw.length, data.events.length);
  assert.equal(raw[0]["sub_order_num"], "1001_1"); // the source column, as the file had it
  const sales = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets["Normalized Sales"]);
  const total = sales.reduce((s, r) => s + Math.round(Number(r["Taxable value"]) * 100), 0);
  assert.equal(total, data.overview.sales.taxable);
  const returns = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets["Sales Returns"]);
  assert.equal(sales.length + returns.length, data.events.length);
  const exceptionsSheet = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets["Exceptions"]);
  assert.equal(exceptionsSheet[0]["Kind"], "missing_hsn");
  // ExcelJS writes the frozen pane into the sheet view.
  const ExcelJS = (await import("exceljs")).default;
  const book = new ExcelJS.Workbook();
  const bytes = await buildWorkbook(data);
  await book.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  for (const name of ["Raw Transactions", "Normalized Sales", "Exceptions"]) {
    assert.equal(book.getWorksheet(name)?.views[0]?.state, "frozen", name);
  }
  const summary = XLSX.utils.sheet_to_json<string[]>(wb.Sheets["Summary"], { header: 1 });
  assert.ok(summary.some(r => r[0] === "Report status" && r[1] === "Needs review"));
});

test("the PDF summary is a real PDF and the same data gives the same figures every time", async () => {
  const pdf = await buildPdf(reportData());
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 2000);
  const a = await buildWorkbook(reportData());
  const b = await buildWorkbook(reportData());
  const read = (buf: Buffer) => XLSX.utils.sheet_to_csv(XLSX.read(buf, { type: "buffer" }).Sheets["HSN-wise Summary"]);
  assert.equal(read(a), read(b));
});
