import ExcelJS from "exceljs";
import { z } from "zod";
import { paise } from "./money";

const amount = z.number().finite().nullable().optional();

const bankSide = z.object({
  date: z.string().max(20),
  narration: z.string().max(500).default(""),
  reference: z.string().max(120).nullable().optional(),
  debit: amount,
  credit: amount,
});

const tallySide = z.object({
  date: z.string().max(20),
  ledgerName: z.string().max(200).default(""),
  voucherNumber: z.string().max(80).nullable().optional(),
  narration: z.string().max(500).optional(),
  debit: amount,
  credit: amount,
});

const item = z.object({
  key: z.string().max(60),
  bucket: z.enum(["confirmed", "suggested", "bank_only", "tally_only", "amount_difference", "duplicate"]),
  status: z.string().max(40).default("suggested"),
  why: z.array(z.string().max(400)).max(10).default([]),
  bank: bankSide.optional(),
  tally: tallySide.optional(),
});

export const brsSchema = z.object({
  clientName: z.string().max(200).default("Client"),
  bankName: z.string().max(120).nullable().optional(),
  periodLabel: z.string().max(80).nullable().optional(),
  /** Closing balance printed on the bank statement. */
  bankClosing: z.number().finite().nullable().optional(),
  /** Closing balance of the bank ledger in Tally, typed in by the CA. */
  booksClosing: z.number().finite().nullable().optional(),
  items: z.array(item).max(60000),
});

export type BrsInput = z.infer<typeof brsSchema>;
type Item = BrsInput["items"][number];

const MONEY = "#,##0.00;[Red](#,##0.00)";

/** Whole paise, so a long list adds up exactly. */
const p = (value: number | null | undefined) => (value == null ? 0 : (paise(value) ?? Math.round(value * 100)));

export interface BrsFigures {
  bankClosing: number | null;
  depositsNotCredited: number;
  paymentsNotPresented: number;
  creditsNotBooked: number;
  debitsNotBooked: number;
  differences: number;
  computedBooks: number | null;
  booksClosing: number | null;
  gap: number | null;
  unresolved: number;
  counts: { tallyOnlyIn: number; tallyOnlyOut: number; bankOnlyIn: number; bankOnlyOut: number; differing: number };
}

/**
 * Standard bank reconciliation, worked from the bank's balance to the books:
 *   books = bank + deposits booked but not credited − payments booked but not presented
 *                − credits in bank not booked + debits in bank not booked ± amount differences.
 * Rows still waiting for a decision (probable matches, possible duplicates) are not adjusted for.
 */
export function brsFigures(input: BrsInput): BrsFigures {
  let depositsNotCredited = 0;
  let paymentsNotPresented = 0;
  let creditsNotBooked = 0;
  let debitsNotBooked = 0;
  let differences = 0;
  let unresolved = 0;
  const counts = { tallyOnlyIn: 0, tallyOnlyOut: 0, bankOnlyIn: 0, bankOnlyOut: 0, differing: 0 };
  for (const entry of input.items) {
    // A person who said "not a match" about a probable pairing leaves both rows where they were.
    if (entry.bucket === "tally_only" && entry.tally) {
      const receipt = p(entry.tally.debit) > 0;
      if (receipt) {
        depositsNotCredited += p(entry.tally.debit);
        counts.tallyOnlyIn += 1;
      } else {
        paymentsNotPresented += p(entry.tally.credit);
        counts.tallyOnlyOut += 1;
      }
    } else if (entry.bucket === "bank_only" && entry.bank) {
      if (p(entry.bank.credit) > 0) {
        creditsNotBooked += p(entry.bank.credit);
        counts.bankOnlyIn += 1;
      } else {
        debitsNotBooked += p(entry.bank.debit);
        counts.bankOnlyOut += 1;
      }
    } else if (entry.bucket === "amount_difference" && entry.bank && entry.tally) {
      const bankReceipt = p(entry.bank.credit) > 0;
      const bankAmount = bankReceipt ? p(entry.bank.credit) : p(entry.bank.debit);
      const tallyAmount = bankReceipt ? p(entry.tally.debit) : p(entry.tally.credit);
      // Receipts: books − bank. Payments: bank − books.
      differences += bankReceipt ? tallyAmount - bankAmount : bankAmount - tallyAmount;
      counts.differing += 1;
    } else if (entry.bucket === "suggested" || entry.bucket === "duplicate") {
      unresolved += 1;
    }
  }
  const bank = input.bankClosing == null ? null : p(input.bankClosing);
  const computed = bank == null ? null : bank + depositsNotCredited - paymentsNotPresented - creditsNotBooked + debitsNotBooked + differences;
  const books = input.booksClosing == null ? null : p(input.booksClosing);
  return {
    bankClosing: bank == null ? null : bank / 100,
    depositsNotCredited: depositsNotCredited / 100,
    paymentsNotPresented: paymentsNotPresented / 100,
    creditsNotBooked: creditsNotBooked / 100,
    debitsNotBooked: debitsNotBooked / 100,
    differences: differences / 100,
    computedBooks: computed == null ? null : computed / 100,
    booksClosing: books == null ? null : books / 100,
    gap: computed != null && books != null ? (computed - books) / 100 : null,
    unresolved,
    counts,
  };
}

function header(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF143E2C" } };
  row.height = 24;
}

