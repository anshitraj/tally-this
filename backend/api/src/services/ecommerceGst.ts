/**
 * Marketplace sales normalization for the e-commerce GST job.
 * Draft figures only. Wording stays "Potential risk — needs CA review."
 */

import { normalizeAmount, normalizeDate, scanCsvTable } from "./bankStatement";

export type MarketplacePlatform = "amazon" | "flipkart" | "meesho" | "myntra" | "jiomart" | "glowroad" | "shop101" | "paytm" | "snapdeal" | "ajio" | "citymall" | "limeroad" | "generic";

export interface MarketplaceSale {
  platform: string;
  orderId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  gstin: string | null;
  buyerState: string | null;
  placeOfSupply: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  grossAmount: number;
  refundAmount: number;
  marketplaceFees: number;
  tcsAmount: number;
  hsn: string | null;
  gstRate: number | null;
  transactionType: string;
  sourceFile: string;
  sourceRow: number;
  issues: string[];
}

export interface EcommercePack {
  status: "parsed" | "needs_review" | "failed";
  message: string;
  platform: string;
  sales: MarketplaceSale[];
  summary: {
    documents: number;
    taxableValue: number;
    gst: number;
    cess: number;
    gross: number;
    refunds: number;
    tcs: number;
    b2b: number;
    b2c: number;
    errors: number;
    excludedSalesRows: number;
  };
  tabs: {
    b2b: MarketplaceSale[];
    b2c: MarketplaceSale[];
    hsn: Array<{ hsn: string; gstRate: number | null; taxableValue: number; count: number; supply: "B2B" | "B2C" }>;
    tcs: MarketplaceSale[];
    table14: MarketplaceSale[];
    errors: MarketplaceSale[];
  };
  gstJson?: unknown;
  documents?: Array<{ platform: string; issued: number; cancelled: number; source: "uploaded reports" | "accountant correction" }>;
  errors: string[];
}

function pick(row: Record<string, string>, aliases: string[]) {
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const found = entries.find(([key]) => key.toLowerCase().replace(/[_-]+/g, " ").includes(alias));
    if (found && found[1].trim()) return found[1].trim();
  }
  return "";
}

/** Cancellations and unlinked returns/adjustments must not be treated as active sales. */
export function marketplaceDocumentKind(sale: { transactionType: string; refundAmount: number }) {
  if (/cancel|\bvoid\b/i.test(sale.transactionType)) return "cancelled" as const;
  if (sale.refundAmount > 0 || /refund|return|credit[\s_-]*note|adjustment|settlement|\bfee\b/i.test(sale.transactionType)) return "adjustment" as const;
  return "sale" as const;
}

export function normalizeMarketplaceCsv(text: string, platform: MarketplacePlatform, fileName: string): EcommercePack {
  const scanned = scanCsvTable(text);
  if (!scanned || scanned.rows.length === 0) {
    return emptyPack(platform, "No marketplace rows were detected. Check that the file has order, invoice, and tax columns.");
  }
  const sales = marketplaceRowsToSales(scanned.rows, platform, fileName);
  if (sales.length === 0) return emptyPack(platform, "Rows were read, but no sales amounts were found.");
  return buildEcommercePack(sales, platform);
}

/** Combines several marketplace reports into one review pack. */
export function mergeEcommercePacks(packs: EcommercePack[]): EcommercePack {
  const sales = packs.flatMap(pack => pack.sales);
  const platforms = [...new Set(packs.filter(pack => pack.sales.length > 0).map(pack => pack.platform))];
  const platform = platforms.length === 1 ? platforms[0] : platforms.join(" + ") || "generic";
  if (sales.length === 0) return emptyPack(platform, packs[0]?.message ?? "No marketplace rows were detected.");
  return buildEcommercePack(sales, platform);
}

