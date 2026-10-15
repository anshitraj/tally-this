/**
 * What an AI answer for a bank statement looks like, and how it becomes rows the rest of the app
 * understands. No network and no database: the schema, the prompt, and the running-balance check.
 */
import { z } from "zod";
import type { AIProviderName } from "../server/ai/types";
import { counterpartyFrom, normalizeDate, type BankStatementSummary, type NormalizedBankTxn } from "./bankStatement";
import { detectBankFromStatement } from "./bankDirectory";
import { checkRunningBalance, chronological, type StatementCheck } from "./statementCheck";
import { outOfOrderIndices } from "./dateOrder";

export const money = z.union([z.number(), z.string()]).nullable().transform(value => {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = value.replace(/[₹,\s]/g, "").replace(/(cr|dr)$/i, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
});

export const bankStatementSchema = z.object({
  bankName: z.string().nullable().optional(),
  ifsc: z.string().nullable().optional(),
  accountNumberLast4: z.string().nullable().optional(),
  periodFrom: z.string().nullable().optional(),
  periodTo: z.string().nullable().optional(),
  openingBalance: money.optional().default(null),
  closingBalance: money.optional().default(null),
  transactions: z.array(z.object({
    date: z.string(),
    valueDate: z.string().nullable().optional(),
    narration: z.string().default(""),
    reference: z.string().nullable().optional(),
    debit: money.optional().default(null),
    credit: money.optional().default(null),
    balance: money.optional().default(null),
  })).max(5000),
});

export type AIBankStatement = z.infer<typeof bankStatementSchema>;

/**
 * Some models answer with a list holding one object per page instead of one statement.
 * That is joined into one statement here, so it is not mistaken for an unreadable answer.
 */
function joinAnswers(value: unknown, rowsKey: "transactions" | "rows"): unknown {
  if (!Array.isArray(value) || value.length === 0) return value;
  const objects = value.filter((item): item is Record<string, unknown> => item != null && typeof item === "object" && !Array.isArray(item));
  if (objects.length !== value.length) return value;
  const present = (item: unknown) => item != null && item !== "";
  const first = (key: string) => objects.map(object => object[key]).find(present) ?? null;
  const last = (key: string) => [...objects].reverse().map(object => object[key]).find(present) ?? null;
  return {
    bankName: first("bankName"),
    ifsc: first("ifsc"),
    accountNumberLast4: first("accountNumberLast4"),
    periodFrom: first("periodFrom"),
    periodTo: last("periodTo"),
    openingBalance: first("openingBalance"),
    closingBalance: last("closingBalance"),
    [rowsKey]: objects.flatMap(object => (Array.isArray(object[rowsKey]) ? (object[rowsKey] as unknown[]) : [])),
  };
}

/** The statement schema, accepting a list of per-page objects as well as one object. */
export const bankStatementAnswerSchema = z.preprocess(value => joinAnswers(value, "transactions"), bankStatementSchema);

const compactCell = z.union([z.string(), z.number()]).nullable();

/**
 * A page-group answer where each transaction is a plain 7-item list instead of an object with
 * seven named keys. Roughly half the output, so a group is read in about half the time. A row of
 * any other length makes the whole answer invalid and the next model is tried; no row is guessed.
 */
export const compactStatementSchema = z
  .preprocess(
    value => joinAnswers(value, "rows"),
    z.object({
      bankName: z.string().nullable().optional(),
      ifsc: z.string().nullable().optional(),
      accountNumberLast4: z.string().nullable().optional(),
      periodFrom: z.string().nullable().optional(),
      periodTo: z.string().nullable().optional(),
      openingBalance: money.optional().default(null),
      closingBalance: money.optional().default(null),
      rows: z.array(z.array(compactCell).length(7)).max(5000),
    }),
  )
  .transform((answer): AIBankStatement => {
    const text = (cell: string | number | null) => (cell == null ? null : String(cell));
    const amount = (cell: string | number | null) => money.parse(cell);
    return {
      bankName: answer.bankName ?? null,
      ifsc: answer.ifsc ?? null,
      accountNumberLast4: answer.accountNumberLast4 ?? null,
      periodFrom: answer.periodFrom ?? null,
      periodTo: answer.periodTo ?? null,
      openingBalance: answer.openingBalance,
      closingBalance: answer.closingBalance,
      transactions: answer.rows.map(([date, valueDate, narration, reference, debit, credit, balance]) => ({
        date: text(date) ?? "",
        valueDate: text(valueDate),
        narration: text(narration) ?? "",
        reference: text(reference),
        debit: amount(debit),
        credit: amount(credit),
        balance: amount(balance),
      })),
    };
  });

export const BANK_PROMPT = [
  "These pages are one Indian bank account statement. Read the transaction table and return JSON only.",
  "Shape: {\"bankName\": string|null, \"ifsc\": string|null, \"accountNumberLast4\": string|null,",
  "\"periodFrom\": \"YYYY-MM-DD\"|null, \"periodTo\": \"YYYY-MM-DD\"|null,",
  "\"openingBalance\": number|null, \"closingBalance\": number|null,",
  "\"transactions\": [{\"date\": \"YYYY-MM-DD\", \"valueDate\": \"YYYY-MM-DD\"|null, \"narration\": string,",
  "\"reference\": string|null, \"debit\": number|null, \"credit\": number|null, \"balance\": number|null}]}.",
  "Rules:",
  "1. One entry per transaction row, in the order printed, across every page. Never skip, merge, summarise or invent a row.",
  "2. Do not include opening balance, closing balance, total or header rows as transactions; put printed opening and closing balances in openingBalance and closingBalance.",
  "3. date is the transaction date; valueDate is the value date column if the statement has one.",
  "4. narration is the full description cell. Join lines that wrap inside the cell. Keep spelling and punctuation exactly as printed.",
  "5. reference is the cheque or reference number column if there is one, else null.",
  "6. debit is the amount in the Withdrawal / Debit column; credit is the amount in the Deposit / Credit column. A printed 0.00 means null.",
  "7. balance is the running balance printed on that row. A balance marked Dr is negative.",
  "8. Numbers are plain JSON numbers without commas or currency signs. Copy every digit exactly.",
  "9. bankName and ifsc are the issuing bank's, from the logo or header, not banks named in narrations.",
  "10. Dates on Indian statements are day/month/year: 05/06/2025 is 5 June 2025.",
  "11. openingBalance and closingBalance are only what the statement prints under those names. If it prints none, use null. Never copy a row's balance into them.",
].join(" ");

/** The rules every statement read follows, whatever shape the answer takes. */
const READING_RULES = [
  "Rules:",
  "1. One entry per transaction row, in the order printed, across every page. Never skip, merge, summarise or invent a row.",
  "2. Do not include opening balance, closing balance, total or header rows as transactions; put printed opening and closing balances in openingBalance and closingBalance.",
  "3. date is the transaction date; valueDate is the value date column if the statement has one.",
  "4. narration is the full description cell. Join lines that wrap inside the cell. Keep spelling and punctuation exactly as printed.",
  "5. reference is the cheque or reference number column if there is one, else null.",
  "6. debit is the amount in the Withdrawal / Debit column; credit is the amount in the Deposit / Credit column. A printed 0.00 means null.",
  "7. balance is the running balance printed on that row. A balance marked Dr is negative.",
  "8. Numbers are plain JSON numbers without commas or currency signs. Copy every digit exactly.",
  "9. bankName and ifsc are the issuing bank, from the logo or header, not banks named in narrations.",
  "10. Dates on Indian statements are day/month/year: 05/06/2025 is 5 June 2025.",
  "11. openingBalance and closingBalance are only what the statement prints under those names. If it prints none, use null. Never copy a row's balance into them.",
];

/**
 * Prompt for a few pages of a long statement. Answers one JSON object with each transaction as a
 * 7-item list: date, valueDate, narration, reference, debit, credit, balance.
 */
export function compactPrompt(pages: string, total: number): string {
  return [
    `These images are only pages ${pages} of a ${total}-page Indian bank account statement. Read the transaction table and return one JSON object only, not a list.`,
    "Shape: {\"bankName\": string|null, \"ifsc\": string|null, \"accountNumberLast4\": string|null, \"openingBalance\": number|null, \"closingBalance\": number|null, \"rows\": [[date, valueDate, narration, reference, debit, credit, balance], ...]}.",
    "Every row is a list of exactly 7 items in that order: date as YYYY-MM-DD, valueDate as YYYY-MM-DD or null, narration string, reference string or null, debit number or null, credit number or null, balance number or null.",
    "The table header, opening balance and closing balance may be on other pages: read only the rows printed on these pages and use null for anything not shown.",
    "Lines such as balance brought forward, balance carried forward, page total and end of statement are not transactions.",
    ...READING_RULES,
  ].join(" ");
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** A row the AI put in the wrong column is fixed only when the printed balance proves it. */
function alignDirections(rows: NormalizedBankTxn[], opening: number | null) {
  rows.forEach((row, index) => {
    const previous = index === 0 ? opening : rows[index - 1].balance;
    const amount = row.debit ?? row.credit;
    if (previous == null || row.balance == null || amount == null) return;
    const delta = round2(row.balance - previous);
    if (Math.abs(Math.abs(delta) - amount) > 0.011) return;
    if (delta > 0 && row.debit != null) {
      row.credit = row.debit;
      row.debit = null;
    } else if (delta < 0 && row.credit != null) {
      row.debit = row.credit;
      row.credit = null;
    }
  });
}

export interface AIStatementRead {
  summary: BankStatementSummary;
  check: StatementCheck;
  provider: AIProviderName;
  model: string;
}

export function toSummary(statement: AIBankStatement, fileName: string): { summary: BankStatementSummary; check: StatementCheck } {
  const detection = detectBankFromStatement([statement.ifsc ? `IFSC Code: ${statement.ifsc}` : "", statement.bankName ?? ""].join("\n"), fileName);
  const bankName = detection?.name ?? statement.bankName ?? null;
  const last4 = statement.accountNumberLast4?.replace(/\D/g, "").slice(-4) || null;
  const rows: NormalizedBankTxn[] = statement.transactions.flatMap(txn => {
    const date = normalizeDate(txn.date);
    if (!date) return [];
    const narration = txn.narration.replace(/\s+/g, " ").trim();
    return [{
      date,
      valueDate: normalizeDate(txn.valueDate ?? null),
      description: narration,
      narration,
      reference: txn.reference?.trim() || null,
      debit: txn.debit != null && txn.debit !== 0 ? Math.abs(txn.debit) : null,
      credit: txn.credit != null && txn.credit !== 0 ? Math.abs(txn.credit) : null,
      balance: txn.balance,
      counterparty: counterpartyFrom(narration),
      accountName: bankName,
      accountNumberMasked: last4,
      bankName,
      rowNumber: 0,
      confidence: 0.85,
      sourceFile: fileName,
      sourcePage: null,
      sourceQuote: narration.slice(0, 200),
    }];
  });
  const ordered = chronological(rows);
  ordered.forEach((row, index) => { row.rowNumber = index + 1; });
  alignDirections(ordered, statement.openingBalance);
  const check = checkRunningBalance(ordered, statement.openingBalance, { printedClosing: statement.closingBalance });
  const debitTotal = round2(ordered.reduce((sum, txn) => sum + (txn.debit ?? 0), 0));
  const creditTotal = round2(ordered.reduce((sum, txn) => sum + (txn.credit ?? 0), 0));
  const from = normalizeDate(statement.periodFrom ?? null) ?? ordered[0]?.date ?? null;
  const to = normalizeDate(statement.periodTo ?? null) ?? ordered[ordered.length - 1]?.date ?? null;
  const day = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  };
  const lowConfidenceCount = ordered.filter(txn => txn.confidence < 0.9).length;
  const noDate = statement.transactions.length - rows.length;
  return {
    check,
    summary: {
      status: check.verified ? "parsed" : "needs_review",
      message: check.verified
        ? `${ordered.length} transactions read. Every row matches the bank's running balance.`
        : `${ordered.length} transactions read. ${lowConfidenceCount} need a check.`,
      bankName,
      periodLabel: from && to ? `${day(from)} – ${day(to)}` : null,
      accountNumberMasked: last4,
      transactions: ordered,
      openingBalance: statement.openingBalance ?? null,
      closingBalance: ordered[ordered.length - 1]?.balance ?? null,
      debitTotal,
      creditTotal,
      lowConfidenceCount,
      detectedColumns: [],
      warnings: [
        ...(check.failed > 0 ? [`${check.failed} row(s) do not match the running balance. Compare them with the statement.`] : []),
        ...(noDate > 0 ? [`${noDate} row(s) had no readable date and were left out. Compare the transaction count with the statement.`] : []),
      ],
    },
  };
}

/**
 * An AI read is never called verified. The model reads the balances too: a closing balance it
 * reports can be nothing more than the last row it happened to read, and rows missing at the start
 * or end of the list do not break the running balance. The reviewer compares the transaction count
 * and totals with the bank statement, and rows that sit out of date order are flagged for a look.
 */
export function finishAiRead(summary: BankStatementSummary, check: StatementCheck): void {
  const rows = summary.transactions;
  // A misread month or year shows up as dates that run backwards, which the running balance cannot see.
  const outside = outOfOrderIndices(rows.map(row => row.date));
  for (const index of outside) rows[index].confidence = Math.min(rows[index].confidence, 0.6);
  const outOfOrder = outside.length;
  check.verified = false;
  summary.status = "needs_review";
  summary.lowConfidenceCount = rows.filter(row => row.confidence < 0.9).length;
  if (outOfOrder > 0) summary.warnings = [...summary.warnings, `${outOfOrder} row(s) are out of date order. Compare them with the statement.`];
  summary.message = summary.lowConfidenceCount === 0
    ? `${rows.length} transactions read. Every row follows the running balance. Compare the transaction count and totals with the bank statement.`
    : `${rows.length} transactions read. ${summary.lowConfidenceCount} need a check.`;
}
