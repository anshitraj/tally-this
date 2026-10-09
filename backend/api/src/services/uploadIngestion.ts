import {
  bankTransactionsTable,
  db,
  gatewaySettlementsTable,
  gstRecordsTable,
  invoicesTable,
  ledgerEntriesTable,
  payrollEntriesTable,
} from "@workspace/db";
import type { ParsedFileResult } from "./fileParser";

export interface UploadImportSummary {
  table: string | null;
  inserted: number;
  skipped: number;
  notes: string[];
}

type Row = Record<string, unknown>;

const SOURCE_TO_TABLE: Record<string, UploadImportSummary["table"]> = {
  bank: "bank_transactions",
  bank_statement: "bank_transactions",
  bankstatement: "bank_transactions",
  invoices: "invoices",
  invoice: "invoices",
  tally: "ledger_entries",
  tally_export: "ledger_entries",
  tallyexport: "ledger_entries",
  ledger: "ledger_entries",
  ledger_entries: "ledger_entries",
  zoho: "invoices",
  zoho_export: "invoices",
  gst: "gst_records",
  gst_tds: "gst_records",
  gsttds: "gst_records",
  payroll: "payroll_entries",
  gateway: "gateway_settlements",
  gateway_settlement: "gateway_settlements",
  gatewaysettlement: "gateway_settlements",
  expenses: "bank_transactions", // expense rows → bank_transactions as debit entries
  expense: "bank_transactions",
};

// ─── Column name normalizer ───────────────────────────────────────────────────
// Strips everything except letters and digits, lowercases.
// "Debit Amt (INR)" → "debitamtinr"
function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ─── Robust multi-strategy column value lookup ────────────────────────────────
// Strategy 1: exact normalized match (e.g. "date" === "date")
// Strategy 2: alias is contained in key  ("txndate" contains "date")
// Strategy 3: key is contained in alias  ("dt" contained in "txndate")
// Strategy 4: longest common substring >= 4 chars
function value(row: Row, aliases: string[]): string | null {
  const entries = Object.entries(row);
  const normalizedAliases = aliases.map(normalizeKey).filter(a => a.length >= 2);

  // Pass 1: exact normalized match
  for (const [key, raw] of entries) {
    const k = normalizeKey(key);
    if (normalizedAliases.includes(k)) {
      const text = String(raw ?? "").trim();
      if (text) return text;
    }
  }

  // Pass 2: alias is a substring of the column key
  for (const [key, raw] of entries) {
    const k = normalizeKey(key);
    if (k.length < 2) continue;
    const hit = normalizedAliases.find(a => a.length >= 3 && k.includes(a));
    if (hit) {
      const text = String(raw ?? "").trim();
      if (text) return text;
    }
  }

  // Pass 3: column key is a substring of an alias
  for (const [key, raw] of entries) {
    const k = normalizeKey(key);
    if (k.length < 3) continue;
    const hit = normalizedAliases.find(a => a.length >= 3 && a.includes(k));
    if (hit) {
      const text = String(raw ?? "").trim();
      if (text) return text;
    }
  }

  return null;
}

