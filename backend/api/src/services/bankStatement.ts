/**
 * Indian bank statement normalization.
 * Deterministic. Used by the Bank Statement → Tally job and the CSV parser fallback.
 */
import { detectBankFromStatement } from "./bankDirectory";

export interface NormalizedBankTxn {
  date: string;
  valueDate: string | null;
  description: string;
  narration: string;
  reference: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  counterparty: string | null;
  accountName: string | null;
  accountNumberMasked: string | null;
  bankName: string | null;
  rowNumber: number;
  confidence: number;
  sourceFile: string;
  sourcePage: number | null;
  sourceQuote: string;
}

export interface BankStatementSummary {
  status: "parsed" | "needs_review" | "failed";
  message: string;
  bankName: string | null;
  periodLabel: string | null;
  accountNumberMasked: string | null;
  transactions: NormalizedBankTxn[];
  openingBalance: number | null;
  closingBalance: number | null;
  debitTotal: number;
  creditTotal: number;
  lowConfidenceCount: number;
  detectedColumns: string[];
  warnings: string[];
}

const HEADER_WORDS = [
  "date", "txn date", "transaction date", "value date", "posting date",
  "narration", "particulars", "transaction remarks", "description", "transaction details",
  "debit", "withdrawal", "credit", "deposit", "balance", "reference", "utr", "chq", "cheque", "rrn",
  "invoice", "gstin", "taxable", "hsn", "order", "igst", "cgst", "sgst", "tcs",
];

const DATE_KEYS = ["date", "txn date", "transaction date", "value date", "posting date", "tran date"];
const NARRATION_KEYS = ["narration", "particulars", "transaction remarks", "description", "transaction details", "remarks", "details"];
const DEBIT_KEYS = ["debit", "debit amt", "debit amount", "withdrawal", "withdrawal amt", "withdrawal amt (inr)", "dr amount", "dr amt", "withdrawal (inr)"];
const CREDIT_KEYS = ["credit", "credit amt", "credit amount", "deposit", "deposit amt", "deposit amt (inr)", "cr amount", "cr amt", "deposit (inr)"];
const BALANCE_KEYS = ["balance", "closing balance", "running balance", "closing balance (inr)", "balance (inr)"];
const REF_KEYS = ["reference", "utr", "chq/ref no", "chq/ref no.", "cheque no", "chq no", "rrn", "transaction id", "ref no"];
const VALUE_DATE_KEYS = ["value date", "value dt"];


export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.map(cell => cell.replace(/^"|"$/g, "").trim());
}

function normKey(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[._]/g, " ").trim();
}

function headerScore(cells: string[]) {
  const filled = cells.filter(Boolean);
  if (filled.length < 3) return 0;
  const keys = filled.map(normKey);
  const hits = keys.filter(key => HEADER_WORDS.some(word => key.includes(word))).length;
  return hits >= 2 ? hits : 0;
}

export function scanCsvTable(text: string): { columns: string[]; rows: Record<string, string>[]; preamble: string[]; headerIndex: number } | null {
  const lines = text.split(/\r?\n/);
  let best = -1;
  let bestScore = 0;
  const parsed = lines.map(line => parseCsvLine(line));
  const limit = Math.min(parsed.length, 25);
  for (let i = 0; i < limit; i += 1) {
    const score = headerScore(parsed[i] ?? []);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0 || bestScore < 2) return null;
  const columns = (parsed[best] ?? []).map(cell => cell || "column");
  const rows: Record<string, string>[] = [];
  for (let i = best + 1; i < parsed.length; i += 1) {
    const cells = parsed[i] ?? [];
    if (cells.every(cell => !cell)) continue;
    const row: Record<string, string> = { _rowNumber: String(i + 1) };
    columns.forEach((column, index) => {
      row[column] = cells[index] ?? "";
    });
    rows.push(row);
  }
  return {
    columns: columns.filter(column => column !== "column" || columns.length < 3),
    rows,
    preamble: lines.slice(0, best).map(line => line.trim()).filter(Boolean),
    headerIndex: best,
  };
}

