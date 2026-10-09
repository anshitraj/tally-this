import { callGeminiProvider, geminiConfig } from "../server/ai/providers/geminiProvider";
import { logger } from "../lib/logger";

/**
 * Hybrid PDF table extraction pipeline:
 *   1. Bank/gateway-specific pattern extractors (HDFC, ICICI, SBI, Kotak, Axis, Razorpay, Cashfree, Stripe).
 *   2. Generic rule extractor (header+column split or date-anchored rows) — passed in from caller.
 *   3. AI fallback (Gemini) — converts raw text to JSON rows when both rule strategies fail or return too few.
 *
 * Each stage tags its result with `method` so the audit log + UI can show provenance.
 */

export type ExtractionMethod =
  | "bank_pattern_hdfc"
  | "bank_pattern_icici"
  | "bank_pattern_sbi"
  | "bank_pattern_kotak"
  | "bank_pattern_axis"
  | "gateway_pattern_razorpay"
  | "gateway_pattern_cashfree"
  | "gateway_pattern_stripe"
  | "gst_pattern_gstr2b"
  | "generic_rules"
  | "ai_gemini"
  | "none";

export interface PdfExtractionResult {
  rows: Record<string, unknown>[];
  columns: string[];
  method: ExtractionMethod;
  confidence: number;
  notes: string[];
}

interface GenericFallback {
  (text: string): { columns: string[]; rows: Record<string, unknown>[] } | null;
}

const MIN_ACCEPTABLE_ROWS = 1;
const AI_MAX_ROWS = 500;

function isAIFallbackEnabled() {
  if (process.env.PDF_AI_FALLBACK === "false") return false;
  return Boolean(process.env.GEMINI_API_KEY || process.env.GENAI_API_KEY);
}

function detectBank(text: string): ExtractionMethod | null {
  const head = text.slice(0, 2000).toLowerCase();
  if (/hdfc bank|hdfc\s+ltd|hdfcin/.test(head)) return "bank_pattern_hdfc";
  if (/icici bank|icicibank|icic0/.test(head)) return "bank_pattern_icici";
  if (/state bank of india|\bsbi\b|sbin/.test(head)) return "bank_pattern_sbi";
  if (/kotak mahindra|kotak bank/.test(head)) return "bank_pattern_kotak";
  if (/axis bank|axisbank|utib/.test(head)) return "bank_pattern_axis";
  return null;
}

function detectGateway(text: string): ExtractionMethod | null {
  const head = text.slice(0, 2000).toLowerCase();
  if (/razorpay/.test(head)) return "gateway_pattern_razorpay";
  if (/cashfree/.test(head)) return "gateway_pattern_cashfree";
  if (/stripe inc|stripe\.com/.test(head)) return "gateway_pattern_stripe";
  return null;
}

function detectGstr(text: string): ExtractionMethod | null {
  if (/gstr-?2b|gstr2a|gstr-?3b/i.test(text.slice(0, 4000))) return "gst_pattern_gstr2b";
  return null;
}

// Generic Indian bank statement row pattern: date + narration + (debit|credit) + balance
// e.g. "01/05/2026 NEFT-ACME Corp-UTR12345 5,000.00 95,000.00"
// Also handles: "2026-05-03 NEFT CR ... INR 118,000.00 INR 1,368,000.00"
const BANK_ROW_RE = /^(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}[\/-]\d{2}[\/-]\d{2})\s+(.+?)\s+([\d,]+\.\d{2})(?:\s+([\d,]+\.\d{2}))?(?:\s+([\d,]+\.\d{2}))?$/;

// Pre-process PDF text: strip currency symbols (INR, Rs, ₹) so regexes can match bare numbers
function normalizeCurrency(text: string): string {
  // Remove "INR " and "Rs. " and "₹ " before numbers, preserving the number
  return text.replace(/(?:INR|Rs\.?|₹)\s*/gi, "");
}

