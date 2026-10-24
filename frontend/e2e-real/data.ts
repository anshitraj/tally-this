/**
 * Small, made-up files for the job tests, built so the right answer is known in advance. Nothing here is a real
 * customer's document. Every figure is in whole paise so totals can be checked exactly.
 */

export interface BankRow {
  date: string; // dd/mm/yyyy
  narration: string;
  ref?: string;
  debit?: number;
  credit?: number;
}

const paise = (value: number) => Math.round(value * 100);
const rupees = (value: number) => (value / 100).toFixed(2);

export interface Statement {
  csv: string;
  rows: number;
  moneyIn: number;
  moneyOut: number;
  opening: number;
  closing: number;
}

/** An HDFC-style CSV with a correct running balance on every row, so the balance proof can pass in full. */
export function hdfcStatement(opening: number, rows: BankRow[], period = "May 2026"): Statement {
  let balance = paise(opening);
  let moneyIn = 0;
  let moneyOut = 0;
  const lines = [
    "HDFC Bank Ltd - Account Statement",
    "Account No: XXXX1234",
    `Period: ${period}`,
    "",
    "Date,Narration,Chq/Ref No.,Withdrawal Amt (INR),Deposit Amt (INR),Closing Balance (INR)",
  ];
  for (const row of rows) {
    const out = paise(row.debit ?? 0);
    const inn = paise(row.credit ?? 0);
    balance += inn - out;
    moneyIn += inn;
    moneyOut += out;
    lines.push([row.date, row.narration, row.ref ?? "", out ? rupees(out) : "", inn ? rupees(inn) : "", rupees(balance)].join(","));
  }
  return { csv: lines.join("\n") + "\n", rows: rows.length, moneyIn, moneyOut, opening: paise(opening), closing: balance };
}

/** May 2026: twenty-four rows that look like a small business's month. */
export const MAY_ROWS: BankRow[] = [
  { date: "01/05/2026", narration: "UPI-ACME Corp/INV-100/YESB0001234", ref: "UTR10000001", debit: 5000 },
  { date: "02/05/2026", narration: "NEFT CR-Sharma Traders/INV-S-501", ref: "UTR10000002", credit: 118000 },
  { date: "03/05/2026", narration: "NEFT-Salary May 2026/SAL2026", ref: "UTR10000003", debit: 75000 },
  { date: "04/05/2026", narration: "UPI-Office Supplies Ltd/BILL-77", ref: "UTR10000004", debit: 2300 },
  { date: "05/05/2026", narration: "Razorpay Settlement/RZP-9988", ref: "RZP9988", credit: 12500 },
  { date: "06/05/2026", narration: "IMPS-Vendor payment/AXIC0001234", ref: "UTR10000006", debit: 8750 },
  { date: "07/05/2026", narration: "NEFT CR-Kapoor Foods/INV-S-502", ref: "UTR10000007", credit: 45000 },
  { date: "08/05/2026", narration: "ATM WDL/ATM-Koramangala", ref: "ATM0801", debit: 20000 },
  { date: "09/05/2026", narration: "NEFT-Google Workspace/GSuite", ref: "UTR10000009", debit: 4200 },
  { date: "10/05/2026", narration: "UPI CR-Payment received/Gupta Hardware", ref: "UTR10000010", credit: 18000 },
  { date: "11/05/2026", narration: "BIL/NEFT/Electricity Board/MAY", ref: "UTR10000011", debit: 6420.5 },
  { date: "12/05/2026", narration: "NEFT CR-Nair Pharma/INV-S-503", ref: "UTR10000012", credit: 23600 },
  { date: "13/05/2026", narration: "UPI-Courier Express/CE-8841", ref: "UTR10000013", debit: 1180 },
  { date: "14/05/2026", narration: "CHQ DEP-Verma Textiles/000417", ref: "000417", credit: 60000 },
  { date: "15/05/2026", narration: "GST PAYMENT/CPIN26051500123", ref: "CPIN26051500123", debit: 14500 },
  { date: "16/05/2026", narration: "UPI-Rent May/Landlord Mehta", ref: "UTR10000016", debit: 30000 },
  { date: "17/05/2026", narration: "NEFT CR-Joshi Exports/INV-S-504", ref: "UTR10000017", credit: 88500 },
  { date: "18/05/2026", narration: "IMPS-Printing Works/PW-221", ref: "UTR10000018", debit: 3350 },
  { date: "19/05/2026", narration: "UPI-Internet Broadband/MAY", ref: "UTR10000019", debit: 1499 },
  { date: "20/05/2026", narration: "NEFT CR-Chopra Motors/INV-S-505", ref: "UTR10000020", credit: 35400 },
  { date: "22/05/2026", narration: "TDS PAYMENT/26Q1", ref: "TDS2205", debit: 2750 },
  { date: "24/05/2026", narration: "UPI-Stationery Mart/SM-90", ref: "UTR10000024", debit: 640 },
  { date: "28/05/2026", narration: "INT.PD:01-04-2026 TO 30-04-2026", credit: 412 },
  { date: "31/05/2026", narration: "SMS ALERT CHARGES Q1", debit: 17.7 },
];

