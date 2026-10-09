import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  bankTransactionsTable,
  invoicesTable,
  uploadBatchesTable,
  riskFlagsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { GetOverviewResponse } from "@workspace/api-zod";
import { getCompanyId, requirePermission } from "../middleware/authz";
import { queryCache } from "../lib/queryCache";

const router: IRouter = Router();
const monthFormatter = new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "Asia/Kolkata" });

function monthlyProgressFromTransactions(txns: Array<typeof bankTransactionsTable.$inferSelect>) {
  const grouped = new Map<string, { month: string; time: number; verified: number; unverified: number }>();

  for (const txn of txns) {
    const date = new Date(txn.date);
    if (Number.isNaN(date.getTime())) continue;

    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const existing = grouped.get(key) ?? {
      month: monthFormatter.format(date),
      time: new Date(date.getFullYear(), date.getMonth(), 1).getTime(),
      verified: 0,
      unverified: 0,
    };

    if (txn.status === "verified") {
      existing.verified += 1;
    } else {
      existing.unverified += 1;
    }

    grouped.set(key, existing);
  }

  return [...grouped.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-6)
    .map(({ month, verified, unverified }) => ({ month, verified, unverified }));
}

router.get("/overview", requirePermission("overview.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);

  // Cache for 30s per company — overview data doesn't change between uploads
  const response = await queryCache.get(`company:${companyId}:overview`, 30, async () => {
    // Run all 4 queries in PARALLEL — cuts latency from 4×RTT to 1×RTT
    const [txns, invoices, allUploads, risks] = await Promise.all([
      db.select().from(bankTransactionsTable).where(eq(bankTransactionsTable.companyId, companyId)),
      db.select().from(invoicesTable).where(eq(invoicesTable.companyId, companyId)),
      db.select().from(uploadBatchesTable).where(eq(uploadBatchesTable.companyId, companyId)).orderBy(uploadBatchesTable.uploadedAt),
      db.select().from(riskFlagsTable).where(eq(riskFlagsTable.companyId, companyId)),
    ]);

    const uploads    = allUploads.filter(upload => upload.status !== "removed").slice(0, 5);
    const openRisks  = risks.filter(r => r.status === "open");

    const verified       = txns.filter(t => t.status === "verified").length;
    const unverified     = txns.filter(t => !["verified", "missing_invoice"].includes(t.status)).length;
    const missingInvoice = txns.filter(t => t.status === "missing_invoice").length;

    const verifiedAmount = txns
      .filter(t => t.status === "verified" && t.type === "credit")
      .reduce((sum, t) => sum + parseFloat(t.amount as string), 0);

    const unverifiedAmount = txns
      .filter(t => t.status !== "verified" && t.type === "credit")
      .reduce((sum, t) => sum + parseFloat(t.amount as string), 0);

    const score   = txns.length > 0 ? Math.round((verified / txns.length) * 100) : 0;
    const caReady = score >= 85 ? "Ready for CA" : score >= 60 ? "Needs Review" : "Not Ready";

    const riskByCategory: Record<string, { count: number; severity: string }> = {};
    for (const r of openRisks) {
      if (!riskByCategory[r.category]) {
        riskByCategory[r.category] = { count: 0, severity: r.severity };
      }
      riskByCategory[r.category].count++;
    }

    const recentUploads = uploads.map(u => ({
      id: u.id,
      companyId: u.companyId ?? null,
      sourceType: u.sourceType,
      fileName: u.fileName,
      status: u.status,
      uploadedAt: u.uploadedAt.toISOString(),
      recordCount: u.recordCount ?? null,
    }));

    return {
      verificationScore: score,
      totalTransactions: txns.length,
      verifiedTransactions: verified,
      unverifiedTransactions: unverified,
      missingInvoices: missingInvoice + invoices.filter(i => i.status === "unverified").length,
      riskFlags: openRisks.length,
      totalUploads: allUploads.filter(upload => upload.status !== "removed").length,
      caReadyStatus: caReady,
      verifiedAmount,
      unverifiedAmount,
      recentUploads,
      monthlyProgress: monthlyProgressFromTransactions(txns),
      riskByCategory: Object.entries(riskByCategory).map(([category, data]) => ({
        category,
        count: data.count,
        severity: data.severity,
      })),
    };
  });

  res.json(GetOverviewResponse.parse(response));
});

export default router;
