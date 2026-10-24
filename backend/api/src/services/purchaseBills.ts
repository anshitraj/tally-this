/**
 * Purchase bills → Tally Purchase vouchers.
 *
 * Bills come from a purchase list (Excel/CSV), from invoice PDFs with a text layer, or from an AI
 * reading of a scan. Whatever the source, every bill is checked here the same way, and only bills
 * that pass reach the XML. Money is held in whole paise. Nothing here decides whether input tax
 * credit may be claimed; it records what the invoice says.
 */
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import {
  amountCell,
  findHeaderRow,
  gstinChecksumOk,
  isoDate,
  mapColumns,
  normalizeGstin,
  canonicalDocNumber,
  sumColumns,
  textCell,
  type Table,
} from "./gstrRecon";
import { stateCode, stateFromGstin, stateName } from "./gstStates";
import { LEDGER_GROUPS } from "./tallyVoucherXml";
import type { InvoiceRow } from "./invoiceVerify";
import type { BillTaxLines } from "./invoicePdf";

export type BillSource = "pdf" | "sheet" | "ai";

/** One bill as the page holds it, in rupees. The page may have corrected any field. */
export interface BillInput {
  key: string;
  source: BillSource;
  fileName: string;
  row: number;
  supplierName: string;
  supplierGstin: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  placeOfSupply: string | null;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  total: number;
  reverseCharge: boolean;
  /** Purchase or expense ledger for this bill. Empty means the default purchase ledger. */
  ledger?: string | null;
  /** False when the person left the bill out, or it repeats another bill. */
  include?: boolean;
  /** The tax was split between heads by state codes, not printed on the invoice. */
  derived?: boolean;
  /** Credit and debit notes are listed but not converted here. */
  note?: boolean;
}

export interface BillIssue {
  level: "block" | "warn";
  code: string;
  message: string;
}

export interface CheckedBill extends BillInput {
  gstinValid: boolean;
  /** Total minus (taxable + tax), in rupees. Posted to the round-off ledger when it is under ₹1. */
  roundOff: number;
  issues: BillIssue[];
  blocked: boolean;
  duplicateOf: string | null;
  supplierState: string | null;
}

const paise = (value: number) => Math.round((Number.isFinite(value) ? value : 0) * 100);
const rupees = (value: number) => value / 100;

/** The most a printed total may differ from taxable value plus tax and still be treated as round-off. */
export const ROUND_OFF_LIMIT_PAISE = 100;