const dateCell = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : value);

export function buildBrsWorkbook(input: BrsInput) {
  const figures = brsFigures(input);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TallyThis";

  const sheet = workbook.addWorksheet("Bank reconciliation");
  sheet.columns = [{ width: 70 }, { width: 20 }, { width: 44 }];
  sheet.addRow([`Bank reconciliation statement${input.bankName ? ` — ${input.bankName}` : ""}`]);
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF143E2C" } };
  sheet.addRow([`${input.clientName}${input.periodLabel ? ` · ${input.periodLabel}` : ""}`]);
  sheet.addRow([]);

  const line = (label: string, value: number | null, note = "", bold = false) => {
    const row = sheet.addRow([label, value, note]);
    row.getCell(2).numFmt = MONEY;
    if (bold) row.font = { bold: true };
    return row;
  };
  line("Balance as per bank statement", figures.bankClosing, figures.bankClosing == null ? "Not found on the statement. Type it in TallyThis to complete this page." : "", true);
  line("Add: deposits and receipts in books, not yet credited by the bank", figures.depositsNotCredited, `${figures.counts.tallyOnlyIn} entries`);
  line("Less: payments and cheques in books, not yet debited by the bank", -figures.paymentsNotPresented, `${figures.counts.tallyOnlyOut} entries`);
  line("Less: credits in the bank, not yet recorded in books", -figures.creditsNotBooked, `${figures.counts.bankOnlyIn} entries`);
  line("Add: debits in the bank, not yet recorded in books (charges, EMIs)", figures.debitsNotBooked, `${figures.counts.bankOnlyOut} entries`);
  if (figures.counts.differing > 0) line("Add / less: entries recorded for a different amount", figures.differences, `${figures.counts.differing} entries`);
  sheet.addRow([]);
  line("Balance as per books, worked out", figures.computedBooks, "", true);
  if (figures.booksClosing != null) {
    line("Balance as per Tally ledger, as entered", figures.booksClosing);
    const row = line("Difference (should be nil)", figures.gap, figures.gap === 0 ? "Reconciled" : "Check the entries below and the Tally balance", true);
    row.getCell(2).font = { bold: true, color: { argb: figures.gap === 0 ? "FF065F46" : "FFB45309" } };
  }
  if (figures.unresolved > 0) {
    sheet.addRow([]);
    sheet.addRow([`${figures.unresolved} probable matches or possible duplicates were not decided. They are not adjusted for here.`]);
  }
  sheet.addRow([]);
  sheet.addRow(["Working statement from the two files you uploaded. Potential risk — needs CA review."]);

  const make = (name: string, rows: Item[], build: (entry: Item) => Array<string | number | Date | null>, columns: string[]) => {
    const target = workbook.addWorksheet(name);
    target.columns = columns.map((title, index) => ({ header: title, width: index === 1 ? 54 : index === columns.length - 1 ? 46 : 16 }));
    header(target);
    for (const entry of rows) {
      const row = target.addRow(build(entry));
      row.getCell(1).numFmt = "dd mmm yyyy";
      for (let col = 3; col <= 4; col += 1) row.getCell(col).numFmt = MONEY;
    }
    return target;
  };

  make(
    "In books, not in bank",
    input.items.filter(entry => entry.bucket === "tally_only" && entry.tally),
    entry => [dateCell(entry.tally!.date), entry.tally!.ledgerName, entry.tally!.debit ?? null, entry.tally!.credit ?? null, entry.tally!.voucherNumber ?? ""],
    ["Date", "Ledger / narration", "Receipt ₹", "Payment ₹", "Voucher no."],
  );
  make(
    "In bank, not in books",
    input.items.filter(entry => entry.bucket === "bank_only" && entry.bank),
    entry => [dateCell(entry.bank!.date), entry.bank!.narration, entry.bank!.credit ?? null, entry.bank!.debit ?? null, entry.bank!.reference ?? ""],
    ["Date", "Narration", "Credit ₹", "Debit ₹", "Reference"],
  );
  make(
    "Amounts differ",
    input.items.filter(entry => entry.bucket === "amount_difference" && entry.bank && entry.tally),
    entry => [
      dateCell(entry.bank!.date),
      `${entry.bank!.narration} ↔ ${entry.tally!.ledgerName}`,
      entry.bank!.credit ?? entry.bank!.debit ?? null,
      entry.tally!.debit ?? entry.tally!.credit ?? null,
      entry.why.join(". "),
    ],
    ["Date", "Bank ↔ Tally", "Bank ₹", "Tally ₹", "Why"],
  );
  make(
    "To confirm",
    input.items.filter(entry => entry.bucket === "suggested" || entry.bucket === "duplicate"),
    entry => [
      dateCell(entry.bank?.date ?? entry.tally?.date ?? ""),
      `${entry.bank?.narration ?? ""}${entry.bank && entry.tally ? " ↔ " : ""}${entry.tally?.ledgerName ?? ""}`,
      entry.bank?.credit ?? entry.bank?.debit ?? null,
      entry.tally?.debit ?? entry.tally?.credit ?? null,
      `${entry.bucket === "duplicate" ? "Possible duplicate. " : "Probable match. "}${entry.why.join(". ")}`,
    ],
    ["Date", "Bank ↔ Tally", "Bank ₹", "Tally ₹", "Why"],
  );
  return workbook;
}
