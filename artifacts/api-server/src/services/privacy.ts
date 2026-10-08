/**
 * Plan lookup and the privacy-mode gate used by the job routes.
 * Entitlement belongs to the signed-in person's own workspace, not to the client being worked on.
 */
import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { PRIVACY_NOT_AVAILABLE, privacyAvailable, truthy, type PlanInfo } from "./privacyPolicy";

export async function planFor(companyId: number): Promise<PlanInfo> {
  try {
    const result = await db.execute(sql`SELECT plan, plan_until FROM companies WHERE id = ${companyId} LIMIT 1`);
    const row = result.rows[0] as { plan?: string | null; plan_until?: string | Date | null } | undefined;
    return { plan: row?.plan ?? "free", until: row?.plan_until ? new Date(row.plan_until) : null };
  } catch {
    // A database without the plan columns behaves as everyone being on the free plan.
    return { plan: "free", until: null };
  }
}

export interface PrivacyGate {
  /** Nothing about this request may be saved. */
  privacy: boolean;
  /** The person agreed to send a scan to AI for this file. Only meaningful in privacy mode. */
  allowAi: boolean;
}

/**
 * Reads the privacy flag. When it is set and the account has no paid plan the request is
 * refused: it never quietly falls back to saving. Returns null after sending that reply.
 */
export async function privacyGate(req: Request, res: Response): Promise<PrivacyGate | null> {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const privacy = truthy(body.privacy) || truthy(req.query.privacy);
  if (!privacy) return { privacy: false, allowAi: true };
  const info = await planFor(req.auth!.companyId);
  if (!privacyAvailable(info)) {
    res.status(403).json({ ok: false, code: "privacy_not_available", message: PRIVACY_NOT_AVAILABLE });
    return null;
  }
  return { privacy: true, allowAi: truthy(body.allowAi) };
}