// ─── Amount normalization ─────────────────────────────────────────────────────
// Handles: "1,23,456.78", "₹1234.56", "1234.56 INR", "(1234.56)" [negatives]
function normalizeAmountStr(raw: string): number | null {
  if (!raw) return null;
  // Strip currency symbols, "(INR)", spaces
  let cleaned = raw
    .replace(/[₹\$£€]/g, "")
    .replace(/\(INR\)/gi, "")
    .replace(/\bINR\b/gi, "")
    .replace(/\bRS\.?\b/gi, "")
    .replace(/\s/g, "")
    .replace(/,/g, "");
  // Handle accounting negatives: (1234.56) → -1234.56
  if (cleaned.startsWith("(") && cleaned.endsWith(")")) {
    cleaned = "-" + cleaned.slice(1, -1);
  }
  if (!cleaned || cleaned === "-") return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function numberValue(row: Row, aliases: string[]): number | null {
  const raw = value(row, aliases);
  if (!raw) return null;
  return normalizeAmountStr(raw);
}

function money(v: number | null | undefined) {
  return Math.abs(v ?? 0).toFixed(2);
}

// ─── Date normalization ───────────────────────────────────────────────────────
// Handles:
//   DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (Indian format)
//   YYYY-MM-DD (ISO)
//   MM/DD/YYYY (US — treated as fallback only)
//   "01 Jan 2026", "01-Jan-2026"
function parseDate(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();

  // ISO: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return s;
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const dmyMatch = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmyMatch) {
    const [, dd, mm, yyyy] = dmyMatch;
    const day = parseInt(dd, 10);
    const month = parseInt(mm, 10);
    const year = parseInt(yyyy, 10);
    // Validate: day 1-31, month 1-12
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  // DD-Mon-YYYY or DD Mon YYYY (e.g. "01 Jan 2026", "15-Feb-2025")
  const monthNames: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const dmonthMatch = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3})[\s\-\/](\d{4})$/);
  if (dmonthMatch) {
    const [, dd, mon, yyyy] = dmonthMatch;
    const mm = monthNames[mon.toLowerCase()];
    if (mm) {
      const day = parseInt(dd, 10);
      return `${yyyy}-${mm}-${String(day).padStart(2, "0")}`;
    }
  }

  // Fallback: try JS Date (handles many formats but may misinterpret DD/MM as MM/DD)
  // Only use if result is a valid date and the string doesn't look like DD/MM
  if (!/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  // Last resort: store the raw string so it's at least visible
  return s;
}

function dateValue(row: Row, aliases: string[]): string | null {
  const raw = value(row, aliases);
  if (!raw) return null;
  return parseDate(raw) ?? raw;
}

function sourceTable(sourceType: string) {
  const key = sourceType.toLowerCase().trim().replace(/[\s-]+/g, "_");
  return SOURCE_TO_TABLE[key] ?? null;
}

function insertNote(table: string | null, inserted: number, skipped: number) {
  if (!table) return "No importer is available for this source type yet.";
  if (inserted > 0) return `Imported ${inserted} rows into ${table} for rule-based reconciliation.`;
  return `No importable rows found for ${table}. Check required columns and try again.`;
}

// ─── Bank statement importer ──────────────────────────────────────────────────
// Covers HDFC, ICICI, SBI, Axis, Kotak, YES, IndusInd CSV formats.
// Column names vary widely — exhaustive alias lists are the fix.
async function importExpenseRows(companyId: number, rows: Row[], uploadId: number | null) {
  const values = rows.flatMap(row => {
    const date = dateValue(row, ["date", "expense date", "txn date", "transaction date", "voucher date", "payment date"]);
    const description = value(row, ["description", "expense", "particulars", "details", "narration", "remarks", "purpose", "expense description", "head"]);
    const amount = numberValue(row, ["amount", "expense amount", "value", "cost", "debit", "amount inr", "total"]);
    if (!date || !description || amount === null || amount === 0) return [];
    const category = value(row, ["category", "type", "head", "expense category", "expense head"]);
    const reference = value(row, ["reference", "bill no", "receipt no", "invoice no", "voucher no", "ref"]);
    return [{
      companyId,
      date,
      narration: description,
      amount: money(amount),
      type: "debit" as const,
      source: "expense" as const,
      bankName: null,
      reference: reference ?? null,
      status: "unverified" as const,
      confidenceScore: 50,  // unverified baseline — reconciliation will score to 85+ when matched
      note: category ? `Expense category: ${category}. Imported from expense sheet.` : "Imported from expense sheet.",
      sourceUploadId: uploadId,
    }];
  });
  if (values.length === 0) return 0;
  await db.insert(bankTransactionsTable).values(values);
  return values.length;
}

