import assert from "node:assert/strict";
import test from "node:test";
import PDFDocument from "pdfkit";
import { readStatementPdf } from "./pdfStatement";
import { checkRunningBalance } from "./statementCheck";

test("one-paise running and closing balance differences never pass", () => {
  const row = { date: "2026-05-01", narration: "Test", description: "Test", reference: null, debit: null, credit: 0.29, balance: 100.30, rowNumber: 1, confidence: 0.95 };
  const check = checkRunningBalance([row as any], 100, { printedClosing: 100.29 });
  assert.equal(check.failed, 1);
  assert.equal(check.closingMatches, false);
  assert.equal(check.verified, false);
  row.balance = 100.29;
  assert.equal(checkRunningBalance([row as any], 100, { printedClosing: 100.29 }).verified, true);
});

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
    { y: 170, cells: [{ text: "1", x: 40 }, { text: "19 Apr 2025", x: 72 }, { text: "UPI/ROHAN SHARMA/1000000/Payment", x: 125 }, { text: "UPI-5109632", x: 280 }, right("50,000.00", D), right("5,20,822.68", B)] },
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
  assert.equal(summary.transactions[0].narration, "UPI/ROHAN SHARMA/1000000/Payment from Ph");
  assert.equal(summary.transactions[1].narration, "FD MATURITY :5150/24-08-25/BHARAT G", "a line broken after a hyphen joins without a space");
  assert.equal(summary.transactions[0].reference, "UPI-5109632");
  assert.equal(read.check!.openingBalance, 470822.68);
  assert.equal(read.check!.closingMatches, true);
  assert.equal(read.check!.serialComplete, true);
  assert.equal(read.check!.verified, true);
});

test("a Closing Balance column heading is not mistaken for a printed closing total", async () => {
  const col = { date: 40, narration: 100, ref: 250, debit: 380, credit: 460, balance: 540 };
  const lines: Line[] = [
    { y: 40, cells: [{ text: "ICICI Bank Ltd - Statement of Account", x: 40 }] },
    { y: 60, cells: [{ text: "Account No: XXXXXXXX4821", x: 40 }] },
    { y: 90, cells: [{ text: "Date", x: col.date }, { text: "Narration", x: col.narration }, { text: "Chq/Ref No.", x: col.ref }, { text: "Withdrawal Amt", x: 345 }, { text: "Deposit Amt", x: 430 }, { text: "Closing Balance", x: 495 }] },
    { y: 110, cells: [{ text: "01/06/2026", x: col.date }, { text: "UPI-SHARMA TRADERS", x: col.narration }, right("12,500.00", W), right("1,87,500.00", B)] },
    { y: 128, cells: [{ text: "02/06/2026", x: col.date }, { text: "NEFT CR-MEHTA EXPORTS", x: col.narration }, right("45,000.00", D), right("2,32,500.00", B)] },
    { y: 146, cells: [{ text: "04/06/2026", x: col.date }, { text: "IMPS-AIRTEL", x: col.narration }, right("1,179.00", W), right("2,31,321.00", B)] },
  ];
  const read = await readStatementPdf(await makePdf(lines), { fileName: "statement.pdf" });
  assert.equal(read.status, "ok");
  assert.equal(read.summary!.transactions.length, 3);
  assert.notEqual(read.check!.closingMatches, false, "no printed closing total exists, so nothing can disagree");
  assert.equal(read.check!.verified, false, "Without a printed opening balance the first row remains unproved.");
  assert.ok(!read.summary!.warnings.some(warning => /closing balance printed/i.test(warning)));
});