function num(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[₹,\s]|INR|Rs\.?/gi, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// PDF text from pdf-parse often comes as a single continuous line with no \n separators.
// Split on date patterns to create logical "lines" for extraction.
function splitPdfTextIntoLines(text: string): string[] {
  // If text already has multiple lines, respect them
  const existingLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (existingLines.length > 3) return existingLines;

  // Single continuous line: split before each date pattern (YYYY-MM-DD or DD/MM/YYYY)
  // Lookahead split: insert newline before each date-like pattern
  const splitText = text.replace(
    /\s+(?=\d{4}[\/-]\d{2}[\/-]\d{2}\b|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b)/g,
    "\n"
  );
  return splitText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}


function extractIndianBankRows(text: string): Record<string, unknown>[] {
  const normalized = normalizeCurrency(text);
  const lines = splitPdfTextIntoLines(normalized);
  const rows: Record<string, unknown>[] = [];
  for (const line of lines) {
    const m = line.match(BANK_ROW_RE);
    if (!m) continue;
    const [, date, narration, a, b, c] = m;
    // Heuristic: if 3 numerics, treat as debit/credit/balance based on narration tokens
    const isDebit = /to|paid|withdrawal|debit|nft\.|imps\b|neft|upi|tfr|chq|dr\b/i.test(narration);
    const row: Record<string, unknown> = { Date: date, Narration: narration };
    if (c) {
      row["Debit"] = isDebit ? num(a) : null;
      row["Credit"] = isDebit ? null : num(a);
      row["Balance"] = num(c);
    } else if (b) {
      row["Amount"] = num(a);
      row["Balance"] = num(b);
    } else {
      row["Amount"] = num(a);
    }
    rows.push(row);
  }

  // Fallback: if regex didn't match, try extracting amounts by scanning for
  // date-anchored lines and collecting all currency-like numbers from each line
  if (rows.length === 0) {
    const rawLines = splitPdfTextIntoLines(text);
    const DATE_START = /^(\d{4}[\/-]\d{2}[\/-]\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/;
    const AMOUNT_RE = /(?:INR|Rs\.?|₹)?\s*([\d,]+\.\d{2})/g;
    for (const line of rawLines) {
      const dateMatch = line.match(DATE_START);
      if (!dateMatch) continue;
      // Skip header/summary lines
      if (/opening balance|closing balance|total|subtotal|page|brought forward|carried forward/i.test(line)) continue;
      const date = dateMatch[1];
      // Extract all amounts from the line
      const amounts: number[] = [];
      let am: RegExpExecArray | null;
      const amountRe = new RegExp(AMOUNT_RE.source, 'g');
      while ((am = amountRe.exec(line)) !== null) {
        const n = Number(am[1].replace(/,/g, ""));
        if (Number.isFinite(n) && n > 0) amounts.push(n);
      }
      if (amounts.length === 0) continue;
      // Extract narration: text between date and first amount
      const firstAmountIdx = line.indexOf(String(amounts[0]));
      let narration = line.slice(dateMatch[0].length, firstAmountIdx > 0 ? firstAmountIdx : undefined).trim();
      // Clean up narration - remove INR and trailing whitespace
      narration = narration.replace(/\bINR\b/g, "").replace(/\s{2,}/g, " ").trim();
      if (!narration || narration.length < 3) continue;
      const isDebit = /\bDR\b|\bdebit\b|\bpaid\b|\bwithdrawal\b|\bIMPS DR\b|\bNEFT DR\b/i.test(line);
      const isCredit = /\bCR\b|\bcredit\b|\breceived\b|\bNEFT CR\b|\bUPI CR\b/i.test(line);
      const row: Record<string, unknown> = { Date: date, Narration: narration };
      if (amounts.length >= 2) {
        const txnAmount = amounts[0];
        const balance = amounts[amounts.length - 1];
        row["Debit"] = isDebit ? txnAmount : null;
        row["Credit"] = isCredit ? txnAmount : (!isDebit ? txnAmount : null);
        row["Balance"] = balance;
      } else {
        row["Amount"] = amounts[0];
      }
      rows.push(row);
    }
  }

  return rows;
}

// Razorpay/Cashfree settlement pattern: settlement_id  amount  fees  net  date
// Original strict pattern: id gross fees net date (all bare numbers)
const SETTLEMENT_ROW_RE = /^(\w[\w-]{6,})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})$/;

