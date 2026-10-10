/**
 * Reads PDFs and images with Claude, then Gemini, when rule-based parsing finds nothing.
 * Output is "AI extracted — pending review". Every response is schema-checked, then
 * passed through the same deterministic normalizers as an uploaded CSV.
 */
import { z } from "zod";
import { callClaudeFiles, claudeConfig, claudeConfigured } from "../server/ai/providers/claudeProvider";
import { callGeminiParts, geminiConfig } from "../server/ai/providers/geminiProvider";
import { safeParseAIJson } from "../server/ai/safeJson";
import { logger } from "../lib/logger";
import { logAIUsage } from "../server/ai/usageLogger";
import { estimateTokens, geminiModels, getAIProviderSettings, type AIProviderName } from "../server/ai/types";
import type { InvoiceRow } from "./invoiceVerify";
import { counterpartyFrom, normalizeDate, type BankStatementSummary, type NormalizedBankTxn } from "./bankStatement";
import { detectBankFromStatement } from "./bankDirectory";
import { checkRunningBalance, chronological, type StatementCheck } from "./statementCheck";

const MAX_BYTES = 20 * 1024 * 1024;

export type DocReadResult<T> =
  | { ok: true; data: T; provider: AIProviderName; model: string }
  | { ok: false; error: string };

function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GENAI_API_KEY);
}

export function aiDocumentReadingAvailable(privacy = false) {
  // Private-file consent names Gemini specifically; Claude must not make that path appear available.
  return geminiConfigured() || (!privacy && claudeConfigured());
}

export function mimeFor(fileName: string, declared?: string) {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return declared || "application/octet-stream";
}

type DocFile = { data: Buffer; mimeType: string };

/**
 * Tries Claude, then the Gemini models in order. `score` (0..1) lets the caller keep
 * going when a reply parses but fails its own checks; the best-scoring reply wins and
 * a perfect score stops early.
 */
async function readDocument<T>(input: {
  files: DocFile[];
  prompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  purpose: "invoice_extraction" | "bank_narration_interpretation";
  companyId?: number | null;
  userId?: number | null;
  /** Privacy mode: write no usage log either. */
  privacy?: boolean;
  score?: (data: T) => number;
}): Promise<DocReadResult<T>> {
  const bytes = input.files.reduce((sum, file) => sum + file.data.length, 0);
  if (bytes > MAX_BYTES) return { ok: false, error: "file_too_large_for_ai" };
  const byProvider: Partial<Record<AIProviderName, Array<{ name: AIProviderName; model: string; call: () => Promise<string> }>>> = { claude: [], gemini: [] };
  if (claudeConfigured()) {
    const config = claudeConfig();
    byProvider.claude!.push({ name: "claude", model: config.model, call: () => callClaudeFiles(input.prompt, input.files, config) });
  }
  if (geminiConfigured()) {
    // Primary model first, then the fallback model (often a cheaper tier with free quota).
    for (const model of geminiModels()) {
      const base = geminiConfig(model);
      const config = { ...base, timeoutMs: Math.max(base.timeoutMs, 300_000) };
      byProvider.gemini!.push({ name: "gemini", model: config.model, call: () => callGeminiParts(input.prompt, input.files, config) });
    }
  }
  // Same order as AI_PROVIDER_ORDER (default: every Gemini model, then Claude).
  const order = getAIProviderSettings().providerOrder.filter(name => name === "gemini" || name === "claude");
  // Privacy mode tells the person their file goes to Gemini, so it never falls through to another vendor.
  const providers = (order.length > 0 ? order : ["gemini", "claude"] as AIProviderName[]).filter(name => !input.privacy || name === "gemini");
  const attempts = providers.flatMap(name => byProvider[name] ?? []);
  if (attempts.length === 0) return { ok: false, error: "no_ai_provider_configured" };

  let lastError = "ai_read_failed";
  let best: { data: T; provider: AIProviderName; model: string; score: number } | null = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const started = Date.now();
    try {
      const raw = await attempt.call();
      const parsed = safeParseAIJson(raw, input.schema as z.ZodType<T>);
      if (!input.privacy) await logAIUsage({
        companyId: input.companyId ?? null,
        userId: input.userId ?? null,
        provider: attempt.name,
        model: attempt.model,
        purpose: input.purpose,
        success: parsed.ok,
        latencyMs: Date.now() - started,
        tokenEstimate: estimateTokens(input.prompt),
        usedFallback: index > 0,
        errorCode: parsed.ok ? undefined : parsed.error,
      }).catch(() => undefined);
      if (parsed.ok) {
        const score = input.score ? input.score(parsed.data) : 1;
        if (!best || score > best.score) best = { data: parsed.data, provider: attempt.name, model: attempt.model, score };
        if (score >= 1) break;
        continue;
      }
      lastError = parsed.error;
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 120) : "ai_read_failed";
      // The reason is a provider status such as an empty balance, never file content, so it is safe to log.
      logger.warn({ provider: attempt.name, model: attempt.model, reason: lastError }, "AI document read failed");
      if (!input.privacy) await logAIUsage({
        companyId: input.companyId ?? null,
        userId: input.userId ?? null,
        provider: attempt.name,
        model: attempt.model,
        purpose: input.purpose,
        success: false,
        latencyMs: Date.now() - started,
        tokenEstimate: estimateTokens(input.prompt),
        usedFallback: index > 0,
        errorCode: lastError,
      }).catch(() => undefined);
    }
  }
  if (best) return { ok: true, data: best.data, provider: best.provider, model: best.model };
  return { ok: false, error: lastError };
}