export function supplierKey(bill: Pick<BillInput, "supplierGstin" | "supplierName">): string {
  const gstin = normalizeGstin(bill.supplierGstin);
  return gstin || `name:${bill.supplierName.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function tidyName(value: string) {
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, 100);
  // A name printed all in capitals, or typed all in lower case, reads better as a proper name.
  const flat = /[A-Za-z]{3}/.test(cleaned) && (cleaned === cleaned.toUpperCase() || cleaned === cleaned.toLowerCase());
  return flat ? cleaned.toLowerCase().replace(/\b([a-z])/g, letter => letter.toUpperCase()) : cleaned;
}

export interface CheckContext {
  /** The client's own GSTIN, when known. It says which state the purchase is delivered to. */
  recipientGstin?: string | null;
}

/** Checks every bill. The result never drops a bill; it says what is wrong with it. */
export function checkBills(input: BillInput[], context: CheckContext = {}): CheckedBill[] {
  const recipientState = stateFromGstin(context.recipientGstin ?? null);
  const seen = new Map<string, string>();
  return input.map(bill => {
    const issues: BillIssue[] = [];
    const block = (code: string, message: string) => issues.push({ level: "block", code, message });
    const warn = (code: string, message: string) => issues.push({ level: "warn", code, message });

    const gstin = normalizeGstin(bill.supplierGstin);
    const gstinValid = gstin === "" ? false : gstinChecksumOk(gstin);
    const name = bill.supplierName.trim();
    const number = bill.invoiceNumber.trim();
    const taxable = paise(bill.taxable);
    const igst = paise(bill.igst);
    const cgst = paise(bill.cgst);
    const sgst = paise(bill.sgst);
    const cess = paise(bill.cess);
    const total = paise(bill.total);
    const tax = igst + cgst + sgst + cess;
    const roundOff = total - (taxable + tax);
    const supplierState = stateFromGstin(gstin);

    if (bill.note) warn("note", "This is a credit or debit note. Notes are not converted here; enter it in Tally.");
    if (!name) block("no_supplier", "Supplier name is missing.");
    if (!number) block("no_number", "Invoice number is missing.");
    if (!bill.invoiceDate || !/^\d{4}-\d{2}-\d{2}$/.test(bill.invoiceDate)) block("no_date", "Invoice date is missing or not a valid date.");
    if (gstin && !gstinValid) block("gstin", `GSTIN ${gstin} does not look right. Check it against the invoice.`);
    if (!gstin && tax > 0 && !bill.reverseCharge) warn("tax_without_gstin", "Tax is shown but the supplier has no GSTIN. Check the invoice.");
    if (!gstin && tax === 0) warn("unregistered", "No supplier GSTIN: booked as a purchase from an unregistered supplier.");
    if (total <= 0 && taxable <= 0) block("no_amount", "No invoice amount was found.");
    if (taxable < 0 || tax < 0 || total < 0) warn("negative", "A value is negative. Credit and debit notes are not converted here.");
    if (igst > 0 && (cgst > 0 || sgst > 0)) block("mixed_tax", "IGST and CGST/SGST appear together. A bill has one or the other.");
    if (cgst > 0 && sgst > 0 && Math.abs(cgst - sgst) > ROUND_OFF_LIMIT_PAISE) block("cgst_sgst", "CGST and SGST differ. They are normally equal.");
    if ((cgst > 0) !== (sgst > 0) && igst === 0) block("one_sided", "Only one of CGST and SGST is present.");
    if (Math.abs(roundOff) > ROUND_OFF_LIMIT_PAISE) {
      block("total_mismatch", `Taxable value plus tax is ${rupees(taxable + tax).toFixed(2)} but the invoice total is ${rupees(total).toFixed(2)}.`);
    }
    if (taxable > 0 && tax > 0 && tax * 100 > taxable * 45) warn("rate_high", "Tax is more than 45% of the taxable value. Check the amounts.");
    if (bill.derived && igst === 0 && cgst === 0 && sgst === 0 && tax === 0 && total > taxable) {
      block("tax_type", "Choose whether the tax is CGST + SGST or IGST.");
    }
    if (supplierState && recipientState && igst + cgst + sgst > 0) {
      const sameState = supplierState === recipientState;
      if (sameState && igst > 0) warn("state_type", `Supplier and buyer are both in ${stateName(supplierState)}, but IGST is charged. Check the place of supply.`);
      if (!sameState && (cgst > 0 || sgst > 0)) warn("state_type", `Supplier is in ${stateName(supplierState)}, buyer in ${stateName(recipientState)}, but CGST/SGST is charged. Check the place of supply.`);
    }

    let duplicateOf: string | null = null;
    const identity = `${supplierKey(bill)}|${canonicalDocNumber(number)}`;
    if (number && bill.include !== false) {
      const first = seen.get(identity);
      if (first) {
        duplicateOf = first;
        block("duplicate", "The same supplier and invoice number appear on another bill in this upload.");
      } else {
        seen.set(identity, bill.key);
      }
    }
    const blocked = bill.include !== false && issues.some(issue => issue.level === "block");
    return { ...bill, supplierGstin: gstin, gstinValid, roundOff: rupees(roundOff), issues, blocked, duplicateOf, supplierState };
  });
}

// ── Reading ─────────────────────────────────────────────────────────────────

let counter = 0;
const nextKey = (prefix: string) => `${prefix}-${(counter += 1)}`;

/** Only for tests, so keys are stable. */
export function resetBillKeys() {
  counter = 0;
}

const NOTE_WORDS = /credit\s*note|debit\s*note|purchase\s*return|sales\s*return|\bcdn\b/i;

export interface SheetBills {
  bills: BillInput[];
  notes: string[];
  rowsSkipped: number;
}

/** A purchase list or Tally purchase register. Lines without a GSTIN are kept: they are real purchases. */
export function readBillsFromTable(table: Table, fileName: string): SheetBills {
  const headerRow = findHeaderRow(table);
  if (headerRow < 0) {
    throw new Error(
      `We could not find the columns in ${fileName}. Use a purchase list with supplier name, invoice number, invoice date, taxable value, GST amounts and total.`,
    );
  }
  const map = mapColumns(table[headerRow] ?? []);
  if (map.docNo === undefined) throw new Error(`${fileName} has no invoice number column. Add one and upload again.`);
  if (map.party === undefined && map.gstin === undefined) throw new Error(`${fileName} has no supplier name or GSTIN column. Add one and upload again.`);
  if (map.taxable === undefined && map.total === undefined) throw new Error(`${fileName} has no taxable value or total column. Add one and upload again.`);

  const bills: BillInput[] = [];
  const stats = { rounded: 0 };
  let skipped = 0;
  for (let i = headerRow + 1; i < table.length; i += 1) {
    const cells = table[i] ?? [];
    if (cells.every(cell => String(cell ?? "").trim() === "")) continue;
    const rowNumber = i + 1;
    const supplierName = textCell(cells[map.party ?? -1]);
    const invoiceNumber = textCell(cells[map.docNo]);
    if (/^(grand )?total\b|^closing|^opening|^sub ?total/i.test(supplierName)) continue;
    if (!invoiceNumber && !supplierName) continue;
    if (!invoiceNumber) {
      skipped += 1;
      continue;
    }
    const igst = sumColumns(cells, map.igst, "IGST", rowNumber, stats);
    const cgst = sumColumns(cells, map.cgst, "CGST", rowNumber, stats);
    const sgst = sumColumns(cells, map.sgst, "SGST", rowNumber, stats);
    const cess = sumColumns(cells, map.cess, "cess", rowNumber, stats);
    const printed = map.total !== undefined && textCell(cells[map.total]) !== "" ? amountCell(cells[map.total], "invoice total", rowNumber, stats) : null;
    const tax = igst + cgst + sgst + cess;
    let taxable = map.taxable !== undefined && textCell(cells[map.taxable]) !== "" ? amountCell(cells[map.taxable], "taxable value", rowNumber, stats) : null;
    if (taxable === null) taxable = printed !== null ? printed - tax : 0;
    const typeText = `${textCell(cells[map.voucherType ?? -1])} ${textCell(cells[map.noteType ?? -1])}`;
    const note = NOTE_WORDS.test(typeText) || taxable < 0 || (printed ?? 0) < 0;
    const total = printed ?? taxable + tax;
    bills.push({
      key: nextKey("s"),
      source: "sheet",
      fileName,
      row: rowNumber,
      supplierName,
      supplierGstin: normalizeGstin(textCell(cells[map.gstin ?? -1])),
      invoiceNumber,
      invoiceDate: isoDate(cells[map.docDate ?? -1]) ?? isoDate(cells[map.voucherDate ?? -1]),
      placeOfSupply: null,
      taxable: rupees(taxable),
      igst: rupees(igst),
      cgst: rupees(cgst),
      sgst: rupees(sgst),
      cess: rupees(cess),
      total: rupees(total),
      reverseCharge: /^y/i.test(textCell(cells[map.reverse ?? -1])),
      include: note ? false : true,
      note,
    });
  }
  const notes: string[] = [];
  if (skipped > 0) notes.push(`${skipped} ${skipped === 1 ? "line has" : "lines have"} no invoice number and ${skipped === 1 ? "was" : "were"} left out.`);
  if (stats.rounded > 0) notes.push(`${stats.rounded} ${stats.rounded === 1 ? "amount carried" : "amounts carried"} more than two decimals and ${stats.rounded === 1 ? "was" : "were"} rounded to the nearest paisa.`);
  if (bills.length === 0) throw new Error(`No purchase bills were found in ${fileName}.`);
  return { bills, notes, rowsSkipped: skipped };
}

/** One invoice read from a PDF's printed text. Tax lines may be missing; the checks then ask for review. */
export function billFromPdf(row: InvoiceRow, tax: BillTaxLines, fileName: string, recipientGstin?: string | null): BillInput {
  const printedTax = tax.igst + tax.cgst + tax.sgst + tax.cess;
  const onlyTotalTax = printedTax === 0 && (row.tax ?? 0) > 0;
  const taxable = tax.taxable ?? Math.round((row.total - (printedTax > 0 ? printedTax : row.tax ?? 0)) * 100) / 100;
  const bill: BillInput = {
    key: nextKey("p"),
    source: "pdf",
    fileName,
    row: row.rowNumber,
    supplierName: row.vendorName === "Unknown vendor" ? "" : row.vendorName,
    supplierGstin: normalizeGstin(row.vendorGstin ?? ""),
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    placeOfSupply: tax.placeOfSupply,
    taxable: taxable > 0 ? taxable : 0,
    igst: tax.igst,
    cgst: tax.cgst,
    sgst: tax.sgst,
    cess: tax.cess,
    total: row.total,
    reverseCharge: tax.reverseCharge,
    include: true,
    derived: onlyTotalTax,
  };
  // Only a total tax figure was printed: split it by the two states when both are known.
  return onlyTotalTax ? splitTax(bill, row.tax ?? 0, recipientGstin) : bill;
}

/** An invoice read by AI: it carries a total and one tax figure, so the heads are worked out from states. */
export function billFromAi(row: InvoiceRow, fileName: string, recipientGstin?: string | null): BillInput {
  const totalTax = row.tax ?? 0;
  const taxable = Math.round((row.total - totalTax) * 100) / 100;
  return splitTax(
    {
      key: nextKey("a"),
      source: "ai",
      fileName,
      row: row.rowNumber,
      supplierName: row.vendorName === "Unknown vendor" ? "" : row.vendorName,
      supplierGstin: normalizeGstin(row.vendorGstin ?? ""),
      invoiceNumber: row.invoiceNumber,
      invoiceDate: row.invoiceDate,
      placeOfSupply: null,
      taxable,
      igst: 0,
      cgst: 0,
      sgst: 0,
      cess: 0,
      total: row.total,
      reverseCharge: false,
      include: true,
      derived: true,
    },
    totalTax,
    recipientGstin,
  );
}

/** Splits one tax figure into heads by the two states. Left unsplit when a state is unknown. */
export function splitTax(bill: BillInput, totalTax: number, recipientGstin?: string | null): BillInput {
  if (totalTax <= 0) return bill;
  const from = stateFromGstin(bill.supplierGstin);
  const to = stateFromGstin(recipientGstin ?? null) ?? stateCode(bill.placeOfSupply);
  if (!from || !to) return bill;
  if (from !== to) return { ...bill, igst: totalTax, cgst: 0, sgst: 0 };
  const half = Math.round(totalTax * 50) / 100;
  return { ...bill, igst: 0, cgst: half, sgst: Math.round((totalTax - half) * 100) / 100 };
}

// ── Tally XML ───────────────────────────────────────────────────────────────

export interface PurchaseXmlConfig {
  clientName: string;
  tallyCompany?: string;
  purchaseLedger: string;
  igstLedger: string;
  cgstLedger: string;
  sgstLedger: string;
  cessLedger: string;
  roundOffLedger: string;
  /** Supplier key → ledger name chosen for that supplier. Others use the supplier's own name. */
  partyLedgers?: Record<string, string>;
  /** Adds create-only supplier masters. Existing ledgers are left untouched. */
  createParties?: boolean;
  /** Records the supplier invoice number as the bill reference, so Tally's outstanding report tracks it. */
  billWise?: boolean;
  /** "auto" leaves voucher numbers to Tally; "series" numbers them PREFIX-00001 from `startAt`. */
  numbering?: "auto" | "series";
  prefix?: string;
  startAt?: number;
}

export interface PurchaseXmlResult {
  ok: boolean;
  xml?: string;
  mastersXml?: string;
  fileName?: string;
  voucherCount?: number;
  errors: string[];
  /** What each voucher posts, for the preview and the Excel copy. */
  vouchers: Array<{ key: string; voucherNumber: string; party: string; ledger: string; total: number; date: string; reference: string }>;
}

function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const tallyDate = (iso: string) => iso.replace(/-/g, "");
const amountText = (paiseValue: number) => (paiseValue / 100).toFixed(2);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/** Stable identity for a bill, so sending the same bill again is recognised by Tally. */
export function billGuid(scope: string, bill: Pick<BillInput, "supplierGstin" | "supplierName" | "invoiceNumber" | "invoiceDate">): string {
  const digest = createHash("sha256")
    .update([scope.trim().toLowerCase(), supplierKey(bill), canonicalDocNumber(bill.invoiceNumber), bill.invoiceDate ?? ""].join("|"))
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function line(name: string, debit: boolean, paiseValue: number, extra = "") {
  const signed = debit ? -paiseValue : paiseValue;
  return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEscape(name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${amountText(signed)}</AMOUNT>${extra}</ALLLEDGERENTRIES.LIST>`;
}

