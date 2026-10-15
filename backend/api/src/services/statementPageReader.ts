/**
 * Reads a long scanned statement in page groups, several at a time, and joins them in page order.
 * Which model answers, and how, is the caller's business: this schedules the groups, stops when
 * nothing is being read, re-reads the groups whose joins do not prove, and refuses to return a
 * statement with missing pages.
 */
import type { AIProviderName } from "../server/ai/types";
import { normalizeDate } from "./bankStatement";
import { compactPrompt, finishAiRead, toSummary, type AIBankStatement, type AIStatementRead } from "./aiStatementShape";
import { paise } from "./money";
import { AI_GROUP_FAILURES_BEFORE_STOP, pageRanges } from "./statementReadPlan";
import { chronological } from "./statementCheck";
import { outOfOrderIndices } from "./dateOrder";

/** Page groups that may be read again by the strongest model. A scan this broken is better re-uploaded. */
const MAX_REPAIRS = 24;

type Row = AIBankStatement["transactions"][number];

/** Joins the answers for consecutive page groups into one statement, in page order. */
export function mergeStatements(parts: AIBankStatement[]): AIBankStatement {
  const first = <K extends "bankName" | "ifsc" | "accountNumberLast4" | "periodFrom">(key: K) => parts.map(part => part[key]).find(value => value) ?? null;
  const lastPeriodEnd = [...parts].reverse().map(part => part.periodTo).find(value => value) ?? null;
  return {
    bankName: first("bankName"),
    ifsc: first("ifsc"),
    accountNumberLast4: first("accountNumberLast4"),
    periodFrom: first("periodFrom"),
    periodTo: lastPeriodEnd,
    // The opening balance is printed with the first pages and the closing balance with the last ones.
    // A balance that a middle page carries forward belongs to that page, not to the statement.
    openingBalance: parts[0]?.openingBalance ?? null,
    closingBalance: parts[parts.length - 1]?.closingBalance ?? null,
    transactions: parts.flatMap(part => part.transactions),
  };
}

function groupPrompt(pages: number[], total: number) {
  return compactPrompt(pageRanges(pages), total);
}

export type DocFile = { data: Buffer; mimeType: string };

export type PageGroupReader = (input: {
  files: DocFile[];
  prompt: string;
  pages: number[];
  /** A second look at a group that did not prove: the strongest model only. */
  strong?: boolean;
}) => Promise<
  | { ok: true; data: AIBankStatement; provider: AIProviderName; model: string }
  | { ok: false; error: string }
>;

/** Does `newer` follow `older` on the running balance? null when a balance is missing. */
function joinHolds(older: Row, newer: Row): boolean | null {
  const before = older.balance == null ? null : paise(older.balance);
  const after = newer.balance == null ? null : paise(newer.balance);
  const credit = paise(newer.credit ?? 0);
  const debit = paise(newer.debit ?? 0);
  if (before == null || after == null || credit == null || debit == null) return null;
  return before + credit - debit === after;
}

/**
 * Rows of one group that do not follow the balance within the group. Only the first group of the
 * statement has an opening balance to start from; for any other group the first row has nothing
 * before it, whatever balance the model reported as carried forward.
 */
function internalFailures(part: AIBankStatement, first: boolean): number {
  return toSummary(first ? part : { ...part, openingBalance: null }, "group").check.failed;
}

/** Pairs of neighbouring non-empty groups (by index) where the balance does not carry across the join. */
function brokenJoins(parts: Array<AIBankStatement | null>): Array<[number, number]> {
  const dated = parts.flatMap(part => (part?.transactions ?? []).map(row => ({ date: normalizeDate(row.date) ?? "" })));
  // chronological() hands back the same array unless the statement runs newest first.
  const newestFirst = chronological(dated) !== dated;
  const broken: Array<[number, number]> = [];
  let previous = -1;
  parts.forEach((part, index) => {
    if (!part || part.transactions.length === 0) return;
    if (previous >= 0) {
      const before = parts[previous]!.transactions;
      const older = newestFirst ? part.transactions[0] : before[before.length - 1];
      const newer = newestFirst ? before[before.length - 1] : part.transactions[0];
      if (joinHolds(older, newer) === false) broken.push([previous, index]);
    }
    previous = index;
  });
  return broken;
}

/** Per group, how many rows have a date outside the run of dates the rest of the statement agrees on. */
function datesOutOfOrder(parts: Array<AIBankStatement | null>): number[] {
  const items: Array<{ group: number; date: string }> = [];
  parts.forEach((part, group) => {
    for (const row of part?.transactions ?? []) {
      const date = normalizeDate(row.date);
      if (date) items.push({ group, date });
    }
  });
  const newestFirst = chronological(items) !== items;
  const ordered = newestFirst ? [...items].reverse() : items;
  const counts = new Array<number>(parts.length).fill(0);
  for (const index of outOfOrderIndices(ordered.map(item => item.date))) counts[ordered[index].group] += 1;
  return counts;
}

/**
 * Groups that cannot be trusted yet: ones whose own rows do not follow the balance, and the groups
 * at a join where the balance does not carry from one group to the next. A group the model invented
 * a consistent balance for proves itself, but not against its neighbours.
 *
 * A broken join alone cannot say which side is wrong, so both sides are suspect. When a group is
 * broken at both of its joins it is the likely culprit and only it is suspect.
 */