export function normalizeAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text || text === "-" || text === "—") return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/dr\b/i.test(text)) negative = true;
  text = text.replace(/₹|rs\.?|inr/gi, "").replace(/,/g, "").replace(/\s+/g, "");
  text = text.replace(/cr|dr/gi, "");
  if (!text || text === "-" || text === ".") return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  const signed = negative ? -Math.abs(value) : value;
  return Math.round(signed * 100) / 100;
}

const MONTHS: Record<string, string> = {
  jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
  apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07",
  aug: "08", august: "08", sep: "09", sept: "09", september: "09", oct: "10", october: "10",
  nov: "11", november: "11", dec: "12", december: "12",
};

export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = String(raw).trim();
  const valid = (year: string, month: string, day: string) => {
    const yyyy = Number(year);
    const mm = Number(month);
    const dd = Number(day);
    const actual = new Date(Date.UTC(yyyy, mm - 1, dd));
    return yyyy >= 1900 && yyyy <= 2100 && actual.getUTCFullYear() === yyyy && actual.getUTCMonth() === mm - 1 && actual.getUTCDate() === dd
      ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
      : null;
  };
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return valid(iso[1], iso[2], iso[3]);
  const dmy = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return valid(year, dmy[2], dmy[1]);
  }
  // "31 Mar 2026", "03-Apr-2025", "03-Apr-25", "3 April, 2026"
  const named = text.match(/^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.,]+(\d{4}|\d{2})\b/);
  if (named) {
    const month = MONTHS[named[2].toLowerCase()];
    const year = named[3].length === 2 ? `20${named[3]}` : named[3];
    if (month) return valid(year, month, named[1]);
  }
  // "Mar 31, 2026"
  const us = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (us) {
    const month = MONTHS[us[1].toLowerCase()];
    if (month) return valid(us[3], month, us[2]);
  }
  return null;
}

function pick(row: Record<string, string>, keys: string[]) {
  const entries = Object.entries(row).filter(([key]) => key !== "_rowNumber");
  for (const key of keys) {
    const found = entries.find(([header]) => normKey(header) === key || normKey(header).includes(key));
    if (found && found[1].trim()) return found[1].trim();
  }
  return "";
}

/** Official bank name from the header block; see bankDirectory for the order of signals. */
function detectBank(preamble: string[], fileName: string) {
  return detectBankFromStatement(preamble.join("\n"), fileName)?.name ?? null;
}

function detectAccount(preamble: string[]) {
  const blob = preamble.join(" ");
  const match = blob.match(/(?:account|a\/c|acct)[^\d]*([Xx*\d]{4,})/i);
  return match?.[1] ?? null;
}

function detectPeriod(preamble: string[], dates: string[]) {
  const labeled = preamble.join(" ").match(/period\s*[:\-]?\s*([A-Za-z]+\s+\d{4})/i);
  if (labeled) return labeled[1];
  if (dates.length === 0) return null;
  const sorted = [...dates].sort();
  const start = sorted[0];
  const end = sorted[sorted.length - 1];
  return start === end ? start : `${start} to ${end}`;
}

// Payment-rail and direction words that prefix Indian bank narrations: "NEFT CR-", "UPI/DR/", "ATM WDL".
const NARRATION_PREFIX = /^(?:(?:upi|neft|imps|rtgs|nach|ecs|ach|atm|pos|inb|bil|trf|to|by|from|cr|dr|wdl|cash|txn|ref)\b[\s\-/:.]*)+/i;

