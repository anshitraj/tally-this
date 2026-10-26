import { createRequire } from "node:module";

/**
 * A text-layer bank statement PDF in a Kotak-style layout (serial column, one amount per row, an opening balance row,
 * a printed opening/closing summary), built with the same library the product uses to write PDFs. The layout is the one
 * the API's own PDF tests use, so the product is expected to read it and prove every row.
 */

const requireFromApi = createRequire(new URL("../../backend/api/package.json", import.meta.url));

export interface PdfRow {
  date: string; // "19 Apr 2025"
  description: string;
  reference: string;
  withdrawal?: number;
  deposit?: number;
}

const grouping = (value: number) => {
  const [whole, paise] = value.toFixed(2).split(".");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," : ""}${last3}.${paise}`;
};

export interface KotakStatement {
  pdf: Buffer;
  rows: PdfRow[];
  opening: number;
  closing: number;
  moneyIn: number;
  moneyOut: number;
}

export function kotakRows(): PdfRow[] {
  return [
    { date: "19 Apr 2025", description: "UPI/ROHAN SHARMA/1000000/Payment", reference: "UPI-5109632", deposit: 50000 },
    { date: "02 May 2025", description: "NEFT-ACME TRADERS-INV-2201", reference: "NEFT-7701", withdrawal: 18250.5 },
    { date: "21 May 2025", description: "IMPS/SUNITA ENTERPRISES/Rent", reference: "IMPS-4410", withdrawal: 30000 },
    { date: "09 Jun 2025", description: "NEFT-KAPOOR FOODS-INV-S-502", reference: "NEFT-7788", deposit: 118000 },
    { date: "30 Jun 2025", description: "Int.Pd:0211300197", reference: "", deposit: 1815 },
    { date: "14 Jul 2025", description: "UPI/OFFICE SUPPLIES LTD/BILL-77", reference: "UPI-5300021", withdrawal: 2300 },
    { date: "05 Aug 2025", description: "FD MATURITY :5150/24-08-25", reference: "MB-998444", deposit: 210000 },
    { date: "18 Sep 2025", description: "GST PAYMENT CPIN25091800123", reference: "CPIN25091800123", withdrawal: 14500 },
  ];
}

/** `misprint` prints a wrong balance on one row (0-based), as a damaged or edited statement would. */
export async function kotakStatement(options: { password?: string; rows?: PdfRow[]; opening?: number; misprint?: { row: number; by: number } } = {}): Promise<KotakStatement> {
  const PDFDocument = requireFromApi("pdfkit");
  const rows = options.rows ?? kotakRows();
  const opening = options.opening ?? 470822.68;
  const W = 416;
  const D = 487;
  const B = 556;
  const pdf = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      ...(options.password ? { userPassword: options.password, ownerPassword: `${options.password}-owner`, pdfVersion: "1.7" } : {}),
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font("Helvetica").fontSize(8);
    const left = (text: string, x: number, y: number) => doc.text(text, x, y, { lineBreak: false });
    const right = (text: string, x: number, y: number) => doc.text(text, x - 76, y, { width: 76, align: "right", lineBreak: false });
    left("Kotak Mahindra Bank", 40, 40);
    left("Account No. 0211300197", 340, 60);
    left("IFSC Code KKBK0004264", 40, 75);
    left("01 Apr 2025 - 31 Mar 2026", 40, 90);
    for (const [text, x] of [["#", 40], ["Date", 72], ["Description", 125], ["Chq/Ref. No.", 280], ["Withdrawal (Dr.)", 345], ["Deposit (Cr.)", 430], ["Balance", 505]] as const) left(text, x, 130);
    left("Opening Balance", 125, 150);
    right(grouping(opening), B, 150);
    let balance = opening;
    let y = 170;
    rows.forEach((row, index) => {
      balance = Math.round((balance + (row.deposit ?? 0) - (row.withdrawal ?? 0)) * 100) / 100;
      left(String(index + 1), 40, y);
      left(row.date, 72, y);
      left(row.description, 125, y);
      if (row.reference) left(row.reference, 280, y);
      if (row.withdrawal) right(grouping(row.withdrawal), W, y);
      if (row.deposit) right(grouping(row.deposit), D, y);
      right(grouping(options.misprint?.row === index ? balance + options.misprint.by : balance), B, y);
      y += 30;
    });
    y += 30;
    left("Opening Balance", 300, y);
    left("Closing Balance", 420, y);
    left("Savings Account (SA):", 125, y + 15);
    right(grouping(opening), 380, y + 15);
    right(grouping(balance), 480, y + 15);
    doc.end();
  });
  const moneyIn = rows.reduce((sum, row) => sum + Math.round((row.deposit ?? 0) * 100), 0);
  const moneyOut = rows.reduce((sum, row) => sum + Math.round((row.withdrawal ?? 0) * 100), 0);
  return { pdf, rows, opening: Math.round(opening * 100), closing: Math.round(opening * 100) + moneyIn - moneyOut, moneyIn, moneyOut };
}
