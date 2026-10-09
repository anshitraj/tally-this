import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  auditLogsTable,
  authSessionsTable,
  companiesTable,
  documentsTable,
  gstRecordsTable,
  oauthAccountsTable,
  rolePermissionsTable,
  usersTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { getCompanyId, requireAuth, requirePermission } from "../middleware/authz";
import { hashPassword, sessionDurationMs, signAuthToken, tokenHash, verifyPassword } from "../services/auth";
import { defaultRolePermissions } from "../services/permissions";
import { deleteStoredObject } from "../services/storage";
import { getAIStatus } from "../server/ai/providerRouter";
import { finishOAuth, oauthProviderStatus, startOAuth } from "../services/oauth";
import { seedDemoData } from "../lib/seedData";

const router: IRouter = Router();

function demoLoadingAllowed(): boolean {
  return process.env.ALLOW_DEMO_SEED === "true" || process.env.NODE_ENV !== "production";
}

router.get("/company", requirePermission("settings.manage_company"), async (req, res): Promise<void> => {
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, getCompanyId(req))).limit(1);
  res.json(company ? {
    id: company.id,
    name: company.name,
    industry: company.industry,
    monthlyRevenueRange: company.monthlyRevenueRange,
    caEmail: company.caEmail,
    gstin: company.gstin,
    pan: company.pan,
    financialYearStart: company.financialYearStart,
    currency: company.currency,
    dataRetentionDays: company.dataRetentionDays,
    createdAt: company.createdAt.toISOString(),
  } : null);
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const email = String(req.body?.email ?? "").toLowerCase().trim();
  const password = String(req.body?.password ?? "");

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user || user.status !== "active") {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  if (!user.passwordHash || !user.passwordSalt || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const [company] = user.companyId
    ? await db.select().from(companiesTable).where(eq(companiesTable.id, user.companyId)).limit(1)
    : await db.select().from(companiesTable).orderBy(desc(companiesTable.createdAt)).limit(1);
  if (!company) {
    res.status(401).json({ error: "User is not attached to an active company" });
    return;
  }

  const expiresAt = new Date(Date.now() + sessionDurationMs());
  const [session] = await db.insert(authSessionsTable).values({
    userId: user.id,
    companyId: company.id,
    tokenHash: "pending",
    userAgent: Array.isArray(req.headers["user-agent"]) ? req.headers["user-agent"][0] : req.headers["user-agent"] ?? null,
    ipAddress: req.ip,
    expiresAt,
  }).returning();

  const token = signAuthToken({
    sid: session.id,
    sub: user.id,
    cid: company.id,
    email: user.email,
    role: user.role,
  }, expiresAt);

  await db.update(authSessionsTable).set({ tokenHash: tokenHash(token) }).where(eq(authSessionsTable.id, session.id));
  await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));

  await db.insert(auditLogsTable).values({
    companyId: company?.id ?? user.companyId ?? null,
    userId: user.id,
    actorEmail: user.email,
    action: "auth.login",
    entityType: "user",
    entityId: user.id,
    metadata: {
      role: user.role,
      authMode: "jwt_session",
      sessionId: session.id,
    },
    ipAddress: req.ip,
  });

  res.json({
    token,
    expiresAt: expiresAt.toISOString(),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      companyId: company?.id ?? user.companyId ?? null,
      company: company.name,
    },
    company: company ? {
      id: company.id,
      name: company.name,
      industry: company.industry,
      monthlyRevenueRange: company.monthlyRevenueRange,
      caEmail: company.caEmail,
      gstin: company.gstin,
      pan: company.pan,
      currency: company.currency,
    } : null,
  });
});

router.get("/auth/providers", (_req, res): void => {
  res.json(oauthProviderStatus());
});

