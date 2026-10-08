import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { ledgerEntriesTable } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { GetLedgerSummaryResponse } from "@workspace/api-zod";
import { getCompanyId, requirePermission } from "../middleware/authz";

import { attachBooksCompany } from "../services/companyScope";

const router: IRouter = Router();
router.use(attachBooksCompany);

async function getLedgerEntries(req: Request, res: Response): Promise<void> {
  const companyId = getCompanyId(req);
  const runId = typeof req.query.runId === "string" ? req.query.runId : null;

  let entries;
  if (runId) {
    // Filter by run via run_sources → upload_ids → ledger_entries.sourceUploadId
    const sourcesRes = await db.execute(sql`
      SELECT rs.upload_id
      FROM run_sources rs
      JOIN workflow_runs wr ON wr.id = rs.run_id
      WHERE rs.run_id = ${runId} AND wr.company_id = ${companyId}
    `);
    const uploadIds = (sourcesRes.rows as { upload_id: number | null }[])
      .map(r => r.upload_id).filter((v): v is number => typeof v === "number");
    if (uploadIds.length === 0) {
      res.json([]);
      return;
    }
    entries = await db.select().from(ledgerEntriesTable)
      .where(and(eq(ledgerEntriesTable.companyId, companyId), inArray(ledgerEntriesTable.sourceUploadId, uploadIds)))
      .orderBy(desc(ledgerEntriesTable.date));
  } else {
    entries = await db.select().from(ledgerEntriesTable)
      .where(eq(ledgerEntriesTable.companyId, companyId))
      .orderBy(desc(ledgerEntriesTable.date));
  }

  // Map DB fields → frontend LedgerEntry interface shape
  const mapped = entries.map(e => {
    const amt = parseFloat(e.amount as string);
    const isDebit = (e.debitCredit ?? "").toLowerCase() === "debit";
    return {
      id: e.id,
      date: e.date,
      // Frontend expects accountName + accountCode
      accountName: e.ledgerName,
      accountCode: e.sourceTool ?? null,
      // Frontend expects description from voucherNumber
      description: e.voucherNumber ?? e.ledgerName,
      // Split single amount into debit/credit columns
      debitAmount: isDebit ? amt : null,
      creditAmount: !isDebit ? amt : null,
      // Balance not stored per-row; omit so frontend shows —
      balance: null as number | null,
      status: e.status,
      linkedTransactionId: e.matchedTransactionId ?? null,
      linkedInvoiceId: null as number | null,
    };
  });

  res.json(mapped);
}

router.get("/ledger", requirePermission("ledger.read"), getLedgerEntries);
router.get("/ledger-entries", requirePermission("ledger.read"), getLedgerEntries);

router.get("/ledger/summary", requirePermission("ledger.read"), async (req, res): Promise<void> => {
  const entries = await db.select().from(ledgerEntriesTable).where(eq(ledgerEntriesTable.companyId, getCompanyId(req)));
  const matched = entries.filter(e => e.status === "matched").length;
  const missing = entries.filter(e => e.status === "missing").length;
  const duplicates = entries.filter(e => e.status === "duplicate").length;
  const suspense = entries.filter(e => e.status === "suspense").length;
  const score = entries.length > 0 ? Math.round((matched / entries.length) * 100) : 0;

  res.json(GetLedgerSummaryResponse.parse({
    totalEntries: entries.length,
    matchedEntries: matched,
    missingEntries: missing,
    duplicateCount: duplicates,
    suspenseCount: suspense,
    matchScore: score,
  }));
});

export default router;
