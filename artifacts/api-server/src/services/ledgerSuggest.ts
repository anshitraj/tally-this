/**
 * Groups bank rows by party and proposes a Tally ledger for each group.
 * Order: the client's remembered choice → keyword rules (instant) → Claude/Gemini
 * picking from the fixed ledger list (asked for separately so the upload stays fast).
 * The person confirms every choice before export.
 */
import { z } from "zod";
import { runAIJsonTask } from "../server/ai/providerRouter";
import type { NormalizedBankTxn } from "./bankStatement";
import { LEDGER_OPTIONS, partyKey, suggestLedger, type LedgerMapping } from "./tallyVoucherXml";

export type LedgerSource = "remembered" | "rule" | "ai" | "none";

export interface LedgerGroup {
  key: string;
  label: string;
  ledger: string;
  source: LedgerSource;
  count: number;
  total: number;
  direction: "in" | "out" | "both";
  sample: string;
}

export const groupKey = partyKey;

/** Remembered choices and keyword rules only. No network calls. */
export function groupLedgers(transactions: NormalizedBankTxn[], remembered: LedgerMapping[]): LedgerGroup[] {
  const groups = new Map<string, LedgerGroup>();
  for (const txn of transactions) {
    const key = groupKey(txn);
    if (!key) continue;
    const amount = txn.debit ?? txn.credit ?? 0;
    const direction = txn.credit != null ? "in" : "out";
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.total += amount;
      if (existing.direction !== direction) existing.direction = "both";
      continue;
    }
    const memory = remembered.find(mapping => mapping.counterparty && mapping.counterparty.toLowerCase() === key.toLowerCase());
    const rule = suggestLedger(txn.narration, [], direction);
    groups.set(key, {
      key,
      label: key,
      ledger: memory?.ledgerName ?? rule,
      source: memory ? "remembered" : rule !== "Suspense" ? "rule" : "none",
      count: 1,
      total: amount,
      direction,
      sample: txn.narration.slice(0, 120),
    });
  }
  return [...groups.values()]
    .map(group => ({ ...group, total: Math.round(group.total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);
}

const aiSchema = z.object({
  suggestions: z.array(z.object({
    key: z.string(),
    ledger: z.string(),
  })),
});

/** Asks AI to pick a ledger from the fixed list for parties the rules could not place. */
export async function aiLedgerPicks(
  parties: Array<{ key: string; direction: "in" | "out" | "both"; sample: string }>,
  ctx: { companyId?: number | null; userId?: number | null } = {},
): Promise<Array<{ key: string; ledger: string }>> {
  const unknown = parties.slice(0, 60);
  if (unknown.length === 0) return [];
  const allowed = new Set<string>(LEDGER_OPTIONS);
  const result = await runAIJsonTask({
    companyId: ctx.companyId,
    userId: ctx.userId,
    purpose: "ledger_suggestion",
    schemaName: "ledger_suggestion_batch",
    schema: aiSchema,
    schemaDescription: '{"suggestions":[{"key": string, "ledger": string}]}',
    input: {
      ledgerChoices: LEDGER_OPTIONS,
      parties: unknown.map(party => ({
        key: party.key,
        direction: party.direction === "in" ? "money received" : party.direction === "out" ? "money paid" : "both",
        narration: party.sample,
      })),
    },
    prompt: [
      "Each party comes from an Indian bank statement narration.",
      "For each party choose exactly one ledger from ledgerChoices.",
      "Use Sundry Debtors for customers who pay us and Sundry Creditors for vendors we pay when no expense ledger fits.",
      "Transfers between the account holder's own accounts, and anything unclear, are Suspense.",
      "Return the key exactly as given.",
    ].join(" "),
  }).catch(() => null);
  if (!result?.ok || result.provider === "rule_based") return [];
  const parsed = aiSchema.safeParse(result.data);
  if (!parsed.success) return [];
  const keys = new Set(unknown.map(party => party.key));
  return parsed.data.suggestions.filter(item => keys.has(item.key) && allowed.has(item.ledger));
}