router.post("/auth/demo", async (req, res): Promise<void> => {
  if (!demoLoadingAllowed()) {
    res.status(403).json({ error: "Demo loading is disabled. Set ALLOW_DEMO_SEED=true to enable it explicitly." });
    return;
  }

  const counts = await seedDemoData();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, "rahul@novastack.in")).limit(1);
  if (!user || !user.companyId) {
    res.status(500).json({ error: "Demo user could not be created" });
    return;
  }

  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, user.companyId)).limit(1);
  if (!company) {
    res.status(500).json({ error: "Demo company could not be created" });
    return;
  }

  const expiresAt = new Date(Date.now() + sessionDurationMs());
  const [session] = await db.insert(authSessionsTable).values({
    userId: user.id,
    companyId: company.id,
    tokenHash: "pending",
    userAgent: Array.isArray(req.headers["user-agent"]) ? req.headers["user-agent"][0] : req.headers["user-agent"] ?? null,
    ipAddress: req.ip,
    expiresAt,
  }).returning();

  const token = signAuthToken({
    sid: session.id,
    sub: user.id,
    cid: company.id,
    email: user.email,
    role: user.role,
  }, expiresAt);

  await db.update(authSessionsTable).set({ tokenHash: tokenHash(token) }).where(eq(authSessionsTable.id, session.id));
  await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));

  await db.insert(auditLogsTable).values({
    companyId: company.id,
    userId: user.id,
    actorEmail: user.email,
    action: "auth.demo_loaded",
    entityType: "company",
    entityId: company.id,
    metadata: {
      role: user.role,
      authMode: "jwt_session",
      sessionId: session.id,
      seededCounts: counts,
    },
    ipAddress: req.ip,
  });

  res.json({
    token,
    expiresAt: expiresAt.toISOString(),
    demo: true,
    counts,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      companyId: company.id,
      company: company.name,
    },
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
  });
});

router.get("/auth/google", (req, res): void => {
  startOAuth(req, res, "google");
});

router.get("/auth/google/callback", async (req, res): Promise<void> => {
  await finishOAuth(req, res, "google");
});

router.get("/auth/github", (req, res): void => {
  startOAuth(req, res, "github");
});

router.get("/auth/github/callback", async (req, res): Promise<void> => {
  await finishOAuth(req, res, "github");
});

router.post("/auth/register", async (req, res): Promise<void> => {
  const name = String(req.body?.name ?? "").trim();
  const email = String(req.body?.email ?? "").toLowerCase().trim();
  const password = String(req.body?.password ?? "");
  const companyName = String(req.body?.companyName ?? "").trim();
  const industry = String(req.body?.industry ?? "Startup finance").trim() || "Startup finance";

  if (!name || !email || !password || !companyName) {
    res.status(400).json({ error: "Name, company name, email, and password are required" });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const [existingUser] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existingUser) {
    res.status(409).json({ error: "A user with this email already exists" });
    return;
  }

  const passwordHash = hashPassword(password);
  const [company] = await db.insert(companiesTable).values({
    name: companyName,
    industry,
    financialYearStart: "April",
    currency: "INR",
    dataRetentionDays: 365,
  }).returning();

  const [user] = await db.insert(usersTable).values({
    companyId: company.id,
    name,
    email,
    passwordHash: passwordHash.hash,
    passwordSalt: passwordHash.salt,
    role: "founder",
    status: "active",
  }).returning();

  await db.insert(rolePermissionsTable).values(defaultRolePermissions(company.id));

  const expiresAt = new Date(Date.now() + sessionDurationMs());
  const [session] = await db.insert(authSessionsTable).values({
    userId: user.id,
    companyId: company.id,
    tokenHash: "pending",
    userAgent: Array.isArray(req.headers["user-agent"]) ? req.headers["user-agent"][0] : req.headers["user-agent"] ?? null,
    ipAddress: req.ip,
    expiresAt,
  }).returning();

  const token = signAuthToken({
    sid: session.id,
    sub: user.id,
    cid: company.id,
    email: user.email,
    role: user.role,
  }, expiresAt);

  await db.update(authSessionsTable).set({ tokenHash: tokenHash(token) }).where(eq(authSessionsTable.id, session.id));
  await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));

  await db.insert(auditLogsTable).values({
    companyId: company.id,
    userId: user.id,
    actorEmail: user.email,
    action: "auth.workspace_created",
    entityType: "company",
    entityId: company.id,
    metadata: { role: user.role, authMode: "jwt_session", sessionId: session.id },
    ipAddress: req.ip,
  });

  res.status(201).json({
    token,
    expiresAt: expiresAt.toISOString(),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      companyId: company.id,
      company: company.name,
    },
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
  });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.auth!.userId)).limit(1);
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, req.auth!.companyId)).limit(1);
  if (!user || !company) {
    res.status(401).json({ error: "Session user not found" });
    return;
  }
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      companyId: company.id,
      company: company.name,
    },
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
  });
});

