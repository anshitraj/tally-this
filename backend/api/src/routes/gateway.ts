import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { gatewaySettlementsTable, bankTransactionsTable, reconciliationMatchesTable, exceptionsTable, auditLogsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { GetGatewaySettlementsResponse } from "@workspace/api-zod";
import { getCompanyId, requirePermission } from "../middleware/authz";
import { detectGatewaySettlements } from "../services/matchingEngine";

const router: IRouter = Router();

router.get("/gateway-settlements", requirePermission("gateway.read"), async (req, res): Promise<void> => {
  const settlements = await db.select().from(gatewaySettlementsTable).where(eq(gatewaySettlementsTable.companyId, getCompanyId(req))).orderBy(desc(gatewaySettlementsTable.settlementDate));
  res.json(GetGatewaySettlementsResponse.parse(
    settlements.map(s => ({
      id: s.id,
      provider: s.provider,
      settlementId: s.settlementId,
      grossAmount: parseFloat(s.grossAmount as string),
      fees: parseFloat(s.fees as string),
      gstOnFees: s.gstOnFees ? parseFloat(s.gstOnFees as string) : null,
      netAmount: parseFloat(s.netAmount as string),
      settlementDate: s.settlementDate,
      bankReference: s.bankReference ?? null,
      status: s.status,
      bankTransactionId: s.bankTransactionId ?? null,
    }))
  ));
});

router.post("/gateway-settlements/match", requirePermission("gateway.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);

  const [txns, settlements] = await Promise.all([
    db.select().from(bankTransactionsTable).where(eq(bankTransactionsTable.companyId, companyId)),
    db.select().from(gatewaySettlementsTable).where(eq(gatewaySettlementsTable.companyId, companyId)),
  ]);

  if (settlements.length === 0) {
    res.json({ ok: true, matchesFound: 0, exceptionsCreated: 0, message: "No gateway settlements found. Upload a Razorpay/Cashfree/Stripe CSV first." });
    return;
  }

  const matches = detectGatewaySettlements(txns, settlements);
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

    if (match.matchType === "gateway_settlement_mismatch") {
      await db.insert(exceptionsTable).values({
        companyId,
        type: "gateway_mismatch",
        title: `Gateway settlement mismatch — bank transaction #${match.bankTransactionId}`,
        description: match.reason + " Amount difference detected. Potential risk — needs CA review.",
        severity: "medium",
        status: "open",
        relatedEntityType: "bank_transaction",
        relatedEntityId: match.bankTransactionId ?? null,
        createdBy: req.auth?.userId ?? null,
      });
      exceptionsCreated++;
    }
  }

  const unmatchedSettlements = settlements.length - matches.length;
  if (unmatchedSettlements > 0) {
    await db.insert(exceptionsTable).values({
      companyId,
      type: "gateway_unmatched",
      title: `${unmatchedSettlements} gateway settlement${unmatchedSettlements > 1 ? "s" : ""} unmatched`,
      description: `${unmatchedSettlements} gateway settlement${unmatchedSettlements > 1 ? "s" : ""} could not be matched against bank credits. Potential risk — needs CA review.`,
      severity: "medium",
      status: "open",
      relatedEntityType: "gateway_settlement",
      relatedEntityId: null,
      createdBy: req.auth?.userId ?? null,
    });
    exceptionsCreated++;
  }

  await db.insert(auditLogsTable).values({
    companyId,
    userId: req.auth?.userId ?? null,
    actorEmail: req.auth?.email ?? "system@finverify.local",
    action: "gateway.match_run",
    entityType: "gateway_settlement",
    metadata: { matchesFound, exceptionsCreated, totalTxns: txns.length, totalSettlements: settlements.length },
    ipAddress: req.ip,
  });

  res.json({
    ok: true,
    matchesFound,
    exceptionsCreated,
    totalSettlements: settlements.length,
    unmatchedSettlements,
    message: matchesFound > 0
      ? `Found ${matchesFound} gateway match${matchesFound > 1 ? "es" : ""}. ${exceptionsCreated} exception${exceptionsCreated > 1 ? "s" : ""} created.`
      : "No new gateway matches. All settlements may already be matched or no bank credits correspond.",
  });
});

export default router;
