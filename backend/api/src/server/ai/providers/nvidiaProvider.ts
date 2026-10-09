import { financeSystemPrompt } from "../prompts/financeSystemPrompt";
import type { AIProviderConfig } from "../types";

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

export function nvidiaConfig(): AIProviderConfig {
  return {
    provider: "nvidia",
    model: process.env.NVIDIA_MODEL || "",
    temperature: Number(process.env.NVIDIA_TEMPERATURE ?? 0),
    maxTokens: Number(process.env.NVIDIA_MAX_TOKENS ?? 4096),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30_000),
  };
}

export async function callNvidiaProvider(prompt: string, config: AIProviderConfig): Promise<string> {
  const apiKey = process.env.NVIDIA_API_KEY || process.env.Nvidia_API_Key;
  if (!apiKey) throw new Error("nvidia_missing_api_key");
  if (!config.model) throw new Error("nvidia_missing_model");

  const baseUrl = (process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
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
      throw new Error(payload.error?.message || `nvidia_http_${response.status}`);
    }

    const text = payload.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("nvidia_empty_response");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