function marketplaceRowsToSales(rows: Record<string, string>[], platform: MarketplacePlatform, fileName: string): MarketplaceSale[] {
  return rows.map((row, index) => {
    const gstin = pick(row, ["gstin", "buyer gstin", "customer gstin"]) || null;
    const taxable = Math.abs(normalizeAmount(pick(row, ["taxable value", "taxable amount", "item taxable", "net taxable", "taxable", "item price"])) ?? 0);
    const cgst = Math.abs(normalizeAmount(pick(row, ["cgst"])) ?? 0);
    const sgst = Math.abs(normalizeAmount(pick(row, ["sgst"])) ?? 0);
    const igst = Math.abs(normalizeAmount(pick(row, ["igst"])) ?? 0);
    const gross = Math.abs(normalizeAmount(pick(row, ["gross amount", "invoice amount", "invoice value", "order amount", "item total", "gross"])) ?? round2(taxable + cgst + sgst + igst));
    const refund = Math.abs(normalizeAmount(pick(row, ["refund"])) ?? 0);
    const hsn = pick(row, ["hsn"]) || null;
    const rateRaw = normalizeAmount(pick(row, ["gst rate", "tax rate", "rate"]));
    const negativeSourceAmount = ["taxable value", "taxable amount", "taxable", "item price", "gross amount", "gross", "invoice amount", "invoice value", "cgst", "sgst", "igst"].some(alias => (normalizeAmount(pick(row, [alias])) ?? 0) < 0);
    const providedType = pick(row, ["transaction type", "type", "document type"]);
    const txnType = negativeSourceAmount && !/refund|return|credit|cancel|adjustment/i.test(providedType)
      ? "adjustment"
      : (providedType || (refund > 0 ? "refund" : "sale")).toLowerCase();
    const issues: string[] = [];
    if (!pick(row, ["invoice", "invoice number", "invoice no"])) issues.push("Missing invoice number.");
    if (!hsn) issues.push("Missing HSN. Potential risk — needs CA review.");
    if (rateRaw == null) issues.push("Missing GST rate. Potential risk — needs CA review.");
    if (gstin && !/^[0-9]{2}[A-Z0-9]{13}$/i.test(gstin)) issues.push("GSTIN format needs review. Potential risk — needs CA review.");
    const buyerState = pick(row, ["buyer state", "ship state", "state"]) || null;
    const place = pick(row, ["place of supply", "pos"]) || buyerState;
    if (buyerState && place && buyerState.toLowerCase() !== place.toLowerCase() && igst === 0 && cgst + sgst === 0) {
      issues.push("State and place of supply need review. Potential risk — needs CA review.");
    }
    return {
      platform,
      orderId: pick(row, ["order id", "sub order", "sub-order", "order-id", "order no", "order number", "order reference"]) || null,
      invoiceNumber: pick(row, ["invoice number", "invoice no", "invoice"]) || null,
      invoiceDate: normalizeDate(pick(row, ["invoice date", "order date", "date"])),
      gstin,
      buyerState,
      placeOfSupply: place,
      taxableValue: taxable,
      cgst,
      sgst,
      igst,
      cess: Math.abs(normalizeAmount(pick(row, ["cess"])) ?? 0),
      grossAmount: gross,
      refundAmount: refund,
      marketplaceFees: Math.abs(normalizeAmount(pick(row, ["marketplace fee", "selling fee", "commission", "fee"])) ?? 0),
      tcsAmount: normalizeAmount(pick(row, ["tcs"])) ?? 0,
      hsn,
      gstRate: rateRaw,
      transactionType: txnType,
      sourceFile: fileName,
      sourceRow: Number(row._rowNumber) || index + 2,
      issues,
    } satisfies MarketplaceSale;
  }).filter(sale => sale.invoiceNumber || sale.orderId || sale.grossAmount > 0);
}

