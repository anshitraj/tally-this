/**
 * Outputs a CA expects after a comparison: the bank reconciliation statement for Bank ↔ Tally and
 * an Excel workbook for Invoice ↔ Bank. The page posts back the result it is already showing, so
 * what is downloaded is what was reviewed, including the person's own decisions.
 */
import { Router, type IRouter } from "express";
import { auditAction, requirePermission } from "../middleware/authz";
import { brsFigures, brsSchema, buildBrsWorkbook } from "../services/brsWorkbook";
import { buildInvoiceBankWorkbook, invoiceBankWorkbookSchema } from "../services/invoiceBankWorkbook";

const router: IRouter = Router();

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The figures alone, so the page can show the reconciliation before anything is downloaded. */
router.post("/jobs/bank-tally/brs-preview", requirePermission("reports.export"), (req, res): void => {
  const parsed = brsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, message: "The reconciliation could not be worked out from this result." });
    return;
  }
  res.json({ ok: true, figures: brsFigures(parsed.data) });
});

router.post("/jobs/bank-tally/brs", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const parsed = brsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, message: "The reconciliation statement could not be created from this result. Run the comparison again." });
    return;
  }
  try {
    const bytes = await buildBrsWorkbook(parsed.data).xlsx.writeBuffer();
    res.setHeader("Content-Type", XLSX_TYPE);
    res.setHeader("Content-Disposition", 'attachment; filename="TallyThis_Bank_Reconciliation.xlsx"');
    res.send(Buffer.from(bytes));
    void auditAction(req, "job.brs_generated", "workflow_run", null, { items: parsed.data.items.length }).catch(() => undefined);
  } catch {
    res.status(500).json({ ok: false, message: "The reconciliation statement could not be created. Try again." });
  }
});

router.post("/jobs/invoice-bank/excel", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const parsed = invoiceBankWorkbookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, message: "The Excel file could not be created from this result. Run the comparison again." });
    return;
  }
  try {
    const bytes = await buildInvoiceBankWorkbook(parsed.data).xlsx.writeBuffer();
    res.setHeader("Content-Type", XLSX_TYPE);
    res.setHeader("Content-Disposition", 'attachment; filename="TallyThis_Invoice_Bank.xlsx"');
    res.send(Buffer.from(bytes));
    void auditAction(req, "job.invoice_bank_excel_generated", "workflow_run", null, { items: parsed.data.items.length }).catch(() => undefined);
  } catch {
    res.status(500).json({ ok: false, message: "The Excel file could not be created. Try again." });
  }
});

export default router;
