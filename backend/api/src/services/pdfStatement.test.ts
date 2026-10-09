import assert from "node:assert/strict";
import test from "node:test";
import PDFDocument from "pdfkit";
import { readStatementPdf } from "./pdfStatement";
import { checkRunningBalance } from "./statementCheck";

type Cell = { text: string; x: number; align?: "right"; width?: number };
type Line = { y: number; cells: Cell[] };

function makePdf(lines: Line[], options: { font?: string; size?: number; userPassword?: string } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      ...(options.userPassword ? { userPassword: options.userPassword, ownerPassword: `${options.userPassword}-owner`, pdfVersion: "1.7" as const } : {}),
    });
    const chunks: Buffer[] = [];
    doc.on("data", chunk => chunks.push(chunk as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font(options.font ?? "Helvetica").fontSize(options.size ?? 8);
    for (const line of lines) {
      for (const cell of line.cells) {
        if (cell.align === "right") doc.text(cell.text, cell.x - (cell.width ?? 76), line.y, { width: cell.width ?? 76, align: "right", lineBreak: false });
        else doc.text(cell.text, cell.x, line.y, { lineBreak: false });
      }
    }
    doc.end();
  });
}

// Kotak-style: serial column, one amount per row, opening balance row, word-wrapped narration.
const W = 416;
const D = 487;
const B = 556;
const right = (text: string, x: number): Cell => ({ text, x, align: "right" });

function kotakLines(secondBalance = "3,10,822.68"): Line[] {
  return [
    { y: 40, cells: [{ text: "Kotak Mahindra Bank", x: 40 }] },
    { y: 60, cells: [{ text: "Account No. 0211300197", x: 340 }] },
    { y: 75, cells: [{ text: "IFSC Code KKBK0004264", x: 40 }] },
    { y: 90, cells: [{ text: "01 Apr 2025 - 31 Mar 2026", x: 40 }] },
    { y: 130, cells: [{ text: "#", x: 40 }, { text: "Date", x: 72 }, { text: "Description", x: 125 }, { text: "Chq/Ref. No.", x: 280 }, { text: "Withdrawal (Dr.)", x: 345 }, { text: "Deposit (Cr.)", x: 430 }, { text: "Balance", x: 505 }] },
    { y: 150, cells: [{ text: "Opening Balance", x: 125 }, right("4,70,822.68", B)] },
    { y: 170, cells: [{ text: "1", x: 40 }, { text: "19 Apr 2025", x: 72 }, { text: "UPI/AMJAD PARVEZ/1880856/Payment", x: 125 }, { text: "UPI-5109632", x: 280 }, right("50,000.00", D), right("5,20,822.68", B)] },
    { y: 179, cells: [{ text: "from Ph", x: 125 }] },
    { y: 200, cells: [{ text: "2", x: 40 }, { text: "05 Aug 2025", x: 72 }, { text: "FD MATURITY :5150/24-08-", x: 125 }, { text: "MB-998444", x: 280 }, right("2,10,000.00", W), right(secondBalance, B)] },
    { y: 209, cells: [{ text: "25/BHARAT G", x: 125 }] },
    { y: 230, cells: [{ text: "3", x: 40 }, { text: "31 Mar 2026", x: 72 }, { text: "Int.Pd:0211300197", x: 125 }, right("1,815.00", D), right("3,12,637.68", B)] },
    { y: 300, cells: [{ text: "Opening Balance", x: 300 }, { text: "Closing Balance", x: 420 }] },
    { y: 315, cells: [{ text: "Savings Account (SA):", x: 125 }, right("4,70,822.68", 380), right("3,12,637.68", 480)] },
  ];
}

test("reads amounts from the column they sit under and proves every row", async () => {
  const read = await readStatementPdf(await makePdf(kotakLines()), { fileName: "statement.pdf" });
  assert.equal(read.status, "ok");
  const summary = read.summary!;
  assert.equal(summary.bankName, "Kotak Mahindra Bank");
  assert.equal(summary.accountNumberMasked, "0197");
  assert.equal(summary.periodLabel, "01 Apr 2025 – 31 Mar 2026");
  assert.deepEqual(summary.transactions.map(txn => [txn.date, txn.debit, txn.credit, txn.balance]), [
    ["2025-04-19", null, 50000, 520822.68],
    ["2025-08-05", 210000, null, 310822.68],
    ["2026-03-31", null, 1815, 312637.68],
  ]);
  assert.equal(summary.transactions[0].narration, "UPI/AMJAD PARVEZ/1880856/Payment from Ph");
  assert.equal(summary.transactions[1].narration, "FD MATURITY :5150/24-08-25/BHARAT G", "a line broken after a hyphen joins without a space");
  assert.equal(summary.transactions[0].reference, "UPI-5109632");
  assert.equal(read.check!.openingBalance, 470822.68);
  assert.equal(read.check!.closingMatches, true);
  assert.equal(read.check!.serialComplete, true);
  assert.equal(read.check!.verified, true);
});