function master(name: string, group: string, extra = "") {
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xmlEscape(name)}" ACTION="Create"><NAME.LIST><NAME>${xmlEscape(name)}</NAME></NAME.LIST><PARENT>${xmlEscape(group)}</PARENT>${extra}</LEDGER></TALLYMESSAGE>`;
}

function envelope(report: "Vouchers" | "All Masters", data: string, company?: string) {
  const target = company?.trim() ? `<STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(company.trim())}</SVCURRENTCOMPANY></STATICVARIABLES>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME>${target}</REQUESTDESC><REQUESTDATA>${data}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

/** Ledger name for each supplier. Two suppliers with one name but different GSTINs get the state added. */
export function supplierLedgers(bills: CheckedBill[], chosen: Record<string, string> = {}): Map<string, string> {
  const byKey = new Map<string, { name: string; state: string | null }>();
  for (const bill of bills) {
    const key = supplierKey(bill);
    if (!byKey.has(key)) byKey.set(key, { name: tidyName(bill.supplierName), state: bill.supplierState });
  }
  const sameName = new Map<string, string[]>();
  for (const [key, entry] of byKey) {
    const list = sameName.get(entry.name.toLowerCase()) ?? [];
    list.push(key);
    sameName.set(entry.name.toLowerCase(), list);
  }
  const out = new Map<string, string>();
  for (const [key, entry] of byKey) {
    const picked = chosen[key]?.trim();
    if (picked) {
      out.set(key, picked.slice(0, 120));
      continue;
    }
    const group = sameName.get(entry.name.toLowerCase()) ?? [];
    let suffix = "";
    if (group.length > 1) {
      const states = group.map(other => byKey.get(other)?.state ?? "");
      const distinct = states.every(state => state !== "") && new Set(states).size === states.length;
      suffix = distinct ? ` - ${stateName(entry.state) ?? ""}` : ` - ${key.startsWith("name:") ? "2" : key.slice(-4)}`;
    }
    out.set(key, `${entry.name}${suffix}`.slice(0, 120));
  }
  return out;
}

export function buildPurchaseXml(checked: CheckedBill[], config: PurchaseXmlConfig): PurchaseXmlResult {
  const errors: string[] = [];
  const empty: PurchaseXmlResult["vouchers"] = [];
  const active = checked.filter(bill => bill.include !== false && !bill.note);
  if (!config.clientName.trim()) errors.push("Client or company name is required.");
  if (active.length === 0) errors.push("No bills are included.");
  const blocked = active.filter(bill => bill.blocked);
  if (blocked.length > 0) {
    errors.push(`${blocked.length} ${blocked.length === 1 ? "bill needs" : "bills need"} attention before a Tally file can be made.`);
    for (const bill of blocked.slice(0, 5)) errors.push(`${bill.invoiceNumber || `Row ${bill.row}`}: ${bill.issues.find(issue => issue.level === "block")?.message ?? "Needs review."}`);
  }
  for (const [label, value] of [
    ["Purchase ledger", config.purchaseLedger],
    ["IGST ledger", config.igstLedger],
    ["CGST ledger", config.cgstLedger],
    ["SGST ledger", config.sgstLedger],
    ["Cess ledger", config.cessLedger],
  ] as const) {
    if (!value.trim()) errors.push(`${label} is required.`);
  }
  if (errors.length > 0) return { ok: false, errors, vouchers: empty };

  const parties = supplierLedgers(active, config.partyLedgers);
  const masters = new Map<string, string>();
  const vouchers: string[] = [];
  const summary: PurchaseXmlResult["vouchers"] = [];
  const seenGuid = new Set<string>();
  const numbering = config.numbering ?? "auto";
  const prefix = (config.prefix ?? "PUR").replace(/[^A-Za-z0-9/_-]/g, "").slice(0, 12) || "PUR";
  let sequence = Math.max(1, Math.floor(config.startAt ?? 1));

  for (const bill of active) {
    const date = tallyDate(bill.invoiceDate ?? "");
    const party = parties.get(supplierKey(bill)) ?? tidyName(bill.supplierName);
    const ledger = (bill.ledger?.trim() || config.purchaseLedger).slice(0, 120);
    const taxable = paise(bill.taxable);
    const igst = paise(bill.igst);
    const cgst = paise(bill.cgst);
    const sgst = paise(bill.sgst);
    const cess = paise(bill.cess);
    const total = paise(bill.total);
    const roundOff = total - (taxable + igst + cgst + sgst + cess);
    if ([party, ledger, bill.invoiceNumber, bill.supplierName].some(value => CONTROL.test(value))) {
      errors.push(`${bill.invoiceNumber}: text contains characters XML cannot represent.`);
      continue;
    }
    if (party.toLowerCase() === ledger.toLowerCase()) {
      errors.push(`${bill.invoiceNumber}: the supplier ledger and the purchase ledger are the same.`);
      continue;
    }
    const guid = billGuid(config.clientName, bill);
    if (seenGuid.has(guid)) {
      errors.push(`${bill.invoiceNumber}: this supplier and invoice number are included twice.`);
      continue;
    }
    seenGuid.add(guid);
    const number = numbering === "series" ? `${prefix}-${String(sequence++).padStart(5, "0")}` : "";
    const lines: string[] = [];
    const bills = config.billWise === false ? "" : `<BILLALLOCATIONS.LIST><NAME>${xmlEscape(bill.invoiceNumber)}</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>${amountText(total)}</AMOUNT></BILLALLOCATIONS.LIST>`;
    lines.push(line(party, false, total, bills));
    lines.push(line(ledger, true, taxable));
    if (igst) lines.push(line(config.igstLedger, true, igst));
    if (cgst) lines.push(line(config.cgstLedger, true, cgst));
    if (sgst) lines.push(line(config.sgstLedger, true, sgst));
    if (cess) lines.push(line(config.cessLedger, true, cess));
    if (roundOff !== 0) lines.push(line(config.roundOffLedger || "Round Off", roundOff > 0, Math.abs(roundOff)));

    const gstin = bill.supplierGstin;
    const place = stateName(stateCode(bill.placeOfSupply)) ?? stateName(bill.supplierState);
    const narration = `${bill.supplierName.trim()} invoice ${bill.invoiceNumber}${bill.fileName ? ` (${bill.fileName})` : ""}`.slice(0, 250);
    vouchers.push(
      `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Purchase" ACTION="Create">` +
        `<DATE>${date}</DATE><GUID>${guid}</GUID><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>` +
        (number ? `<VOUCHERNUMBER>${xmlEscape(number)}</VOUCHERNUMBER>` : "") +
        `<REFERENCE>${xmlEscape(bill.invoiceNumber)}</REFERENCE><REFERENCEDATE>${date}</REFERENCEDATE>` +
        `<PARTYLEDGERNAME>${xmlEscape(party)}</PARTYLEDGERNAME>` +
        (gstin ? `<PARTYGSTIN>${gstin}</PARTYGSTIN>` : "") +
        (place ? `<PLACEOFSUPPLY>${xmlEscape(place)}</PLACEOFSUPPLY>` : "") +
        `<NARRATION>${xmlEscape(narration)}</NARRATION>${lines.join("")}</VOUCHER></TALLYMESSAGE>`,
    );
    summary.push({ key: bill.key, voucherNumber: number, party, ledger, total: rupees(total), date: bill.invoiceDate ?? "", reference: bill.invoiceNumber });

    if (config.createParties !== false && !masters.has(party.toLowerCase())) {
      const details =
        `<ISBILLWISEON>Yes</ISBILLWISEON>` +
        (gstin
          ? `<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE><PARTYGSTIN>${gstin}</PARTYGSTIN>${bill.supplierState ? `<LEDSTATENAME>${xmlEscape(stateName(bill.supplierState) ?? "")}</LEDSTATENAME>` : ""}`
          : `<GSTREGISTRATIONTYPE>Unregistered</GSTREGISTRATIONTYPE>`);
      masters.set(party.toLowerCase(), master(party, "Sundry Creditors", details));
    }
    const group = LEDGER_GROUPS[ledger];
    if (config.createParties !== false && group && !masters.has(ledger.toLowerCase()) && ledger.toLowerCase() !== config.purchaseLedger.toLowerCase()) {
      masters.set(ledger.toLowerCase(), master(ledger, group));
    }
  }
  if (errors.length > 0) return { ok: false, errors, vouchers: empty };
  if (config.createParties !== false && !masters.has(config.purchaseLedger.toLowerCase())) {
    masters.set(config.purchaseLedger.toLowerCase(), master(config.purchaseLedger, LEDGER_GROUPS[config.purchaseLedger] ?? "Purchase Accounts"));
  }

  const xml = envelope("Vouchers", vouchers.join(""), config.tallyCompany);
  const check = validatePurchaseXml(xml, vouchers.length);
  if (!check.ok) return { ok: false, errors: check.errors, vouchers: empty };
  const safe = config.clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
  return {
    ok: true,
    xml,
    mastersXml: envelope("All Masters", [...masters.values()].join(""), config.tallyCompany),
    fileName: `${safe}-purchase-vouchers.xml`,
    voucherCount: vouchers.length,
    errors: [],
    vouchers: summary,
  };
}

