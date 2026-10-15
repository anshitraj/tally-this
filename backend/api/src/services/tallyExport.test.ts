import assert from "node:assert/strict";
import test from "node:test";
import PDFDocument from "pdfkit";
import { kindFromText, peekPdfKind } from "./documentPeek";
import { detectFileKind } from "./fileDetect";
import { extractInvoicesFromText, readPdfText } from "./invoicePdf";
import { parseTallyLedgerCsv } from "./statementCompare";
import { readTallyExportFile } from "./tallyExport";

type Cell = { text: string; x: number; right?: boolean };
type Line = { y: number; cells: Cell[] };

function makePdf(lines: Line[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", chunk => chunks.push(chunk as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font("Helvetica").fontSize(8);
    for (const line of lines) {
      for (const cell of line.cells) {
        if (cell.right) doc.text(cell.text, cell.x - 70, line.y, { width: 70, align: "right", lineBreak: false });
        else doc.text(cell.text, cell.x, line.y, { lineBreak: false });
      }
    }
    doc.end();
  });
}

function file(originalname: string, buffer: Buffer | string, mimetype = "application/octet-stream") {
  return { originalname, mimetype, buffer: typeof buffer === "string" ? Buffer.from(buffer, "utf8") : buffer };
}

const DEBIT = 480;
const CREDIT = 560;
const header: Line = {
  y: 100,
  cells: [{ text: "Date", x: 40 }, { text: "Particulars", x: 110 }, { text: "Vch Type", x: 300 }, { text: "Vch No.", x: 380 }, { text: "Debit Amount", x: 430 }, { text: "Credit Amount", x: 510 }],
};

function dayBook(totalDebit = "1,60,000.50"): Line[] {
  return [
    { y: 40, cells: [{ text: "Mehta Traders", x: 40 }] },
    { y: 55, cells: [{ text: "Day Book", x: 40 }] },
    { y: 70, cells: [{ text: "1-Apr-2025 to 30-Apr-2025", x: 40 }] },
    header,
    { y: 120, cells: [{ text: "Opening Balance", x: 110 }, { text: "1,00,000.00", x: DEBIT, right: true }] },
    { y: 140, cells: [{ text: "1-Apr-25", x: 40 }, { text: "ACME Corp", x: 110 }, { text: "Receipt", x: 300 }, { text: "1", x: 380 }, { text: "50,000.00", x: DEBIT, right: true }] },
    { y: 152, cells: [{ text: "Being payment received", x: 110 }] },
    // Same day: Tally leaves the date blank.
    { y: 175, cells: [{ text: "Beta Supplies", x: 110 }, { text: "Payment", x: 300 }, { text: "2", x: 380 }, { text: "20,000.00", x: CREDIT, right: true }] },
    { y: 195, cells: [{ text: "3-Apr-25", x: 40 }, { text: "Gamma Stores", x: 110 }, { text: "Receipt", x: 300 }, { text: "3", x: 380 }, { text: "10,000.50", x: DEBIT, right: true }] },
    { y: 225, cells: [{ text: "Closing Balance", x: 110 }, { text: "1,40,000.50", x: CREDIT, right: true }] },
    { y: 245, cells: [{ text: "Total", x: 110 }, { text: totalDebit, x: DEBIT, right: true }, { text: "1,60,000.50", x: CREDIT, right: true }] },
  ];
}

test("a Tally Day Book PDF is read into entries and checked against its printed totals", async () => {
  const read = await readTallyExportFile(file("daybook.pdf", await makePdf(dayBook()), "application/pdf"));
  assert.equal(read.ok, true, read.message);
  assert.equal(read.source, "pdf");
  assert.deepEqual(read.rows.map(row => [row.date, row.ledgerName, row.voucherNumber, row.debit, row.credit]), [
    ["2025-04-01", "ACME Corp", "1", 50000, null],
    ["2025-04-01", "Beta Supplies", "2", null, 20000],
    ["2025-04-03", "Gamma Stores", "3", 10000.5, null],
  ]);
  assert.equal(read.rows[0].narration, "Being payment received");
  assert.match(read.notes.join(" "), /add up to the totals printed/);
});

test("a Tally PDF whose entries do not add up to its printed total is flagged, not trusted", async () => {
  const read = await readTallyExportFile(file("daybook.pdf", await makePdf(dayBook("1,70,000.50")), "application/pdf"));
  assert.equal(read.ok, true);
  assert.match(read.notes.join(" "), /Potential risk — needs CA review/);
});

test("a bank statement PDF dropped in the Tally slot is refused plainly, not read as Tally", async () => {
  const bank: Line[] = [
    { y: 100, cells: [{ text: "Date", x: 40 }, { text: "Narration", x: 110 }, { text: "Withdrawal", x: 330 }, { text: "Deposit", x: 420 }, { text: "Balance", x: 500 }] },
    { y: 120, cells: [{ text: "01 Apr 2025", x: 40 }, { text: "UPI/ACME", x: 110 }, { text: "500.00", x: 380, right: true }, { text: "9,500.00", x: 560, right: true }] },
    { y: 140, cells: [{ text: "Opening Balance 10,000.00 and more text to pass the length check", x: 40 }] },
  ];
  const read = await readTallyExportFile(file("hdfc.pdf", await makePdf(bank), "application/pdf"));
  assert.equal(read.ok, false);
  assert.match(read.message, /does not look like a Tally/);
});

