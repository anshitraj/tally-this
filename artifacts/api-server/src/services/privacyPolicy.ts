/**
 * Rules for privacy mode and the history window. Pure: no database, no network.
 *
 * Privacy mode saves nothing: no run, no result, no ledger choices, no audit detail, no AI usage log.
 * AI is used only when a file cannot be read without it, only with the person's consent for that
 * file, and only when the operator has confirmed the AI keys are on a paid, no-training plan.
 */

import { supportEmail } from "../lib/brand";

export const PLANS = ["free", "starter", "growth", "ca_firm", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanInfo {
  plan: string;
  until: Date | null;
}

function list(value: string | undefined, fallback: string[]) {
  const items = (value ?? "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

/** Plans that include privacy mode. Everything except free by default. */
export function privacyPlans(env: Record<string, string | undefined> = process.env) {
  return list(env.PRIVACY_MODE_PLANS, ["starter", "growth", "ca_firm", "enterprise"]);
}

/** A plan counts while it has no end date or the end date is still ahead. */
export function planIsActive(info: PlanInfo, now = new Date()) {
  if (!info.plan || info.plan.toLowerCase() === "free") return false;
  return info.until == null || info.until.getTime() > now.getTime();
}

export function privacyAvailable(info: PlanInfo, env: Record<string, string | undefined> = process.env, now = new Date()) {
  return planIsActive(info, now) && privacyPlans(env).includes(info.plan.toLowerCase());
}

/** Form fields and JSON bodies both carry "1", "true" or true. */
export function truthy(value: unknown) {
  return value === true || value === "1" || value === 1 || (typeof value === "string" && value.toLowerCase() === "true");
}

/** Operator confirmation that AI keys are paid-tier, so content is not used to train models. */
export function privacyAiConfirmed(env: Record<string, string | undefined> = process.env) {
  return truthy(env.PRIVACY_AI_ALLOWED);
}

export type AiDecision =
  | "use_ai" //          go ahead
  | "ask_consent" //     privacy mode: a scan needs AI; ask the person first
  | "ai_blocked" //      privacy mode: AI is not confirmed for private use; do not send anything
  | "no_ai_needed"; //   privacy mode: the file was read without AI

/**
 * Decides whether a file may be sent to AI.
 *  - Outside privacy mode AI is used whenever it is configured and the file needs it.
 *  - In privacy mode, a file already read without AI never goes to AI.
 */
export function aiDecision(input: {
  privacy: boolean;
  allowAi: boolean;
  aiConfigured: boolean;
  readWithoutAi: boolean;
  confirmed?: boolean;
}): AiDecision {
  if (!input.privacy) return "use_ai";
  if (input.readWithoutAi) return "no_ai_needed";
  if (!input.aiConfigured || !(input.confirmed ?? privacyAiConfirmed())) return "ai_blocked";
  return input.allowAi ? "use_ai" : "ask_consent";
}

export const PRIVACY_NOT_AVAILABLE =
  "Privacy mode is part of our paid plans. Email us to upgrade and it will be switched on for your account.";

export const AI_CONSENT_MESSAGE =
  "This file is a scan, so an AI service has to read it. It is sent over an encrypted connection to Google Gemini on a paid business account: Google does not use it to train its models and may keep a log for a limited time to prevent abuse. TallyThis does not save the file or the result.";

export const AI_BLOCKED_MESSAGE =
  "This file is a scan and needs AI to read it, which is switched off in privacy mode. Download the statement as Excel or CSV from your bank, or use a PDF from net banking.";

// ── History window ──────────────────────────────────────────────────────────

export function historyMonths(env: Record<string, string | undefined> = process.env) {
  const months = Math.floor(Number(env.HISTORY_MONTHS));
  return Number.isFinite(months) && months >= 1 ? Math.min(months, 120) : 3;
}

export function outsideWindowMessage(months = historyMonths(), email = supportEmail()) {
  return `This item is older than ${months} months. It is kept safely: ${email ? `email us at ${email}` : "contact us"} and we will send it to you.`;
}

/** Items older than this are kept in the database but not shown. */
export function historyCutoff(months = historyMonths(), now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff;
}
