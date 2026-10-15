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
import { normalizeDate } from "./bankStatement";
import { BANK_PROMPT, bankStatementAnswerSchema, compactStatementSchema, finishAiRead, money, toSummary, type AIBankStatement, type AIStatementRead } from "./aiStatementShape";
import { readBankStatementByPages, type DocFile } from "./statementPageReader";
import { AI_ATTEMPTS_PER_GROUP, AI_CALL_TIMEOUT_MS, chainIntact, pageRanges } from "./statementReadPlan";

export type { AIBankStatement, AIStatementRead } from "./aiStatementShape";

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
  /** A valid answer that found nothing. Two in a row means the file has nothing to find; stop paying for more tries. */
  empty?: (data: T) => boolean;
  /** Per-attempt limit for Gemini. Defaults to five minutes, which suits one document but not many page groups. */
  timeoutMs?: number;
  /** Stop after this many models. */
  maxAttempts?: number;
  /** Extraction without long reasoning: much faster on dense tables. */
  fast?: boolean;
  /**
   * Try the quick fallback model first, twice (its slips are random, so a fresh answer usually
   * proves), then the primary model. Slower models in between are left out: on dense numbers a
   * model that is quick and wrong is worse than none.
   */
  fastestFirst?: boolean;
  /** The primary model only, twice. For a second look at what the quick model could not prove. */
  primaryOnly?: boolean;
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
      const config = {
        ...base,
        timeoutMs: input.timeoutMs ?? Math.max(base.timeoutMs, 300_000),
        ...(input.fast ? { thinkingLevel: "low" as const } : {}),
      };
      byProvider.gemini!.push({ name: "gemini", model: config.model, call: () => callGeminiParts(input.prompt, input.files, config) });
    }
  }
  // Same order as AI_PROVIDER_ORDER (default: every Gemini model, then Claude).
  const order = getAIProviderSettings().providerOrder.filter(name => name === "gemini" || name === "claude");
  // Privacy mode tells the person their file goes to Gemini, so it never falls through to another vendor.
  const providers = (order.length > 0 ? order : ["gemini", "claude"] as AIProviderName[]).filter(name => !input.privacy || name === "gemini");
  if ((input.fastestFirst || input.primaryOnly) && (byProvider.gemini?.length ?? 0) > 0) {
    const [primary, ...quicker] = byProvider.gemini!;
    const quick = quicker[0];
    byProvider.gemini = input.primaryOnly || !quick ? [primary, primary] : [quick, quick, primary];
  }
  const attempts = providers.flatMap(name => byProvider[name] ?? []).slice(0, input.maxAttempts ?? Number.MAX_SAFE_INTEGER);
  if (attempts.length === 0) return { ok: false, error: "no_ai_provider_configured" };

  let lastError = "ai_read_failed";
  let best: { data: T; provider: AIProviderName; model: string; score: number } | null = null;
  let emptyAnswers = 0;
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
        if (input.empty?.(parsed.data) && ++emptyAnswers >= 2) break;
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
    schema: bankStatementAnswerSchema,
    purpose: "bank_narration_interpretation",
    companyId: input.companyId,
    userId: input.userId,
    privacy: input.privacy,
    score,
    empty: data => toSummary(data, input.fileName).summary.transactions.length === 0,
  });
  if (!result.ok) return result;
  const { summary, check } = toSummary(result.data, input.fileName);
  if (summary.transactions.length === 0) return { ok: false, error: "no_transactions_read" };
  finishAiRead(summary, check);
  return { ok: true, read: { summary, check, provider: result.provider, model: result.model } };
}


/** Reads a long scan page group by page group, each group by the usual models in the usual order. */
export function readBankStatementPages(input: Omit<Parameters<typeof readBankStatementByPages>[0], "read"> & {
  companyId?: number | null;
  userId?: number | null;
  privacy?: boolean;
}) {
  return readBankStatementByPages({
    ...input,
    read: ({ files, prompt, strong }) => readDocument({
      files,
      prompt,
      schema: compactStatementSchema,
      purpose: "bank_narration_interpretation",
      companyId: input.companyId,
      userId: input.userId,
      privacy: input.privacy,
      timeoutMs: AI_CALL_TIMEOUT_MS,
      maxAttempts: strong ? 2 : AI_ATTEMPTS_PER_GROUP,
      fast: true,
      fastestFirst: !strong,
      primaryOnly: strong === true,
      score: data => {
        const { check } = toSummary(data, input.fileName);
        if (check.rows === 0) return 0;
        return chainIntact(check) ? 1 : 0.5 * (check.passed / Math.max(1, check.checked));
      },
      empty: data => data.transactions.length === 0,
    }),
    onGroupError: (pages, reason) => logger.warn({ pages: pageRanges(pages), reason }, "Statement page group could not be read"),
  });
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
