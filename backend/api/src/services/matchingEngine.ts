export interface MatchBankTransaction {
  id: number;
  date: string;
  narration: string;
  amount: string | number;
  type: string;
  source?: string | null;
  reference?: string | null;
  status?: string | null;
  confidenceScore?: number | null;
}

export interface MatchInvoice {
  id: number;
  invoiceNumber: string;
  vendorName: string;
  customerName?: string | null;
  gstin?: string | null;
  date: string;
  amount: string | number;
  gstAmount?: string | number | null;
  type?: string | null;
  status?: string | null;
}

export interface MatchLedgerEntry {
  id: number;
  date: string;
  ledgerName: string;
  voucherNumber?: string | null;
  amount: string | number;
  debitCredit: string;
  sourceTool?: string | null;
  status?: string | null;
}

export interface MatchPayrollEntry {
  id: number;
  employeeName: string;
  month: string;
  netAmount: string | number;
  paymentDate?: string | null;
  bankReference?: string | null;
  status?: string | null;
}

export interface MatchGatewaySettlement {
  id: number;
  provider: string;
  settlementId: string;
  grossAmount: string | number;
  fees: string | number;
  gstOnFees?: string | number | null;
  netAmount: string | number;
  settlementDate: string;
  bankReference?: string | null;
  status?: string | null;
}

export interface ReconciliationSuggestion {
  bankTransactionId?: number;
  invoiceId?: number;
  ledgerEntryId?: number;
  matchType: string;
  confidenceScore: number;
  reason: string;
  status: "pending" | "approved";
}

export interface GeneratedRiskFlag {
  entityType: string;
  entityId?: number;
  category: string;
  severity: "low" | "medium" | "high";
  reason: string;
  suggestedAction: string;
  status: "open";
}

const COMPANY_SUFFIXES = [
  "pvt ltd",
  "private limited",
  "ltd",
  "llp",
  "inc",
  "technologies",
  "technology",
  "solutions",
  "enterprises",
  "india",
  "corp",
  "corporation",
];

function amount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number.parseFloat(value);
}

export function normalizeName(name: string): string {
  let normalized = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  for (const suffix of COMPANY_SUFFIXES) {
    normalized = normalized.replace(new RegExp(`\\b${suffix}\\b`, "g"), " ");
  }
  return normalized.replace(/\s+/g, " ").trim();
}

export function extractReferences(narration: string): string[] {
  const patterns = [
    /\bUTR[A-Z0-9-]*\d+\b/gi,
    /\bRRN[A-Z0-9-]*\d+\b/gi,
    /\bNEFT[A-Z0-9-]*\d+\b/gi,
    /\bRTGS[A-Z0-9-]*\d+\b/gi,
    /\bIMPS[A-Z0-9-]*\d+\b/gi,
    /\bUPI[A-Z0-9-]*\d+\b/gi,
    /\bINV[-/]?[A-Z0-9-]*\d+\b/gi,
    /\b[A-Z]{2,5}[-/]?STL[-/]?\d+\b/gi,
    /\b[A-Z]{2,6}[-/]\d{4}[-/]\d{2,}\b/gi,
  ];
  return [...new Set(patterns.flatMap((pattern) => narration.match(pattern) ?? []).map((ref) => ref.toUpperCase()))];
}

