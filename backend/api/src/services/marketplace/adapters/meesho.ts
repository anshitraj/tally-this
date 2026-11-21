/**
 * Meesho report adapter.
 *
 * Reads the files a Meesho supplier downloads from the Supplier Panel (Payments → GST Reports and Tax Invoice):
 *  - tcs_sales.xlsx: every forward sale, one row per sub-order;
 *  - tcs_sales_return.xlsx: every return or cancellation, amounts usually positive;
 *  - Tax_invoice_details.xlsx: the invoice and credit-note numbers Meesho issued in the seller's name;
 * and a combined working sheet that marks returns with a "Sales Return" YES/NO column. A CA's HSN-wise pivot is read for
 * comparison only.
 *
 * What a row means is decided here; arithmetic is left to the shared engines. Shipping is already inside Meesho's
 * taxable value, so `taxable_shipping` is kept for reference and never added again. A negative sale with no return
 * flag is a price reduction on an earlier invoice (a credit note): its value comes off, its quantity does not.
 */
import { detectionFor } from "../columns";
import { checkTax, expectedApparelRate, financialYearOf, hsnStatus, isValidGstin, parseRate, placeOfSupply, rateStatus, rateText, splitTax, supplyType } from "../gstEngine";
import { formatInr, readAmount, readDecimal, type Paise } from "../money";
import type { SourceTable } from "../tables";
import type { CanonicalField, Detection, DraftEvent, DraftIssue, EventType, MarketplaceAdapter, NormalizeContext, NormalizeResult, ReportType } from "../types";

export const MEESHO_ALIASES: Partial<Record<CanonicalField, string[]>> = {
  identifier: ["identifier"],
  sellerName: ["sup_name", "supplier_name", "seller_name"],
  sellerGstin: ["gstin", "supplier_gstin", "seller_gstin"],
  subOrderId: ["sub_order_num", "sub_order_no", "suborder_no", "suborder_num", "sub_order_number", "suborder no.", "sub order no", "suborder number"],
  orderDate: ["order_date", "order date"],
  hsn: ["hsn_code", "hsn", "hsn code"],
  description: ["product_name", "product name", "description"],
  quantity: ["quantity", "qty"],
  returnFlag: ["sales return", "sales_return", "is_return", "return"],
  gstRate: ["gst_rate", "gst rate", "tax_rate"],
  taxable: ["total_taxable_sale_value", "taxable_value", "total_taxable_value", "taxable value"],
  tax: ["tax_amount", "total_tax_amount", "gst_amount", "tax amount"],
  invoiceValue: ["total_invoice_value", "invoice_value", "invoice value"],
  shippingTaxable: ["taxable_shipping", "shipping_taxable_value"],
  customerState: ["end_customer_state_new", "end_customer_state_name", "end_customer_state", "customer_state", "customer state", "state"],
  manifestDate: ["manifest_date"],
  returnDate: ["cancel_return_date", "return_date", "return_created_date"],
  ecoGstin: ["eco_tcs_gstin", "ecommerce_gstin", "eco_gstin"],
  financialYear: ["financial_year"],
  month: ["month_number", "month_num", "month"],
  supplierId: ["supplier_id"],
  documentNumber: ["invoice no.", "invoice no", "invoice_no", "invoice number", "credit note no"],
  documentType: ["type", "document type"],
  documentDate: ["invoice date", "invoice_date", "date"],
};

const MANDATORY: CanonicalField[] = ["subOrderId", "taxable", "gstRate", "customerState", "hsn", "quantity"];

const CA_SUMMARY_KEYS = ["hsn", "taxable", "integrated", "central", "state"];

