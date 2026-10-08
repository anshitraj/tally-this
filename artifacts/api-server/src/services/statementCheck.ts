/**
 * Proof that a statement was read correctly: each row must move the running balance
 * by exactly its withdrawal or deposit, and the last balance must equal any closing
 * balance printed on the statement. Used for both table-read and AI-read statements.
 */
import type { NormalizedBankTxn } from "./bankStatement";

export interface StatementCheck {
  rows: number;
  /** Rows that had an earlier balance to compare with. */
  checked: number;
  passed: number;
  failed: number;
  failedRows: number[];
  openingBalance: number | null;
  closingBalance: number | null;
  printedClosing: number | null;
  closingMatches: boolean | null;
  serialComplete: boolean | null;
  /** Every comparable row passed and nothing printed on the statement contradicts the result. */
  verified: boolean;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * `transactions` must be in date order (oldest first). Sets each row's confidence:
 * 0.99 when proved by the balance, 0.6 when the balance disagrees.
 */
export function checkRunningBalance(
  transactions: NormalizedBankTxn[],
  opening: number | null,
  options: { printedClosing?: number | null; serialComplete?: boolean | null } = {},
): StatementCheck {
  const failedRows: number[] = [];
  let checked = 0;
  transactions.forEach((txn, index) => {
    const previous = index === 0 ? opening : transactions[index - 1].balance;
    if (txn.debit == null && txn.credit == null) {
      txn.confidence = Math.min(txn.confidence, 0.5);
      return;
    }
    if (previous == null || txn.balance == null) return;
    checked += 1;
    const expected = round2(previous + (txn.credit ?? 0) - (txn.debit ?? 0));
    if (Math.abs(expected - txn.balance) <= 0.011) {
      txn.confidence = Math.max(txn.confidence, 0.99);
    } else {
      txn.confidence = Math.min(txn.confidence, 0.6);
      failedRows.push(txn.rowNumber);
    }
  });
  const closingBalance = transactions[transactions.length - 1]?.balance ?? null;
  const printedClosing = options.printedClosing ?? null;
  const closingMatches = printedClosing == null || closingBalance == null ? null : Math.abs(printedClosing - closingBalance) <= 0.011;
  const serialComplete = options.serialComplete ?? null;
  const failed = failedRows.length;
  return {
    rows: transactions.length,
    checked,
    passed: checked - failed,
    failed,
    failedRows,
    openingBalance: opening,
    closingBalance,
    printedClosing,
    closingMatches,
    serialComplete,
    verified: transactions.length > 0
      && failed === 0
      && checked >= transactions.length - 1
      && closingMatches !== false
      && serialComplete !== false
      && transactions.every(txn => txn.debit != null || txn.credit != null),
  };
}

/** Oldest first. Statements printed newest-first are reversed; same-day order is kept. */
export function chronological<T extends { date: string }>(rows: T[]): T[] {
  if (rows.length > 1 && rows[0].date > rows[rows.length - 1].date) return [...rows].reverse();
  return rows;
}
