/**
 * Neon Auth sign-in. The browser signs in with Neon and sends us the signed token it received.
 * We check the token, find (or create) the matching TallyThis account and hand back the same
 * session the older email/password sign-in returns, so every other route works unchanged.
 */
import { Router, type IRouter, type Request } from "express";
import { sql, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { auditLogsTable, authSessionsTable, companiesTable, rolePermissionsTable, usersTable } from "@workspace/db";
import { sessionDurationMs, signAuthToken, tokenHash } from "../services/auth";
import { defaultRolePermissions } from "../services/permissions";
import {
  NEON_REJECTION_MESSAGES,
  createNeonTokenVerifier,
  exchangeNeonToken,
  neonAuthConfig,
  type AppUserRecord,
  type ExchangeDeps,
  type NeonUserRecord,
} from "../services/neonAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Database adapters ───────────────────────────────────────────────────────

async function loadNeonUser(id: string): Promise<NeonUserRecord | null> {
  try {
    const result = await db.execute(sql`
      SELECT id::text AS id, name, email, "emailVerified" AS email_verified, COALESCE(banned, false) AS banned
      FROM neon_auth."user" WHERE id::text = ${id} LIMIT 1
    `);
    const row = result.rows[0] as { id: string; name: string | null; email: string; email_verified: boolean; banned: boolean } | undefined;
    return row ? { id: row.id, name: row.name, email: row.email, emailVerified: row.email_verified === true, banned: row.banned === true } : null;
  } catch (err) {
    logger.error({ err }, "Could not read the Neon Auth user table");
    return null;
  }
}

async function findAppUsers(neonId: string, email: string) {
  const toRecord = (row: typeof usersTable.$inferSelect | undefined): AppUserRecord | null =>
    row ? { id: row.id, email: row.email, neonUserId: row.neonUserId, status: row.status } : null;
  const [byNeon] = await db.select().from(usersTable).where(eq(usersTable.neonUserId, neonId)).limit(1);
  const [byMail] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  return { byNeonId: toRecord(byNeon), byEmail: toRecord(byMail) };
}

function requestMeta(req: Request) {
  const agent = req.headers["user-agent"];
  return { userAgent: Array.isArray(agent) ? agent[0] : agent ?? null, ip: req.ip };
}

function liveDeps(req: Request, verify: (token: string) => Promise<string | null>): ExchangeDeps {
  return {
    verify,
    loadNeonUser,
    findAppUsers,
    async linkUser(userId, neonId) {
      await db.update(usersTable).set({ neonUserId: neonId }).where(eq(usersTable.id, userId));
    },
    async createWorkspace({ neon, companyName }) {
      const [company] = await db.insert(companiesTable).values({
        name: companyName,
        industry: "Startup finance",
        financialYearStart: "April",
        currency: "INR",
        dataRetentionDays: 365,
      }).returning();
      const [user] = await db.insert(usersTable).values({
        companyId: company.id,
        name: (neon.name ?? "").trim() || neon.email.split("@")[0],
        email: neon.email.toLowerCase(),
        neonUserId: neon.id,
        role: "founder",
        status: "active",
      }).returning();
      await db.insert(rolePermissionsTable).values(defaultRolePermissions(company.id));
      await db.insert(auditLogsTable).values({
        companyId: company.id,
        userId: user.id,
        actorEmail: user.email,
        action: "auth.workspace_created",
        entityType: "company",
        entityId: company.id,
        metadata: { role: user.role, authMode: "neon_auth" },
        ipAddress: req.ip,
      });
      return user.id;
    },
    async startSession(userId, how) {
      const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      if (!user || user.status !== "active") return { status: 403, body: { error: NEON_REJECTION_MESSAGES.inactive, code: "inactive" } };
      // A person with no workspace is never attached to somebody else's.
      const [company] = user.companyId
        ? await db.select().from(companiesTable).where(eq(companiesTable.id, user.companyId)).limit(1)
        : [];
      if (!company) return { status: 403, body: { error: "This account is not attached to a workspace yet. Email us and we will set it up." } };

      const expiresAt = new Date(Date.now() + sessionDurationMs());
      const meta = requestMeta(req);
      const [session] = await db.insert(authSessionsTable).values({
        userId: user.id,
        companyId: company.id,
        tokenHash: "pending",
        userAgent: meta.userAgent,
        ipAddress: meta.ip,
        expiresAt,
      }).returning();
      const token = signAuthToken({ sid: session.id, sub: user.id, cid: company.id, email: user.email, role: user.role }, expiresAt);
      await db.update(authSessionsTable).set({ tokenHash: tokenHash(token) }).where(eq(authSessionsTable.id, session.id));
      await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));
      await db.insert(auditLogsTable).values({
        companyId: company.id,
        userId: user.id,
        actorEmail: user.email,
        action: how === "link" ? "auth.neon_linked" : "auth.login",
        entityType: "user",
        entityId: user.id,
        metadata: { role: user.role, authMode: "neon_auth", sessionId: session.id },
        ipAddress: meta.ip,
      });
      return {
        status: 200,
        body: {
          token,
          expiresAt: expiresAt.toISOString(),
          created: how === "create",
          user: { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status, companyId: company.id, company: company.name },
          company: {
            id: company.id,
            name: company.name,
            industry: company.industry,
            monthlyRevenueRange: company.monthlyRevenueRange,
            caEmail: company.caEmail,
            gstin: company.gstin,
            pan: company.pan,
            currency: company.currency,
          },
        },
      };
    },
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

const config = neonAuthConfig();
const verifier = config ? createNeonTokenVerifier(config) : null;

/** What the sign-in page needs to know. Nothing here is secret. */
router.get("/auth/neon/config", (_req, res): void => {
  res.json({
    enabled: Boolean(config),
    authUrl: config?.authUrl ?? null,
    legacyLogin: process.env.LEGACY_PASSWORD_LOGIN !== "false",
  });
});

router.post("/auth/neon/exchange", async (req, res): Promise<void> => {
  if (!verifier) {
    res.status(404).json({ error: "This sign-in is not switched on." });
    return;
  }
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const companyName = typeof req.body?.companyName === "string" ? req.body.companyName : undefined;
  try {
    const result = await exchangeNeonToken(token, companyName, liveDeps(req, verifier));
    res.status(result.status).json(result.body);
  } catch (err) {
    req.log?.error({ err }, "Neon Auth sign-in failed");
    res.status(500).json({ error: "Sign-in could not be completed. Please try again." });
  }
});

export default router;