function extractSettlementRows(text: string, provider: string): Record<string, unknown>[] {
  // Try normalized text first (strip INR/Rs/₹), then raw
  const normalized = normalizeCurrency(text);
  const lines = splitPdfTextIntoLines(normalized);
  const rows: Record<string, unknown>[] = [];
  for (const line of lines) {
    const m = line.match(SETTLEMENT_ROW_RE);
    if (!m) continue;
    const [, id, gross, fees, net, date] = m;
    rows.push({
      "Settlement ID": id,
      Provider: provider,
      "Gross Amount": num(gross),
      Fees: num(fees),
      "Net Amount": num(net),
      "Settlement Date": date,
    });
  }

  // Fallback: date-anchored settlement extraction with INR-aware amount parsing
  if (rows.length === 0) {
    const rawLines = splitPdfTextIntoLines(text);
    const DATE_RE = /\b(\d{4}[\/-]\d{2}[\/-]\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/;
    const SETL_ID_RE = /\b([A-Z]{2,}[\w-]{4,})\b/;
    const AMOUNT_RE = /(?:INR|Rs\.?|₹)?\s*([\d,]+\.\d{2})/g;
    for (const line of rawLines) {
      if (/settlement date|header|page|total|company|provider|synthetic/i.test(line)) continue;
      const dateMatch = line.match(DATE_RE);
      const idMatch = line.match(SETL_ID_RE);
      if (!dateMatch || !idMatch) continue;
      // Extract all amounts
      const amounts: number[] = [];
      let am: RegExpExecArray | null;
      const amRe = new RegExp(AMOUNT_RE.source, 'g');
      while ((am = amRe.exec(line)) !== null) {
        const n = Number(am[1].replace(/,/g, ""));
        if (Number.isFinite(n)) amounts.push(n);
      }
      if (amounts.length < 2) continue; // Need at least gross and net
      const gross = amounts[0];
      const fees = amounts.length >= 3 ? amounts[1] : 0;
      const gstOnFees = amounts.length >= 4 ? amounts[2] : null;
      const net = amounts[amounts.length - 2] ?? amounts[amounts.length - 1];
      // Find net as the amount closest to gross minus fees
      const expectedNet = gross - fees - (gstOnFees ?? 0);
      const bestNet = amounts.find(a => Math.abs(a - expectedNet) < 1) ?? amounts[amounts.length - 1];
      rows.push({
        "Settlement ID": idMatch[1],
        Provider: provider,
        "Gross Amount": gross,
        Fees: fees,
        "GST on Fees": gstOnFees,
        "Net Amount": bestNet,
        "Settlement Date": dateMatch[1],
      });
    }
  }

  return rows;
}

// GSTR-2B style: GSTIN  Counterparty  InvoiceNo  Date  Taxable  IGST  CGST  SGST
const GST_ROW_RE = /^(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d])\s+(.+?)\s+(\S+)\s+(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/;

function extractGstrRows(text: string): Record<string, unknown>[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows: Record<string, unknown>[] = [];
  for (const line of lines) {
    const m = line.match(GST_ROW_RE);
    if (!m) continue;
    const [, gstin, counterparty, invoiceNo, date, taxable, igst, cgst, sgst] = m;
    rows.push({
      GSTIN: gstin,
      Counterparty: counterparty,
      "Invoice Number": invoiceNo,
      "Invoice Date": date,
      "Taxable Value": num(taxable),
      IGST: num(igst),
      CGST: num(cgst),
      SGST: num(sgst),
      "GST Amount": (num(igst) ?? 0) + (num(cgst) ?? 0) + (num(sgst) ?? 0),
    });
  }
  return rows;
}

async function extractByAI(text: string, sourceType: string): Promise<Record<string, unknown>[]> {
  const sample = text.slice(0, 18_000);
  const schemaHint = (() => {
    const s = sourceType.toLowerCase();
    if (["bank", "bank_statement"].includes(s)) return `keys: Date, Narration, Debit, Credit, Balance, Reference (UTR/cheque/transaction id). Either Debit OR Credit must be set per row.`;
    if (["tally", "tally_export", "zoho", "zoho_export", "ledger"].includes(s)) return `keys: Date, Ledger (account/party name), Voucher (voucher number), Debit, Credit. Either Debit OR Credit per row.`;
    if (["gateway", "gateway_settlement"].includes(s)) return `keys: "Settlement ID", Provider, "Gross Amount", Fees, "Net Amount", "Settlement Date", "Bank Reference".`;
    if (["gst", "gst_tds", "tds"].includes(s)) return `keys: GSTIN, Counterparty, "Invoice Number", "Invoice Date", "Taxable Value", IGST, CGST, SGST, "GST Amount".`;
    if (s === "payroll") return `keys: Employee, Month, "Gross Amount", "Net Amount", "Payment Date", "Bank Reference".`;
    if (["invoices", "invoice"].includes(s)) return `keys: "Invoice Number", Date, Vendor (vendor/party name), Customer, GSTIN, Amount, "GST Amount", Type (sales/purchase).`;
    if (s === "expenses") return `keys: Date, Description, Amount, Category, Reference.`;
    return `keys: Date, Description, Amount.`;
  })();

  const prompt = `You are a financial data extraction engine. Convert the following ${sourceType} PDF text into a JSON array of row objects.

Rules:
- Output ONLY a JSON array, no prose, no markdown fences.
- Each row = one transaction/line-item.
- Use ${schemaHint}
- Amounts as numbers (no commas, no currency symbol). Negative for outflows when only one signed Amount is available.
- Dates kept in original format (DD/MM/YYYY or YYYY-MM-DD).
- Empty/unknown numeric fields = null. Empty strings = null.
- Skip header / footer / summary / running balance / "opening balance" / "closing balance" lines.
- Maximum ${AI_MAX_ROWS} rows.

PDF text:
"""
${sample}
"""

JSON:`;

  const config = geminiConfig();
  const raw = await callGeminiProvider(prompt, config);
  const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const arrMatch = jsonText.match(/\[[\s\S]*\]/);
    if (!arrMatch) throw new Error("ai_invalid_json");
    parsed = JSON.parse(arrMatch[0]);
  }
  if (!Array.isArray(parsed)) throw new Error("ai_response_not_array");
  return parsed
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row))
    .slice(0, AI_MAX_ROWS);
}