async function importBankRows(companyId: number, rows: Row[], uploadId: number | null) {
  const values = rows.flatMap(row => {
    // Date — every major Indian bank format
    const date = dateValue(row, [
      "date",
      "txn date",
      "transaction date",
      "value date",
      "posting date",
      "tran date",
      "booking date",
      "entry date",
      "cheque date",
      "instrument date",
      "value dt",
      "txn dt",
    ]);

    // Narration / description
    const narration = value(row, [
      "narration",
      "description",
      "particulars",
      "details",
      "remarks",
      "transaction remarks",
      "transaction particulars",
      "transaction description",
      "transaction details",
      "cheque details",
      "beneficiary",
      "transaction narration",
      "payment details",
      "memo",
      "reference details",
      "tran remarks",
    ]);

    // Credit (money IN)
    const credit = numberValue(row, [
      "credit",
      "credit amt",
      "credit amount",
      "credit amt (inr)",
      "deposit",
      "deposit amt",
      "deposit amount",
      "deposit amt (inr)",
      "paid in",
      "receipt",
      "receipts",
      "cr",
      "cr amount",
      "cr amt",
      "inflow",
      "money in",
      "amount credited",
      "credit (inr)",
    ]);

    // Debit (money OUT)
    const debit = numberValue(row, [
      "debit",
      "debit amt",
      "debit amount",
      "debit amt (inr)",
      "withdrawal",
      "withdrawal amt",
      "withdrawal amount",
      "withdrawal amt (inr)",
      "paid out",
      "payment",
      "payments",
      "dr",
      "dr amount",
      "dr amt",
      "outflow",
      "money out",
      "amount debited",
      "debit (inr)",
      "charges",
    ]);

    // Signed amount (some formats have a single amount column with +/-)
    const signedAmount = numberValue(row, [
      "amount",
      "transaction amount",
      "tran amount",
      "amt",
      "net amount",
    ]);

    // Balance (for context / audit — not required for import)
    const balance = value(row, [
      "balance",
      "closing balance",
      "available balance",
      "running balance",
      "balance amt",
      "balance (inr)",
      "bal",
    ]);

    // Determine amount and transaction type
    const amount = credit ?? debit ?? (signedAmount !== null ? Math.abs(signedAmount) : null);
    if (amount === null || amount === 0) return [];

    const type =
      credit !== null && credit > 0
        ? "credit"
        : debit !== null && debit > 0
          ? "debit"
          : signedAmount !== null && signedAmount < 0
            ? "debit"
            : signedAmount !== null && signedAmount > 0
              ? "credit"
              : "credit";

    if (!date || !narration) return [];

    // Bank / account name
    const bankName = value(row, [
      "bank",
      "bank name",
      "account",
      "account name",
      "account no",
      "a/c name",
    ]);

    // Reference number
    const reference = value(row, [
      "reference",
      "ref",
      "ref no",
      "ref number",
      "utr",
      "utr no",
      "utr number",
      "cheque no",
      "cheque number",
      "chq no",
      "chq number",
      "instrument no",
      "transaction id",
      "txn id",
      "rrn",
      "neft ref",
      "imps ref",
      "trace no",
    ]);

    return [{
      companyId,
      date,
      narration,
      amount: money(amount),
      type,
      source: "bank",
      bankName: bankName ?? null,
      reference: reference ?? null,
      status: "unverified" as const,
      confidenceScore: 50,  // unverified baseline — reconciliation will score to 85+ when matched
      note: balance ? `Closing balance: ${balance}` : "Imported from uploaded bank statement.",
      sourceUploadId: uploadId,
    }];
  });

  if (values.length === 0) return 0;
  await db.insert(bankTransactionsTable).values(values);
  return values.length;
}

