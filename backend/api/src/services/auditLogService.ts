import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, auditLogsTable } from "@workspace/db";

export interface AuditLogInput {
  companyId: number;
  userId?: number | null;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  beforeJson?: Record<string, unknown> | null;
  afterJson?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function createAuditLog(input: AuditLogInput) {
  const metadataPayload: Record<string, unknown> = {
    ...(input.metadata ?? {}),
  };
  if (input.beforeJson) metadataPayload._before = input.beforeJson;
  if (input.afterJson) metadataPayload._after = input.afterJson;
  if (input.userAgent) metadataPayload._userAgent = input.userAgent;

  const [log] = await db
    .insert(auditLogsTable)
    .values({
      companyId: input.companyId,
      userId: input.userId ?? null,
      actorEmail: input.actorEmail ?? "system@finverify.local",
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: metadataPayload,
      ipAddress: input.ipAddress ?? null,
    })
    .returning();

  return log;
}

export interface AuditLogFilters {
  action?: string;
  entityType?: string;
  entityId?: number;
  userId?: number;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

export async function listAuditLogs(
  companyId: number,
  filters: AuditLogFilters = {},
) {
  const conditions = [eq(auditLogsTable.companyId, companyId)];

  if (filters.action) {
    conditions.push(eq(auditLogsTable.action, filters.action));
  }
  if (filters.entityType) {
    conditions.push(eq(auditLogsTable.entityType, filters.entityType));
  }
  if (filters.entityId) {
    conditions.push(eq(auditLogsTable.entityId, filters.entityId));
  }
  if (filters.userId) {
    conditions.push(eq(auditLogsTable.userId, filters.userId));
  }
  if (filters.dateFrom) {
    conditions.push(gte(auditLogsTable.createdAt, new Date(filters.dateFrom)));
  }
  if (filters.dateTo) {
    conditions.push(lte(auditLogsTable.createdAt, new Date(filters.dateTo)));
  }

  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;

  const logs = await db
    .select()
    .from(auditLogsTable)
    .where(and(...conditions))
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(limit)
    .offset(offset);

  return logs.map((log) => ({
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
  }));
}
