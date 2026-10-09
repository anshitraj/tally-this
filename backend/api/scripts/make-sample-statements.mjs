/**
 * Writes two sample bank statement PDFs for manual testing:
 *   sample-statement-text.pdf     — normal text PDF
 *   sample-statement-scanned.pdf  — the same page as an image only (no text layer)
 * Usage: node scripts/make-sample-statements.mjs <outDir>
 */
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { createCanvas } from "@napi-rs/canvas";

const outDir = process.argv[2] ?? ".";
fs.mkdirSync(outDir, { recursive: true });

const rows = [
  ["01/06/2026", "UPI-SHARMA TRADERS/INV-501/HDFC0001234", "UTR90001", "12,500.00", "", "1,87,500.00"],
  ["02/06/2026", "NEFT CR-MEHTA EXPORTS/INV-88", "UTR90002", "", "45,000.00", "2,32,500.00"],
  ["04/06/2026", "IMPS-AIRTEL BROADBAND/JUN26", "UTR90003", "1,179.00", "", "2,31,321.00"],
  ["06/06/2026", "ATM WDL/ANDHERI EAST", "", "10,000.00", "", "2,21,321.00"],
  ["09/06/2026", "NEFT-SALARY JUNE 2026/BATCH1", "UTR90004", "85,000.00", "", "1,36,321.00"],
  ["12/06/2026", "UPI CR-AMAZON SELLER SERVICES/SETTLE", "UTR90005", "", "28,640.50", "1,64,961.50"],
  ["15/06/2026", "SMS ALERT CHGS QTR", "", "17.70", "", "1,64,943.80"],
  ["20/06/2026", "RTGS-KUMAR LOGISTICS PVT LTD/FREIGHT", "UTR90006", "32,000.00", "", "1,32,943.80"],
];
const header = ["Date", "Narration", "Chq/Ref No.", "Withdrawal Amt", "Deposit Amt", "Closing Balance"];
const widths = [70, 230, 70, 75, 75, 85];

function drawTable(write, startY) {
  let x = 30;
  header.forEach((cell, i) => { write(cell, x, startY, true); x += widths[i]; });
  rows.forEach((row, r) => {
    let cx = 30;
    row.forEach((cell, i) => { write(cell, cx, startY + 22 + r * 20, false); cx += widths[i]; });
  });
}

// Text PDF
{
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 30 });
  doc.pipe(fs.createWriteStream(path.join(outDir, "sample-statement-text.pdf")));
  doc.fontSize(14).text("ICICI Bank Ltd - Statement of Account", 30, 30);
  doc.fontSize(10).text("Account No: XXXXXXXX4821    Period: June 2026", 30, 52);
  doc.fontSize(9);
  drawTable((text, x, y, bold) => doc.font(bold ? "Helvetica-Bold" : "Helvetica").text(text, x, y, { width: 220, lineBreak: false }), 90);
  doc.end();
}

// Image-only PDF (simulates a scan)
{
  const scale = 2;
  const canvas = createCanvas(842 * scale, 595 * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111";
  ctx.scale(scale, scale);
  ctx.font = "bold 16px sans-serif";
  ctx.fillText("ICICI Bank Ltd - Statement of Account", 30, 40);
  ctx.font = "11px sans-serif";
  ctx.fillText("Account No: XXXXXXXX4821    Period: June 2026", 30, 62);
  drawTable((text, x, y, bold) => {
    ctx.font = `${bold ? "bold " : ""}10px sans-serif`;
    ctx.fillText(text, x, y + 10);
  }, 90);
  const png = canvas.toBuffer("image/png");
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 0 });
  doc.pipe(fs.createWriteStream(path.join(outDir, "sample-statement-scanned.pdf")));
  doc.image(png, 0, 0, { width: 842, height: 595 });
  doc.end();
  fs.writeFileSync(path.join(outDir, "sample-statement-scanned.png"), png);
}

console.log("Wrote sample statements to", outDir);