test("Tally XML uses the bank ledger, leaves out cancelled vouchers and does not mistake Bank Charges for the bank", async () => {
  const entry = (ledger: string, amount: string) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${ledger}</LEDGERNAME><AMOUNT>${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
  const xml = `<?xml version="1.0"?><ENVELOPE><BODY><DATA><TALLYMESSAGE>
    <VOUCHER VCHTYPE="Receipt"><DATE>20250401</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER><NARRATION>Being payment &amp; received</NARRATION>${entry("HDFC Bank", "-50000.00")}${entry("ACME Corp", "50000.00")}</VOUCHER>
    <VOUCHER VCHTYPE="Payment"><DATE>20250402</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><VOUCHERNUMBER>2</VOUCHERNUMBER>${entry("HDFC Bank", "20000.00")}${entry("Beta Supplies", "-20000.00")}</VOUCHER>
    <VOUCHER VCHTYPE="Payment"><DATE>20250403</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><VOUCHERNUMBER>3</VOUCHERNUMBER>${entry("HDFC Bank", "100.00")}${entry("Bank Charges", "-100.00")}</VOUCHER>
    <VOUCHER VCHTYPE="Receipt"><DATE>20250404</DATE><ISCANCELLED>Yes</ISCANCELLED><VOUCHERNUMBER>4</VOUCHERNUMBER>${entry("HDFC Bank", "-999.00")}${entry("Cancelled Co", "999.00")}</VOUCHER>
  </TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  const read = await readTallyExportFile(file("tally.xml", xml, "text/xml"), { bankName: "HDFC Bank" });
  assert.equal(read.ok, true, read.message);
  assert.equal(read.source, "xml");
  assert.deepEqual(read.rows.map(row => [row.date, row.ledgerName, row.debit, row.credit]), [
    ["2025-04-01", "ACME Corp", 50000, null],
    ["2025-04-02", "Beta Supplies", null, 20000],
    ["2025-04-03", "Bank Charges", null, 100],
  ]);
  assert.equal(read.rows[0].narration, "Being payment & received");
  assert.match(read.notes.join(" "), /1 cancelled/);
});

test("a Tally HTML export is read like a sheet", async () => {
  const html = `<html><body><table>
    <tr><th>Date</th><th>Particulars</th><th>Vch Type</th><th>Vch No.</th><th>Debit</th><th>Credit</th></tr>
    <tr><td>1-Apr-2025</td><td>ACME&nbsp;Corp</td><td>Receipt</td><td>1</td><td>50,000.00</td><td></td></tr>
    <tr><td>2-Apr-2025</td><td>Beta Supplies</td><td>Payment</td><td>2</td><td></td><td>20,000.00</td></tr>
  </table></body></html>`;
  const read = await readTallyExportFile(file("daybook.html", html, "text/html"));
  assert.equal(read.ok, true, read.message);
  assert.equal(read.source, "html");
  assert.equal(read.rows.length, 2);
  assert.equal(read.rows[0].ledgerName, "ACME Corp");
});

test("an Excel or CSV export keeps same-day vouchers whose date cell is blank and skips balances", () => {
  const csv = [
    "Date,Particulars,Vch Type,Vch No.,Debit,Credit",
    "01-Apr-2025,Opening Balance,,,1000.00,",
    "01-Apr-2025,To ACME Corp,Receipt,1,50000.00,",
    ",Beta Supplies,Payment,2,,20000.00",
    ",Being payment,,,,",
    "03-Apr-2025,Gamma Stores,Receipt,3,10000.50,",
    ",Closing Balance,,,,41000.50",
    ",Total,,,61000.50,61000.50",
  ].join("\n");
  const rows = parseTallyLedgerCsv(csv);
  assert.deepEqual(rows.map(row => [row.date, row.ledgerName, row.debit, row.credit]), [
    ["2025-04-01", "ACME Corp", 50000, null],
    ["2025-04-01", "Beta Supplies", null, 20000],
    ["2025-04-03", "Gamma Stores", 10000.5, null],
  ]);
});

test("a picture or an unknown file gets a message that names the formats Tally can export", async () => {
  const picture = await readTallyExportFile(file("scan.png", Buffer.from([137, 80, 78, 71]), "image/png"));
  assert.equal(picture.ok, false);
  assert.match(picture.message, /Excel, CSV, XML, HTML or PDF/);
  const empty = await readTallyExportFile(file("notes.csv", "hello,world\n1,2\n"));
  assert.equal(empty.ok, false);
  assert.match(empty.message, /No entries were found/);
});

// ── Detection ───────────────────────────────────────────────────────────────

test("Tally files are recognised by their name or markup, not mistaken for bank statements", () => {
  assert.equal(detectFileKind(file("Day Book.pdf", "%PDF", "application/pdf")).kind, "tally_export");
  assert.equal(detectFileKind(file("export.xml", "<ENVELOPE><BODY></BODY></ENVELOPE>")).kind, "tally_export");
  assert.equal(detectFileKind(file("random.xml", "<a></a>")).kind, "unknown");
  assert.equal(detectFileKind(file("statement.pdf", "%PDF", "application/pdf")).kind, "bank_statement");
});

test("a PDF is told apart from its first pages", async () => {
  assert.equal(kindFromText("Mehta Traders Day Book Date Particulars Vch Type Vch No. Debit Amount Credit Amount"), "tally_export");
  assert.equal(kindFromText("Account Statement Date Narration Withdrawal Deposit Balance IFSC HDFC0001"), "bank_statement");
  assert.equal(kindFromText("TAX INVOICE Invoice No: 42 Invoice Date: 01-04-2025 Grand Total 100.00"), "invoice_document");
  assert.equal(kindFromText("Minutes of the meeting"), "unknown");
  assert.equal(await peekPdfKind(await makePdf(dayBook())), "tally_export");
});

// ── Invoices ────────────────────────────────────────────────────────────────

const INVOICE = [
  "Mehta Traders Pvt Ltd",
  "12 Ring Road, Surat",
  "GSTIN: 24ABCDE1234F1Z5",
  "TAX INVOICE",
  "Invoice No: MT/25-26/0042",
  "Invoice Date: 12-04-2025",
  "Bill To: Acme Industries",
  "GSTIN: 27AAPFU0939F1ZV",
  "Description Qty Rate Amount",
  "Widgets 10 1,000.00 10,000.00",
  "Taxable Value 10,000.00",
  "CGST @9% 900.00",
  "SGST @9% 900.00",
  "Total Tax 1,800.00",
  "Grand Total Rs. 11,800.00",
  "Amount in words: Eleven thousand eight hundred only",
].join("\n");

test("a printed GST invoice is read by its labels, with seller and buyer kept apart", () => {
  const [row, ...rest] = extractInvoicesFromText(INVOICE);
  assert.equal(rest.length, 0);
  assert.equal(row.invoiceNumber, "MT/25-26/0042");
  assert.equal(row.invoiceDate, "2025-04-12");
  assert.equal(row.vendorName, "Mehta Traders Pvt Ltd");
  assert.equal(row.vendorGstin, "24ABCDE1234F1Z5");
  assert.equal(row.customerName, "Acme Industries");
  assert.equal(row.total, 11800);
  assert.equal(row.tax, 1800);
  assert.equal(row.label, "Read from PDF — pending review");
});

test("an invoice with no total, or a bundle of several invoices, is never guessed", () => {
  assert.deepEqual(extractInvoicesFromText(INVOICE.split("\n").filter(line => !/Total|Rs\./.test(line)).join("\n")), []);
  assert.deepEqual(extractInvoicesFromText(`${INVOICE}\nInvoice No: MT/25-26/0043\nGrand Total Rs. 500.00`), []);
});

test("an invoice PDF is read from its text layer without AI", async () => {
  const lines: Line[] = INVOICE.split("\n").map((text, index) => ({ y: 40 + index * 16, cells: [{ text, x: 40 }] }));
  const text = await readPdfText(await makePdf(lines));
  assert.equal(text.status, "ok");
  const rows = extractInvoicesFromText(text.status === "ok" ? text.text : "");
  assert.equal(rows[0]?.invoiceNumber, "MT/25-26/0042");
  assert.equal(rows[0]?.total, 11800);
});

test("Tally XML with no bank-named ledger uses the ledger in most vouchers and says so as a risk", async () => {
  const entry = (ledger: string, amount: string) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${ledger}</LEDGERNAME><AMOUNT>${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
  const voucher = (date: string, no: string, party: string, amount: string) =>
    `<VOUCHER VCHTYPE="Receipt"><DATE>${date}</DATE><VOUCHERNUMBER>${no}</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>${entry("CA 1234", `-${amount}`)}${entry(party, amount)}</VOUCHER>`;
  const xml = `<ENVELOPE>${voucher("20250712", "RC-1", "Sunrise Traders", "250000.00")}${voucher("20250713", "RC-2", "Apex", "1000.00")}</ENVELOPE>`;
  const read = await readTallyExportFile(file("export.xml", xml, "text/xml"));
  assert.equal(read.ok, true, read.message);
  assert.deepEqual(read.rows.map(row => [row.ledgerName, row.debit]), [["Sunrise Traders", 250000], ["Apex", 1000]]);
  assert.match(read.notes[0], /Potential risk — needs CA review/);
  const none = await readTallyExportFile(file("export.xml", "<ENVELOPE><VOUCHER><DATE>20250712</DATE></VOUCHER></ENVELOPE>", "text/xml"));
  assert.equal(none.ok, false);
});