export async function extractHybrid(
  text: string,
  sourceType: string,
  genericFallback: GenericFallback,
): Promise<PdfExtractionResult> {
  const normalizedSource = sourceType.toLowerCase();
  const notes: string[] = [];

  // Stage 1: source-specific pattern extractors
  let method: ExtractionMethod = "none";
  let rows: Record<string, unknown>[] = [];

  if (["bank", "bank_statement"].includes(normalizedSource)) {
    const detected = detectBank(text);
    if (detected) {
      rows = extractIndianBankRows(text);
      method = detected;
      notes.push(`Detected ${detected.replace("bank_pattern_", "").toUpperCase()} bank pattern.`);
    }
  } else if (["gateway", "gateway_settlement"].includes(normalizedSource)) {
    const detected = detectGateway(text);
    if (detected) {
      const provider = detected.replace("gateway_pattern_", "");
      rows = extractSettlementRows(text, provider.charAt(0).toUpperCase() + provider.slice(1));
      method = detected;
      notes.push(`Detected ${provider} settlement pattern.`);
    }
  } else if (["gst", "gst_tds", "tds"].includes(normalizedSource)) {
    const detected = detectGstr(text);
    if (detected) {
      rows = extractGstrRows(text);
      method = detected;
      notes.push("Detected GSTR/TDS table pattern.");
    }
  }

  if (rows.length >= MIN_ACCEPTABLE_ROWS) {
    return {
      rows,
      columns: rows[0] ? Object.keys(rows[0]) : [],
      method,
      confidence: 0.9,
      notes,
    };
  }

  // Stage 2: generic rule extractor (header/date-anchor)
  const generic = genericFallback(text);
  if (generic && generic.rows.length >= MIN_ACCEPTABLE_ROWS) {
    notes.push("Generic rule extractor matched header/date pattern.");
    return {
      rows: generic.rows,
      columns: generic.columns,
      method: "generic_rules",
      confidence: 0.75,
      notes,
    };
  }

  // Stage 3: AI fallback
  if (isAIFallbackEnabled()) {
    try {
      const aiRows = await extractByAI(text, normalizedSource);
      if (aiRows.length >= MIN_ACCEPTABLE_ROWS) {
        notes.push(`AI Gemini fallback extracted ${aiRows.length} rows. Mark as pending review before accepting.`);
        return {
          rows: aiRows,
          columns: aiRows[0] ? Object.keys(aiRows[0]) : [],
          method: "ai_gemini",
          confidence: 0.65,
          notes,
        };
      }
      notes.push(`AI Gemini returned ${aiRows.length} rows (below ${MIN_ACCEPTABLE_ROWS}).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "ai_unknown_error";
      logger.warn({ err: msg, sourceType }, "PDF AI fallback failed");
      notes.push(`AI Gemini fallback failed: ${msg}.`);
    }
  } else {
    notes.push("AI fallback disabled or GEMINI_API_KEY missing.");
  }

  return { rows: [], columns: [], method: "none", confidence: 0, notes };
}