export function buildEcommercePack(sales: MarketplaceSale[], platform: string, annualTurnoverAbove5Cr?: boolean): EcommercePack {
  const seen = new Set<string>();
  const reviewed = sales.map(sale => ({ ...sale, issues: [] as string[] }));
  reviewed.forEach(sale => {
    if (!sale.invoiceNumber) sale.issues.push("Missing invoice number. Potential risk — needs CA review.");
    const kind = marketplaceDocumentKind(sale);
    if (kind === "cancelled") return;
    if (!sale.invoiceDate) sale.issues.push("Missing invoice date. Potential risk — needs CA review.");
    if (!sale.hsn) sale.issues.push("Missing HSN. Potential risk — needs CA review.");
    else if (!/^\d{4,8}$/.test(sale.hsn) || (annualTurnoverAbove5Cr && sale.hsn.length < 6)) sale.issues.push("HSN length needs review. Potential risk — needs CA review.");
    if (sale.gstRate == null) sale.issues.push("Missing GST rate. Potential risk — needs CA review.");
    if (sale.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/i.test(sale.gstin)) sale.issues.push("GSTIN format needs review. Potential risk — needs CA review.");
    if (!sale.placeOfSupply) sale.issues.push("Place of supply is missing. Potential risk — needs CA review.");
    if (sale.grossAmount === 0 && sale.refundAmount === 0 && !/cancel/i.test(sale.transactionType)) sale.issues.push("Invoice total is zero. Potential risk — needs CA review.");
    const tax = sale.cgst + sale.sgst + sale.igst + sale.cess;
    if (kind === "adjustment") sale.issues.push("Return or adjustment needs supporting credit-note or settlement details. Potential risk — needs CA review.");
    else if (kind === "sale" && Math.round((sale.taxableValue + tax) * 100) !== Math.round(sale.grossAmount * 100)) sale.issues.push("Invoice value and tax do not add up. Potential risk — needs CA review.");
    const gst = sale.cgst + sale.sgst + sale.igst;
    if (kind === "sale" && sale.gstRate != null && sale.taxableValue > 0 && Math.abs(Math.round(gst * 100) - Math.round(sale.taxableValue * sale.gstRate)) > 2) sale.issues.push("GST rate and tax amount do not agree. Potential risk — needs CA review.");
    const key = `${sale.invoiceNumber ?? ""}:${sale.orderId ?? ""}:${sale.grossAmount}`;
    if (sale.invoiceNumber && seen.has(key)) sale.issues.push("Possible duplicate invoice. Potential risk — needs CA review.");
    seen.add(key);
  });

  const eligible = reviewed.filter(sale => marketplaceDocumentKind(sale) === "sale");
  const b2b = eligible.filter(sale => Boolean(sale.gstin));
  const b2c = eligible.filter(sale => !sale.gstin);
  const hsnMap = new Map<string, { hsn: string; gstRate: number | null; taxableValue: number; count: number; supply: "B2B" | "B2C" }>();
  eligible.forEach(sale => {
    const supply = sale.gstin ? "B2B" : "B2C";
    const key = `${supply}:${sale.hsn ?? "missing"}:${sale.gstRate ?? "missing"}`;
    const current = hsnMap.get(key) ?? { hsn: sale.hsn ?? "missing", gstRate: sale.gstRate, taxableValue: 0, count: 0, supply };
    current.taxableValue = round2(current.taxableValue + sale.taxableValue);
    current.count += 1;
    hsnMap.set(key, current);
  });
  const errors = reviewed.filter(sale => sale.issues.length > 0);
  const summary = {
    documents: reviewed.length,
    taxableValue: round2(eligible.reduce((sum, sale) => sum + sale.taxableValue, 0)),
    gst: round2(eligible.reduce((sum, sale) => sum + sale.cgst + sale.sgst + sale.igst, 0)),
    cess: round2(eligible.reduce((sum, sale) => sum + sale.cess, 0)),
    gross: round2(eligible.reduce((sum, sale) => sum + sale.grossAmount, 0)),
    refunds: round2(reviewed.reduce((sum, sale) => sum + sale.refundAmount, 0)),
    tcs: round2(reviewed.reduce((sum, sale) => sum + sale.tcsAmount, 0)),
    b2b: b2b.length,
    b2c: b2c.length,
    errors: errors.length,
    excludedSalesRows: reviewed.length - eligible.length,
  };

  return {
    status: errors.length > 0 ? "needs_review" : "parsed",
    message: errors.length > 0
      ? `Normalized ${reviewed.length} marketplace rows. ${errors.length} need CA review.`
      : `Normalized ${reviewed.length} marketplace rows.`,
    platform,
    sales: reviewed,
    summary,
    tabs: {
      b2b,
      b2c,
      hsn: [...hsnMap.values()],
      tcs: reviewed.filter(sale => sale.tcsAmount !== 0),
      table14: eligible.filter(sale => sale.transactionType.includes("9(5)") || sale.transactionType.includes("table 14") || sale.platform !== "generic" && sale.igst + sale.cgst + sale.sgst > 0 && sale.transactionType.includes("operator")),
      errors,
    },
    errors: [],
  };
}