/** Words that describe the payment, not who it was with. */
const NARRATION_STOP_WORDS = new Set([
  "upi", "neft", "imps", "imp", "rtgs", "nach", "ecs", "ach", "pos", "visa", "rupay", "mastercard", "txn", "tran", "trf",
  "transfer", "to", "by", "from", "at", "in", "of", "for", "the", "dr", "cr", "debit", "credit", "card", "payment", "paid",
  "pay", "sent", "received", "using", "ph", "payt", "mb", "ib", "inb", "bil", "ref", "no", "p2a", "p2m", "collect",
  "request", "pcd", "ecom", "purchase", "com", "mmt", "a/c", "ac", "pg", "online", "fund", "funds", "money",
]);

/** Four-letter bank codes that appear as their own segment ("UPI/123/DR/ZEPT/KKBK/..."). */
const BANK_CODES = /^(hdfc|icic|sbin|utib|kkbk|indb|yesb|idfb|punb|barb|cnrb|ubin|bkid|mahb|cbin|ioba|idib|ucba|psib|fdrl|ratn|dcbl|bdbl|aubl|ibkl|kvbl|karb|sibl|citi|hsbc|scbl|dbss|pytm|airp|ipos|jsfb|esfb|ujvn)$/i;

function cleanSegment(segment: string) {
  return segment
    .split(/\s+/)
    .filter(word => word && !/\d/.test(word) && !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(word))
    .join(" ")
    .replace(/^[:.\-\s]+|[:.\-\s]+$/g, "")
    .trim();
}

function segmentScore(segment: string) {
  const words = segment.split(/\s+/).filter(word => /[a-z]{2,}/i.test(word) && !NARRATION_STOP_WORDS.has(word.toLowerCase()));
  if (words.length === 0) return 0;
  if (words.length === 1 && BANK_CODES.test(words[0])) return 0;
  const letters = words.join("").replace(/[^a-z]/gi, "").length;
  return letters + (words.length >= 2 ? 3 : 0);
}

/**
 * The other party in an Indian bank narration, so rows from the same party group together.
 * Handles "UPI/NAME/REF/NOTE", "UPI REF vpa@bank NAME", "N/REF/BANK/NAME", "IMP-REF-PHONE-NAME".
 */
export function counterpartyFrom(narration: string) {
  if (/\batm\b|cash wdl|cash withdrawal/i.test(narration)) return "Cash withdrawal";
  // Quarterly interest lines differ only by dates; they belong together.
  if (/\bint\.?\s*(pd|paid|cr|credit)\b|credit interest|interest (paid|credit)|\bsb\s*int\b/i.test(narration)) return "Bank interest";
  if (/\bfd\b|fixed deposit|term deposit/i.test(narration)) return "Fixed deposit";
  const cleaned = narration.replace(NARRATION_PREFIX, "");
  const segments: string[] = [];
  let vpa: string | null = null;
  for (const part of cleaned.split(/[\/|]+|(?<=\S)-(?=\S)|\s+-\s+/)) {
    const found = part.match(/\S+@\S+/);
    if (found) {
      vpa ??= found[0];
      segments.push(part.slice(0, found.index), part.slice((found.index ?? 0) + found[0].length));
    } else {
      segments.push(part);
    }
  }
  let best: { text: string; score: number } | null = null;
  for (const segment of segments) {
    const text = cleanSegment(segment);
    const score = segmentScore(text);
    if (score >= 2 && (!best || score > best.score)) best = { text, score };
  }
  if (best) {
    const words = best.text.split(/\s+/).filter(word => !NARRATION_STOP_WORDS.has(word.toLowerCase()));
    return (words.join(" ") || best.text).slice(0, 80);
  }
  if (vpa) {
    const handle = vpa.split("@")[0].replace(/[\d._-]+/g, " ").trim();
    if (handle.length >= 3) return handle.slice(0, 80);
  }
  return null;
}

/**
 * Banks cut names to fit a column ("Brijesh Brij", "Brijesh Brije"). A name that is the start
 * of a longer one, and most of its length, is the same party; both take the longer name.
 */
