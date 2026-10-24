/**
 * Removes secrets from text before it is logged.
 *
 * Database and provider errors can carry the whole connection string (user, password and host) or an API
 * key inside their message. Logs are shared with support and with the hosting dashboard, so those values
 * must never reach them. This is a safety net for the places that log a whole error object, not a reason
 * to log secrets on purpose.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s"'<>`]+/gi, "$1://<hidden>"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "<key hidden>"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, "<key hidden>"],
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g, "<key hidden>"],
  [/\bre_[A-Za-z0-9_]{20,}/g, "<key hidden>"],
  [/\bnpg_[A-Za-z0-9]{10,}/g, "<key hidden>"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 <hidden>"],
  [/\b(password|passwd|secret|token|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi, "$1$2<hidden>"],
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** A copy of the value with every string scrubbed. Deep enough for log objects, safe against cycles. */
export function scrubValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubSecrets(value);
  if (value === null || typeof value !== "object" || depth > 6) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  // An error keeps being an error (so the logger still prints its type, message and stack), with the
  // secrets taken out of the text.
  if (value instanceof Error) {
    const clone = Object.create(Object.getPrototypeOf(value)) as Error;
    for (const key of ["message", "stack"] as const) {
      if (typeof value[key] === "string") Object.defineProperty(clone, key, { value: scrubSecrets(value[key] as string), writable: true, configurable: true, enumerable: false });
    }
    for (const [key, inner] of Object.entries(value)) (clone as unknown as Record<string, unknown>)[key] = scrubValue(inner, depth + 1, seen);
    if ("cause" in value) Object.defineProperty(clone, "cause", { value: scrubValue((value as { cause?: unknown }).cause, depth + 1, seen), writable: true, configurable: true, enumerable: false });
    return clone;
  }
  if (Array.isArray(value)) return value.map(item => scrubValue(item, depth + 1, seen));
  const copy: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) copy[key] = scrubValue(inner, depth + 1, seen);
  return copy;
}
