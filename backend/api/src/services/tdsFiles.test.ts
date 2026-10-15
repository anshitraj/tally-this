import assert from "node:assert/strict";
import test from "node:test";
import { readTdsFile } from "./tdsFiles";
import { normalizeParty, reconcile26AS } from "./tdsReconEngine";

// A made-up statement laid out like the TRACES text file: ^ between fields, Part I, then detail lines.
const TRACES = [
  "^Annual Tax Statement^",
  "^PART-I - Details of Tax Deducted at Source^",
  "^Sr. No.^Name of Deductor^TAN of Deductor^Total Amount Paid / Credited(Rs.)^Total Tax Deducted(Rs.)^Total TDS Deposited(Rs.)^",
  "^1^BRIGHTLINE RETAIL PRIVATE LIMITED^DELB12345A^150000.00^1500.00^1500.00^",
  "^^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks^Amount Paid / Credited(Rs.)^Tax Deducted(Rs.)^TDS Deposited(Rs.)^",
  "^^1^194C^15-Jun-2026^F^30-Jul-2026^-^100000.00^1000.00^1000.00^",
  "^^2^194C^20-Jul-2026^F^30-Aug-2026^-^50000.00^500.00^500.00^",
  "^2^ORBIT MEDIA LLP^MUMO54321B^30000.00^3000.00^3000.00^",
  "^^1^194J^10-Jun-2026^F^30-Jul-2026^-^30000.00^3000.00^3000.00^",
  "^3^PINNACLE CORP^DELP44556D^20000.00^200.00^200.00^",
  "^^1^194H^05-Jun-2026^U^30-Jul-2026^-^20000.00^200.00^200.00^",
  "^PART-II - Details of Tax Deducted at Source for 15G / 15H^",
  "^1^SOME BANK^DELS99887C^1000.00^0.00^0.00^",
].join("\n");

test("a TRACES text file is read: Part I only, final bookings only", () => {
  const read = readTdsFile({ originalname: "26AS.txt", buffer: Buffer.from(TRACES) });
  assert.equal(read.source, "traces-text");
  assert.deepEqual(
    read.entries.map(entry => [entry.tan, entry.section, entry.amount]),
    [
      ["DELB12345A", "194C", 1000],
      ["DELB12345A", "194C", 500],
      ["MUMO54321B", "194J", 3000],
    ],
  );
  assert.match(read.notes.join(" "), /status other than F/);
});

test("a books ledger with names and amounts only is read from CSV and Excel-like tables", () => {
  const csv = ["Party Name,Section,TDS Amount", "Brightline Retail Pvt Ltd,194C,1500", "Orbit Media LLP,,3000", ",,", "Total,,4500"].join("\n");
  const read = readTdsFile({ originalname: "books.csv", buffer: Buffer.from(csv) });
  assert.equal(read.entries.length, 2);
  assert.equal(read.entries[0].deductor, "Brightline Retail Pvt Ltd");
  assert.equal(read.entries[1].section, "");
});

test("a statement with a title block above its headings is still found", () => {
  const csv = ["Form 26AS - FY 2026-27,,", "PAN: ABCDE1234F,,", "Name of Deductor,TAN of Deductor,Section,Tax Deducted", "Alpha Co,DELA11111A,194C,500.00"].join("\n");
  const read = readTdsFile({ originalname: "as26.csv", buffer: Buffer.from(csv) });
  assert.deepEqual(read.entries, [{ deductor: "Alpha Co", tan: "DELA11111A", section: "194C", amount: 500 }]);
});

test("a PDF is refused with the way to get a readable copy", () => {
  assert.throws(() => readTdsFile({ originalname: "26AS.pdf", buffer: Buffer.from("%PDF") }), /text \(\.txt\) or Excel/);
});

test("party names are tidied so Pvt Ltd and Private Limited are the same", () => {
  assert.equal(normalizeParty("M/s Brightline Retail Pvt. Ltd."), normalizeParty("BRIGHTLINE RETAIL PRIVATE LIMITED"));
  assert.notEqual(normalizeParty("Orbit Media LLP"), normalizeParty("Orbit Films LLP"));
});

test("books lines with names but no TAN or section are matched with the 26AS", () => {
  const as26 = readTdsFile({ originalname: "26AS.txt", buffer: Buffer.from(TRACES) }).entries;
  const books = [
    { deductor: "M/s Brightline Retail Pvt Ltd", tan: "", section: "", amount: 1500 },
    { deductor: "Orbit Media LLP", tan: "", section: "194J", amount: 2400 },
    { deductor: "Zenith Exports", tan: "", section: "194C", amount: 800 },
  ];
  const result = reconcile26AS(as26, books);
  const row = (name: string) => result.rows.find(entry => entry.deductor.toUpperCase().includes(name))!;
  assert.equal(row("BRIGHTLINE").status, "Matched");
  assert.equal(row("BRIGHTLINE").as26, 1500);
  assert.equal(row("ORBIT").status, "Short credit in books");
  assert.equal(row("ORBIT").difference, 600);
  assert.equal(row("ZENITH").status, "Not in 26AS");
  assert.equal(result.totals.matched, 1);
});