/** Structure and balance of the Purchase XML, checked before it is handed over. */
export function validatePurchaseXml(xml: string, expected: number): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!xml.startsWith("<?xml")) errors.push("XML declaration is missing.");
  if (!xml.includes("<TALLYREQUEST>Import Data</TALLYREQUEST>")) errors.push("Tally import request is missing.");
  const chunks = xml.split("<VOUCHER ").slice(1);
  if (chunks.length !== expected) errors.push(`Expected ${expected} vouchers, found ${chunks.length}.`);
  if (xml.includes("<LEDGERNAME></LEDGERNAME>")) errors.push("A voucher has an empty ledger name.");
  chunks.forEach((chunk, index) => {
    if (!/<DATE>\d{8}<\/DATE>/.test(chunk)) errors.push(`Voucher ${index + 1} has no valid date.`);
    // Bill allocations repeat the party amount, so only the ledger lines are summed.
    const body = chunk.replace(/<BILLALLOCATIONS\.LIST>[\s\S]*?<\/BILLALLOCATIONS\.LIST>/g, "");
    const amounts = [...body.matchAll(/<AMOUNT>(-?\d+\.\d{2})<\/AMOUNT>/g)].map(match => Math.round(Number(match[1]) * 100));
    if (amounts.length < 2) errors.push(`Voucher ${index + 1} has fewer than two ledger lines.`);
    else if (amounts.reduce((sum, value) => sum + value, 0) !== 0) errors.push(`Voucher ${index + 1} does not balance to the paise.`);
  });
  return { ok: errors.length === 0, errors };
}

