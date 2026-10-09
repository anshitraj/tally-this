import { financeSystemPrompt } from "../prompts/financeSystemPrompt";
import type { AIProviderConfig, AIRequestPurpose } from "../types";

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

const dailyUsage = {
  day: "",
  requests: 0,
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function openrouterAllowed(purpose: AIRequestPurpose): boolean {
  const enabled = process.env.OPENROUTER_ENABLED === "true";
  if (!enabled) return false;
  const productionOnly = (process.env.OPENROUTER_PRODUCTION_ONLY ?? "true") === "true";
  if (productionOnly && process.env.NODE_ENV !== "production") return false;
  if (!["invoice_extraction", "risk_explanation", "month_end_summary", "column_mapping", "ca_note_generation"].includes(purpose)) return false;

  const day = todayKey();
  if (dailyUsage.day !== day) {
    dailyUsage.day = day;
    dailyUsage.requests = 0;
  }

  const maxRequests = Number(process.env.OPENROUTER_MAX_REQUESTS_PER_DAY ?? 25);
  return dailyUsage.requests < maxRequests;
}

export function openrouterConfig(): AIProviderConfig {
  return {
    provider: "openrouter",
    model: process.env.OPENROUTER_MODEL || "",
    temperature: 0,
    maxTokens: Number(process.env.OPENROUTER_MAX_TOKENS ?? 4096),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30_000),
  };
}

export async function callOpenRouterProvider(prompt: string, config: AIProviderConfig): Promise<string> {
  if (process.env.OPENROUTER_ENABLED !== "true") throw new Error("openrouter_disabled");
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.Openrouter_API_Key;
  if (!apiKey) throw new Error("openrouter_missing_api_key");
  if (!config.model) throw new Error("openrouter_missing_model");

  const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.APP_URL || "http://localhost:21950",
        "X-Title": "TallyThis",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: financeSystemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        response_format: { type: "json_object" },
      }),
    });

    const payload = await response.json() as ChatCompletionResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message || `openrouter_http_${response.status}`);
    }

    dailyUsage.requests += 1;
    const text = payload.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("openrouter_empty_response");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