export function calculateNameSimilarity(a: string, b: string): number {
  const left = new Set(normalizeName(a).split(" ").filter(Boolean));
  const right = new Set(normalizeName(b).split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return Math.round((intersection / union) * 100);
}

export function calculateDateDistance(dateA: string, dateB: string): number {
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 999;
  return Math.abs(Math.round((a - b) / 86400000));
}

export function calculateConfidenceScore(input: {
  amountMatches: boolean;
  dateDistance: number;
  nameSimilarity: number;
  referenceMatches: boolean;
  sourceConsistent: boolean;
}): number {
  let score = 0;
  if (input.amountMatches) score += 35;
  if (input.dateDistance <= 1) score += 15;
  else if (input.dateDistance <= 3) score += 10;
  else if (input.dateDistance <= 7) score += 5;
  score += Math.round(Math.min(input.nameSimilarity, 100) * 0.2);
  if (input.referenceMatches) score += 20;
  if (input.sourceConsistent) score += 10;
  return Math.min(score, 100);
}

function statusFromScore(score: number): string {
  if (score >= 85) return "exact";
  if (score >= 60) return "potential";
  return "unverified";
}

export function matchBankToInvoices(bankTransactions: MatchBankTransaction[], invoices: MatchInvoice[]): ReconciliationSuggestion[] {
  const suggestions: ReconciliationSuggestion[] = [];
  for (const txn of bankTransactions) {
    let best: ReconciliationSuggestion | null = null;
    const refs = extractReferences(`${txn.narration} ${txn.reference ?? ""}`);
    for (const invoice of invoices) {
      const parties = [invoice.vendorName, invoice.customerName].filter(Boolean).join(" ");
      const referenceMatches = refs.includes(invoice.invoiceNumber.toUpperCase()) || txn.narration.toUpperCase().includes(invoice.invoiceNumber.toUpperCase());
      const score = calculateConfidenceScore({
        amountMatches: Math.abs(amount(txn.amount) - amount(invoice.amount)) <= 1,
        dateDistance: calculateDateDistance(txn.date, invoice.date),
        nameSimilarity: calculateNameSimilarity(txn.narration, parties),
        referenceMatches,
        sourceConsistent: txn.type === (invoice.type === "sales" ? "credit" : "debit"),
      });
      if (!best || score > best.confidenceScore) {
        best = {
          bankTransactionId: txn.id,
          invoiceId: invoice.id,
          matchType: statusFromScore(score),
          confidenceScore: score,
          reason: `Invoice ${invoice.invoiceNumber}: amount ${Math.abs(amount(txn.amount) - amount(invoice.amount)) <= 1 ? "matches" : "differs"}, date distance ${calculateDateDistance(txn.date, invoice.date)} days, name similarity ${calculateNameSimilarity(txn.narration, parties)}%.`,
          status: "pending",
        };
      }
    }
    if (best && best.confidenceScore >= 45) suggestions.push(best);
  }
  return suggestions;
}

export function matchBankToLedger(bankTransactions: MatchBankTransaction[], ledgerEntries: MatchLedgerEntry[]): ReconciliationSuggestion[] {
  return bankTransactions.flatMap((txn) => {
    const best = ledgerEntries
      .map((entry) => {
        const score = calculateConfidenceScore({
          amountMatches: Math.abs(amount(txn.amount) - amount(entry.amount)) <= 1,
          dateDistance: calculateDateDistance(txn.date, entry.date),
          nameSimilarity: calculateNameSimilarity(txn.narration, entry.ledgerName),
          referenceMatches: Boolean(entry.voucherNumber && txn.narration.toUpperCase().includes(entry.voucherNumber.toUpperCase())),
          sourceConsistent: txn.type === (entry.debitCredit === "credit" ? "credit" : "debit"),
        });
        return { entry, score };
      })
      .sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < 55) return [];
    return [{
      bankTransactionId: txn.id,
      ledgerEntryId: best.entry.id,
      matchType: best.score >= 85 ? "ledger_match" : "potential_ledger_match",
      confidenceScore: best.score,
      reason: `Ledger ${best.entry.ledgerName}: rules-first match with amount/date/name/reference scoring.`,
      status: "pending" as const,
    }];
  });
}

export function detectDuplicates(transactions: MatchBankTransaction[], invoices: MatchInvoice[]): ReconciliationSuggestion[] {
  const suggestions: ReconciliationSuggestion[] = [];
  const seen = new Map<string, MatchBankTransaction>();
  for (const txn of transactions) {
    const key = `${txn.type}:${amount(txn.amount)}:${normalizeName(txn.narration).slice(0, 28)}`;
    const previous = seen.get(key);
    if (previous && calculateDateDistance(previous.date, txn.date) <= 7) {
      suggestions.push({
        bankTransactionId: txn.id,
        matchType: "duplicate",
        confidenceScore: 72,
        reason: `Possible duplicate of transaction #${previous.id}: same amount and similar narration within 7 days.`,
        status: "pending",
      });
    }
    seen.set(key, txn);
  }

  const invoiceNumbers = new Set<string>();
  for (const invoice of invoices) {
    const key = invoice.invoiceNumber.toUpperCase();
    if (invoiceNumbers.has(key)) {
      suggestions.push({
        invoiceId: invoice.id,
        matchType: "duplicate_invoice",
        confidenceScore: 80,
        reason: `Duplicate invoice number ${invoice.invoiceNumber} detected.`,
        status: "pending",
      });
    }
    invoiceNumbers.add(key);
  }
  return suggestions;
}

export function detectPartialPayments(transactions: MatchBankTransaction[], invoices: MatchInvoice[]): ReconciliationSuggestion[] {
  return matchBankToInvoices(transactions, invoices)
    .filter((match) => match.confidenceScore >= 45 && match.confidenceScore < 85)
    .map((match) => ({ ...match, matchType: "partial_payment", reason: `${match.reason} Possible partial payment - needs CA review.` }));
}

