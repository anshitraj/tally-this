import { buildFinanceTaskPrompt } from "./prompts/financeSystemPrompt";
import { callClaudeProvider, claudeConfig, claudeConfigured } from "./providers/claudeProvider";
import { callGeminiProvider, geminiConfig } from "./providers/geminiProvider";
import { callNvidiaProvider, nvidiaConfig } from "./providers/nvidiaProvider";
import { callOpenRouterProvider, openrouterAllowed, openrouterConfig } from "./providers/openrouterProvider";
import { ruleBasedFallback } from "./ruleBasedFallback";
import { buildRepairPrompt, safeParseAIJson } from "./safeJson";
import { logAIUsage } from "./usageLogger";
import { estimateTokens, geminiModels, getAIProviderSettings, type AIJsonTask, type AIProviderConfig, type AIProviderName, type AIResult } from "./types";

type ProviderAttempt = {
  name: Exclude<AIProviderName, "rule_based">;
  config: AIProviderConfig;
  call: (prompt: string, config: AIProviderConfig) => Promise<string>;
};

function attemptsForTask<T>(task: AIJsonTask<T>): ProviderAttempt[] {
  const settings = getAIProviderSettings();
  const attempts: ProviderAttempt[] = [];
  for (const provider of settings.providerOrder) {
    if (provider === "claude" && claudeConfigured()) {
      attempts.push({ name: "claude", config: claudeConfig(settings.claudeModel), call: callClaudeProvider });
    }
    if (provider === "gemini" && geminiConfigured()) {
      for (const model of geminiModels(settings)) {
        attempts.push({ name: "gemini", config: geminiConfig(model), call: callGeminiProvider });
      }
    }
    if (provider === "nvidia") {
      attempts.push({ name: "nvidia", config: nvidiaConfig(), call: callNvidiaProvider });
    }
  }
  if (openrouterAllowed(task.purpose)) {
    attempts.push({ name: "openrouter", config: openrouterConfig(), call: callOpenRouterProvider });
  }
  return settings.enableFallbacks ? attempts : attempts.slice(0, 1);
}

function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GENAI_API_KEY);
}

function errorCode(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 120);
  return "unknown_ai_error";
}

async function callAndValidate<T>(input: {
  task: AIJsonTask<T>;
  attempt: ProviderAttempt;
  prompt: string;
  usedFallback: boolean;
}): Promise<AIResult<T>> {
  const started = Date.now();
  let rawText = "";
  try {
    rawText = await input.attempt.call(input.prompt, input.attempt.config);
    let parsed = safeParseAIJson(rawText, input.task.schema);

    if (!parsed.ok && getAIProviderSettings().maxRetries > 0) {
      const repairPrompt = buildRepairPrompt(rawText, input.task.schemaDescription);
      rawText = await input.attempt.call(repairPrompt, input.attempt.config);
      parsed = safeParseAIJson(rawText, input.task.schema);
    }

    const latencyMs = Date.now() - started;
    if (!parsed.ok) {
      await logAIUsage({
        companyId: input.task.companyId,
        userId: input.task.userId,
        provider: input.attempt.name,
        model: input.attempt.config.model,
        purpose: input.task.purpose,
        success: false,
        latencyMs,
        tokenEstimate: estimateTokens(input.prompt),
        usedFallback: input.usedFallback,
        errorCode: parsed.error,
      });
      return {
        ok: false,
        provider: input.attempt.name,
        model: input.attempt.config.model,
        rawText: undefined,
        error: parsed.error,
        confidence: 0,
        usedFallback: input.usedFallback,
        validationErrors: parsed.validationErrors,
      };
    }

    const confidence = typeof parsed.data === "object" && parsed.data && "confidence" in parsed.data
      ? Number((parsed.data as { confidence: unknown }).confidence)
      : 0.8;
    await logAIUsage({
      companyId: input.task.companyId,
      userId: input.task.userId,
      provider: input.attempt.name,
      model: input.attempt.config.model,
      purpose: input.task.purpose,
      success: true,
      latencyMs,
      tokenEstimate: estimateTokens(input.prompt),
      usedFallback: input.usedFallback,
    });
    return {
      ok: true,
      provider: input.attempt.name,
      model: input.attempt.config.model,
      data: parsed.data,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      usedFallback: input.usedFallback,
    };
  } catch (err) {
    await logAIUsage({
      companyId: input.task.companyId,
      userId: input.task.userId,
      provider: input.attempt.name,
      model: input.attempt.config.model,
      purpose: input.task.purpose,
      success: false,
      latencyMs: Date.now() - started,
      tokenEstimate: estimateTokens(input.prompt),
      usedFallback: input.usedFallback,
      errorCode: errorCode(err),
    });
    return {
      ok: false,
      provider: input.attempt.name,
      model: input.attempt.config.model,
      error: errorCode(err),
      confidence: 0,
      usedFallback: input.usedFallback,
    };
  }
}

export async function runAIJsonTask<T>(task: AIJsonTask<T>): Promise<AIResult<T>> {
  const prompt = buildFinanceTaskPrompt({
    taskName: task.schemaName,
    allowedData: task.input,
    schemaDescription: task.schemaDescription,
    taskInstructions: task.prompt,
  });
  const attempts = attemptsForTask(task);
  const validationErrors: string[] = [];

  for (let index = 0; index < attempts.length; index += 1) {
    const result = await callAndValidate({
      task,
      attempt: attempts[index],
      prompt,
      usedFallback: index > 0,
    });
    if (result.ok) return result;
    if (result.validationErrors) validationErrors.push(...result.validationErrors);
  }

  const fallback = ruleBasedFallback<T>(task.purpose, task.input);
  fallback.validationErrors = validationErrors.length > 0 ? validationErrors : undefined;
  return fallback;
}

export function getAIStatus() {
  const settings = getAIProviderSettings();
  return {
    claude: claudeConfigured() ? "configured" : "missing",
    gemini: geminiConfigured() ? "configured" : "missing",
    nvidia: (process.env.NVIDIA_API_KEY || process.env.Nvidia_API_Key) && process.env.NVIDIA_MODEL ? "configured" : "missing",
    openrouter: process.env.OPENROUTER_ENABLED === "true"
      ? (process.env.OPENROUTER_API_KEY || process.env.Openrouter_API_Key) && process.env.OPENROUTER_MODEL ? "configured" : "missing"
      : "disabled",
    currentPrimaryModel: settings.providerOrder.find(provider => (provider === "gemini" && geminiConfigured()) || (provider === "claude" && claudeConfigured())) === "claude" ? settings.claudeModel : settings.geminiModel,
    providerOrder: settings.providerOrder,
    ruleBasedFallbackActive: settings.enableFallbacks,
    openrouterEnabled: settings.openrouterEnabled,
  };
}