test("a row that breaks the running balance is caught", async () => {
  const read = await readStatementPdf(await makePdf(kotakLines("3,10,000.00")), { fileName: "statement.pdf" });
  assert.equal(read.check!.verified, false);
  assert.ok(read.check!.failedRows.includes(2));
  assert.ok(read.summary!.transactions[1].confidence < 0.9);
});

test("a bank mentioned in a payment is not mistaken for the statement bank", async () => {
  const lines = kotakLines().filter(line => line.y !== 40 && line.y !== 75);
  lines[0] = { y: 40, cells: [{ text: "Account Statement", x: 40 }] };
  const payment = lines.find(line => line.y === 170);
  if (payment) payment.cells[2] = { text: "UPI to HDFC Bank customer", x: 125 };
  const read = await readStatementPdf(await makePdf(lines), { fileName: "statement.pdf" });
  assert.equal(read.status, "ok");
  assert.equal(read.summary?.bankName, null);
});

test("newest-first statements with both columns printed and character-wrapped narration", async () => {
  const lines: Line[] = [
    { y: 40, cells: [{ text: "Account Statement", x: 40 }] },
    { y: 60, cells: [{ text: "Statement Period: 01 Apr 2025 - 31 Mar 2026", x: 40 }, { text: "Branch IFSC Code: INDB0000756", x: 320 }] },
    { y: 130, cells: [{ text: "Date", x: 50 }, { text: "Particulars", x: 125 }, { text: "Chq No/Ref No", x: 256 }, { text: "Withdrawal", x: 346 }, { text: "Deposit", x: 437 }, { text: "Balance", x: 495 }] },
    { y: 150, cells: [{ text: "31 Mar 2026", x: 50 }, { text: "158802222334:Int.Pd:01-0", x: 125 }, { text: "S225591", x: 256 }, right("0.00", 395), right("8.00", 468), right("1286.08", 527)] },
    { y: 162, cells: [{ text: "1-2026 to 31-03-2026", x: 125 }] },
    { y: 180, cells: [{ text: "03 Jan 2026", x: 50 }, { text: "VISA POS TXN AT IN/Swig", x: 125 }, { text: "S99647101", x: 256 }, right("818.00", 395), right("0.00", 468), right("1278.08", 527)] },
    { y: 192, cells: [{ text: "gy 560103", x: 125 }] },
    { y: 210, cells: [{ text: "31 Dec 2025", x: 50 }, { text: "UPI/280293513165/DR/ZE", x: 125 }, { text: "S60507535", x: 256 }, right("123.00", 395), right("0.00", 468), right("2096.08", 527)] },
    { y: 222, cells: [{ text: "PT/KKBK/lacepriva@kotak", x: 125 }] },
  ];
  const read = await readStatementPdf(await makePdf(lines, { font: "Courier", size: 7 }), { fileName: "statement.pdf" });
  const summary = read.summary!;
  assert.equal(summary.bankName, "IndusInd Bank");
  assert.deepEqual(summary.transactions.map(txn => txn.date), ["2025-12-31", "2026-01-03", "2026-03-31"], "returned oldest first");
  assert.equal(summary.transactions[1].narration, "VISA POS TXN AT IN/Swiggy 560103");
  assert.equal(summary.transactions[2].narration, "158802222334:Int.Pd:01-01-2026 to 31-03-2026");
  assert.equal(summary.transactions[1].debit, 818);
  assert.equal(summary.transactions[2].credit, 8);
  assert.equal(read.check!.verified, true);
});

test("locked PDFs ask for the password and reject a wrong one", async () => {
  const pdf = await makePdf(kotakLines(), { userPassword: "test0404" });
  assert.equal((await readStatementPdf(pdf, {})).status, "needs_password");
  assert.equal((await readStatementPdf(pdf, { password: "nope" })).status, "wrong_password");
  const opened = await readStatementPdf(pdf, { password: "test0404" });
  assert.equal(opened.status, "ok");
  assert.equal(opened.check!.verified, true);
});

test("the balance check needs every comparable row to move by its amount", () => {
  const base = { valueDate: null, description: "", narration: "", reference: null, counterparty: null, accountName: null, accountNumberMasked: null, bankName: null, confidence: 0.9, sourceFile: "", sourcePage: null, sourceQuote: "" };
  const rows = [
    { ...base, date: "2026-01-01", debit: 100, credit: null, balance: 900, rowNumber: 1 },
    { ...base, date: "2026-01-02", debit: null, credit: 50, balance: 950, rowNumber: 2 },
  ];
  assert.equal(checkRunningBalance(rows, 1000).verified, true);
  assert.equal(checkRunningBalance(rows, 1000, { printedClosing: 949 }).verified, false);
});