export function detectSplitPayments(transactions: MatchBankTransaction[], invoices: MatchInvoice[]): ReconciliationSuggestion[] {
  const suggestions: ReconciliationSuggestion[] = [];
  for (const invoice of invoices) {
    const nearby = transactions.filter((txn) => txn.type === (invoice.type === "sales" ? "credit" : "debit") && calculateDateDistance(txn.date, invoice.date) <= 7);
    const total = nearby.reduce((sum, txn) => sum + amount(txn.amount), 0);
    if (nearby.length > 1 && Math.abs(total - amount(invoice.amount)) <= 5) {
      suggestions.push({
        invoiceId: invoice.id,
        matchType: "split_payment",
        confidenceScore: 78,
        reason: `${nearby.length} nearby bank entries add up to invoice ${invoice.invoiceNumber}.`,
        status: "pending",
      });
    }
  }
  return suggestions;
}

export function detectGatewaySettlements(bankTransactions: MatchBankTransaction[], settlements: MatchGatewaySettlement[]): ReconciliationSuggestion[] {
  return settlements.flatMap((settlement) => {
    const match = bankTransactions.find((txn) => txn.type === "credit" && (
      Math.abs(amount(txn.amount) - amount(settlement.netAmount)) <= 1000 ||
      txn.narration.toUpperCase().includes(settlement.settlementId.toUpperCase()) ||
      (settlement.bankReference && txn.narration.toUpperCase().includes(settlement.bankReference.toUpperCase()))
    ));
    if (!match) return [];
    const confidenceScore = Math.abs(amount(match.amount) - amount(settlement.netAmount)) <= 1 ? 95 : 74;
    return [{
      bankTransactionId: match.id,
      matchType: confidenceScore >= 85 ? "gateway_settlement_match" : "gateway_settlement_mismatch",
      confidenceScore,
      reason: `${settlement.provider} settlement ${settlement.settlementId} compared with bank credit.`,
      status: "pending" as const,
    }];
  });
}

export function detectPayrollMatches(bankTransactions: MatchBankTransaction[], payrollEntries: MatchPayrollEntry[]): ReconciliationSuggestion[] {
  const payrollTotalByDate = new Map<string, number>();
  for (const entry of payrollEntries) {
    if (entry.paymentDate) payrollTotalByDate.set(entry.paymentDate, (payrollTotalByDate.get(entry.paymentDate) ?? 0) + amount(entry.netAmount));
  }
  return bankTransactions
    .filter((txn) => txn.type === "debit" && /salary|payroll|sal/i.test(txn.narration))
    .map((txn) => {
      const expected = payrollTotalByDate.get(txn.date) ?? 0;
      const confidenceScore = Math.abs(expected - amount(txn.amount)) <= 1 ? 98 : expected > 0 ? 68 : 40;
      return {
        bankTransactionId: txn.id,
        matchType: confidenceScore >= 85 ? "payroll_match" : "payroll_mismatch",
        confidenceScore,
        reason: expected > 0
          ? `Payroll register total INR ${expected.toLocaleString("en-IN")} compared with salary debit.`
          : "Salary debit found but no payroll-sheet total for that payment date.",
        status: "pending" as const,
      };
    });
}

