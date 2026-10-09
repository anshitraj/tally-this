import Anthropic from "@anthropic-ai/sdk";
import { financeSystemPrompt } from "../prompts/financeSystemPrompt";
import type { AIProviderConfig } from "../types";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORTS = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);

function apiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || undefined;
}

export function claudeConfigured(): boolean {
  return Boolean(apiKey());
}

export function claudeConfig(model?: string): AIProviderConfig {
  return {
    provider: "claude",
    model: model || process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
    temperature: 0,
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 16000),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30_000),
  };
}

function effort(): Effort {
  const value = (process.env.ANTHROPIC_EFFORT ?? "low").toLowerCase() as Effort;
  return EFFORTS.has(value) ? value : "low";
}

let cachedClient: Anthropic | null = null;
let cachedKey: string | undefined;

function client(): Anthropic {
  const key = apiKey();
  if (!key) throw new Error("claude_missing_api_key");
  if (!cachedClient || cachedKey !== key) {
    // Organisation-level keys must name the workspace to bill; workspace keys need nothing extra.
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
    cachedClient = new Anthropic({
      apiKey: key,
      maxRetries: 1,
      ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}),
    });
    cachedKey = key;
  }
  return cachedClient;
}

type UserContent = Anthropic.Beta.BetaContentBlockParam[];

async function run(content: UserContent, config: AIProviderConfig, timeoutMs: number): Promise<string> {
  // Server-side fallback reroutes a policy decline to Anthropic's recommended model
  // instead of returning a refusal. Streaming keeps long extractions under HTTP timeouts.
  const stream = client().beta.messages.stream(
    {
      model: config.model,
      max_tokens: config.maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: effort() },
      system: financeSystemPrompt,
      messages: [{ role: "user", content }],
    },
    { timeout: timeoutMs },
  );
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("claude_refusal");
  if (message.stop_reason === "max_tokens") throw new Error("claude_output_truncated");
  const text = message.content
    .map(block => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  if (!text) throw new Error("claude_empty_response");
  return text;
}

export async function callClaudeProvider(prompt: string, config: AIProviderConfig): Promise<string> {
  return run([{ type: "text", text: prompt }], config, config.timeoutMs);
}

function fileBlock(buffer: Buffer, mimeType: string): Anthropic.Beta.BetaContentBlockParam {
  const data = buffer.toString("base64");
  const media = mimeType.toLowerCase();
  if (media === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  if (media === "image/png" || media === "image/jpeg" || media === "image/webp" || media === "image/gif") {
    return { type: "image", source: { type: "base64", media_type: media, data } };
  }
  throw new Error("claude_unsupported_media");
}

/** Reads a PDF or image directly. Used when text extraction found nothing usable. */
export async function callClaudeDocument(
  prompt: string,
  buffer: Buffer,
  mimeType: string,
  config: AIProviderConfig,
): Promise<string> {
  return callClaudeFiles(prompt, [{ data: buffer, mimeType }], config);
}

/** Several page images (or one PDF) in one request. Long statements need a large output budget. */
export async function callClaudeFiles(
  prompt: string,
  files: Array<{ data: Buffer; mimeType: string }>,
  config: AIProviderConfig,
): Promise<string> {
  const blocks = files.map(file => fileBlock(file.data, file.mimeType));
  return run([...blocks, { type: "text", text: prompt }], { ...config, maxTokens: Math.max(config.maxTokens, 64000) }, Math.max(config.timeoutMs, 300_000));
}
