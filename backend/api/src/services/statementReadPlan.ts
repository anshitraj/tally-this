/**
 * How a bank statement PDF is read. Pure rules, no network.
 *
 * The table reader is exact and takes a moment even for hundreds of pages. AI is a second opinion
 * for short statements and the only reader for scans. A scan is read in small page groups so that a
 * 150-page statement is many quick requests that each fit in one answer, never one request that cannot.
 */
import { availableParallelism } from "node:os";
import type { StatementCheck } from "./statementCheck";

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A statement this short may be read by AI as one document. */
export const WHOLE_DOCUMENT_PAGES = envNumber("AI_WHOLE_DOCUMENT_PAGES", 12);
/** Pages sent in one AI request when a long statement is read in groups. */
export const PAGES_PER_AI_CALL = envNumber("AI_PAGES_PER_CALL", 2);
/** Page groups read at the same time. */
export const AI_CALLS_IN_FLIGHT = envNumber("AI_CALLS_IN_FLIGHT", 8);
/** One model's attempt at one page group. A slow or stuck model is dropped for the next one. */
export const AI_CALL_TIMEOUT_MS = envNumber("AI_CALL_TIMEOUT_MS", 150_000);
/** The page-group read stops here and returns nothing partial. */
export const AI_READ_BUDGET_MS = envNumber("AI_READ_BUDGET_MS", 20 * 60_000);
/** Models tried for one page group before it counts as unreadable. */
export const AI_ATTEMPTS_PER_GROUP = 3;
/** Page groups that may fail with nothing read before the whole read stops. */
export const AI_GROUP_FAILURES_BEFORE_STOP = 3;

function defaultOcrWorkers() {
  const cores = typeof availableParallelism === "function" ? availableParallelism() : 2;
  return Math.max(1, Math.min(8, cores - 1));
}

/** The longest scan local OCR reads. A longer one is refused, never half read. */
export const OCR_MAX_PAGES = envNumber("OCR_MAX_PAGES", 200);
/** Pages OCR reads at the same time: one per spare CPU core. */
export const OCR_PAGES_IN_FLIGHT = envNumber("OCR_PAGES_IN_FLIGHT", defaultOcrWorkers());
/** The OCR read stops here and returns nothing partial. */
export const OCR_BUDGET_MS = envNumber("OCR_BUDGET_MS", 10 * 60_000);
/** Pages that may fail with nothing read before the whole OCR read stops. */
export const OCR_PAGE_FAILURES_BEFORE_STOP = 3;
/** Characters of real text a page must carry before its text layer is trusted. */
export const TEXT_LAYER_MIN_CHARS = 40;

/**
 * 1-based numbers of the pages whose text layer is too thin to trust. Only these need OCR: a page
 * with a real text layer is read from it exactly, and a statement of text pages is never OCR'd.
 */
export function pagesNeedingOcr(pages: Array<{ num: number; text: string }>, minChars = TEXT_LAYER_MIN_CHARS): number[] {
  return pages
    .filter(page => page.text.replace(/\s+/g, "").length < minChars)
    .map(page => page.num)
    .sort((a, b) => a - b);
}

/**
 * Every row moves the running balance by exactly its amount. The first row may lack an opening
 * balance and the last a printed closing balance, so this is not "verified", but a missing or
 * misread row anywhere in between would break it.
 */
export function chainIntact(check: StatementCheck | null | undefined): boolean {
  if (!check || check.rows === 0) return false;
  return check.failed === 0 && check.checked >= check.rows - 1 && check.closingMatches !== false && check.serialComplete !== false;
}

export type AiPlan =
  /** The table read stands: nothing for AI to add. */
  | "skip"
  /** One request with the whole file. */
  | "whole_document"
  /** Many requests, a few pages each, joined in page order. */
  | "by_pages";

export function planAiRead(input: { hasTableRead: boolean; check?: StatementCheck | null; pageCount: number }): AiPlan {
  const short = input.pageCount <= WHOLE_DOCUMENT_PAGES;
  if (input.hasTableRead) {
    // A long statement the table reader got through is never sent whole: no answer could hold it.
    // Rows that do not follow the running balance stay flagged for the reviewer.
    if (!short) return "skip";
    return chainIntact(input.check) ? "skip" : "whole_document";
  }
  return short ? "whole_document" : "by_pages";
}

/** Page numbers (1-based) split into groups of at most `size`, in order. */
export function pageGroups(total: number, size = PAGES_PER_AI_CALL): number[][] {
  const groups: number[][] = [];
  for (let start = 1; start <= total; start += size) {
    const group: number[] = [];
    for (let page = start; page < start + size && page <= total; page += 1) group.push(page);
    groups.push(group);
  }
  return groups;
}

/** "3–6, 9" for page numbers, so a message can say exactly which pages were not read. */
export function pageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index];
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) {
      index += 1;
      end = sorted[index];
    }
    parts.push(start === end ? String(start) : `${start}–${end}`);
  }
  return parts.join(", ");
}