// ─── Invoice importer ─────────────────────────────────────────────────────────
async function importInvoiceRows(companyId: number, rows: Row[], sourceType: string, uploadId: number | null) {
  const values = rows.flatMap(row => {
    const invoiceNumber = value(row, [
      "invoice number",
      "invoice no",
      "invoice",
      "inv no",
      "inv number",
      "bill number",
      "bill no",
      "bill",
      "voucher number",
      "voucher no",
      "document number",
      "doc no",
      "reference number",
    ]);

    const date = dateValue(row, [
      "date",
      "invoice date",
      "bill date",
      "doc date",
      "document date",
      "transaction date",
      "voucher date",
    ]);

    const vendorName = value(row, [
      "vendor",
      "vendor name",
      "supplier",
      "supplier name",
      "party",
      "party name",
      "customer",
      "customer name",
      "buyer",
      "buyer name",
      "name",
      "counterparty",
    ]);

    const totalAmount = numberValue(row, [
      "total amount",
      "invoice amount",
      "amount",
      "gross amount",
      "total",
      "net amount",
      "bill amount",
      "taxable value",
      "value",
    ]);

    if (!invoiceNumber || !date || !vendorName || totalAmount === null || totalAmount === 0) return [];

    const cgst = numberValue(row, ["cgst", "cgst amount", "central gst"]);
    const sgst = numberValue(row, ["sgst", "sgst amount", "state gst"]);
    const igst = numberValue(row, ["igst", "igst amount", "integrated gst"]);
    const gstAmount =
      numberValue(row, ["gst", "tax", "tax amount", "gst amount", "total tax"]) ??
      ((cgst ?? 0) + (sgst ?? 0) + (igst ?? 0));

    const typeRaw = value(row, ["type", "invoice type", "document type", "transaction type"]);
    const isSales = typeRaw?.toLowerCase().includes("sale") || typeRaw?.toLowerCase().includes("outward");

    return [{
      companyId,
      invoiceNumber,
      vendorName,
      customerName: value(row, ["customer", "customer name", "buyer", "buyer name", "to"]) ?? null,
      gstin: value(row, ["gstin", "vendor gstin", "supplier gstin", "gst no", "gst number", "gstin of supplier"]) ?? null,
      date,
      amount: money(totalAmount),
      gstAmount: gstAmount > 0 ? money(gstAmount) : null,
      type: isSales ? "sales" : "purchase",
      paymentStatus: "unpaid",
      status: sourceType === "invoices" ? "unverified" : "pending_reconciliation",
      sourceUploadId: uploadId,
    }];
  });

  if (values.length === 0) return 0;
  await db.insert(invoicesTable).values(values);
  return values.length;
}

// ─── Ledger / Tally / Zoho importer ──────────────────────────────────────────
async function importLedgerRows(companyId: number, rows: Row[], uploadId: number | null) {
  const values = rows.flatMap(row => {
    const date = dateValue(row, [
      "date",
      "voucher date",
      "posting date",
      "txn date",
      "transaction date",
      "entry date",
      "doc date",
    ]);

    const ledgerName = value(row, [
      "ledger",
      "ledger name",
      "account",
      "account name",
      "particulars",
      "party",
      "party name",
      "narration",
      "description",
      "details",
      "remarks",
      "name",
      "head",
      "cost centre",
    ]);

    const debit = numberValue(row, ["debit", "dr", "dr amount", "debit amount", "debit amt", "debit (dr)"]);
    const credit = numberValue(row, ["credit", "cr", "cr amount", "credit amount", "credit amt", "credit (cr)"]);
    const amount =
      debit ?? credit ??
      numberValue(row, ["amount", "voucher amount", "transaction amount", "value", "net amount"]);

    if (!date || !ledgerName || amount === null || amount === 0) return [];

    const dcRaw = value(row, ["debit credit", "dr cr", "type", "nature", "dc"]);
    const debitCredit =
      debit !== null && debit > 0
        ? "debit"
        : credit !== null && credit > 0
          ? "credit"
          : (dcRaw?.toLowerCase().startsWith("d") ? "debit" : "credit");

    return [{
      companyId,
      date,
      ledgerName,
      voucherNumber: value(row, ["voucher", "voucher no", "voucher number", "reference", "doc no", "ref no"]) ?? null,
      amount: money(amount),
      debitCredit,
      sourceTool: "upload",
      status: "unmatched",
      sourceUploadId: uploadId,
    }];
  });

  if (values.length === 0) return 0;
  await db.insert(ledgerEntriesTable).values(values);
  return values.length;
}

