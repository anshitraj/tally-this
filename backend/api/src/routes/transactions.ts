import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { bankTransactionsTable } from "@workspace/db";
import { eq, desc, and, gte, lte, like, or } from "drizzle-orm";
import { auditAction, getCompanyId, requirePermission } from "../middleware/authz";
import {
  GetTransactionsResponse,
  GetTransactionsQueryParams,
  UpdateTransactionStatusParams,
  UpdateTransactionStatusBody,
  UpdateTransactionStatusResponse,
} from "@workspace/api-zod";

import { attachBooksCompany } from "../services/companyScope";

const router: IRouter = Router();
router.use(attachBooksCompany);

router.get("/transactions", requirePermission("transactions.read"), async (req, res): Promise<void> => {
  const qp = GetTransactionsQueryParams.safeParse(req.query);
  const params = qp.success ? qp.data : {};
  const companyId = getCompanyId(req);

  let txns = await db.select().from(bankTransactionsTable).where(eq(bankTransactionsTable.companyId, companyId)).orderBy(desc(bankTransactionsTable.date));

  if (params.status) {
    txns = txns.filter(t => t.status === params.status);
  }
  if (params.source) {
    txns = txns.filter(t => t.source === params.source);
  }
  if (params.search) {
    const q = params.search.toLowerCase();
    txns = txns.filter(t =>
      t.narration.toLowerCase().includes(q) ||
      (t.reference?.toLowerCase().includes(q) ?? false)
    );
  }
  if (params.dateFrom) {
    txns = txns.filter(t => t.date >= params.dateFrom!);
  }
  if (params.dateTo) {
    txns = txns.filter(t => t.date <= params.dateTo!);
  }

  res.json(GetTransactionsResponse.parse(
    txns.map(t => ({
      id: t.id,
      date: t.date,
      narration: t.narration,
      amount: parseFloat(t.amount as string),
      type: t.type,
      source: t.source,
      bankName: t.bankName ?? null,
      reference: t.reference ?? null,
      status: t.status,
      confidenceScore: t.confidenceScore,
      matchedInvoiceId: t.matchedInvoiceId ?? null,
      note: t.note ?? null,
    }))
  ));
});

router.patch("/transactions/:id/status", requirePermission("transactions.update_status"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const parsed = UpdateTransactionStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [txn] = await db.update(bankTransactionsTable)
    .set({ status: parsed.data.status, note: parsed.data.note ?? null })
    .where(and(eq(bankTransactionsTable.id, id), eq(bankTransactionsTable.companyId, getCompanyId(req))))
    .returning();

  if (!txn) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }

  await auditAction(req, "transaction.status_updated", "transaction", txn.id, {
    status: txn.status,
    note: txn.note,
  });

  res.json(UpdateTransactionStatusResponse.parse({
    id: txn.id,
    date: txn.date,
    narration: txn.narration,
    amount: parseFloat(txn.amount as string),
    type: txn.type,
    source: txn.source,
    bankName: txn.bankName ?? null,
    reference: txn.reference ?? null,
    status: txn.status,
    confidenceScore: txn.confidenceScore,
    matchedInvoiceId: txn.matchedInvoiceId ?? null,
    note: txn.note ?? null,
  }));
});

export default router;
