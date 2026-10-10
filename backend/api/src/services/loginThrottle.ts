/**
 * Slows down password guessing. Failed sign-ins are counted per email address (not per network
 * address, which behind a proxy can be one address for everyone) and the same limit applies whether
 * or not the account exists, so the answer never reveals which emails are registered.
 */
export interface ThrottleState {
  blocked: boolean;
  retryAfterSeconds: number;
}

export interface LoginThrottle {
  check(key: string, now?: number): ThrottleState;
  fail(key: string, now?: number): void;
  reset(key: string): void;
}

export function createLoginThrottle(options: { maxFailures?: number; windowMs?: number } = {}): LoginThrottle {
  const maxFailures = options.maxFailures ?? 8;
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const failures = new Map<string, { count: number; since: number }>();

  const prune = (now: number) => {
    if (failures.size < 5000) return;
    for (const [key, entry] of failures) if (now - entry.since >= windowMs) failures.delete(key);
  };

  return {
    check(key, now = Date.now()) {
      const entry = failures.get(key);
      if (!entry || now - entry.since >= windowMs) return { blocked: false, retryAfterSeconds: 0 };
      if (entry.count < maxFailures) return { blocked: false, retryAfterSeconds: 0 };
      return { blocked: true, retryAfterSeconds: Math.ceil((entry.since + windowMs - now) / 1000) };
    },
    fail(key, now = Date.now()) {
      prune(now);
      const entry = failures.get(key);
      if (!entry || now - entry.since >= windowMs) failures.set(key, { count: 1, since: now });
      else entry.count += 1;
    },
    reset(key) {
      failures.delete(key);
    },
  };
}

export function throttleMessage(retryAfterSeconds: number) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many sign-in attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}
