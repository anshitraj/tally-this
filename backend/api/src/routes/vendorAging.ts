/**
 * Vendor Payment Aging
 * Shows unpaid vendor invoices grouped by aging bucket: Current, 1-30d, 31-60d, 61-90d, 90d+
 * Essential for AP (Accounts Payable) management.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getCompanyId, requirePermission } from "../middleware/authz";

const router: IRouter = Router();

router.get("/vendor-aging", requirePermission("reports.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const asOf = typeof req.query.asOf === "string" ? req.query.asOf : new Date().toISOString().split("T")[0];

  try {
    const result = await db.execute(sql`
      SELECT
        vendor_name AS vendor,
        invoice_number,
        amount,
        gst_amount,
        date AS invoice_date,
        (date::date + INTERVAL '30 days')::date AS due_date,
        payment_status AS status,
        (${asOf}::date - (date::date + INTERVAL '30 days')::date) AS days_overdue,
        CASE
          WHEN (date::date + INTERVAL '30 days')::date > ${asOf}::date THEN 'current'
          WHEN (${asOf}::date - (date::date + INTERVAL '30 days')::date) BETWEEN 1 AND 30 THEN '1_30'
          WHEN (${asOf}::date - (date::date + INTERVAL '30 days')::date) BETWEEN 31 AND 60 THEN '31_60'
          WHEN (${asOf}::date - (date::date + INTERVAL '30 days')::date) BETWEEN 61 AND 90 THEN '61_90'
          ELSE 'over_90'
        END AS aging_bucket
      FROM invoices
      WHERE company_id = ${companyId}
        AND type = 'purchase'
        AND payment_status NOT IN ('paid', 'cancelled')
        AND date IS NOT NULL
      ORDER BY days_overdue DESC, vendor_name, date
      LIMIT 2000`);

    type Row = {
      vendor: string; invoice_number: string; amount: string;
      gst_amount: string; invoice_date: string; due_date: string;
      status: string; days_overdue: number; aging_bucket: string;
    };
    const rows = result.rows as Row[];

    // Build aging summary per vendor
    type VendorSummary = {
      vendor: string;
      current: number; b1_30: number; b31_60: number; b61_90: number; over90: number;
      total: number; invoiceCount: number;
      invoices: Row[];
    };
    const vendorMap = new Map<string, VendorSummary>();
    for (const r of rows) {
      let v = vendorMap.get(r.vendor);
      if (!v) {
        v = { vendor: r.vendor, current: 0, b1_30: 0, b31_60: 0, b61_90: 0, over90: 0, total: 0, invoiceCount: 0, invoices: [] };
        vendorMap.set(r.vendor, v);
      }
      const amt = parseFloat(r.amount || "0");
      v.total += amt;
      v.invoiceCount++;
      v.invoices.push(r);
      if (r.aging_bucket === "current") v.current += amt;
      else if (r.aging_bucket === "1_30") v.b1_30 += amt;
      else if (r.aging_bucket === "31_60") v.b31_60 += amt;
      else if (r.aging_bucket === "61_90") v.b61_90 += amt;
      else v.over90 += amt;
    }

    const vendors = Array.from(vendorMap.values()).sort((a, b) => b.total - a.total);

    // Overall summary
    const totals = vendors.reduce((acc, v) => ({
      current: acc.current + v.current,
      b1_30: acc.b1_30 + v.b1_30,
      b31_60: acc.b31_60 + v.b31_60,
      b61_90: acc.b61_90 + v.b61_90,
      over90: acc.over90 + v.over90,
      total: acc.total + v.total,
    }), { current: 0, b1_30: 0, b31_60: 0, b61_90: 0, over90: 0, total: 0 });

    res.json({ ok: true, asOf, vendors, totals, invoiceCount: rows.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Vendor aging failed" });
  }
});

export default router;
