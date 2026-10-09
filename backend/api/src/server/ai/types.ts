import type { z } from "zod";

export type AIProviderName = "claude" | "gemini" | "nvidia" | "openrouter" | "rule_based";

export type AIRequestPurpose =
  | "invoice_extraction"
  | "bank_narration_interpretation"
  | "ledger_suggestion"
  | "risk_explanation"
  | "month_end_summary"
  | "column_mapping"
  | "ca_note_generation";

export type AIProviderConfig = {
  provider: AIProviderName;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
};

export type AIResult<T> = {
  ok: boolean;
  provider: AIProviderName;
  model?: string;
  data?: T;
  rawText?: string;
  error?: string;
  confidence: number;
  usedFallback: boolean;
  validationErrors?: string[];
};

export type AIJsonTask<T> = {
  companyId?: number | null;
  userId?: number | null;
  purpose: AIRequestPurpose;
  schemaName: string;
  schema: z.ZodType<T>;
  schemaDescription: string;
  input: unknown;
  prompt: string;
};

export type AIProviderSettings = {
  claudeModel: string;
  geminiModel: string;
  geminiFallbackModel: string | null;
  nvidiaModel: string | null;
  openrouterModel: string | null;
  openrouterEnabled: boolean;
  providerOrder: AIProviderName[];
  enableFallbacks: boolean;
  enableStructuredOutput: boolean;
  enableLogging: boolean;
  storeRawPrompts: boolean;
  timeoutMs: number;
  maxRetries: number;
};

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function providerOrderFromEnv(): AIProviderName[] {
  const allowed = new Set<AIProviderName>(["claude", "gemini", "nvidia", "openrouter"]);
  const configured = (process.env.AI_PROVIDER_ORDER ?? "gemini,claude,nvidia")
    .split(",")
    .map((item) => item.trim().toLowerCase() as AIProviderName)
    .filter((item) => allowed.has(item));
  return configured.length > 0 ? configured : ["gemini", "claude", "nvidia"];
}

export function getAIProviderSettings(): AIProviderSettings {
  return {
    claudeModel: process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash",
    nvidiaModel: process.env.NVIDIA_MODEL || null,
    openrouterModel: process.env.OPENROUTER_MODEL || null,
    openrouterEnabled: boolFromEnv("OPENROUTER_ENABLED", false),
    providerOrder: providerOrderFromEnv(),
    enableFallbacks: boolFromEnv("AI_ENABLE_FALLBACKS", true),
    enableStructuredOutput: boolFromEnv("AI_ENABLE_STRUCTURED_OUTPUT", true),
    enableLogging: boolFromEnv("AI_ENABLE_LOGGING", true),
    storeRawPrompts: boolFromEnv("AI_STORE_RAW_PROMPTS", false) && process.env.NODE_ENV !== "production",
    timeoutMs: numberFromEnv("AI_TIMEOUT_MS", 30_000),
    maxRetries: numberFromEnv("AI_MAX_RETRIES", 1),
  };
}

/** Main model, then each comma-separated fallback model, without repeats. */
export function geminiModels(settings: AIProviderSettings = getAIProviderSettings()): string[] {
  const fallbacks = (settings.geminiFallbackModel ?? "").split(",").map(model => model.trim()).filter(Boolean);
  return [...new Set([settings.geminiModel, ...fallbacks])];
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