export const MAY_STATEMENT = hdfcStatement(100000, MAY_ROWS);

/** A Tally day book matching MAY_ROWS, except for the differences listed in MAY_TALLY_DIFFERENCES. */
export interface TallyRow {
  date: string;
  particulars: string;
  type: string;
  number: string;
  debit?: number;
  credit?: number;
  narration: string;
}

export function tallyCsv(rows: TallyRow[]): string {
  const lines = ["Date,Particulars,Vch Type,Vch No.,Debit,Credit,Narration"];
  for (const row of rows) {
    lines.push([row.date, row.particulars, row.type, row.number, row.debit ? rupees(paise(row.debit)) : "", row.credit ? rupees(paise(row.credit)) : "", row.narration].join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * The bank rows as Tally would have recorded them (a payment is a Tally credit to the bank, a receipt a debit; the
 * file lists the other side, so the direction here is the party's side).
 */
function tallyFor(row: BankRow, index: number): TallyRow {
  const out = row.debit ?? 0;
  const inn = row.credit ?? 0;
  const label = row.narration.split("/")[0].replace(/^(UPI|NEFT CR|NEFT|IMPS|UPI CR|CHQ DEP|BIL\/NEFT)-?/, "").trim() || "Bank entry";
  return {
    date: row.date,
    particulars: label,
    type: out ? "Payment" : "Receipt",
    number: `${out ? "PMT" : "RCP"}-${String(index + 1).padStart(4, "0")}`,
    debit: out || undefined,
    credit: inn || undefined,
    narration: row.ref ? `${row.narration} ${row.ref}` : row.narration,
  };
}

/** Rows the bank has that the books do not: these must come out as needing attention. */
export const MISSING_FROM_TALLY = [6, 10, 21] as const; // indexes into MAY_ROWS: Kapoor receipt, electricity bill, stationery
/** A row the books have that the bank does not. */
export const EXTRA_IN_TALLY: TallyRow = { date: "26/05/2026", particulars: "Cash sale never banked", type: "Receipt", number: "RCP-9999", credit: 7777, narration: "Not in the bank statement" };

export function mayTallyRows(): TallyRow[] {
  const rows = MAY_ROWS.map((row, index) => tallyFor(row, index)).filter((_, index) => !(MISSING_FROM_TALLY as readonly number[]).includes(index));
  rows.push(EXTRA_IN_TALLY);
  return rows;
}

// ── Books jobs ──────────────────────────────────────────────────────────────

/** Valid GSTINs (the checksum character is right), the same ones the API's unit tests use. */
export const SELLER_GSTIN = "27AAPFU0939F1ZV";
export const BUYER_GSTIN = "29AABCT1332L1ZA";

const csv = (rows: Array<Array<string | number>>) => rows.map(row => row.join(",")).join("\n") + "\n";

/** October 2026 sales register: 6 sales and a credit note. See the hand-worked answers in books-jobs.spec.ts. */
export const SALES_REGISTER = csv([
  ["Demo Co"],
  [`GSTIN/UIN: ${SELLER_GSTIN}`],
  ["Date", "Particulars", "Voucher Type", "Voucher No.", "GSTIN/UIN", "Place of Supply", "Taxable Value", "IGST", "CGST", "SGST", "Gross Total"],
  ["02-10-2026", "Buyer One Pvt Ltd", "Sales", "S-001", BUYER_GSTIN, "Karnataka", 100000, 18000, 0, 0, 118000],
  ["03-10-2026", "Local Buyer", "Sales", "S-002", "", "Maharashtra", 5000, 0, 450, 450, 5900],
  ["04-10-2026", "Local Buyer 2", "Sales", "S-003", "", "Maharashtra", 2000, 0, 180, 180, 2360],
  ["05-10-2026", "Delhi Walk-in", "Sales", "S-004", "", "Delhi", 150000, 27000, 0, 0, 177000],
  ["06-10-2026", "Delhi Small", "Sales", "S-005", "", "Delhi", 40000, 7200, 0, 0, 47200],
  ["07-10-2026", "Buyer One Pvt Ltd", "Credit Note", "CN-001", BUYER_GSTIN, "Karnataka", 10000, 1800, 0, 0, 11800],
  ["08-10-2026", "Exempt Goods Buyer", "Sales", "S-006", "", "Maharashtra", 3000, 0, 0, 0, 3000],
]);

/** A purchase list: two clean bills, and one whose total does not add up. */
export const PURCHASE_LIST = csv([
  ["Date", "Supplier Name", "Supplier GSTIN", "Supplier Invoice No.", "Taxable Value", "CGST", "SGST", "IGST", "Invoice Value"],
  ["05-10-2026", "Alpha Traders", SELLER_GSTIN, "INV-001", 10000, 900, 900, 0, 11800],
  ["06-10-2026", "Beta Supplies", BUYER_GSTIN, "BS-77", 20000, 0, 0, 3600, 23600],
]);
export const PURCHASE_LIST_WITH_ERROR = csv([
  ["Date", "Supplier Name", "Supplier GSTIN", "Supplier Invoice No.", "Taxable Value", "CGST", "SGST", "IGST", "Invoice Value"],
  ["05-10-2026", "Alpha Traders", SELLER_GSTIN, "INV-001", 10000, 900, 900, 0, 11800],
  ["06-10-2026", "Beta Supplies", BUYER_GSTIN, "BS-77", 20000, 0, 0, 3600, 25000],
]);

/** A salary register for October 2026 with three employees. Each row adds up; Meena has PF but no UAN. */
export const SALARY_SHEET = csv([
  ["Sunrise Traders Pvt Ltd"],
  ["Salary register for the month of October 2026"],
  [""],
  ["Emp Code", "Employee Name", "UAN", "PAN", "Bank A/c No", "Paid Days", "Basic", "HRA", "Special Allowance", "Gross", "PF", "ESI", "Professional Tax", "TDS", "Loan Recovery", "Net Pay"],
  ["E001", "Anita Rao", "100200300401", "ABCDE1234F", "501000123456", 31, 20000, 8000, 7000, 35000, 1800, 0, 200, 1000, 0, 32000],
  ["E002", "Ravi Kumar", "100200300402", "ABCDE1234G", "501000123457", 31, 12000, 4800, 3000, 19800, 1440, 149, 200, 0, 500, 17511],
  ["E003", "Meena Joshi", "", "", "501000123458", 30, 15000, 6000, 4000, 25000, 1800, 0, 200, 0, 0, 23000],
  ["Total", "", "", "", "", "", 47000, 18800, 14000, 79800, 5040, 149, 600, 1000, 500, 72511],
]);