router.post("/auth/logout", requireAuth, async (req, res): Promise<void> => {
  await db.update(authSessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(authSessionsTable.id, req.auth!.sessionId));
  await db.insert(auditLogsTable).values({
    companyId: req.auth!.companyId,
    userId: req.auth!.userId,
    actorEmail: req.auth!.email,
    action: "auth.logout",
    entityType: "user",
    entityId: req.auth!.userId,
    metadata: { sessionId: req.auth!.sessionId },
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

router.get("/users", requirePermission("settings.manage_company"), async (req, res): Promise<void> => {
  const users = await db.select().from(usersTable).where(eq(usersTable.companyId, getCompanyId(req))).orderBy(desc(usersTable.createdAt));
  res.json(users.map(user => ({
    id: user.id,
    companyId: user.companyId,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  })));
});

router.post("/roles/backfill", requirePermission("settings.manage_company"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const existing = await db.select({ role: rolePermissionsTable.role, permission: rolePermissionsTable.permission })
    .from(rolePermissionsTable)
    .where(eq(rolePermissionsTable.companyId, companyId));
  const existingKeys = new Set(existing.map(e => `${e.role}:${e.permission}`));
  const desired = defaultRolePermissions(companyId);
  const missing = desired.filter(d => !existingKeys.has(`${d.role}:${d.permission}`));
  if (missing.length > 0) {
    await db.insert(rolePermissionsTable).values(missing);
  }
  res.json({ ok: true, inserted: missing.length });
});

router.get("/roles", requirePermission("settings.manage_company"), async (req, res): Promise<void> => {
  const permissions = await db.select().from(rolePermissionsTable).where(eq(rolePermissionsTable.companyId, getCompanyId(req))).orderBy(rolePermissionsTable.role);
  const grouped = permissions.reduce<Record<string, Array<{ permission: string; enabled: boolean }>>>((acc, item) => {
    acc[item.role] ??= [];
    acc[item.role].push({ permission: item.permission, enabled: item.enabled });
    return acc;
  }, {});
  res.json(Object.entries(grouped).map(([role, items]) => ({
    role,
    permissions: items,
  })));
});

router.get("/documents", requirePermission("uploads.read"), async (req, res): Promise<void> => {
  const documents = await db.select().from(documentsTable).where(eq(documentsTable.companyId, getCompanyId(req))).orderBy(desc(documentsTable.createdAt));
  res.json(documents.map(document => ({
    id: document.id,
    companyId: document.companyId,
    uploadBatchId: document.uploadBatchId,
    fileName: document.fileName,
    sourceType: document.sourceType,
    mimeType: document.mimeType,
    storageProvider: document.storageProvider,
    storageKey: document.storageKey,
    status: document.status,
    extractedTextStatus: document.extractedTextStatus,
    rowCount: document.rowCount,
    detectedColumns: document.detectedColumns,
    uploadedByUserId: document.uploadedByUserId,
    createdAt: document.createdAt.toISOString(),
  })));
});

router.delete("/documents/:id", requirePermission("uploads.delete"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid document id" });
    return;
  }

  const [document] = await db.select().from(documentsTable).where(and(
    eq(documentsTable.id, id),
    eq(documentsTable.companyId, getCompanyId(req)),
  )).limit(1);

  if (!document) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const deletion = await deleteStoredObject({
    provider: document.storageProvider,
    bucket: document.storageBucket,
    key: document.storageKey,
  });

  const [updated] = await db.update(documentsTable).set({
    status: "deleted",
    deletedAt: new Date(),
    deletedByUserId: req.auth?.userId ?? null,
  }).where(and(
    eq(documentsTable.id, id),
    eq(documentsTable.companyId, getCompanyId(req)),
  )).returning();

  await db.insert(auditLogsTable).values({
    companyId: getCompanyId(req),
    userId: req.auth?.userId ?? null,
    actorEmail: req.auth?.email ?? null,
    action: "document.deleted",
    entityType: "document",
    entityId: id,
    metadata: {
      fileName: document.fileName,
      storageProvider: document.storageProvider,
      storageKey: document.storageKey,
      deletedRemote: deletion.deletedRemote,
    },
    ipAddress: req.ip,
  });

  res.json({
    id: updated.id,
    status: updated.status,
    deletedAt: updated.deletedAt?.toISOString() ?? null,
    deletedRemote: deletion.deletedRemote,
  });
});

router.get("/gst-records", requirePermission("risks.read"), async (req, res): Promise<void> => {
  const records = await db.select().from(gstRecordsTable).where(eq(gstRecordsTable.companyId, getCompanyId(req))).orderBy(desc(gstRecordsTable.createdAt));
  res.json(records.map(record => ({
    id: record.id,
    companyId: record.companyId,
    period: record.period,
    sourceType: record.sourceType,
    gstin: record.gstin,
    counterpartyName: record.counterpartyName,
    invoiceNumber: record.invoiceNumber,
    invoiceDate: record.invoiceDate,
    taxableValue: parseFloat(record.taxableValue as string),
    gstAmount: parseFloat(record.gstAmount as string),
    matchStatus: record.matchStatus,
    riskStatus: record.riskStatus,
    createdAt: record.createdAt.toISOString(),
  })));
});

router.get("/audit-logs", requirePermission("settings.manage_company"), async (req, res): Promise<void> => {
  const limit = Math.min(Number(req.query.limit ?? 30), 100);
  const logs = await db.select().from(auditLogsTable).where(eq(auditLogsTable.companyId, getCompanyId(req))).orderBy(desc(auditLogsTable.createdAt)).limit(limit);
  res.json(logs.map(log => ({
    id: log.id,
    companyId: log.companyId,
    userId: log.userId,
    actorEmail: log.actorEmail,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    metadata: log.metadata,
    ipAddress: log.ipAddress,
    createdAt: log.createdAt.toISOString(),
  })));
});

router.get("/security/posture", requirePermission("settings.manage_company"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const users = await db.select().from(usersTable).where(eq(usersTable.companyId, companyId));
  const documents = await db.select().from(documentsTable).where(eq(documentsTable.companyId, companyId));
  const auditLogs = await db.select().from(auditLogsTable).where(eq(auditLogsTable.companyId, companyId)).limit(1);
  const aiStatus = getAIStatus();
  const oauthStatus = oauthProviderStatus();
  res.json({
    roleBasedAccessDesign: true,
    activeUsers: users.length,
    auditLogsEnabled: true,
    auditLogEvents: auditLogs.length,
    fileStorageMode: documents.some(document => document.storageProvider !== "metadata_only") ? "configured" : "metadata_only",
    aiMode: aiStatus.gemini === "configured" || aiStatus.nvidia === "configured" ? "AI-assisted with rule-based fallback" : "rule-based",
    aiProviderStatus: aiStatus,
    authProviderStatus: oauthStatus,
    directIntegrationsLive: false,
    dataExportDeleteControls: true,
    noTrainingClaim: true,
    notes: [
      "Uploaded files are stored in private R2 when configured; Neon stores metadata only.",
      "AI suggestions stay pending review and are not a financial source of truth.",
      "No direct bank/GST/Tally connection is live in this prototype.",
      "Potential risk — needs CA review.",
    ],
  });
});

export default router;