// ── Excel copy ──────────────────────────────────────────────────────────────

const MONEY = "#,##0.00;[Red](#,##0.00)";

export function buildBillsWorkbook(input: { clientName: string; bills: CheckedBill[]; vouchers: PurchaseXmlResult["vouchers"] }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TallyThis";
  const sheet = workbook.addWorksheet("Purchase bills", { views: [{ state: "frozen", ySplit: 3 }] });
  sheet.getCell("A1").value = `${input.clientName} · Purchase bills`;
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getRow(3).values = ["Supplier", "GSTIN", "Invoice no.", "Date", "Taxable", "IGST", "CGST", "SGST", "Cess", "Round off", "Total", "Ledger", "Tally voucher", "Status", "File"];
  sheet.getRow(3).font = { bold: true };
  sheet.columns = [34, 18, 18, 12, 14, 12, 12, 12, 10, 10, 14, 24, 14, 44, 28].map(width => ({ width }));
  const byKey = new Map(input.vouchers.map(voucher => [voucher.key, voucher]));
  input.bills.forEach((bill, index) => {
    const voucher = byKey.get(bill.key);
    const status =
      bill.include === false ? "Left out" : bill.note ? "Credit/debit note: not converted" : bill.blocked ? bill.issues.find(issue => issue.level === "block")?.message ?? "Needs review" : bill.issues.some(issue => issue.level === "warn") ? `Check: ${bill.issues.find(issue => issue.level === "warn")?.message}` : "Ready";
    const row = sheet.getRow(4 + index);
    row.values = [
      bill.supplierName,
      bill.supplierGstin,
      bill.invoiceNumber,
      bill.invoiceDate ? new Date(`${bill.invoiceDate}T00:00:00.000Z`) : "",
      bill.taxable,
      bill.igst,
      bill.cgst,
      bill.sgst,
      bill.cess,
      bill.roundOff,
      bill.total,
      voucher?.ledger ?? bill.ledger ?? "",
      voucher?.voucherNumber || (voucher ? "Auto" : ""),
      status,
      bill.fileName,
    ];
    for (const column of [5, 6, 7, 8, 9, 10, 11]) row.getCell(column).numFmt = MONEY;
    if (bill.invoiceDate) row.getCell(4).numFmt = "dd/mm/yyyy";
  });
  const last = 3 + input.bills.length;
  const totals = sheet.getRow(last + 2);
  totals.getCell(1).value = "Total (included bills)";
  totals.font = { bold: true };
  const included = input.bills.filter(bill => bill.include !== false && !bill.note);
  const sum = (pick: (bill: CheckedBill) => number) => included.reduce((total, bill) => total + paise(pick(bill)), 0) / 100;
  [
    [5, sum(bill => bill.taxable)],
    [6, sum(bill => bill.igst)],
    [7, sum(bill => bill.cgst)],
    [8, sum(bill => bill.sgst)],
    [9, sum(bill => bill.cess)],
    [10, sum(bill => bill.roundOff)],
    [11, sum(bill => bill.total)],
  ].forEach(([column, value]) => {
    totals.getCell(column).value = value;
    totals.getCell(column).numFmt = MONEY;
  });
  return workbook;
}