test("a printed closing total that disagrees with the last row is still flagged", async () => {
  const lines = kotakLines();
  lines.push({ y: 260, cells: [{ text: "Closing Balance", x: 125 }, right("9,99,999.00", B)] });
  const read = await readStatementPdf(await makePdf(lines), { fileName: "statement.pdf" });
  assert.equal(read.check!.printedClosing, 999999);
  assert.equal(read.check!.closingMatches, false);
  assert.equal(read.check!.verified, false);
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
    { y: 150, cells: [{ text: "31 Mar 2026", x: 50 }, { text: "100000002222:Int.Pd:01-0", x: 125 }, { text: "S225591", x: 256 }, right("0.00", 395), right("8.00", 468), right("1286.08", 527)] },
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
  assert.equal(summary.transactions[2].narration, "100000002222:Int.Pd:01-01-2026 to 31-03-2026");
  assert.equal(summary.transactions[1].debit, 818);
  assert.equal(summary.transactions[2].credit, 8);
  assert.equal(read.check!.verified, false, "Correct ordering does not prove the first amount without an opening balance.");
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

// Canara-style passbook: each description is centred on its date and amount line (it starts above
// it), every block ends with a "Chq:" line, and text wraps at the column's width.
function canaraLines(): Line[] {
  const cell = (text: string, x = 107): Cell => ({ text, x });
  return [
    { y: 60, cells: [cell("Statement for A/c XXXXXXXXX9240 for the period 15-Sep-2025 to 30-Nov-2025", 36)] },
    { y: 100, cells: [{ text: "Date", x: 44 }, { text: "Particulars", x: 167 }, { text: "Deposits", x: 321 }, { text: "Withdrawals", x: 413 }, { text: "Balance", x: 517 }] },
    { y: 120, cells: [{ text: "Opening Balance", x: 306 }, right("1,000.00", 560)] },
    { y: 140, cells: [cell("UPI/DR/525805739236/COUNTR")] },
    { y: 152, cells: [cell("YDE/UTIB/**.PAYU@AXISBANK/")] },
    { y: 164, cells: [{ text: "15-09-2025", x: 27 }, cell("COUNTRY"), right("80.00", 470), right("920.00", 560)] },
    { y: 176, cells: [cell("4368C85487/15/09/2025")] },
    { y: 188, cells: [cell("23:31:55")] },
    { y: 200, cells: [cell("Chq: 525805739236")] },
    { y: 224, cells: [cell("NEFT CR-AXNGG25963817073-")] },
    { y: 236, cells: [cell("UTIB0000553-GOOGLE INDIA")] },
    { y: 248, cells: [{ text: "16-09-2025", x: 27 }, cell("DIGITAL SERVICES PRIVATE"), right("70.00", 380), right("990.00", 560)] },
    { y: 260, cells: [cell("Chq: 0")] },
    { y: 284, cells: [cell("UPI/CR/533357815619/SHAHAJ")] },
    { y: 296, cells: [cell("AD /YESB/**097-")] },
    { y: 308, cells: [{ text: "29-11-2025", x: 27 }, cell("F744F7CB376374986BCCAB5/2"), right("500.00", 380), right("1,490.00", 560)] },
    { y: 320, cells: [cell("9/11/2025 13:57:40")] },
    { y: 332, cells: [cell("Chq: 533357815619")] },
    { y: 356, cells: [cell("UPI/REV/601314504161/ASHA")] },
    { y: 368, cells: [{ text: "30-11-2025", x: 27 }, cell("BHAR/CNRB/**07764@PTAXIS/"), right("-40.00", 470), right("1,530.00", 560)] },
    { y: 380, cells: [cell("Chq: 601314504161")] },
  ];
}

test("a passbook whose descriptions start above the amount line keeps every line, its reference and its reversals", async () => {
  const read = await readStatementPdf(await makePdf(canaraLines(), { font: "Courier" }), { fileName: "canara_epassbook.pdf" });
  assert.equal(read.status, "ok");
  const txns = read.summary!.transactions;
  // The wrapped line "9/11/2025 13:57:40" is part of a description, not a fifth transaction.
  assert.equal(txns.length, 4);
  assert.equal(txns[0].narration, "UPI/DR/525805739236/COUNTRYDE/UTIB/**.PAYU@AXISBANK/COUNTRY 4368C85487/15/09/2025 23:31:55");
  assert.equal(txns[1].narration, "NEFT CR-AXNGG25963817073-UTIB0000553-GOOGLE INDIA DIGITAL SERVICES PRIVATE");
  assert.equal(txns[2].narration, "UPI/CR/533357815619/SHAHAJAD /YESB/**097- F744F7CB376374986BCCAB5/29/11/2025 13:57:40");
  assert.match(txns[3].narration, /^UPI\/REV\/601314504161\/ASHA/);
  assert.deepEqual(txns.map(txn => txn.reference), ["525805739236", null, "533357815619", "601314504161"]);
  // "-40.00" under Withdrawals raised the balance: it is money back in.
  assert.deepEqual(txns.map(txn => [txn.date, txn.debit, txn.credit, txn.balance]), [
    ["2025-09-15", 80, null, 920],
    ["2025-09-16", null, 70, 990],
    ["2025-11-29", null, 500, 1490],
    ["2025-11-30", null, 40, 1530],
  ]);
  assert.equal(read.check!.verified, true);
  assert.equal(read.check!.failed, 0);
});
