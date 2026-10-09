/**
 * GSTR-2B Reconciliation — match supplier-filed records (2B) with purchase register (invoices).
 * Critical for monthly ITC claim.
 */
import { Router, type IRouter } from "express";
import { db, invoicesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import multer from "multer";
import { getCompanyId, requirePermission } from "../middleware/authz";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

interface GSTR2BRow {
  supplier_gstin: string;
  supplier_name?: string | null;
  invoice_number: string;
  invoice_date?: string | null;
  invoice_value?: number;
  taxable_value?: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
  cess?: number;
  itc_eligible?: string;
}

/** Detect GSTN portal JSON version and extract rows from any known format. */
function parseGstr2bJson(parsed: Record<string, unknown>): GSTR2BRow[] {
  const rows: GSTR2BRow[] = [];

  // Detect version string: "2.2", "2.1", etc.
  const version = String((parsed.version ?? parsed.gstnformat ?? "2.1")).trim();
  const data = (parsed.data ?? parsed) as Record<string, unknown>;

  // ── Format 2.2 (new portal, from ~Jan 2024) ──────────────────────────────
  // Structure: data.b2bData[].ctin, .trdnm, .docDtls[].docNo, .docDt, .igst, etc.
  if (version.startsWith("2.2") || Array.isArray(data.b2bData)) {
    const b2bData = (data.b2bData ?? []) as Record<string, unknown>[];
    for (const sup of b2bData) {
      const gstin = String(sup.ctin ?? sup.gstin ?? "");
      const name = sup.trdnm as string | null ?? null;
      for (const doc of ((sup.docDtls ?? sup.docs ?? []) as Record<string, unknown>[])) {
        rows.push({
          supplier_gstin: gstin,
          supplier_name: name,
          invoice_number: String(doc.docNo ?? doc.inum ?? ""),
          invoice_date: doc.docDt as string ?? doc.dt as string ?? null,
          invoice_value: parseFloat(String(doc.docVal ?? doc.val ?? 0)),
          taxable_value: parseFloat(String(doc.txval ?? 0)),
          igst: parseFloat(String(doc.igst ?? doc.iamt ?? 0)),
          cgst: parseFloat(String(doc.cgst ?? doc.camt ?? 0)),
          sgst: parseFloat(String(doc.sgst ?? doc.samt ?? 0)),
          cess: parseFloat(String(doc.cess ?? doc.csamt ?? 0)),
          itc_eligible: (doc.itcAvl ?? doc.itcavl) === "Y" ? "eligible" : "ineligible",
        });
      }
    }
    return rows;
  }

  // ── Format 2.1 (standard portal format pre-2024) ─────────────────────────
  // Structure: data.b2b[].ctin, .trdnm, .inv[].inum, .dt, .val, etc.
  if (Array.isArray(data.b2b)) {
    for (const sup of (data.b2b as Record<string, unknown>[])) {
      const gstin = String(sup.ctin ?? sup.gstin ?? "");
      const name = sup.trdnm as string | null ?? null;
      for (const inv of ((sup.inv ?? sup.docs ?? []) as Record<string, unknown>[])) {
        rows.push({
          supplier_gstin: gstin,
          supplier_name: name,
          invoice_number: String(inv.inum ?? inv.invoice_no ?? ""),
          invoice_date: inv.dt as string ?? null,
          invoice_value: parseFloat(String(inv.val ?? 0)),
          taxable_value: parseFloat(String(inv.txval ?? 0)),
          igst: parseFloat(String(inv.iamt ?? 0)),
          cgst: parseFloat(String(inv.camt ?? 0)),
          sgst: parseFloat(String(inv.samt ?? 0)),
          cess: parseFloat(String(inv.csamt ?? 0)),
          itc_eligible: inv.itcavl === "Y" ? "eligible" : "ineligible",
        });
      }
    }
    return rows;
  }

  // ── Flat array (manual JSON export from Tally/Excel) ─────────────────────
  if (Array.isArray(parsed)) {
    return (parsed as Record<string, unknown>[]).map(r => ({
      supplier_gstin: String(r.supplier_gstin ?? r.gstin ?? r.ctin ?? ""),
      supplier_name: r.supplier_name as string ?? null,
      invoice_number: String(r.invoice_number ?? r.invoice_no ?? r.inum ?? ""),
      invoice_date: r.invoice_date as string ?? r.dt as string ?? null,
      invoice_value: parseFloat(String(r.invoice_value ?? r.val ?? 0)),
      taxable_value: parseFloat(String(r.taxable_value ?? r.txval ?? 0)),
      igst: parseFloat(String(r.igst ?? r.iamt ?? 0)),
      cgst: parseFloat(String(r.cgst ?? r.camt ?? 0)),
      sgst: parseFloat(String(r.sgst ?? r.samt ?? 0)),
      cess: parseFloat(String(r.cess ?? r.csamt ?? 0)),
      itc_eligible: (r.itc_eligible as string ?? "eligible").toLowerCase(),
    }));
  }

  return rows; // empty if unknown format
}

// ── List loaded 2B records
router.get("/gstr-2b", requirePermission("risks.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const period = typeof req.query.period === "string" ? req.query.period : null;
  try {
    const result = period
      ? await db.execute(sql`
          SELECT * FROM gstr_2b_records WHERE company_id = ${companyId} AND return_period = ${period}
          ORDER BY supplier_gstin, invoice_date DESC LIMIT 1000`)
      : await db.execute(sql`
          SELECT * FROM gstr_2b_records WHERE company_id = ${companyId}
          ORDER BY return_period DESC, supplier_gstin LIMIT 1000`);
    res.json(result.rows);
  } catch { res.json([]); }
});

// ── Upload 2B records from JSON or CSV
router.post("/gstr-2b/upload", requirePermission("risks.resolve"), upload.single("file"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const period = String(req.body?.period || new Date().toISOString().slice(0, 7));
  if (!req.file) {
    res.status(400).json({ error: "file required (JSON or CSV)" });
    return;
  }

  let rows: GSTR2BRow[] = [];
  const text = req.file.buffer.toString("utf-8");
  try {
    if (req.file.originalname.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      rows = parseGstr2bJson(parsed);
    } else {
      // CSV: simple parse — first line headers, rest are rows
      const lines = text.split(/\r?\n/).filter(Boolean);
      const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
      for (let i = 1; i < lines.length; i++) {
        const cells = lines[i].split(",");
        const obj: Record<string, string> = {};
        headers.forEach((h, j) => { obj[h] = (cells[j] ?? "").trim(); });
        rows.push({
          supplier_gstin: obj.gstin || obj.supplier_gstin || obj.ctin || "",
          supplier_name: obj.supplier_name || obj.trade_name || null,
          invoice_number: obj.invoice_number || obj.invoice_no || obj.inum || "",
          invoice_date: obj.invoice_date || obj.date || null,
          invoice_value: parseFloat(obj.invoice_value || obj.value || "0") || 0,
          taxable_value: parseFloat(obj.taxable_value || obj.taxable || "0") || 0,
          igst: parseFloat(obj.igst || "0") || 0,
          cgst: parseFloat(obj.cgst || "0") || 0,
          sgst: parseFloat(obj.sgst || "0") || 0,
          cess: parseFloat(obj.cess || "0") || 0,
          itc_eligible: (obj.itc_eligible || "eligible").toLowerCase(),
        });
      }
    }
  } catch (err) {
    res.status(400).json({ error: "Could not parse file", detail: err instanceof Error ? err.message : "" });
    return;
  }

  const valid = rows.filter(r => r.supplier_gstin && r.invoice_number);
  if (valid.length === 0) {
    res.status(400).json({ error: "No valid 2B rows found. Expected fields: supplier_gstin, invoice_number." });
    return;
  }

  // Insert rows
  for (const r of valid) {
    await db.execute(sql`
      INSERT INTO gstr_2b_records (company_id, return_period, supplier_gstin, supplier_name, invoice_number, invoice_date,
                                    invoice_value, taxable_value, igst, cgst, sgst, cess, itc_eligible)
      VALUES (
        ${companyId}, ${period}, ${r.supplier_gstin}, ${r.supplier_name ?? null},
        ${r.invoice_number}, ${r.invoice_date ?? null},
        ${(r.invoice_value ?? 0).toFixed(2)}, ${(r.taxable_value ?? 0).toFixed(2)},
        ${(r.igst ?? 0).toFixed(2)}, ${(r.cgst ?? 0).toFixed(2)},
        ${(r.sgst ?? 0).toFixed(2)}, ${(r.cess ?? 0).toFixed(2)},
        ${r.itc_eligible ?? "eligible"}
      )`);
  }

  res.json({ ok: true, inserted: valid.length, period });
});

// ── Run reconciliation: 2B vs purchase register
router.post("/gstr-2b/reconcile", requirePermission("reconciliation.run"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const period = typeof req.body?.period === "string" ? req.body.period : null;
  if (!period) { res.status(400).json({ error: "period required (YYYY-MM)" }); return; }

  // 2B records
  const twoBRes = await db.execute(sql`
    SELECT id, supplier_gstin, invoice_number, invoice_value, taxable_value,
           igst+cgst+sgst+cess AS total_gst
    FROM gstr_2b_records WHERE company_id = ${companyId} AND return_period = ${period}`);
  const twoB = twoBRes.rows as { id: number; supplier_gstin: string; invoice_number: string;
    invoice_value: string; taxable_value: string; total_gst: string }[];

  // Purchase register: invoices with type=purchase
  const invoicesRows = await db.select().from(invoicesTable).where(eq(invoicesTable.companyId, companyId));
  const purchases = invoicesRows.filter(i => i.type === "purchase");

  type Status = "matched" | "missing_in_2b" | "missing_in_books" | "value_mismatch" | "gstin_mismatch";

  const result: { status: Status; supplierGstin: string; invoiceNumber: string;
    bookValue: number | null; portalValue: number | null; bookGst: number | null;
    portalGst: number | null; itcImpact: number; explanation: string }[] = [];

  // Build lookups
  const twoBByKey = new Map<string, typeof twoB[0]>();
  for (const r of twoB) twoBByKey.set(`${r.supplier_gstin}|${r.invoice_number}`, r);

  const purchasesByKey = new Map<string, typeof purchases[0]>();
  for (const p of purchases) purchasesByKey.set(`${p.gstin || ""}|${p.invoiceNumber}`, p);

  const matchedKeys = new Set<string>();

  // For each 2B, find match in books
  for (const r of twoB) {
    const key = `${r.supplier_gstin}|${r.invoice_number}`;
    const book = purchasesByKey.get(key);
    const portalGst = parseFloat(r.total_gst || "0");
    const portalVal = parseFloat(r.invoice_value || "0");

    if (book) {
      const bookGst = parseFloat(String(book.gstAmount || "0"));
      const bookVal = parseFloat(String(book.amount || "0"));
      const mismatch = Math.abs(bookGst - portalGst) > 1 || Math.abs(bookVal - portalVal) > 1;
      result.push({
        status: mismatch ? "value_mismatch" : "matched",
        supplierGstin: r.supplier_gstin,
        invoiceNumber: r.invoice_number,
        bookValue: bookVal,
        portalValue: portalVal,
        bookGst,
        portalGst,
        itcImpact: 0,
        explanation: mismatch
          ? `Value/GST differs: book ${bookVal.toFixed(2)}/${bookGst.toFixed(2)} vs portal ${portalVal.toFixed(2)}/${portalGst.toFixed(2)}`
          : "Matched exactly with purchase register",
      });
      matchedKeys.add(key);
    } else {
      result.push({
        status: "missing_in_books",
        supplierGstin: r.supplier_gstin,
        invoiceNumber: r.invoice_number,
        bookValue: null,
        portalValue: portalVal,
        bookGst: null,
        portalGst,
        itcImpact: portalGst,
        explanation: "Supplier filed invoice in GSTR-2B but it's not in books. Add to purchases or contact supplier.",
      });
    }
  }

  // Books with no 2B counterpart = ITC at risk
  for (const p of purchases) {
    const key = `${p.gstin || ""}|${p.invoiceNumber}`;
    if (matchedKeys.has(key)) continue;
    if (!p.gstin) continue; // skip non-GST invoices
    const bookGst = parseFloat(String(p.gstAmount || "0"));
    const bookVal = parseFloat(String(p.amount || "0"));
    result.push({
      status: "missing_in_2b",
      supplierGstin: p.gstin,
      invoiceNumber: p.invoiceNumber,
      bookValue: bookVal,
      portalValue: null,
      bookGst,
      portalGst: null,
      itcImpact: -bookGst,
      explanation: "Invoice booked but supplier hasn't filed it in GSTR-1 yet. ITC at risk. Follow up with supplier before filing.",
    });
  }

  const summary = {
    matched: result.filter(r => r.status === "matched").length,
    valueMismatches: result.filter(r => r.status === "value_mismatch").length,
    missingInBooks: result.filter(r => r.status === "missing_in_books").length,
    missingIn2B: result.filter(r => r.status === "missing_in_2b").length,
    itcAtRisk: result.filter(r => r.itcImpact < 0).reduce((s, r) => s + Math.abs(r.itcImpact), 0),
    itcGain: result.filter(r => r.itcImpact > 0).reduce((s, r) => s + r.itcImpact, 0),
  };

  res.json({ ok: true, period, summary, results: result });
});

export default router;