function key(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function reportTypeOf(headers: string[], map: Partial<Record<CanonicalField, string>>, table: SourceTable): ReportType {
  const keys = headers.map(key);
  const name = `${table.fileName} ${table.sheetName ?? ""}`.toLowerCase();
  if (map.documentNumber && map.subOrderId && !map.taxable) return "invoice_details";
  const looksLikeCaSummary = keys.some(k => k === "hsn") && keys.some(k => k.includes("taxable")) && keys.some(k => k.includes("integrated") || k.includes("igst"))
    && keys.some(k => k.includes("central") || k.includes("cgst")) && !map.subOrderId;
  if (looksLikeCaSummary) return "ca_hsn_summary";
  if (!map.subOrderId || !map.taxable) return "unknown";
  if (map.returnFlag) return "combined";
  if (/return|rto|cancel/.test(name) || map.returnDate) return "returns";
  return "sales";
}

/** yyyy-mm-dd from the date forms marketplace exports use. Day before month, as in India. */
export function isoDate(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim().replace(/[T ].*$/, "");
  if (!text) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(text);
  if (m) return valid(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1]));
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  m = /^(\d{1,2})[-\s]([a-z]{3})[a-z]*[-\s,]+(\d{4})$/i.exec(text);
  if (m) {
    const month = months.indexOf(m[2].toLowerCase()) + 1;
    return month ? valid(Number(m[3]), month, Number(m[1])) : null;
  }
  return null;
}

