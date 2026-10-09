import type { AIRequestPurpose, AIResult } from "./types";

const gstinRegex = /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const amountRegex = /(?:INR|Rs\.?|₹)?\s*([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})|[0-9]+(?:\.[0-9]{1,2})?)/gi;
const invoiceRegex = /\b(?:invoice|inv|bill)\s*(?:no|number|#)?\s*[:\-]?\s*([A-Z0-9\/\-]{3,})/i;
const dateRegex = /\b([0-3]?\d[\/\-][01]?\d[\/\-](?:20)?\d{2}|20\d{2}[\/\-][01]?\d[\/\-][0-3]?\d)\b/;

function textFromInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "text" in input) return String((input as { text?: unknown }).text ?? "");
  return JSON.stringify(input ?? {});
}

function parseAmount(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function invoiceFallback(input: unknown) {
  const text = textFromInput(input);
  const gstins = Array.from(text.matchAll(gstinRegex)).map((match) => match[0]);
  const amounts = Array.from(text.matchAll(amountRegex)).map((match) => parseAmount(match[1])).filter((value): value is number => value !== null);
  const invoiceNumber = text.match(invoiceRegex)?.[1] ?? null;
  const invoiceDate = text.match(dateRegex)?.[1] ?? null;
  const totalAmount = amounts.length ? Math.max(...amounts) : null;
  const missingFields = [
    invoiceNumber ? null : "invoiceNumber",
    invoiceDate ? null : "invoiceDate",
    gstins[0] ? null : "vendorGstin",
    totalAmount !== null ? null : "totalAmount",
  ].filter((field): field is string => Boolean(field));

  return {
    invoiceNumber,
    invoiceDate,
    vendorName: null,
    customerName: null,
    vendorGstin: gstins[0] ?? null,
    customerGstin: gstins[1] ?? null,
    subtotalAmount: null,
    gstAmount: null,
    totalAmount,
    currency: totalAmount !== null ? "INR" : null,
    lineItems: [],
    confidence: invoiceNumber || totalAmount ? 0.45 : 0.2,
    missingFields,
    warnings: ["AI unavailable — using rule-based extraction", "Extracted fields are pending review and must not be treated as verified."],
    sourceQuotes: [invoiceNumber, invoiceDate, gstins[0]].filter((item): item is string => Boolean(item)).slice(0, 3),
  };
}

function narrationFallback(input: unknown) {
  const text = textFromInput(input);
  const rail = /\bUPI\b/i.test(text) ? "UPI"
    : /\bNEFT\b/i.test(text) ? "NEFT"
      : /\bRTGS\b/i.test(text) ? "RTGS"
        : /\bIMPS\b/i.test(text) ? "IMPS"
          : /\bCHEQUE|CHQ\b/i.test(text) ? "CHEQUE"
            : /\bCARD|POS\b/i.test(text) ? "CARD"
              : /\bRAZORPAY|CASHFREE|STRIPE|GATEWAY\b/i.test(text) ? "GATEWAY"
                : "UNKNOWN";
  const reference = text.match(/\b(?:UTR|RRN|REF|UPI)\s*[:\-]?\s*([A-Z0-9]{6,})\b/i)?.[1] ?? null;
  return {
    possiblePartyName: null,
    possibleReference: reference,
    paymentRail: rail,
    possiblePurpose: null,
    ledgerSuggestion: keywordLedger(text),
    confidence: reference || rail !== "UNKNOWN" ? 0.5 : 0.25,
    reason: "AI unavailable - using deterministic keyword and reference patterns.",
    needsReview: true,
  };
}

function keywordLedger(text: string): string | null {
  if (/salary|payroll/i.test(text)) return "Payroll Expenses";
  if (/rent/i.test(text)) return "Rent Expense";
  if (/razorpay|cashfree|stripe|gateway/i.test(text)) return "Payment Gateway Settlements";
  if (/gst|tds/i.test(text)) return "Statutory Dues";
  if (/aws|cloud|software|saas/i.test(text)) return "Software Expenses";
  return null;
}

function ledgerFallback(input: unknown) {
  const text = textFromInput(input);
  const suggestedLedger = keywordLedger(text);
  return {
    suggestedLedger,
    ledgerCategory: suggestedLedger ? "expense_or_settlement" : null,
    confidence: suggestedLedger ? 0.55 : 0.2,
    reason: suggestedLedger ? "Matched a deterministic keyword map." : "No deterministic ledger keyword matched.",
    needsCAReview: true,
  };
}

function riskFallback(input: unknown) {
  const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const category = String(data.category ?? "Review required");
  return {
    riskTitle: category,
    riskCategory: category,
    severity: ["low", "medium", "high"].includes(String(data.severity)) ? data.severity as "low" | "medium" | "high" : "medium",
    explanation: "Potential risk — needs CA review. Rule-based controls found an item requiring supporting evidence before close.",
    suggestedAction: "Collect source documents and ask the CA to confirm treatment before month close.",
    requiredDocuments: ["Source invoice or statement", "Payment reference", "Ledger export"],
    confidence: 0.45,
    caReviewRequired: true as const,
  };
}

function monthEndFallback(input: unknown) {
  const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return {
    summary: "AI unavailable - using rule-based mode. Review open risks, missing invoices, unmatched ledger entries, and export CA-ready reports after deterministic checks pass.",
    verificationScore: Number(data.verificationScore ?? 0),
    readyForCA: false,
    topIssues: [],
    nextActions: ["Review unmatched transactions", "Resolve Potential risk — needs CA review items", "Export reports after deterministic reconciliation"],
    caReviewRequired: true,
    disclaimer: "This is an AI-assisted summary. Potential risks need CA review." as const,
  };
}

function columnMappingFallback(input: unknown) {
  const data = input && typeof input === "object" ? input as { sourceType?: string; columns?: unknown[] } : {};
  const sourceType = ["bank", "invoice", "tally", "zoho", "gst", "payroll", "gateway", "expense"].includes(String(data.sourceType))
    ? String(data.sourceType) as "bank" | "invoice" | "tally" | "zoho" | "gst" | "payroll" | "gateway" | "expense"
    : "bank";
  const columns = Array.isArray(data.columns) ? data.columns.map(String) : [];
  return {
    sourceType,
    mappings: columns.map((column) => ({ originalColumn: column, mappedField: null, confidence: 0.1 })),
    unmappedColumns: columns,
    warnings: ["AI unavailable - using rule-based mode. Review all column mappings manually."],
  };
}

export function ruleBasedFallback<T>(purpose: AIRequestPurpose, input: unknown): AIResult<T> {
  const data = (() => {
    switch (purpose) {
      case "invoice_extraction": return invoiceFallback(input);
      case "bank_narration_interpretation": return narrationFallback(input);
      case "ledger_suggestion": return ledgerFallback(input);
      case "risk_explanation": return riskFallback(input);
      case "month_end_summary": return monthEndFallback(input);
      case "column_mapping": return columnMappingFallback(input);
      case "ca_note_generation": return {
        note: "AI unavailable - using rule-based mode. Potential risk — needs CA review.",
        confidence: 0.25,
        caReviewRequired: true,
      };
    }
  })();

  return {
    ok: true,
    provider: "rule_based",
    data: data as T,
    error: "AI unavailable — using rule-based extraction",
    confidence: typeof data === "object" && data && "confidence" in data ? Number((data as { confidence: unknown }).confidence) : 0.25,
    usedFallback: true,
  };
}
