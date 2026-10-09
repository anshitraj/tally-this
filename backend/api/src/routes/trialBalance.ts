/**
 * Trial Balance — aggregates ledger_entries by accountName.
 * Adds optional totals from journal_entry_lines (posted manual JEs).
 * Group by parent: Indirect Income/Expense/Assets/Liabilities heuristic.
 */
import { Router, type IRouter } from "express";
import { db, ledgerEntriesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { getCompanyId, requirePermission } from "../middleware/authz";

const router: IRouter = Router();

function classifyAccount(name: string): "asset" | "liability" | "income" | "expense" | "equity" | "unknown" {
  const n = name.toLowerCase();
  if (/cash|bank|hdfc|icici|sbi|axis|kotak|debtors|receivable|inventory|stock|asset|deposit|advance|prepaid/.test(n)) return "asset";
  if (/payable|creditor|loan|provision|tds payable|gst payable|liability|duties|tax payable/.test(n)) return "liability";
  if (/sales|revenue|income|interest received|other income/.test(n)) return "income";
  if (/expense|salary|rent|electricity|fees|purchase|cost|fee|charges|interest paid|gst input|gst on/.test(n)) return "expense";
  if (/capital|reserves|surplus|equity/.test(n)) return "equity";
  return "unknown";
}

router.get("/trial-balance", requirePermission("ledger.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const asOf = typeof req.query.asOf === "string" ? req.query.asOf : null;
  const runId = typeof req.query.runId === "string" ? req.query.runId : null;

  // Pull all ledger entries for company (optionally filtered by date)
  const entries = await db.select().from(ledgerEntriesTable).where(eq(ledgerEntriesTable.companyId, companyId));

  // Filter by date and runId
  const filtered = entries.filter(e => {
    if (asOf && e.date > asOf) return false;
    return true;
  });

  // Aggregate by account
  const byAccount = new Map<string, { name: string; debit: number; credit: number; entries: number; classification: string }>();
  for (const e of filtered) {
    const acc = e.ledgerName || "(unnamed)";
    const amt = parseFloat(String(e.amount));
    const isDebit = (e.debitCredit || "").toLowerCase() === "debit";
    const existing = byAccount.get(acc) ?? { name: acc, debit: 0, credit: 0, entries: 0, classification: classifyAccount(acc) };
    if (isDebit) existing.debit += amt;
    else existing.credit += amt;
    existing.entries++;
    byAccount.set(acc, existing);
  }

  // Pull posted journal entry lines and add to totals
  try {
    const jeLines = await db.execute(sql`
      SELECT jel.account_name, jel.debit, jel.credit
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_id
      WHERE je.company_id = ${companyId} AND je.status = 'posted'
        AND (${asOf}::text IS NULL OR je.entry_date <= ${asOf})
    `);
    for (const row of jeLines.rows as { account_name: string; debit: string; credit: string }[]) {
      const acc = row.account_name;
      const debit = parseFloat(row.debit);
      const credit = parseFloat(row.credit);
      const existing = byAccount.get(acc) ?? { name: acc, debit: 0, credit: 0, entries: 0, classification: classifyAccount(acc) };
      existing.debit += debit;
      existing.credit += credit;
      existing.entries++;
      byAccount.set(acc, existing);
    }
  } catch { /* journal_entries table may not exist yet */ }

  const accounts = Array.from(byAccount.values()).map(a => ({
    accountName: a.name,
    classification: a.classification,
    totalDebit: Math.round(a.debit * 100) / 100,
    totalCredit: Math.round(a.credit * 100) / 100,
    balance: Math.round((a.debit - a.credit) * 100) / 100,
    entryCount: a.entries,
  }));

  // Group by classification
  const groups: Record<string, typeof accounts> = { asset: [], liability: [], income: [], expense: [], equity: [], unknown: [] };
  for (const a of accounts) groups[a.classification].push(a);

  const totalDebit = accounts.reduce((s, a) => s + a.totalDebit, 0);
  const totalCredit = accounts.reduce((s, a) => s + a.totalCredit, 0);

  res.json({
    asOf: asOf ?? new Date().toISOString().slice(0, 10),
    runId,
    totals: {
      totalDebit: Math.round(totalDebit * 100) / 100,
      totalCredit: Math.round(totalCredit * 100) / 100,
      balanced: Math.abs(totalDebit - totalCredit) < 0.01,
    },
    groups,
    accounts: accounts.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)),
  });
});

router.get("/trial-balance/account/:name/transactions", requirePermission("ledger.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const accountName = decodeURIComponent(String(req.params.name));
  const entries = await db.select().from(ledgerEntriesTable)
    .where(and(eq(ledgerEntriesTable.companyId, companyId), eq(ledgerEntriesTable.ledgerName, accountName)));
  res.json(entries.map(e => ({
    id: e.id, date: e.date, voucherNumber: e.voucherNumber, amount: parseFloat(String(e.amount)),
    debitCredit: e.debitCredit, status: e.status, sourceUploadId: e.sourceUploadId,
  })));
});

export default router;