// ─── Payroll importer ─────────────────────────────────────────────────────────
async function importPayrollRows(companyId: number, rows: Row[], uploadId: number | null) {
  const values = rows.flatMap(row => {
    const employeeName = value(row, [
      "employee",
      "employee name",
      "name",
      "staff name",
      "emp name",
      "employee id",
      "emp id",
    ]);

    const month = value(row, [
      "month",
      "pay month",
      "salary month",
      "period",
      "pay period",
      "month year",
      "payroll period",
    ]);

    const netAmount = numberValue(row, [
      "net amount",
      "net salary",
      "net pay",
      "take home",
      "net ctc",
      "amount",
      "paid amount",
      "net",
    ]);

    if (!employeeName || !month || netAmount === null || netAmount === 0) return [];

    return [{
      companyId,
      employeeName,
      month,
      grossAmount: numberValue(row, [
        "gross amount",
        "gross salary",
        "gross pay",
        "gross ctc",
        "ctc",
        "total earnings",
        "gross",
      ])?.toFixed(2) ?? null,
      netAmount: money(netAmount),
      paymentDate: dateValue(row, ["payment date", "paid date", "date", "salary date", "disbursement date"]) ?? null,
      bankReference: value(row, ["bank reference", "reference", "utr", "neft ref", "transaction id"]) ?? null,
      status: "unverified",
      sourceUploadId: uploadId,
    }];
  });

  if (values.length === 0) return 0;
  await db.insert(payrollEntriesTable).values(values);
  return values.length;
}

// ─── Gateway settlement importer ──────────────────────────────────────────────
async function importGatewayRows(companyId: number, rows: Row[], fileName: string, uploadId: number | null) {
  const providerFromName =
    /cashfree/i.test(fileName)
      ? "Cashfree"
      : /stripe/i.test(fileName)
        ? "Stripe"
        : /razorpay/i.test(fileName)
          ? "Razorpay"
          : /payu/i.test(fileName)
            ? "PayU"
            : /paytm/i.test(fileName)
              ? "Paytm"
              : null;

  const values = rows.flatMap(row => {
    const settlementId = value(row, [
      "settlement id",
      "settlement_id",
      "id",
      "reference",
      "settlement number",
      "payout id",
      "transaction id",
      "transfer id",
      "batch id",
    ]);

    const netAmount = numberValue(row, [
      "net amount",
      "settled amount",
      "amount",
      "net",
      "payout amount",
      "settlement amount",
      "transfer amount",
    ]);

    const settlementDate = dateValue(row, [
      "settlement date",
      "date",
      "paid date",
      "payout date",
      "settled date",
      "transfer date",
      "credit date",
    ]);

    if (!settlementId || netAmount === null || netAmount === 0 || !settlementDate) return [];

    return [{
      companyId,
      provider: value(row, ["provider", "gateway", "payment gateway"]) ?? providerFromName ?? "Gateway",
      settlementId,
      grossAmount: money(numberValue(row, ["gross amount", "gross", "total amount"]) ?? netAmount),
      fees: money(numberValue(row, ["fees", "fee", "charges", "platform fee", "processing fee"]) ?? 0),
      gstOnFees: numberValue(row, ["gst on fees", "tax on fees", "gst", "igst on fees"])?.toFixed(2) ?? null,
      netAmount: money(netAmount),
      settlementDate,
      bankReference: value(row, ["bank reference", "utr", "reference", "neft ref"]) ?? null,
      status: "pending",
      sourceUploadId: uploadId,
    }];
  });

  if (values.length === 0) return 0;
  await db.insert(gatewaySettlementsTable).values(values);
  return values.length;
}