function valid(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * The GST month a row belongs to. Meesho gives a month number and a year; the date on the row decides the year when
 * the month is January to March and the year column could be either the calendar or the financial year.
 */
function periodOf(monthText: string, yearText: string, relevantDate: string | null, fallback: string | null): { period: string | null; note?: string } {
  const month = Number(monthText);
  const year = Number(String(yearText).slice(0, 4));
  if (Number.isInteger(month) && month >= 1 && month <= 12 && year >= 2000 && year < 2100) {
    const candidates = month <= 3 ? [year, year + 1] : [year];
    if (relevantDate) {
      const dateMonth = Number(relevantDate.slice(5, 7));
      const dateYear = Number(relevantDate.slice(0, 4));
      if (dateMonth === month && candidates.includes(dateYear)) return { period: `${dateYear}-${String(month).padStart(2, "0")}` };
      const best = candidates.reduce((a, b) => Math.abs(b * 12 + month - (dateYear * 12 + dateMonth)) < Math.abs(a * 12 + month - (dateYear * 12 + dateMonth)) ? b : a);
      return { period: `${best}-${String(month).padStart(2, "0")}` };
    }
    return { period: `${year}-${String(month).padStart(2, "0")}`, note: month <= 3 ? "Period year taken from the year column; check January to March rows." : undefined };
  }
  if (relevantDate) return { period: relevantDate.slice(0, 7) };
  if (fallback) return { period: fallback, note: "No month on the row; the period chosen for the import was used." };
  return { period: null };
}

function cell(row: string[], headers: string[], header: string | undefined): string {
  if (!header) return "";
  const index = headers.indexOf(header);
  return index >= 0 ? (row[index] ?? "").trim() : "";
}

function yes(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (["yes", "y", "true", "1", "return", "returned"].includes(v)) return true;
  if (["no", "n", "false", "0", "sale", ""].includes(v)) return false;
  return null;
}

function normalizeRows(table: SourceTable, detection: Detection, ctx: NormalizeContext): NormalizeResult {
  const { headers, columnMap: map } = detection;
  const events: DraftEvent[] = [];
  const issues: DraftIssue[] = [];
  const periods = new Set<string>();
  let skippedTotals = 0;
  let inexact = 0;
  const get = (row: string[], field: CanonicalField) => cell(row, headers, map[field]);

  for (let i = detection.headerIndex + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const sourceRow = table.rowNumbers[i];
    const subOrder = get(row, "subOrderId");
    if (!subOrder) {
      // Totals, notes or blank lines under the data.
      if (row.some(value => value !== "")) skippedTotals += 1;
      continue;
    }
    const raw: Record<string, string> = {};
    headers.forEach((header, index) => {
      if ((row[index] ?? "") !== "") raw[header] = row[index];
    });
    const rowIssues: DraftIssue[] = [];
    const notes: string[] = [];

    const taxableRead = readAmount(get(row, "taxable"));
    const taxRead = readAmount(get(row, "tax"));
    const invoiceRead = readAmount(get(row, "invoiceValue"));
    const shippingRead = readAmount(get(row, "shippingTaxable"));
    for (const read of [taxableRead, taxRead, invoiceRead]) if (read && !read.exact) inexact += 1;

    // What kind of event this row is. The flag or the file decides; the sign never flips a value twice.
    let eventType: EventType;
    const flag = map.returnFlag ? yes(get(row, "returnFlag")) : null;
    if (detection.reportType === "returns") eventType = "return";
    else if (detection.reportType === "combined" && flag === null) {
      eventType = (taxableRead?.paise ?? 0) < 0 ? "credit_note" : "sale";
      rowIssues.push({ kind: "unclear_classification", severity: "warning", message: `The "Sales Return" value "${get(row, "returnFlag")}" is neither YES nor NO; the row was read as a ${eventType === "sale" ? "sale" : "credit note"}.` });
    } else if (flag) eventType = "return";
    else eventType = (taxableRead?.paise ?? 0) < 0 ? "credit_note" : "sale";

    const signedTaxable = taxableRead?.paise ?? 0;
    const magnitude = (value: Paise | null | undefined) => (value == null ? null : Math.abs(value));
    const taxable = magnitude(signedTaxable) ?? 0;
    const sourceTax = magnitude(taxRead?.paise);
    const invoiceValue = magnitude(invoiceRead?.paise) ?? 0;
    if (eventType === "return" && signedTaxable < 0) notes.push("The return arrived as a negative amount; it is counted once as a return.");
    if (eventType === "credit_note") {
      rowIssues.push({
        kind: "credit_note_without_return",
        severity: "warning",
        message: "A negative amount with no return flag: read as a price reduction on an earlier invoice (credit note). Its value comes off; its quantity does not.",
        details: { taxable: signedTaxable },
      });
    }
    if (taxableRead == null) rowIssues.push({ kind: "missing_taxable", severity: "error", message: "No taxable value on this row." });

    const orderDate = isoDate(get(row, "orderDate"));
    const returnDate = isoDate(get(row, "returnDate"));
    const manifestDate = isoDate(get(row, "manifestDate"));
    if (get(row, "orderDate") && !orderDate) rowIssues.push({ kind: "invalid_date", severity: "warning", message: `The order date "${get(row, "orderDate")}" is not a date.` });

    const relevantDate = eventType === "return" ? returnDate ?? orderDate : orderDate ?? manifestDate;
    const { period, note } = periodOf(get(row, "month"), get(row, "financialYear"), eventType === "return" ? returnDate : relevantDate, ctx.period);
    if (note) notes.push(note);
    if (!period) {
      rowIssues.push({ kind: "missing_period", severity: "error", message: "The row has no month or date, so its GST period is unknown." });
    }
    const reportPeriod = period ?? ctx.period ?? "unknown";
    if (period) periods.add(period);

    const hsn = get(row, "hsn").replace(/\.0+$/, "") || null;
    const hsnCheck = hsnStatus(hsn);
    if (hsnCheck === "missing") rowIssues.push({ kind: "missing_hsn", severity: "error", message: "No HSN code; the row cannot go into the HSN summary." });
    if (hsnCheck === "invalid") rowIssues.push({ kind: "invalid_hsn", severity: "warning", message: `"${hsn}" is not a 4, 6 or 8 digit HSN code.` });

    const quantity = readDecimal(get(row, "quantity"));
    const quantityAbs = quantity == null ? null : quantity.replace(/^-/, "");

    const rateMilli = parseRate(get(row, "gstRate"));
    const rateDate = orderDate ?? relevantDate;
    if (rateMilli == null) rowIssues.push({ kind: "unknown_rate", severity: "error", message: `The GST rate "${get(row, "gstRate")}" is not a rate.` });
    else {
      const status = rateStatus(rateMilli, rateDate);
      if (status === "unknown") rowIssues.push({ kind: "unknown_rate", severity: "error", message: `${rateText(rateMilli)}% is not a GST rate in force on ${rateDate ?? "this date"}.`, details: { rate: rateText(rateMilli), date: rateDate } });
      if (status === "check") rowIssues.push({ kind: "rate_check", severity: "warning", message: `${rateText(rateMilli)}% applies to few goods after the 22 September 2025 rate changes. Potential risk — needs CA review.`, details: { rate: rateText(rateMilli) } });
      const pieces = quantityAbs ? Number(quantityAbs) : 0;
      const perPiece = pieces > 0 && Number.isInteger(pieces) ? Math.round(taxable / pieces) : null;
      const expected = expectedApparelRate(hsn, perPiece, rateDate);
      if (expected != null && expected !== rateMilli && eventType === "sale") {
        rowIssues.push({
          kind: "rate_check",
          severity: "warning",
          message: `Apparel at ${formatInr(perPiece ?? 0)} a piece is usually taxed at ${rateText(expected)}% on ${rateDate ?? "this date"}, but the report shows ${rateText(rateMilli)}%. Potential risk — needs CA review.`,
          details: { hsn, perPiece, reported: rateText(rateMilli), expected: rateText(expected), rule: "Apparel (HSN 61, 62) taxed by sale value per piece; thresholds changed on 22 September 2025." },
        });
      }
    }

    const rowGstin = get(row, "sellerGstin").toUpperCase() || null;
    const sellerGstin = rowGstin ?? ctx.sellerGstin;
    if (!sellerGstin) rowIssues.push({ kind: "missing_gstin", severity: "error", message: "No seller GSTIN on the row or chosen for the import." });
    else if (rowGstin && !isValidGstin(rowGstin)) rowIssues.push({ kind: "invalid_gstin", severity: "warning", message: `The seller GSTIN ${rowGstin} does not pass the GSTIN check.` });
    if (rowGstin && ctx.sellerGstin && rowGstin !== ctx.sellerGstin) {
      rowIssues.push({ kind: "other_gstin", severity: "error", message: `This row belongs to GSTIN ${rowGstin}, not the GSTIN chosen for the import (${ctx.sellerGstin}).` });
    }

    const stateText = get(row, "customerState");
    const pos = placeOfSupply(stateText);
    if (!pos) rowIssues.push({ kind: "unknown_state", severity: "error", message: stateText ? `"${stateText}" is not a State or Union Territory name, so the place of supply is unknown.` : "No customer State, so the place of supply is unknown." });
    const type = supplyType(sellerGstin, pos);

    let computedTax: Paise | null = null;
    let reportedTax: Paise;
    if (rateMilli != null) {
      const check = checkTax(taxable, rateMilli, sourceTax);
      computedTax = check.computed;
      reportedTax = sourceTax ?? check.computed;
      if (sourceTax == null) notes.push("No tax amount on the row; the tax was worked out from the taxable value and rate.");
      else if (!check.withinTolerance) {
        rowIssues.push({
          kind: "tax_mismatch",
          severity: "warning",
          message: `The report shows tax of ${formatInr(sourceTax)}; ${rateText(rateMilli)}% of ${formatInr(taxable)} is ${formatInr(check.computed)} (difference ${formatInr(check.difference)}).`,
          details: { source: sourceTax, computed: check.computed, difference: check.difference, rule: `taxable × ${rateText(rateMilli)}%, rounded to the paisa; 1 paisa either way is treated as rounding` },
        });
      }
    } else reportedTax = sourceTax ?? 0;

    if (invoiceRead && Math.abs(taxable + reportedTax - invoiceValue) > 2) {
      rowIssues.push({
        kind: "invoice_value_mismatch",
        severity: "warning",
        message: `Taxable value plus tax (${formatInr(taxable + reportedTax)}) is not the invoice value (${formatInr(invoiceValue)}).`,
        details: { taxable, tax: reportedTax, invoiceValue, difference: invoiceValue - taxable - reportedTax },
      });
    }

    const split = splitTax(reportedTax, type);
    if (type === "unknown" && reportedTax) notes.push("The tax is not split into IGST or CGST and SGST because the place of supply is unknown.");
    if (shippingRead && shippingRead.paise !== 0) notes.push("Shipping is already inside the taxable value in Meesho's reports; taxable_shipping is shown for reference and not added again.");

    const lastUnderscore = subOrder.lastIndexOf("_");
    const ecoGstin = get(row, "ecoGstin").toUpperCase() || null;
    events.push({
      sourceRow,
      eventType,
      sellerGstin,
      orderId: lastUnderscore > 0 ? subOrder.slice(0, lastUnderscore) : subOrder,
      subOrderId: subOrder,
      lineId: lastUnderscore > 0 ? subOrder.slice(lastUnderscore + 1) : null,
      orderDate,
      documentDate: null,
      returnDate: eventType === "return" ? returnDate : null,
      documentNumber: null,
      reportPeriod,
      financialYear: reportPeriod === "unknown" ? "" : financialYearOf(reportPeriod),
      hsn,
      description: get(row, "description") || null,
      quantity: eventType === "credit_note" ? "0" : quantityAbs,
      uqc: "PCS",
      taxable,
      rateMilli,
      igst: split.igst,
      cgst: split.cgst,
      sgst: split.sgst,
      cess: 0,
      invoiceValue,
      sourceTax,
      computedTax,
      shippingTaxable: shippingRead?.paise ?? null,
      placeOfSupply: pos,
      supplyType: type,
      ecoGstin,
      sourceStatus: map.returnFlag ? get(row, "returnFlag") || null : null,
      raw,
      notes,
      issues: rowIssues,
    });
  }

  if (skippedTotals > 0) {
    issues.push({ kind: "skipped_rows", severity: "info", message: `${skippedTotals} row(s) with no sub-order number were not read (totals, notes or headings under the data).`, details: { rows: skippedTotals } });
  }
  if (inexact > 0) {
    issues.push({ kind: "rounded_amounts", severity: "info", message: `${inexact} amount(s) had more than two decimals and were rounded to the paisa (half away from zero).`, details: { amounts: inexact } });
  }
  if (detection.unknownColumns.length > 0) {
    issues.push({ kind: "unmapped_columns", severity: "info", message: `Kept for reference, not used in calculations: ${detection.unknownColumns.join(", ")}.`, details: { columns: detection.unknownColumns } });
  }
  return { events, issues, periods: [...periods].sort() };
}

function normalizeInvoiceDetails(table: SourceTable, detection: Detection): NormalizeResult {
  const { headers, columnMap: map } = detection;
  const documents: NonNullable<NormalizeResult["documents"]> = [];
  for (let i = detection.headerIndex + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const sub = cell(row, headers, map.subOrderId);
    const number = cell(row, headers, map.documentNumber);
    if (!sub || !number) continue;
    const type = /credit/i.test(cell(row, headers, map.documentType)) ? "credit_note" : "invoice";
    documents.push({ subOrderId: sub, type, number, date: isoDate(cell(row, headers, map.documentDate)) });
  }
  return { events: [], issues: [], periods: [], documents };
}

/** A CA's HSN pivot (HSN, count, taxable, IGST, CGST, SGST), read only to compare with what TallyThis works out. */
function normalizeCaSummary(table: SourceTable): NormalizeResult {
  const headerIndex = table.rows.findIndex(row => CA_SUMMARY_KEYS.every(k => row.some(c => key(c).includes(k))));
  if (headerIndex < 0) return { events: [], issues: [], periods: [] };
  const headers = table.rows[headerIndex].map(key);
  const col = (test: (k: string) => boolean) => headers.findIndex(test);
  const hsnCol = col(k => k === "hsn");
  const countCol = col(k => k.includes("count") || k.includes("quantity"));
  const taxableCol = col(k => k.includes("taxable"));
  const igstCol = col(k => k.includes("integrated") || k.includes("igst"));
  const cgstCol = col(k => k.includes("central") || k.includes("cgst"));
  const sgstCol = col(k => k.includes("stateut") || k.includes("sgst") || (k.includes("state") && k.includes("tax")));
  const caSummary: NonNullable<NormalizeResult["caSummary"]> = [];
  for (const row of table.rows.slice(headerIndex + 1)) {
    const hsn = (row[hsnCol] ?? "").trim();
    if (!hsn) continue;
    const amount = (index: number) => (index < 0 ? 0 : readAmount(row[index])?.paise ?? 0);
    const count = countCol < 0 ? null : Number(String(row[countCol] ?? "").replace(/,/g, "")) || null;
    caSummary.push({ hsn, count, taxable: amount(taxableCol), igst: amount(igstCol), cgst: amount(cgstCol), sgst: amount(sgstCol) });
  }
  return { events: [], issues: [], periods: [], caSummary };
}

export const meeshoAdapter: MarketplaceAdapter = {
  id: "meesho",
  name: "Meesho",
  capabilities: ["file_import", "sales", "returns", "credit_notes", "gst", "documents"],
  mandatory: MANDATORY,
  fieldAliases: MEESHO_ALIASES,
  detect(table) {
    return detectionFor(table, MEESHO_ALIASES, MANDATORY, reportTypeOf);
  },
  normalize(table, detection, ctx) {
    if (detection.reportType === "invoice_details") return normalizeInvoiceDetails(table, detection);
    if (detection.reportType === "ca_hsn_summary") return normalizeCaSummary(table);
    if (detection.reportType === "unknown" || detection.missing.length > 0) return { events: [], issues: [], periods: [] };
    return normalizeRows(table, detection, ctx);
  },
};
