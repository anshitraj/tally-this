/**
 * Run-scoped bank ↔ tally comparison.
 * Deterministic scoring. AI is not used to decide a match.
 */
import { calculateConfidenceScore, calculateDateDistance, calculateNameSimilarity, normalizeName } from "./matchingEngine";
import { normalizeAmount, normalizeDate, parseCsvLine } from "./bankStatement";
import type { NormalizedBankTxn } from "./bankStatement";

export type ReviewStatus = "suggested" | "approved" | "rejected" | "needs_info" | "document_requested" | "resolved";

export interface TallyRow {
  id: string;
  date: string;
  ledgerName: string;
  voucherNumber: string | null;
  debit: number | null;
  credit: number | null;
  narration: string;
  rowNumber: number;
}

export interface CompareItem {
  key: string;
  bucket: "confirmed" | "suggested" | "bank_only" | "tally_only" | "amount_difference" | "duplicate";
  status: ReviewStatus;
  confidence: number;
  why: string[];
  bank?: NormalizedBankTxn;
  tally?: TallyRow;
}

export interface CompareResult {
  counts: {
    bank: number;
    tally: number;
    confirmed: number;
    suggested: number;
    bankOnly: number;
    tallyOnly: number;
    amountDifferences: number;
    duplicates: number;
  };
  items: CompareItem[];
}

function headerIndex(headers: string[], aliases: string[]) {
  const normalized = headers.map(header => header.toLowerCase());
  return normalized.findIndex(header => aliases.some(alias => header.includes(alias)));
}

export function parseTallyLedgerCsv(text: string): TallyRow[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let headerAt = 0;
  for (let i = 0; i < Math.min(lines.length, 15); i += 1) {
    const cells = parseCsvLine(lines[i]).map(cell => cell.toLowerCase());
    if (cells.some(cell => cell.includes("date")) && cells.some(cell => cell.includes("debit") || cell.includes("particular"))) {
      headerAt = i;
      break;
    }
  }
  const headers = parseCsvLine(lines[headerAt]);
  const dateIdx = headerIndex(headers, ["date"]);
  const ledgerIdx = headerIndex(headers, ["particular", "ledger", "account"]);
  const voucherIdx = headerIndex(headers, ["vch no", "voucher"]);
  const debitIdx = headerIndex(headers, ["debit"]);
  const creditIdx = headerIndex(headers, ["credit"]);
  const narrationIdx = headerIndex(headers, ["narration", "description"]);
  const rows: TallyRow[] = [];
  for (let i = headerAt + 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const date = normalizeDate(cells[dateIdx] ?? "");
    const ledgerName = (cells[ledgerIdx] ?? "").trim();
    if (!date || !ledgerName) continue;
    const debit = normalizeAmount(cells[debitIdx] ?? "");
    const credit = normalizeAmount(cells[creditIdx] ?? "");
    if ((debit == null || debit === 0) && (credit == null || credit === 0)) continue;
    rows.push({
      id: `tally-${i + 1}`,
      date,
      ledgerName,
      voucherNumber: (cells[voucherIdx] ?? "").trim() || null,
      debit: debit && debit !== 0 ? Math.abs(debit) : null,
      credit: credit && credit !== 0 ? Math.abs(credit) : null,
      narration: (cells[narrationIdx] ?? "").trim(),
      rowNumber: i + 1,
    });
  }
  return rows;
}

function amountOf(debit: number | null | undefined, credit: number | null | undefined) {
  return debit ?? credit ?? 0;
}

function direction(debit: number | null | undefined, credit: number | null | undefined) {
  if (debit && debit > 0) return "debit";
  if (credit && credit > 0) return "credit";
  return "unknown";
}

/**
 * A Tally bank-ledger export shows money received as Debit; a party or day-book view
 * shows it as Credit. Pick the convention that agrees with the bank on most same-day,
 * same-amount pairs, so direction is compared like for like.
 */
function alignTallyDirection(bank: NormalizedBankTxn[], tally: TallyRow[]): TallyRow[] {
  let same = 0;
  let opposite = 0;
  for (const txn of bank) {
    const amount = amountOf(txn.debit, txn.credit);
    const bankDir = direction(txn.debit, txn.credit);
    for (const row of tally) {
      if (Math.abs(amountOf(row.debit, row.credit) - amount) > 1 || calculateDateDistance(txn.date, row.date) > 1) continue;
      if (direction(row.debit, row.credit) === bankDir) same += 1;
      else opposite += 1;
    }
  }
  if (opposite <= same) return tally;
  return tally.map(row => ({ ...row, debit: row.credit, credit: row.debit }));
}

/** Uniqueness reduces ambiguity; it does not prove two entries are the same payment. */
function isUniquePair(txn: NormalizedBankTxn, row: TallyRow, bank: NormalizedBankTxn[], tally: TallyRow[]) {
  const amount = amountOf(txn.debit, txn.credit);
  const near = (a: string, b: string) => calculateDateDistance(a, b) <= 7;
  const tallyCandidates = tally.filter(other => Math.abs(amountOf(other.debit, other.credit) - amount) <= 1 && near(other.date, txn.date));
  const bankCandidates = bank.filter(other => Math.abs(amountOf(other.debit, other.credit) - amount) <= 1 && near(other.date, row.date));
  return tallyCandidates.length === 1 && bankCandidates.length === 1;
}

