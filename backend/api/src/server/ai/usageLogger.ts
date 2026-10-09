import { aiUsageLogsTable, db } from "@workspace/db";
import { logger } from "../../lib/logger";
import type { AIProviderName, AIRequestPurpose } from "./types";

export async function logAIUsage(input: {
  companyId?: number | null;
  userId?: number | null;
  provider: AIProviderName;
  model?: string | null;
  purpose: AIRequestPurpose;
  success: boolean;
  latencyMs: number;
  tokenEstimate?: number | null;
  usedFallback: boolean;
  errorCode?: string | null;
}) {
  if ((process.env.AI_ENABLE_LOGGING ?? "true") !== "true") return;

  try {
    await db.insert(aiUsageLogsTable).values({
      companyId: input.companyId ?? null,
      userId: input.userId ?? null,
      provider: input.provider,
      model: input.model ?? null,
      purpose: input.purpose,
      success: input.success,
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      tokenEstimate: input.tokenEstimate ?? null,
      usedFallback: input.usedFallback,
      errorCode: input.errorCode ?? null,
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : "unknown" }, "AI usage log write failed");
  }
}
