/**
 * Manual Journal Entries — depreciation, prepaids, accruals, reclassifications.
 * Each entry has balanced debit/credit lines. Posted entries hit Trial Balance.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getCompanyId, requirePermission } from "../middleware/authz";

const router: IRouter = Router();

interface JELine {
  accountName: string;
  description?: string | null;
  debit?: number;
  credit?: number;
}

// Templates CAs use weekly
const TEMPLATES: Record<string, { narration: string; lines: JELine[] }> = {
  depreciation_slm: {
    narration: "Depreciation for the month — Straight Line Method",
    lines: [
      { accountName: "Depreciation Expense", debit: 0, credit: 0 },
      { accountName: "Accumulated Depreciation", debit: 0, credit: 0 },
    ],
  },
  prepaid_amortization: {
    narration: "Monthly amortization of prepaid expense",
    lines: [
      { accountName: "Insurance / Rent / Subscription Expense", debit: 0, credit: 0 },
      { accountName: "Prepaid Expenses", debit: 0, credit: 0 },
    ],
  },
  accrued_expense: {
    narration: "Expense accrued but not yet paid",
    lines: [
      { accountName: "Expense", debit: 0, credit: 0 },
      { accountName: "Accrued Liabilities", debit: 0, credit: 0 },
    ],
  },
  accrued_salary: {
    narration: "Salary payable for the month",
    lines: [
      { accountName: "Salary Expense", debit: 0, credit: 0 },
      { accountName: "Salary Payable", debit: 0, credit: 0 },
    ],
  },
  reclassification: {
    narration: "Reclassification entry",
    lines: [
      { accountName: "Account A (from)", debit: 0, credit: 0 },
      { accountName: "Account B (to)", debit: 0, credit: 0 },
    ],
  },
};

router.get("/journal-entries/templates", requirePermission("ledger.read"), (_req, res): void => {
  res.json(
    Object.entries(TEMPLATES).map(([key, t]) => ({ key, ...t }))
  );
});

router.get("/journal-entries", requirePermission("ledger.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const status = typeof req.query.status === "string" ? req.query.status : null;
  try {
    const result = status
      ? await db.execute(sql`
          SELECT id, entry_date, voucher_no, narration, template_key, total_debit, total_credit,
                 status, created_by, reviewed_by, reviewed_at, posted_at, created_at
          FROM journal_entries WHERE company_id = ${companyId} AND status = ${status}
          ORDER BY entry_date DESC, created_at DESC LIMIT 200`)
      : await db.execute(sql`
          SELECT id, entry_date, voucher_no, narration, template_key, total_debit, total_credit,
                 status, created_by, reviewed_by, reviewed_at, posted_at, created_at
          FROM journal_entries WHERE company_id = ${companyId}
          ORDER BY entry_date DESC, created_at DESC LIMIT 200`);
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

router.get("/journal-entries/:id", requirePermission("ledger.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const headerRes = await db.execute(sql`
    SELECT * FROM journal_entries WHERE id = ${id} AND company_id = ${companyId} LIMIT 1`);
  const header = headerRes.rows[0];
  if (!header) { res.status(404).json({ error: "Not found" }); return; }
  const linesRes = await db.execute(sql`
    SELECT * FROM journal_entry_lines WHERE journal_id = ${id} ORDER BY line_order`);
  res.json({ ...header, lines: linesRes.rows });
});

router.post("/journal-entries", requirePermission("ledger.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const body = req.body as {
    entryDate: string;
    voucherNo?: string;
    narration: string;
    templateKey?: string;
    lines: JELine[];
    runId?: string;
  };

  if (!body.entryDate || !body.narration || !Array.isArray(body.lines) || body.lines.length < 2) {
    res.status(400).json({ error: "entryDate, narration, and >= 2 lines required" });
    return;
  }

  // Balance check
  const totalDebit = body.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const totalCredit = body.lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    res.status(400).json({
      error: "Unbalanced entry",
      detail: `Total Dr ${totalDebit.toFixed(2)} ≠ Total Cr ${totalCredit.toFixed(2)}. Debits must equal credits.`,
    });
    return;
  }

  try {
    const headerRes = await db.execute(sql`
      INSERT INTO journal_entries (company_id, run_id, entry_date, voucher_no, narration, template_key, total_debit, total_credit, status, created_by)
      VALUES (
        ${companyId}, ${body.runId ?? null}, ${body.entryDate}, ${body.voucherNo ?? null},
        ${body.narration}, ${body.templateKey ?? null},
        ${totalDebit.toFixed(2)}, ${totalCredit.toFixed(2)},
        'draft', ${req.auth?.userId ?? null}
      )
      RETURNING id, status, created_at`);
    const id = (headerRes.rows[0] as { id: number }).id;

    for (let i = 0; i < body.lines.length; i++) {
      const l = body.lines[i];
      await db.execute(sql`
        INSERT INTO journal_entry_lines (journal_id, account_name, description, debit, credit, line_order)
        VALUES (${id}, ${l.accountName}, ${l.description ?? null},
                ${(l.debit ?? 0).toFixed(2)}, ${(l.credit ?? 0).toFixed(2)}, ${i})`);
    }

    res.status(201).json({ ok: true, id, totalDebit, totalCredit, status: "draft" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to save" });
  }
});

router.post("/journal-entries/:id/post", requirePermission("ledger.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.execute(sql`
    UPDATE journal_entries SET status='posted', posted_at=NOW(), reviewed_by=${req.auth?.userId ?? null}, reviewed_at=NOW()
    WHERE id=${id} AND company_id=${companyId} AND status='draft'`);
  res.json({ ok: true, id, status: "posted" });
});

router.delete("/journal-entries/:id", requirePermission("ledger.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.execute(sql`DELETE FROM journal_entries WHERE id=${id} AND company_id=${companyId} AND status='draft'`);
  res.json({ ok: true, id, deleted: true });
});

export default router;