export function suspectGroups(parts: Array<AIBankStatement | null>): number[] {
  const suspects = new Set<number>();
  parts.forEach((part, index) => {
    if (part && part.transactions.length > 0 && internalFailures(part, index === 0) > 0) suspects.add(index);
  });
  // Dates the rest of the statement contradicts: a month or year misread across a whole page.
  datesOutOfOrder(parts).forEach((count, index) => {
    if (count > 0) suspects.add(index);
  });
  const broken = brokenJoins(parts);
  const degree = new Map<number, number>();
  for (const [before, after] of broken) {
    degree.set(before, (degree.get(before) ?? 0) + 1);
    degree.set(after, (degree.get(after) ?? 0) + 1);
  }
  for (const [before, after] of broken) {
    const culprits = [before, after].filter(index => degree.get(index) === 2);
    for (const index of culprits.length > 0 ? culprits : [before, after]) suspects.add(index);
  }
  return [...suspects].sort((a, b) => a - b);
}

/**
 * How badly group `index` fits: its rows that break the balance, its broken joins and its dates
 * that run against the rest of the statement. Lower is better.
 */
function misfit(parts: Array<AIBankStatement | null>, index: number): number {
  const part = parts[index];
  if (!part) return Number.MAX_SAFE_INTEGER;
  const joins = brokenJoins(parts).filter(([before, after]) => before === index || after === index).length;
  return internalFailures(part, index === 0) + joins + datesOutOfOrder(parts)[index];
}

/** A re-read replaces a group only when it fits its neighbours better, or equally well with more rows. */
function improves(parts: Array<AIBankStatement | null>, index: number, candidate: AIBankStatement): boolean {
  const current = parts[index];
  if (!current) return true;
  const trial = parts.slice();
  trial[index] = candidate;
  const difference = misfit(trial, index) - misfit(parts, index);
  if (difference !== 0) return difference < 0;
  return candidate.transactions.length > current.transactions.length;
}

/**
 * Reads a long scanned statement in page groups, several at a time, and joins them in page order.
 * The running balance is then checked across the joins, so a group that was misread or skipped
 * shows up as rows that do not follow the balance, and the groups on either side of a broken join
 * are read again by the strongest model. If any group cannot be read nothing is returned:
 * a statement with missing pages must never look complete.
 */
export async function readBankStatementByPages(input: {
  fileName: string;
  totalPages: number;
  groups: number[][];
  render: (pages: number[]) => Promise<DocFile[]>;
  concurrency: number;
  budgetMs: number;
  onProgress?: (done: number, total: number) => void;
  /** Called once when some groups are about to be read again, with how many. */
  onRepair?: (groups: number) => void;
  /** A group could not be rendered or read; `reason` is a status, never file content. */
  onGroupError?: (pages: number[], reason: string) => void;
  /** Reads one group of page images. */
  read: PageGroupReader;
}): Promise<{ ok: true; read: AIStatementRead; groups: number; repaired: number } | { ok: false; error: string; failedPages: number[] }> {
  const total = input.groups.length;
  const parts: Array<AIBankStatement | null> = new Array(total).fill(null);
  const failed: number[] = [];
  const deadline = Date.now() + input.budgetMs;
  let usedProvider: { provider: AIProviderName; model: string } | null = null;
  let finished = 0;
  let succeeded = 0;
  let stopped = false;

  /** Runs `task` for every index, `concurrency` at a time. */
  const pool = async (indices: number[], task: (index: number) => Promise<void>) => {
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const position = cursor;
        cursor += 1;
        if (position >= indices.length) return;
        await task(indices[position]);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency, indices.length)) }, worker));
  };

  await pool(Array.from({ length: total }, (_, index) => index), async index => {
    const pages = input.groups[index];
    if (stopped || Date.now() > deadline) {
      failed.push(index);
      return;
    }
    try {
      const files = await input.render(pages);
      const result = await input.read({ files, prompt: groupPrompt(pages, input.totalPages), pages });
      if (result.ok) {
        parts[index] = result.data;
        succeeded += 1;
        if (!usedProvider) usedProvider = { provider: result.provider, model: result.model };
      } else {
        failed.push(index);
      }
    } catch (err) {
      input.onGroupError?.(pages, err instanceof Error ? err.message.slice(0, 120) : "render_failed");
      failed.push(index);
    }
    finished += 1;
    input.onProgress?.(finished, total);
    // Nothing is being read at all (no credit, no key, model down): stop spending time on the rest.
    if (succeeded === 0 && failed.length >= AI_GROUP_FAILURES_BEFORE_STOP) stopped = true;
  });

  if (failed.length > 0) {
    return { ok: false, error: "pages_not_read", failedPages: failed.flatMap(index => input.groups[index]).sort((a, b) => a - b) };
  }

  // Second look: the groups whose rows or joins do not follow the running balance, by the strongest
  // model. One round only; what still does not prove stays flagged for the reviewer.
  let repaired = 0;
  const suspects = suspectGroups(parts).slice(0, MAX_REPAIRS);
  if (suspects.length > 0 && Date.now() < deadline) {
    input.onRepair?.(suspects.length);
    await pool(suspects, async index => {
      if (Date.now() > deadline) return;
      const pages = input.groups[index];
      try {
        const files = await input.render(pages);
        const result = await input.read({ files, prompt: groupPrompt(pages, input.totalPages), pages, strong: true });
        if (result.ok && improves(parts, index, result.data)) {
          parts[index] = result.data;
          repaired += 1;
        }
      } catch (err) {
        input.onGroupError?.(pages, err instanceof Error ? err.message.slice(0, 120) : "render_failed");
      }
    });
  }

  const merged = mergeStatements(parts.filter((part): part is AIBankStatement => part != null));
  const { summary, check } = toSummary(merged, input.fileName);
  if (summary.transactions.length === 0) return { ok: false, error: "no_transactions_read", failedPages: [] };
  finishAiRead(summary, check);
  const used = usedProvider ?? { provider: "gemini" as AIProviderName, model: "" };
  return { ok: true, read: { summary, check, provider: used.provider, model: used.model }, groups: total, repaired };
}