export function unifyParties(transactions: NormalizedBankTxn[]) {
  const compact = (name: string) => name.toLowerCase().replace(/[^a-z]/g, "");
  const names = [...new Set(transactions.map(txn => txn.counterparty).filter((name): name is string => Boolean(name)))]
    .sort((a, b) => compact(b).length - compact(a).length);
  const canonical = new Map<string, string>();
  for (const name of names) {
    const short = compact(name);
    const longer = short.length >= 5
      ? names.find(other => other !== name && !canonical.has(other) && compact(other).startsWith(short) && short.length >= 0.6 * compact(other).length)
      : undefined;
    if (longer) canonical.set(name, longer);
  }
  for (const txn of transactions) {
    if (txn.counterparty && canonical.has(txn.counterparty)) txn.counterparty = canonical.get(txn.counterparty)!;
  }
  return transactions;
}

function almost(a: number, b: number) {
  return Math.abs(a - b) < 0.02;
}

export function parseBankStatement(text: string, fileName = "statement.csv"): BankStatementSummary {
  const scanned = scanCsvTable(text);
  if (!scanned) {
    const hasText = text.trim().length > 40;
    return {
      status: "failed",
      message: hasText
        ? "PDF text was extracted, but reliable table rows were not detected."
        : "This document appears to be scanned. OCR/AI extraction is required.",
      bankName: detectBank(text.split(/\r?\n/).slice(0, 8), fileName),
      periodLabel: null,
      accountNumberMasked: null,
      transactions: [],
      openingBalance: null,
      closingBalance: null,
      debitTotal: 0,
      creditTotal: 0,
      lowConfidenceCount: 0,
      detectedColumns: [],
      warnings: ["No Date / Narration / Debit / Credit header row was found."],
    };
  }

  const bankName = detectBank(scanned.preamble, fileName);
  const accountNumberMasked = detectAccount(scanned.preamble);
  const warnings: string[] = [];
  const transactions: NormalizedBankTxn[] = [];
  let unreadableDatedRows = 0;
  let invalidDateRows = 0;
  let previousBalance: number | null = null;

  scanned.rows.forEach((row, index) => {
    const narration = pick(row, NARRATION_KEYS);
    const lower = narration.toLowerCase();
    if (/^(opening balance|closing balance|total|brought forward|carried forward)$/.test(lower)) return;
    const rawDate = pick(row, DATE_KEYS);
    const date = normalizeDate(rawDate);
    if (!date) {
      if (rawDate && narration.trim()) invalidDateRows += 1;
      return;
    }

    let debit = normalizeAmount(pick(row, DEBIT_KEYS));
    let credit = normalizeAmount(pick(row, CREDIT_KEYS));
    let balance = normalizeAmount(pick(row, BALANCE_KEYS));
    let repaired = false;

    if (debit != null && credit != null && previousBalance != null && balance == null) {
      if (almost(previousBalance + debit, credit)) {
        balance = credit;
        credit = debit;
        debit = null;
        repaired = true;
      } else if (almost(previousBalance - debit, credit)) {
        balance = credit;
        credit = null;
        repaired = true;
      }
    }

    if ((debit == null || debit === 0) && (credit == null || credit === 0)) {
      const signed = normalizeAmount(row.Amount || row.amount || "");
      if (signed != null && signed !== 0) {
        if (signed < 0) debit = Math.abs(signed);
        else credit = signed;
      }
    }

    if ((debit == null || debit === 0) && (credit == null || credit === 0)) {
      // A dated table row may be a real transaction in an unfamiliar bank format.
      // Never silently omit it and present an incomplete export as successful.
      if (narration.trim()) unreadableDatedRows += 1;
      return;
    }
    if (debit === 0) debit = null;
    if (credit === 0) credit = null;
    if (balance != null) previousBalance = balance;

    const reference = pick(row, REF_KEYS) || null;
    const quote = Object.values(row).filter(value => value && value !== row._rowNumber).join(" | ");
    const confidence = date && narration && (debit || credit) && !repaired ? 0.95 : 0.72;
    transactions.push({
      date,
      valueDate: normalizeDate(pick(row, VALUE_DATE_KEYS)),
      description: narration,
      narration,
      reference,
      debit,
      credit,
      balance,
      counterparty: counterpartyFrom(narration),
      accountName: bankName,
      accountNumberMasked,
      bankName,
      rowNumber: Number(row._rowNumber) || index + 1,
      confidence,
      sourceFile: fileName,
      sourcePage: null,
      sourceQuote: quote.slice(0, 500),
    });
  });

  if (unreadableDatedRows > 0 || invalidDateRows > 0) {
    const reasons = [
      unreadableDatedRows > 0 ? `${unreadableDatedRows} dated ${unreadableDatedRows === 1 ? "row has" : "rows have"} no readable paid or received amount` : "",
      invalidDateRows > 0 ? `${invalidDateRows} ${invalidDateRows === 1 ? "row has" : "rows have"} an unreadable or invalid date` : "",
    ].filter(Boolean);
    return {
      status: "failed",
      message: `The statement cannot be exported: ${reasons.join("; ")}. Try another bank export format so no transactions are left out.`,
      bankName,
      periodLabel: detectPeriod(scanned.preamble, transactions.map(txn => txn.date)),
      accountNumberMasked,
      transactions: [],
      openingBalance: null,
      closingBalance: null,
      debitTotal: 0,
      creditTotal: 0,
      lowConfidenceCount: 0,
      detectedColumns: scanned.columns,
      warnings: ["A statement row could not be read; export was stopped."],
    };
  }

  if (transactions.length === 0) {
    return {
      status: "failed",
      message: "PDF text was extracted, but reliable table rows were not detected.",
      bankName,
      periodLabel: detectPeriod(scanned.preamble, []),
      accountNumberMasked,
      transactions: [],
      openingBalance: null,
      closingBalance: null,
      debitTotal: 0,
      creditTotal: 0,
      lowConfidenceCount: 0,
      detectedColumns: scanned.columns,
      warnings: ["A header was found, but no debit or credit amounts could be read."],
    };
  }

  const flipped = repairDirectionsFromBalance(transactions);
  if (flipped > 0) warnings.push(`${flipped} row(s) were set to money in or money out using the running balance.`);
  const debitTotal = round2(transactions.reduce((sum, txn) => sum + (txn.debit ?? 0), 0));
  const creditTotal = round2(transactions.reduce((sum, txn) => sum + (txn.credit ?? 0), 0));
  const first = transactions[0];
  const last = transactions[transactions.length - 1];
  const openingBalance = first.balance == null
    ? null
    : round2(first.balance - (first.credit ?? 0) + (first.debit ?? 0));
  const breaks = markBalanceBreaks(transactions);
  if (breaks > 0) warnings.push(`${breaks} row(s) do not continue the running balance. Check them against the statement.`);
  const lowConfidenceCount = transactions.filter(txn => txn.confidence < 0.9).length;
  if (lowConfidenceCount > 0) warnings.push(`${lowConfidenceCount} row(s) need a quick review before export.`);

  return {
    status: lowConfidenceCount > 0 ? "needs_review" : "parsed",
    message: `Parsed successfully. ${transactions.length} transactions detected.`,
    bankName,
    periodLabel: detectPeriod(scanned.preamble, transactions.map(txn => txn.date)),
    accountNumberMasked,
    transactions,
    openingBalance,
    closingBalance: last.balance,
    debitTotal,
    creditTotal,
    lowConfidenceCount,
    detectedColumns: scanned.columns,
    warnings,
  };
}

