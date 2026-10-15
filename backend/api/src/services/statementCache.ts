/**
 * Remembers what a statement read produced, so the same file uploaded again is answered at once
 * instead of being read again (a long scan can take minutes and a paid AI call per page group).
 *
 * Server memory only: nothing is written to disk or the database, a restart empties it, and an entry
 * is dropped after a short time. It is per company and keyed by the file's content, so it can only
 * ever answer the company that already uploaded exactly the same bytes. Privacy mode never uses it.
 */
import { createHash } from "node:crypto";
import type { StatementRead } from "./fileReaders";

const KEEP_MS = 30 * 60_000;
const MAX_ENTRIES = 12;

const entries = new Map<string, { at: number; read: StatementRead }>();

function digest(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Same company, same bytes, same password and same AI choice. The password is part of the key, as a
 * hash, so a locked file is never opened for someone who did not type its password.
 */
export function statementCacheKey(input: { companyId: number; buffer: Buffer; password?: string; allowAi: boolean }): string {
  return [input.companyId, digest(input.buffer), input.password ? digest(input.password) : "", input.allowAi ? "ai" : "no-ai"].join(":");
}

export function recallStatement(key: string, now = Date.now()): StatementRead | null {
  const hit = entries.get(key);
  if (!hit) return null;
  if (now - hit.at > KEEP_MS) {
    entries.delete(key);
    return null;
  }
  // A copy, so a caller that edits its rows never changes what is remembered.
  return structuredClone(hit.read);
}

/** Only a read that produced a statement is remembered: a failure is worth trying again. */
export function rememberStatement(key: string, read: StatementRead, now = Date.now()) {
  if (!read.ok || !read.summary) return;
  for (const [id, entry] of entries) if (now - entry.at > KEEP_MS) entries.delete(id);
  entries.delete(key);
  entries.set(key, { at: now, read: structuredClone(read) });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Test helper. */
export function clearStatementCache() {
  entries.clear();
}
