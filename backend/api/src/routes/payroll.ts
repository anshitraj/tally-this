import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { payrollEntriesTable, bankTransactionsTable, reconciliationMatchesTable, exceptionsTable, auditLogsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { GetPayrollEntriesResponse } from "@workspace/api-zod";
import { getCompanyId, requirePermission } from "../middleware/authz";
import { detectPayrollMatches } from "../services/matchingEngine";

const router: IRouter = Router();

router.get("/payroll", requirePermission("payroll.read"), async (req, res): Promise<void> => {
  const entries = await db.select().from(payrollEntriesTable).where(eq(payrollEntriesTable.companyId, getCompanyId(req))).orderBy(desc(payrollEntriesTable.createdAt));
  res.json(GetPayrollEntriesResponse.parse(
    entries.map(e => ({
      id: e.id,
      employeeName: e.employeeName,
      month: e.month,
      grossAmount: e.grossAmount ? parseFloat(e.grossAmount as string) : null,
      netAmount: parseFloat(e.netAmount as string),
      paymentDate: e.paymentDate ?? null,
      bankReference: e.bankReference ?? null,
      status: e.status,
    }))
  ));
});

router.post("/payroll/match", requirePermission("payroll.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);

  const [txns, payroll] = await Promise.all([
    db.select().from(bankTransactionsTable).where(eq(bankTransactionsTable.companyId, companyId)),
    db.select().from(payrollEntriesTable).where(eq(payrollEntriesTable.companyId, companyId)),
  ]);

  if (payroll.length === 0) {
    res.json({ ok: true, matchesFound: 0, exceptionsCreated: 0, message: "No payroll entries found. Upload and import a payroll sheet first." });
    return;
  }

  const matches = detectPayrollMatches(txns, payroll);
  let matchesFound = 0;
  let exceptionsCreated = 0;

  for (const match of matches) {
    const existing = await db.select({ id: reconciliationMatchesTable.id }).from(reconciliationMatchesTable)
      .where(and(
        eq(reconciliationMatchesTable.companyId, companyId),
        eq(reconciliationMatchesTable.matchType, match.matchType),
        match.bankTransactionId ? eq(reconciliationMatchesTable.bankTransactionId, match.bankTransactionId) : eq(reconciliationMatchesTable.id, -1),
      )).limit(1);

    if (existing.length > 0) continue;

    await db.insert(reconciliationMatchesTable).values({
      companyId,
      bankTransactionId: match.bankTransactionId ?? null,
      invoiceId: null,
      ledgerEntryId: null,
      matchType: match.matchType,
      confidenceScore: match.confidenceScore,
      reason: match.reason,
      status: match.status,
    });
    matchesFound++;

    if (match.matchType === "payroll_mismatch" || match.confidenceScore < 60) {
      await db.insert(exceptionsTable).values({
        companyId,
        type: "payroll_mismatch",
        title: `Payroll mismatch — transaction #${match.bankTransactionId}`,
        description: match.reason + " Potential risk — needs CA review.",
        severity: "medium",
        status: "open",
        relatedEntityType: "bank_transaction",
        relatedEntityId: match.bankTransactionId ?? null,
        createdBy: req.auth?.userId ?? null,
      });
      exceptionsCreated++;
    }
  }

  await db.insert(auditLogsTable).values({
    companyId,
    userId: req.auth?.userId ?? null,
    actorEmail: req.auth?.email ?? "system@finverify.local",
    action: "payroll.match_run",
    entityType: "payroll",
    metadata: { matchesFound, exceptionsCreated, totalTxns: txns.length, totalPayroll: payroll.length },
    ipAddress: req.ip,
  });

  res.json({
    ok: true,
    matchesFound,
    exceptionsCreated,
    totalTxns: txns.length,
    totalPayroll: payroll.length,
    message: matchesFound > 0
      ? `Found ${matchesFound} payroll match${matchesFound > 1 ? "es" : ""}. ${exceptionsCreated} exception${exceptionsCreated > 1 ? "s" : ""} created for mismatches.`
      : "No new payroll matches found.",
  });
});

export default router;