export function extractionFailureMessage(input: { textLength: number; rowCount: number; parser: string }) {
  if (input.rowCount > 0) return null;
  if (input.parser === "pdf" && input.textLength < 40) {
    return "This document appears to be scanned. OCR/AI extraction is required.";
  }
  if (input.parser === "pdf" || input.parser === "image") {
    return input.textLength > 40
      ? "PDF text was extracted, but reliable table rows were not detected."
      : "This document appears to be scanned. OCR/AI extraction is required.";
  }
  return "No reliable table rows were detected. Check the file and try CSV or Excel.";
}

/**
 * PDF tables often lose which column an amount sat in. The running balance says it:
 * a rise is money in, a fall is money out. A row is re-labelled only when the balance
 * moved by exactly that row's amount. The earliest row has nothing to compare with,
 * so after any repair it is sent to review.
 */
function repairDirectionsFromBalance(transactions: NormalizedBankTxn[]) {
  const rows = transactions.filter(txn => txn.balance != null);
  if (rows.length < 3) return 0;
  const amount = (txn: NormalizedBankTxn) => txn.debit ?? txn.credit ?? 0;
  const fits = (ordered: NormalizedBankTxn[]) => {
    let count = 0;
    for (let i = 1; i < ordered.length; i += 1) {
      if (almost(Math.abs((ordered[i].balance as number) - (ordered[i - 1].balance as number)), amount(ordered[i]))) count += 1;
    }
    return count;
  };
  const reversed = [...rows].reverse();
  const chronological = fits(reversed) > fits(rows) ? reversed : rows;
  let fixed = 0;
  for (let i = 1; i < chronological.length; i += 1) {
    const row = chronological[i];
    const value = amount(row);
    const delta = (row.balance as number) - (chronological[i - 1].balance as number);
    if (value === 0 || !almost(Math.abs(delta), value)) continue;
    if (delta > 0 && row.credit == null) {
      row.credit = value;
      row.debit = null;
      fixed += 1;
    } else if (delta < 0 && row.debit == null) {
      row.debit = value;
      row.credit = null;
      fixed += 1;
    }
  }
  if (fixed > 0) chronological[0].confidence = Math.min(chronological[0].confidence, 0.7);
  return fixed;
}