// ─── GST importer ─────────────────────────────────────────────────────────────
async function importGstRows(companyId: number, rows: Row[], uploadId: number | null) {
  const values = rows.flatMap(row => {
    const invoiceNumber = value(row, [
      "invoice number",
      "invoice no",
      "inum",
      "bill number",
      "doc no",
      "reference number",
    ]);

    const period = value(row, ["period", "return period", "month", "tax period", "gstr period"]) ?? "Uploaded period";
    const taxableValue = numberValue(row, ["taxable value", "taxable", "value", "assessable value"]) ?? 0;
    const cgst = numberValue(row, ["cgst", "central tax"]) ?? 0;
    const sgst = numberValue(row, ["sgst", "state tax", "ut tax"]) ?? 0;
    const igst = numberValue(row, ["igst", "integrated tax"]) ?? 0;
    const gstAmount =
      numberValue(row, ["gst", "tax", "igst", "cgst", "sgst", "gst amount", "total tax"]) ??
      (cgst + sgst + igst);

    if (!invoiceNumber && taxableValue === 0 && gstAmount === 0) return [];

    return [{
      companyId,
      period,
      sourceType: "uploaded_gst",
      gstin: value(row, ["gstin", "counterparty gstin", "ctin", "supplier gstin"]) ?? null,
      counterpartyName: value(row, ["counterparty", "counterparty name", "supplier", "party name", "trade name"]) ?? null,
      invoiceNumber,
      invoiceDate: dateValue(row, ["invoice date", "date", "doc date"]) ?? null,
      taxableValue: money(taxableValue),
      gstAmount: money(gstAmount),
      matchStatus: "unmatched",
      riskStatus: "none",
      sourceUploadId: uploadId,
    }];
  });

  if (values.length === 0) return 0;
  await db.insert(gstRecordsTable).values(values);
  return values.length;
}

// ─── Main ingestion entry point ───────────────────────────────────────────────
export async function ingestParsedUpload(input: {
  companyId: number;
  sourceType: string;
  fileName: string;
  parsedFile: ParsedFileResult;
  uploadId?: number | null;
}): Promise<UploadImportSummary> {
  const table = sourceTable(input.sourceType);
  const rows = input.parsedFile.parsedRows ?? [];

  if (input.parsedFile.status !== "parsed" || rows.length === 0 || !table) {
    const isPdf = input.parsedFile.parser === "pdf";
    const isInvoice = ["invoice", "invoices"].includes(input.sourceType.toLowerCase());
    let note: string;
    if (isPdf && isInvoice) {
      note = "PDF invoice parsed — no structured rows. Run AI extraction to extract fields, then accept for import.";
    } else if (isPdf) {
      note = `PDF parsed but no structured table found. Re-upload ${input.sourceType} as CSV or Excel for row-level import.`;
    } else if (!table) {
      note = `No importer available for source type "${input.sourceType}".`;
    } else if (rows.length === 0) {
      note = `0 rows found after parsing. Check that the file has data rows and recognized column headers (Date, Narration/Description, Debit/Credit/Amount).`;
    } else {
      note = insertNote(table, 0, rows.length);
    }
    return { table, inserted: 0, skipped: rows.length, notes: [note] };
  }

  const uploadId = input.uploadId ?? null;
  let inserted = 0;

  // Expense uploads route to bank_transactions but use a dedicated mapper that
  // preserves category metadata in the `note` field and marks source=expense.
  const isExpenseSource = ["expense", "expenses"].includes(input.sourceType.toLowerCase());
  if (table === "bank_transactions" && isExpenseSource) {
    inserted = await importExpenseRows(input.companyId, rows, uploadId);
  } else if (table === "bank_transactions") {
    inserted = await importBankRows(input.companyId, rows, uploadId);
  }
  if (table === "invoices") inserted = await importInvoiceRows(input.companyId, rows, input.sourceType, uploadId);
  if (table === "ledger_entries") inserted = await importLedgerRows(input.companyId, rows, uploadId);
  if (table === "payroll_entries") inserted = await importPayrollRows(input.companyId, rows, uploadId);
  if (table === "gateway_settlements") inserted = await importGatewayRows(input.companyId, rows, input.fileName, uploadId);
  if (table === "gst_records") inserted = await importGstRows(input.companyId, rows, uploadId);

  return {
    table,
    inserted,
    skipped: Math.max(rows.length - inserted, 0),
    notes: [insertNote(table, inserted, Math.max(rows.length - inserted, 0))],
  };
}
