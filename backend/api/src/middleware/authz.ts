import type { NextFunction, Request, Response } from "express";
import { db } from "@workspace/db";
import { auditLogsTable, authSessionsTable, rolePermissionsTable, usersTable } from "@workspace/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { bearerToken, tokenHash, verifyAuthToken } from "../services/auth";

export interface AuthContext {
  userId: number;
  companyId: number;
  sessionId: number;
  email: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      booksCompanyId?: number;
    }
  }
}

export async function attachAuthContext(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      next();
      return;
    }

    const payload = verifyAuthToken(token);
    if (!payload) {
      next();
      return;
    }

    const [session] = await db.select().from(authSessionsTable).where(and(
      eq(authSessionsTable.id, payload.sid),
      eq(authSessionsTable.userId, payload.sub),
      eq(authSessionsTable.companyId, payload.cid),
      eq(authSessionsTable.tokenHash, tokenHash(token)),
      gt(authSessionsTable.expiresAt, new Date()),
      isNull(authSessionsTable.revokedAt),
    )).limit(1);

    if (!session) {
      next();
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, payload.sub)).limit(1);
    if (!user || user.companyId !== payload.cid || user.status !== "active") {
      next();
      return;
    }

    req.auth = {
      userId: user.id,
      companyId: payload.cid,
      sessionId: session.id,
      email: user.email,
      role: user.role,
    };
  } catch {
    // Authentication failures should fall through to route-level 401s.
  }

  next();
}

export function getCompanyId(req: Request): number {
  if (!req.auth) {
    throw new Error("Authenticated company context is required");
  }
  return req.booksCompanyId ?? req.auth.companyId;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const [allowed] = await db.select().from(rolePermissionsTable).where(and(
      eq(rolePermissionsTable.companyId, req.auth.companyId),
      eq(rolePermissionsTable.role, req.auth.role),
      eq(rolePermissionsTable.permission, permission),
      eq(rolePermissionsTable.enabled, true),
    )).limit(1);

    if (!allowed) {
      await db.insert(auditLogsTable).values({
        companyId: req.auth.companyId,
        userId: req.auth.userId,
        actorEmail: req.auth.email,
        action: "auth.permission_denied",
        entityType: "permission",
        metadata: { permission, role: req.auth.role, path: req.path, method: req.method },
        ipAddress: req.ip,
      });
      res.status(403).json({ error: "Permission denied", permission });
      return;
    }

    next();
  };
}

/**
 * Events about the person's own workspace (signing in, settings, their list of clients) belong to that workspace. Everything
 * else is work on somebody's books (a bank statement read, a decision, a download) and is recorded against the books it was
 * done on: the client's when a CA is working on a client, which is what that client's Activity page lists.
 */
const OWN_WORKSPACE_EVENTS = /^(auth|settings|practice|account|roles)\./;

export function auditCompanyId(req: Request, action: string): number {
  if (!req.auth) throw new Error("Authenticated company context is required");
  return OWN_WORKSPACE_EVENTS.test(action) ? req.auth.companyId : req.booksCompanyId ?? req.auth.companyId;
}

export async function auditAction(req: Request, action: string, entityType: string, entityId?: number | null, metadata?: Record<string, unknown>) {
  if (!req.auth) return;
  await db.insert(auditLogsTable).values({
    companyId: auditCompanyId(req, action),
    userId: req.auth.userId,
    actorEmail: req.auth.email,
    action,
    entityType,
    entityId: entityId ?? null,
    metadata: metadata ?? {},
    ipAddress: req.ip,
  });
}
