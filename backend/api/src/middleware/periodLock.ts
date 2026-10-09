/**
 * Period-lock middleware.
 * Blocks POST, PATCH, PUT, DELETE on financial data routes when the
 * active month's period is locked in the period_locks table.
 *
 * Reads X-Period-Month header (YYYY-MM) or derives from current month.
 * CAs with `settings.manage_company` permission can still unlock via
 * the /periods/:month/unlock endpoint.
 */
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getCompanyId } from "./authz";
import { logger } from "../lib/logger";

/** Routes that should NOT be blocked by period lock (meta/auth/admin). */
const PERIOD_LOCK_EXEMPT = new Set([
  "/api/health",
  "/api/auth/demo",
  "/api/auth/logout",
  "/api/periods",           // lock/unlock itself
  "/api/workflow",          // run management
  "/api/ca-review",         // review actions always allowed
  "/api/settings",
  "/api/admin",
  "/api/docs",
]);

/** HTTP methods that are read-only — always allowed. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Cache lock status per (companyId, month) for 60s to avoid DB hammering. */
const lockCache = new Map<string, { locked: boolean; expiresAt: number }>();

async function isMonthLocked(companyId: number, yearMonth: string): Promise<boolean> {
  const cacheKey = `${companyId}:${yearMonth}`;
  const cached = lockCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.locked;

  const [yr, mo] = yearMonth.split("-");
  if (!yr || !mo) return false;

  try {
    const result = await db.execute(sql`
      SELECT locked FROM period_locks
      WHERE company_id = ${companyId}
        AND period_month = ${mo}
        AND period_year = ${parseInt(yr, 10)}
      LIMIT 1`);
    const row = result.rows[0] as { locked: boolean } | undefined;
    const locked = row?.locked === true;
    lockCache.set(cacheKey, { locked, expiresAt: Date.now() + 60_000 });
    return locked;
  } catch (err) {
    logger.warn({ err }, "period-lock check failed — defaulting to unlocked");
    return false;
  }
}

/** Call this from unlock endpoint to bust the cache immediately. */
export function bustPeriodLockCache(companyId: number, yearMonth: string) {
  lockCache.delete(`${companyId}:${yearMonth}`);
}

export function periodLockMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Pass through read-only methods immediately
    if (READ_METHODS.has(req.method)) { next(); return; }

    // Pass through exempt routes
    const path = req.path.replace(/^\/api/, "/api");
    for (const exempt of PERIOD_LOCK_EXEMPT) {
      if (path.startsWith(exempt)) { next(); return; }
    }

    // No auth yet? Let auth middleware handle it
    if (!req.auth?.companyId) { next(); return; }

    // Determine which month this write targets
    // Priority: X-Period-Month header → request body periodMonth → current month
    const headerMonth = req.headers["x-period-month"] as string | undefined;
    const bodyMonth = (req.body as Record<string, unknown> | undefined)?.periodMonth as string | undefined;
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const targetMonth = headerMonth ?? bodyMonth ?? currentMonth;

    const companyId = getCompanyId(req);
    const locked = await isMonthLocked(companyId, targetMonth);

    if (locked) {
      logger.warn({
        method: req.method,
        path: req.path,
        companyId,
        targetMonth,
        user: req.auth?.email,
      }, "period-lock: write blocked");

      res.status(423).json({
        error: `Period ${targetMonth} is locked. Contact your CA to unlock before making changes.`,
        period: targetMonth,
        locked: true,
        unlockUrl: `/api/periods/${targetMonth}/unlock`,
      });
      return;
    }

    next();
  };
}
