import type { LedgerMapping } from "./tallyVoucherXml";

/** Newest batches first. A later export of one party must not forget earlier approved choices. */
export function mergeLedgerPreferences(batches: unknown[]): LedgerMapping[] {
  const choices = new Map<string, LedgerMapping>();
  for (const batch of batches) {
    if (!Array.isArray(batch)) continue;
    for (const value of batch) {
      if (!value || typeof value.counterparty !== "string" || typeof value.ledgerName !== "string") continue;
      const counterparty = value.counterparty.trim();
      const ledgerName = value.ledgerName.trim();
      const key = counterparty.toLowerCase();
      if (!key || !ledgerName || counterparty.length > 200 || ledgerName.length > 200 || ledgerName === "Suspense") continue;
      if (!choices.has(key)) choices.set(key, { counterparty, ledgerName });
    }
  }
  return [...choices.values()];
}