export function generateRiskFlags(data: {
  transactions: MatchBankTransaction[];
  invoices: MatchInvoice[];
  ledgerEntries: MatchLedgerEntry[];
  payrollEntries: MatchPayrollEntry[];
  gatewaySettlements: MatchGatewaySettlement[];
}): GeneratedRiskFlag[] {
  const risks: GeneratedRiskFlag[] = [];
  const invoiceNumbers = new Set<string>();

  for (const txn of data.transactions) {
    if (txn.type === "debit" && (txn.status === "missing_invoice" || amount(txn.amount) >= 50000 && (txn.confidenceScore ?? 0) < 60)) {
      risks.push({
        entityType: "transaction",
        entityId: txn.id,
        category: amount(txn.amount) >= 50000 ? "High-value payment missing document" : "Vendor payment without invoice",
        severity: amount(txn.amount) >= 50000 ? "high" : "medium",
        reason: `Debit of INR ${amount(txn.amount).toLocaleString("en-IN")} has low document confidence.`,
        suggestedAction: "Potential risk — needs CA review. Attach invoice or supporting approval before close.",
        status: "open",
      });
    }
    if (/tds|contractor|freelancer|professional|advance/i.test(txn.narration) && !/tds/i.test(txn.narration)) {
      risks.push({
        entityType: "transaction",
        entityId: txn.id,
        category: "Possible TDS deduction",
        severity: "high",
        reason: "Payment narration suggests contractor/professional/advance context without a TDS note.",
        suggestedAction: "Potential risk — needs CA review. Confirm TDS applicability and documentation.",
        status: "open",
      });
    }
  }

  for (const invoice of data.invoices) {
    const number = invoice.invoiceNumber.toUpperCase();
    if (invoiceNumbers.has(number)) {
      risks.push({
        entityType: "invoice",
        entityId: invoice.id,
        category: "Duplicate invoice number",
        severity: "medium",
        reason: `Invoice number ${invoice.invoiceNumber} appears more than once.`,
        suggestedAction: "Potential risk — needs CA review. Verify whether this is a duplicate or revised invoice.",
        status: "open",
      });
    }
    invoiceNumbers.add(number);
    if (!invoice.gstin || invoice.gstin === "NOTAVAILABLE") {
      risks.push({
        entityType: "invoice",
        entityId: invoice.id,
        category: "Missing GSTIN",
        severity: "medium",
        reason: `Invoice ${invoice.invoiceNumber} is missing a usable GSTIN.`,
        suggestedAction: "Potential risk — needs CA review. Request a tax invoice or document the treatment.",
        status: "open",
      });
    }
    const expectedGst = Math.round((amount(invoice.amount) * 18 / 118) * 100) / 100;
    if (invoice.gstAmount && Math.abs(amount(invoice.gstAmount) - expectedGst) > 50) {
      risks.push({
        entityType: "invoice",
        entityId: invoice.id,
        category: "GST amount mismatch",
        severity: "medium",
        reason: `GST amount differs from the standard 18% inclusive estimate by more than INR 50.`,
        suggestedAction: "Potential risk — needs CA review. Check tax rate, place of supply, and invoice math.",
        status: "open",
      });
    }
  }

  for (const ledger of data.ledgerEntries) {
    if (/suspense|unmapped|missing/i.test(ledger.ledgerName) || ledger.status === "suspense") {
      risks.push({
        entityType: "ledger",
        entityId: ledger.id,
        category: "Suspense ledger",
        severity: "low",
        reason: `${ledger.ledgerName} needs a clearer accounting head.`,
        suggestedAction: "Potential risk — needs CA review. Remap to the correct ledger before handoff.",
        status: "open",
      });
    }
  }

  for (const entry of data.payrollEntries) {
    if (!entry.paymentDate || entry.status === "missing") {
      risks.push({
        entityType: "payroll",
        entityId: entry.id,
        category: "Payroll mismatch",
        severity: "low",
        reason: `${entry.employeeName} has no matched salary payout date/reference.`,
        suggestedAction: "Potential risk — needs CA review. Confirm payout or mark as payable.",
        status: "open",
      });
    }
  }

  for (const settlement of data.gatewaySettlements) {
    const computedNet = amount(settlement.grossAmount) - amount(settlement.fees) - amount(settlement.gstOnFees);
    if (Math.abs(computedNet - amount(settlement.netAmount)) > 100) {
      risks.push({
        entityType: "gateway_settlement",
        entityId: settlement.id,
        category: "Gateway settlement mismatch",
        severity: "medium",
        reason: `${settlement.provider} settlement net amount does not match gross minus fees and GST on fees.`,
        suggestedAction: "Potential risk — needs CA review. Reconcile with gateway settlement export.",
        status: "open",
      });
    }
  }

  return risks;
}

export function runFullReconciliation(data: {
  transactions: MatchBankTransaction[];
  invoices: MatchInvoice[];
  ledgerEntries: MatchLedgerEntry[];
  payrollEntries: MatchPayrollEntry[];
  gatewaySettlements: MatchGatewaySettlement[];
}) {
  const suggestions = [
    ...matchBankToInvoices(data.transactions, data.invoices),
    ...matchBankToLedger(data.transactions, data.ledgerEntries),
    ...detectDuplicates(data.transactions, data.invoices),
    ...detectPartialPayments(data.transactions, data.invoices),
    ...detectSplitPayments(data.transactions, data.invoices),
    ...detectGatewaySettlements(data.transactions, data.gatewaySettlements),
    ...detectPayrollMatches(data.transactions, data.payrollEntries),
  ];

  const deduped = new Map<string, ReconciliationSuggestion>();
  for (const suggestion of suggestions) {
    const key = `${suggestion.bankTransactionId ?? "none"}:${suggestion.invoiceId ?? "none"}:${suggestion.ledgerEntryId ?? "none"}:${suggestion.matchType}`;
    const existing = deduped.get(key);
    if (!existing || suggestion.confidenceScore > existing.confidenceScore) deduped.set(key, suggestion);
  }

  return {
    matches: [...deduped.values()].sort((a, b) => b.confidenceScore - a.confidenceScore),
    risks: generateRiskFlags(data),
  };
}
