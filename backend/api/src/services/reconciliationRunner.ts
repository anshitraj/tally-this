import { eq, sql } from "drizzle-orm";
import {
  bankTransactionsTable,
  db,
  gatewaySettlementsTable,
  invoicesTable,
  ledgerEntriesTable,
  payrollEntriesTable,
  reconciliationMatchesTable,
} from "@workspace/db";
import { runFullReconciliation } from "./matchingEngine";

export async function runAndPersistReconciliation(companyId: number, runId?: string | null) {
  const txns = await db.select().from(bankTransactionsTable).where(eq(bankTransactionsTable.companyId, companyId));
  const invoices = await db.select().from(invoicesTable).where(eq(invoicesTable.companyId, companyId));
  const ledgerEntries = await db.select().from(ledgerEntriesTable).where(eq(ledgerEntriesTable.companyId, companyId));
  const payrollEntries = await db.select().from(payrollEntriesTable).where(eq(payrollEntriesTable.companyId, companyId));
  const gatewaySettlements = await db.select().from(gatewaySettlementsTable).where(eq(gatewaySettlementsTable.companyId, companyId));
  const existingMatches = await db.select().from(reconciliationMatchesTable).where(eq(reconciliationMatchesTable.companyId, companyId));

  const existingKeys = new Set(
    existingMatches.map(m => `${m.bankTransactionId ?? "none"}:${m.invoiceId ?? "none"}:${m.ledgerEntryId ?? "none"}:${m.matchType}`)
  );
  const reconciliation = runFullReconciliation({
    transactions: txns,
    invoices,
    ledgerEntries,
    payrollEntries,
    gatewaySettlements,
  });

  const newMatches: typeof reconciliationMatchesTable.$inferInsert[] = reconciliation.matches
    .filter(match => !existingKeys.has(`${match.bankTransactionId ?? "none"}:${match.invoiceId ?? "none"}:${match.ledgerEntryId ?? "none"}:${match.matchType}`))
    .slice(0, 50)
    .map(match => ({
      bankTransactionId: match.bankTransactionId ?? null,
      companyId,
      invoiceId: match.invoiceId ?? null,
      ledgerEntryId: match.ledgerEntryId ?? null,
      matchType: match.matchType,
      confidenceScore: match.confidenceScore,
      reason: match.reason,
      status: match.status,
    }));

  if (newMatches.length > 0) {
    await db.insert(reconciliationMatchesTable).values(newMatches);
  }

  // Link matched upload IDs to this run in run_sources so /reconciliation/runs
  // can compute matchCount and /reconciliation?runId= can filter correctly.
  if (runId && newMatches.length > 0) {
    const txnById = Object.fromEntries(txns.map(t => [t.id, t]));
    const invById = Object.fromEntries(invoices.map(i => [i.id, i]));

    // Collect unique (uploadId, sourceType, fileName) tuples from matched records
    const uploadSet = new Map<number, { sourceType: string; fileName: string }>();
    for (const m of newMatches) {
      if (m.bankTransactionId) {
        const t = txnById[m.bankTransactionId];
        if (t?.sourceUploadId) uploadSet.set(t.sourceUploadId, { sourceType: t.source ?? "bank", fileName: t.bankName ?? "bank" });
      }
      if (m.invoiceId) {
        const inv = invById[m.invoiceId];
        if (inv?.sourceUploadId) uploadSet.set(inv.sourceUploadId, { sourceType: "invoices", fileName: inv.invoiceNumber ?? "invoice" });
      }
    }

    for (const [uploadId, { sourceType, fileName }] of uploadSet) {
      try {
        await db.execute(sql`
          INSERT INTO run_sources (run_id, upload_id, source_type, file_name, row_count, status, created_at)
          VALUES (${runId}, ${uploadId}, ${sourceType}, ${fileName}, ${newMatches.length}, 'reconciled', NOW())
          ON CONFLICT DO NOTHING
        `);
      } catch { /* run_sources table may not exist yet */ }
    }
  }

  return {
    matchesFound: newMatches.length,
    newVerified: newMatches.filter(m => (m.confidenceScore ?? 0) >= 85).length,
    newPotential: newMatches.filter(m => (m.confidenceScore ?? 0) >= 60 && (m.confidenceScore ?? 0) < 85).length,
    newUnverified: txns.filter(t => t.confidenceScore < 60).length,
  };
}