// ── Bank statements ─────────────────────────────────────────────────────────

const money = z.union([z.number(), z.string()]).nullable().transform(value => {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = value.replace(/[₹,\s]/g, "").replace(/(cr|dr)$/i, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
});

const bankStatementSchema = z.object({
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

const BANK_PROMPT = [
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
].join(" ");

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

function toSummary(statement: AIBankStatement, fileName: string): { summary: BankStatementSummary; check: StatementCheck } {
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
      warnings: check.failed > 0 ? [`${check.failed} row(s) do not match the running balance. Compare them with the statement.`] : [],
    },
  };
}

/**
 * Reads statement pages with AI. Each model's answer is scored by the running-balance
 * proof; a fully proved answer is used at once, otherwise the next model is tried.
 */
export async function readBankStatementWithAI(input: {
  files: DocFile[];
  fileName: string;
  companyId?: number | null;
  userId?: number | null;
  privacy?: boolean;
}): Promise<{ ok: true; read: AIStatementRead } | { ok: false; error: string }> {
  const score = (data: AIBankStatement) => {
    const { check } = toSummary(data, input.fileName);
    if (check.rows === 0) return 0;
    if (check.verified) return 1;
    return 0.5 * (check.passed / Math.max(1, check.checked));
  };
  const result = await readDocument({
    files: input.files,
    prompt: BANK_PROMPT,
    schema: bankStatementSchema,
    purpose: "bank_narration_interpretation",
    companyId: input.companyId,
    userId: input.userId,
    privacy: input.privacy,
    score,
  });
  if (!result.ok) return result;
  const { summary, check } = toSummary(result.data, input.fileName);
  if (summary.transactions.length === 0) return { ok: false, error: "no_transactions_read" };
  return { ok: true, read: { summary, check, provider: result.provider, model: result.model } };
}

// ── Invoices ────────────────────────────────────────────────────────────────

const invoiceDocSchema = z.object({
  invoices: z.array(z.object({
    invoiceNumber: z.string().nullable(),
    invoiceDate: z.string().nullable().optional(),
    vendorName: z.string().nullable().optional(),
    vendorGstin: z.string().nullable().optional(),
    customerName: z.string().nullable().optional(),
    total: money,
    tax: money.optional().default(null),
  })).max(200),
});

const INVOICE_PROMPT = [
  "This file contains one or more Indian GST invoices or bills.",
  "Return JSON only with this shape:",
  '{"invoices": [{"invoiceNumber": string|null, "invoiceDate": "YYYY-MM-DD"|null, "vendorName": string|null,',
  '"vendorGstin": string|null, "customerName": string|null, "total": number|null, "tax": number|null}]}',
  "vendorName is the seller who issued the invoice. total is the final invoice amount including tax.",
  "Copy values exactly as printed. Use null for anything missing or unclear. Do not invent values.",
].join(" ");

export async function readInvoicesWithAI(input: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  companyId?: number | null;
  userId?: number | null;
  privacy?: boolean;
}): Promise<{ ok: true; rows: InvoiceRow[]; provider: AIProviderName } | { ok: false; error: string }> {
  const result = await readDocument({
    files: [{ data: input.buffer, mimeType: input.mimeType }],
    companyId: input.companyId,
    userId: input.userId,
    privacy: input.privacy,
    prompt: INVOICE_PROMPT,
    schema: invoiceDocSchema,
    purpose: "invoice_extraction",
  });
  if (!result.ok) return result;
  const rows: InvoiceRow[] = result.data.invoices.flatMap((invoice, index) => {
    if (!invoice.invoiceNumber || invoice.total == null) return [];
    return [{
      invoiceNumber: invoice.invoiceNumber.trim(),
      invoiceDate: normalizeDate(invoice.invoiceDate ?? null),
      vendorName: invoice.vendorName?.trim() || "Unknown vendor",
      vendorGstin: invoice.vendorGstin?.trim() || null,
      customerName: invoice.customerName?.trim() || null,
      total: Math.abs(invoice.total),
      tax: invoice.tax ?? null,
      rowNumber: index + 1,
      label: "AI extracted — pending review" as const,
    }];
  });
  return { ok: true, rows, provider: result.provider };
}