export function buildGstDraftJson(pack: EcommercePack) {
  const errors: string[] = [];
  if (pack.sales.length === 0) errors.push("No sales to export.");
  pack.sales.forEach(sale => {
    if (!sale.invoiceDate && marketplaceDocumentKind(sale) === "sale") errors.push(`Row ${sale.sourceRow}: invoice date is missing.`);
    if (sale.taxableValue < 0) errors.push(`Row ${sale.sourceRow}: taxable value is negative.`);
  });
  if (errors.length > 0) return { ok: false as const, errors };
  const json = {
    schema: "finverify.gstr1.draft.v1",
    note: "Draft JSON for CA review. This file is not validated by the GST portal.",
    platform: pack.platform,
    b2b: pack.tabs.b2b.map(sale => ({
      ctin: sale.gstin,
      inv: [{ inum: sale.invoiceNumber, idt: sale.invoiceDate, val: sale.grossAmount, pos: sale.placeOfSupply, itms: [{ hsn: sale.hsn, txval: sale.taxableValue, camt: sale.cgst, samt: sale.sgst, iamt: sale.igst, csamt: sale.cess, rt: sale.gstRate }] }],
    })),
    b2c: pack.tabs.b2c.map(sale => ({
      inum: sale.invoiceNumber,
      idt: sale.invoiceDate,
      pos: sale.placeOfSupply,
      txval: sale.taxableValue,
      camt: sale.cgst,
      samt: sale.sgst,
      iamt: sale.igst,
      csamt: sale.cess,
    })),
    hsn: pack.tabs.hsn,
    tcs: pack.tabs.tcs.map(sale => ({ inum: sale.invoiceNumber, tcs: sale.tcsAmount })),
    table14: pack.tabs.table14.map(sale => ({ inum: sale.invoiceNumber, note: "Potential risk — needs CA review." })),
    documentSummary: pack.documents ?? [],
    excludedFromSales: pack.sales.filter(sale => marketplaceDocumentKind(sale) !== "sale").map(sale => ({ invoiceNumber: sale.invoiceNumber, documentType: sale.transactionType, sourceRow: sale.sourceRow, reason: marketplaceDocumentKind(sale) })),
  };
  if (!json.schema || !Array.isArray(json.b2b) || !Array.isArray(json.b2c)) {
    return { ok: false as const, errors: ["GST draft JSON failed structural checks."] };
  }
  return { ok: true as const, json, errors: [] as string[] };
}

export function salesToCsv(sales: MarketplaceSale[]) {
  const headers = ["platform", "orderId", "invoiceNumber", "invoiceDate", "gstin", "buyerState", "placeOfSupply", "taxableValue", "cgst", "sgst", "igst", "cess", "grossAmount", "tcsAmount", "refundAmount", "marketplaceFees", "hsn", "gstRate", "transactionType", "salesTreatment"];
  const lines = sales.map(sale => headers.map(header => {
    const value = header === "salesTreatment" ? marketplaceDocumentKind(sale) : sale[header as keyof MarketplaceSale];
    const raw = value == null ? "" : String(value);
    const text = typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(","));
  return [headers.join(","), ...lines].join("\n");
}

function emptyPack(platform: string, message: string): EcommercePack {
  return {
    status: "failed",
    message,
    platform,
    sales: [],
    summary: { documents: 0, taxableValue: 0, gst: 0, cess: 0, gross: 0, refunds: 0, tcs: 0, b2b: 0, b2c: 0, errors: 0, excludedSalesRows: 0 },
    tabs: { b2b: [], b2c: [], hsn: [], tcs: [], table14: [], errors: [] },
    errors: [message],
  };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}