/** Fills bank, account and period from page text when the table rows came without a header block. */
export function applyStatementMeta(summary: BankStatementSummary, text: string, fileName: string) {
  const lines = text.split(/\r?\n/).slice(0, 15);
  summary.bankName = summary.bankName ?? detectBank(lines, fileName);
  summary.accountNumberMasked = summary.accountNumberMasked ?? detectAccount(lines);
  const labeled = lines.join(" ").match(/period\s*[:\-]?\s*([A-Za-z]+\s+\d{4})/i);
  if (labeled) summary.periodLabel = labeled[1];
  summary.transactions.forEach(txn => {
    txn.bankName = txn.bankName ?? summary.bankName;
    txn.accountName = txn.accountName ?? summary.bankName;
    txn.accountNumberMasked = txn.accountNumberMasked ?? summary.accountNumberMasked;
  });
  return summary;
}

/**
 * Running balance must move by exactly the debit or credit on each row.
 * Statements may be printed newest-first, so both directions are checked.
 * Rows that break the chain are lowered to review confidence.
 */
function markBalanceBreaks(transactions: NormalizedBankTxn[]) {
  const withBalance = transactions.filter(txn => txn.balance != null);
  if (withBalance.length < 3) return 0;
  const breaksIn = (rows: NormalizedBankTxn[]) => {
    const bad: NormalizedBankTxn[] = [];
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1].balance as number;
      const row = rows[i];
      const expected = prev + (row.credit ?? 0) - (row.debit ?? 0);
      if (!almost(expected, row.balance as number)) bad.push(row);
    }
    return bad;
  };
  const forward = breaksIn(withBalance);
  const backward = breaksIn([...withBalance].reverse());
  const bad = backward.length < forward.length ? backward : forward;
  // Balances that never chain usually mean a different column layout, not bad rows.
  if (bad.length > withBalance.length / 2) return 0;
  bad.forEach(txn => { txn.confidence = Math.min(txn.confidence, 0.7); });
  return bad.length;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}