function containsReference(text: string, reference: string | null | undefined) {
  const value = reference?.trim().toUpperCase() ?? "";
  // Short voucher numbers and partial substrings are not reliable shared evidence.
  if (value.replace(/[^A-Z0-9]/g, "").length < 6 || !/\d/.test(value)) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z0-9])${escaped}(?=$|[^A-Z0-9])`).test(text.toUpperCase());
}

export function compareBankWithTally(bank: NormalizedBankTxn[], rawTally: TallyRow[]): CompareResult {
  const tally = alignTallyDirection(bank, rawTally);
  const usedTally = new Set<string>();
  const items: CompareItem[] = [];
  const seenBank = new Map<string, string>();

  bank.forEach(txn => {
    const dupKey = `${direction(txn.debit, txn.credit)}:${amountOf(txn.debit, txn.credit)}:${normalizeName(txn.narration).slice(0, 28)}`;
    const previous = seenBank.get(dupKey);
    if (previous && calculateDateDistance(previous, txn.date) <= 7) {
      items.push({
        key: `dup-${txn.rowNumber}`,
        bucket: "duplicate",
        status: "suggested",
        confidence: 72,
        why: ["Possible duplicate: same amount and similar narration within 7 days."],
        bank: txn,
      });
    }
    seenBank.set(dupKey, txn.date);

    let best: { row: TallyRow; score: number; amountMatches: boolean; dateDistance: number; nameSimilarity: number; referenceMatches: boolean } | null = null;
    for (const row of tally) {
      if (usedTally.has(row.id)) continue;
      const bankAmount = amountOf(txn.debit, txn.credit);
      const tallyAmount = amountOf(row.debit, row.credit);
      const amountMatches = Math.abs(bankAmount - tallyAmount) <= 1;
      const dateDistance = calculateDateDistance(txn.date, row.date);
      const nameSimilarity = Math.max(
        calculateNameSimilarity(txn.narration, row.ledgerName),
        calculateNameSimilarity(txn.counterparty ?? "", row.ledgerName),
        calculateNameSimilarity(txn.narration, row.narration),
      );
      const referenceMatches = containsReference(row.narration, txn.reference)
        || containsReference(txn.narration, row.voucherNumber);
      const score = calculateConfidenceScore({
        amountMatches,
        dateDistance,
        nameSimilarity,
        referenceMatches,
        sourceConsistent: direction(txn.debit, txn.credit) === direction(row.debit, row.credit),
      });
      if (!best || score > best.score) best = { row, score, amountMatches, dateDistance, nameSimilarity, referenceMatches };
    }

    if (!best || (best.score < 55 && best.amountMatches)) {
      items.push({
        key: `bank-${txn.rowNumber}`,
        bucket: "bank_only",
        status: "needs_info",
        confidence: best?.score ?? 0,
        why: ["No Tally row matched this bank entry."],
        bank: txn,
      });
      return;
    }

    if (!best.amountMatches && best.nameSimilarity >= 40 && best.dateDistance <= 5) {
      usedTally.add(best.row.id);
      items.push({
        key: `amt-${txn.rowNumber}`,
        bucket: "amount_difference",
        status: "needs_info",
        confidence: best.score,
        why: ["Party and date are close, but the amount differs.", "Potential risk — needs CA review."],
        bank: txn,
        tally: best.row,
      });
      return;
    }

    if (best.score < 55) {
      items.push({
        key: `bank-${txn.rowNumber}`,
        bucket: "bank_only",
        status: "needs_info",
        confidence: best.score,
        why: ["No Tally row scored high enough to suggest a match."],
        bank: txn,
      });
      return;
    }

    const sameDirection = direction(txn.debit, txn.credit) === direction(best.row.debit, best.row.credit);
    const exactAmount = Math.round(amountOf(txn.debit, txn.credit) * 100) === Math.round(amountOf(best.row.debit, best.row.credit) * 100);
    const unique = best.amountMatches && best.dateDistance <= 2 && sameDirection && isUniquePair(txn, best.row, bank, tally);
    const confirmed = exactAmount && sameDirection && best.dateDistance <= 2 && best.referenceMatches && unique;
    usedTally.add(best.row.id);
    const why = [
      exactAmount ? "Amount matches exactly" : best.amountMatches ? "Amounts are within the ₹1 review tolerance" : "Amount differs",
      `Name similarity ${best.nameSimilarity}%`,
      `Date distance ${best.dateDistance} day(s)`,
      best.referenceMatches ? "Reference or voucher found" : "No shared reference",
      ...(unique ? ["Only entry with this amount and date on both sides"] : []),
    ];
    items.push({
      key: `match-${txn.rowNumber}-${best.row.id}`,
      bucket: confirmed ? "confirmed" : "suggested",
      status: "suggested",
      confidence: best.score,
      why,
      bank: txn,
      tally: best.row,
    });
  });

  tally.forEach(row => {
    if (usedTally.has(row.id)) return;
    items.push({
      key: `tally-${row.rowNumber}`,
      bucket: "tally_only",
      status: "needs_info",
      confidence: 0,
      why: ["This Tally entry was not found in the bank statement."],
      tally: row,
    });
  });

  const count = (bucket: CompareItem["bucket"]) => items.filter(item => item.bucket === bucket).length;
  return {
    counts: {
      bank: bank.length,
      tally: tally.length,
      confirmed: count("confirmed"),
      suggested: count("suggested"),
      bankOnly: count("bank_only"),
      tallyOnly: count("tally_only"),
      amountDifferences: count("amount_difference"),
      duplicates: count("duplicate"),
    },
    items,
  };
}

export function applyDecision(items: CompareItem[], key: string, status: ReviewStatus) {
  return items.map(item => item.key === key ? { ...item, status } : item);
}
