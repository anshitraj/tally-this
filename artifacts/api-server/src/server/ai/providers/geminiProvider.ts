import { financeSystemPrompt } from "../prompts/financeSystemPrompt";
import type { AIProviderConfig } from "../types";

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
  }>;
  error?: { message?: string };
};

export function geminiConfig(model?: string): AIProviderConfig {
  return {
    provider: "gemini",
    model: model || process.env.GEMINI_MODEL || "gemini-2.5-flash",
    temperature: Number(process.env.GEMINI_TEMPERATURE ?? 0),
    maxTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? 4096),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30_000),
  };
}

/** Gemini 3 models are tuned for the default temperature; lower values can cause loops. */
function temperatureFor(model: string, temperature: number) {
  return /^gemini-3/.test(model) ? undefined : temperature;
}

export async function callGeminiVision(
  prompt: string,
  imageBuffer: Buffer,
  mimeType: string,
  config: AIProviderConfig,
): Promise<string> {
  return callGeminiParts(prompt, [{ data: imageBuffer, mimeType }], config);
}

/** "High demand" and server errors pass in seconds; quota errors do not, so they are not retried. */
function isTransient(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return /high demand|overloaded|unavailable|internal error|gemini_http_5\d\d|try again later/i.test(text) && !/quota/i.test(text);
}

/** Reads one or more documents or page images in a single request, retrying brief outages. */
export async function callGeminiParts(
  prompt: string,
  files: Array<{ data: Buffer; mimeType: string }>,
  config: AIProviderConfig,
): Promise<string> {
  const delays = [3000, 8000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestGeminiParts(prompt, files, config);
    } catch (error) {
      if (attempt >= delays.length || !isTransient(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function requestGeminiParts(
  prompt: string,
  files: Array<{ data: Buffer; mimeType: string }>,
  config: AIProviderConfig,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GENAI_API_KEY;
  if (!apiKey) throw new Error("gemini_missing_api_key");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              ...files.map(file => ({ inlineData: { mimeType: file.mimeType, data: file.data.toString("base64") } })),
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: temperatureFor(config.model, 0),
          maxOutputTokens: 65536,
          responseMimeType: "application/json",
          // Small print on statements needs full-resolution reading.
          mediaResolution: "MEDIA_RESOLUTION_HIGH",
        },
      }),
    });

    const payload = await response.json() as GeminiResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message || `gemini_http_${response.status}`);
    }

    const text = payload.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text ?? "").join("").trim();
    if (!text) throw new Error("gemini_empty_response");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callGeminiProvider(prompt: string, config: AIProviderConfig): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GENAI_API_KEY;
  if (!apiKey) throw new Error("gemini_missing_api_key");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: financeSystemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: temperatureFor(config.model, config.temperature),
          maxOutputTokens: Math.max(config.maxTokens, 8192),
          responseMimeType: "application/json",
          // Short JSON tasks (ledger picks, summaries) do not need long reasoning; keep uploads fast.
          ...(/^gemini-3/.test(config.model) ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
        },
      }),
    });

    const payload = await response.json() as GeminiResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message || `gemini_http_${response.status}`);
    }

    const text = payload.candidates?.[0]?.content?.parts?.filter((part) => !part.thought).map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error("gemini_empty_response");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
