/**
 * E-commerce workspace: the shapes the API answers with and the calls the pages make. Money arrives from the server as
 * exact decimal strings ("1234.50") or integer paise; nothing here works tax out, it only formats what it is given.
 */
import { getAuthToken } from "@/lib/auth";
import { getActiveClient } from "@/lib/activeClient";
import { readJson } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface MarketplaceInfo {
  id: string;
  name: string;
  description: string;
  status: "available" | "coming_soon";
  sourceFiles: string[];
  capabilities: string[];
  connection: "report_import";
  logo: string | null;
  usage?: { transactions: number; periods: number; lastImport: string } | null;
}

export interface Totals {
  count: number;
  quantity: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  tax: number;
  invoiceValue: number;
  unassignedTax: number;
}

export interface Overview {
  period: string;
  sales: Totals;
  returns: Totals;
  creditNotes: Totals;
  net: Totals;
  byRate: Array<{ rate: string; sales: number; reductions: number; net: number; tax: number }>;
}

export interface ReportState {
  id: number | null;
  status: "draft" | "needs_review" | "reconciled" | "approved";
  openBlocking: number;
  approvedBy: number | null;
  approvedAt: string | null;
  approvalOutdated: boolean;
  approver?: string | null;
}

export interface ImportJob {
  id: string;
  status: "queued" | "running" | "needs_mapping" | "completed" | "failed";
  stage: string;
  stageLabel: string;
  progress: number;
  message: string | null;
  period: string | null;
  financialYear: string | null;
  sellerGstin: string | null;
  createdAt: string;
  completedAt: string | null;
  uploads: Array<{ name: string; size: number }>;
  files: Array<{ fileName: string; sheetName: string | null; reportType: string; label: string; status: string; rows: number; periods: string[] }>;
  transactions: number | null;
  counted: number | null;
  duplicates: number | null;
  conflicts?: number | null;
  sales: number | null;
  returns: number | null;
  exceptions: number | null;
  periods: string[];
  problems: Array<{ fileName: string; message: string }>;
  needsMapping: Array<{ key: string; fileName: string; sheetName: string | null; headers: string[]; missing: string[]; columnMap: Record<string, string>; aliases: Record<string, string[]> }>;
}

export interface Workspace {
  ok: boolean;
  marketplace: MarketplaceInfo;
  can: { import: boolean; remove: boolean; review: boolean; approve: boolean; export: boolean };
  company: { name: string; gstin: string | null };
  sellerGstins: string[];
  periods: Array<{ period: string; events: number; sales: number; reductions: number }>;
  period: string | null;
  data: null | {
    overview: Overview;
    exceptions: { openBlocking: number; openInfo: number; resolved: number };
    report: ReportState;
    statuses: Array<{ status: string; n: number }>;
    duplicates: number;
    hsnCount: number;
    stateCount: number;
  };
  byMonth: Array<{ period: string; sales: string; returns: string }>;
  jobs: ImportJob[];
  stages: Array<{ id: string; label: string }>;
}

export interface TransactionRow {
  id: number;
  eventType: string;
  sourceType: string;
  orderId: string | null;
  subOrderId: string | null;
  orderDate: string | null;
  returnDate: string | null;
  documentNumber: string | null;
  hsn: string | null;
  description: string | null;
  quantity: string | null;
  taxable: string;
  rate: string | null;
  igst: string;
  cgst: string;
  sgst: string;
  cess: string;
  invoiceValue: string;
  sourceTax: string | null;
  computedTax: string | null;
  placeOfSupply: string | null;
  posName: string | null;
  supplyType: string;
  status: string;
  duplicateOf: number | null;
  relatedEventId: number | null;
  sourceRow: number;
  fileName: string | null;
  sheetName: string | null;
  openExceptions: number;
}

export interface ExceptionRow {
  id: number;
  eventId: number | null;
  kind: string;
  severity: "error" | "warning" | "info";
  status: "open" | "resolved" | "accepted";
  message: string;
  details: Record<string, unknown>;
  note: string | null;
  resolvedAt: string | null;
  createdAt: string;
  subOrderId: string | null;
  taxable: string | null;
  eventType: string | null;
}

export interface HsnRow { hsn: string; description: string | null; uqc: string; rate: string; sales: Totals; returns: Totals; net: Totals }
export interface StateRow { pos: string; posName: string; rate: string; supplyType: string; ecoGstin: string | null; sales: Totals; returns: Totals; net: Totals }

export interface Summary {
  ok: boolean;
  period: string | null;
  rounding: "line" | "aggregate";
  overview: Overview;
  hsn: HsnRow[];
  states: StateRow[];
  gstr1: {
    b2cs: Array<{ type: "E" | "OE"; pos: string; posName: string; rate: string; ecoGstin: string | null; taxable: number; igst: number; cgst: number; sgst: number; cess: number; negative: boolean }>;
    b2clCandidates: Array<{ reference: string; pos: string | null; invoiceValue: number; taxable: number }>;
    table12: HsnRow[];
    table13: { available: boolean; reason?: string; invoices: Array<{ prefix: string; from: string; to: string; count: number }>; creditNotes: Array<{ prefix: string; from: string; to: string; count: number }> };
    table14a: Array<{ ecoGstin: string; taxable: number; igst: number; cgst: number; sgst: number; cess: number }>;
    tcs: { netTaxable: number; expected: number; rate: string; note: string };
    unassigned: { count: number; taxable: number };
    notes: string[];
  };
  ca: null | { fileName: string; rows: Array<{ hsn: string; ca: { count: number | null; taxable: number; igst: number; cgst: number; sgst: number }; ours: { count: number; taxable: number; igst: number; cgst: number; sgst: number } | null; difference: { taxable: number; igst: number; cgst: number; sgst: number } | null }> };
}

export function api<T>(path: string): Promise<T> {
  return fetch(`${BASE}/api${path}`).then(response => readJson<T>(response));
}

export async function send<T = { ok: boolean }>(method: "POST" | "DELETE", path: string, body?: unknown): Promise<T & { ok: boolean; message?: string }> {
  try {
    const response = await fetch(`${BASE}/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return { ...data, ok: response.ok && data.ok !== false, message: data.message ?? data.error };
  } catch {
    return { ok: false, message: "Could not reach TallyThis. Check your connection and try again." } as T & { ok: boolean; message?: string };
  }
}

/**
 * Uploads report files with real progress (fetch cannot report upload progress, so this uses XMLHttpRequest with the
 * same sign-in and client headers the rest of the app sends).
 */
export function uploadReports(
  marketplace: string,
  files: File[],
  fields: { sellerGstin?: string; period?: string; financialYear?: string },
  onProgress: (percent: number) => void,
): Promise<{ ok: boolean; status: number; jobId?: string; message?: string }> {
  return new Promise(resolve => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    for (const [key, value] of Object.entries(fields)) if (value) form.append(key, value);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/api/ecommerce/${encodeURIComponent(marketplace)}/imports`);
    const token = getAuthToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    const client = getActiveClient();
    if (client?.id && client.id > 0) xhr.setRequestHeader("X-Client-Company-Id", String(client.id));
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let data: { ok?: boolean; jobId?: string; message?: string; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // An unreadable answer is reported below.
      }
      const ok = xhr.status >= 200 && xhr.status < 300 && data.ok !== false;
      resolve({ ok, status: xhr.status, jobId: data.jobId, message: data.message ?? data.error ?? (ok ? undefined : "The upload did not go through. Try again.") });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, message: "Could not reach TallyThis. Check your connection and try again." });
    xhr.send(form);
  });
}

export async function download(marketplace: string, period: string, format: "xlsx" | "pdf" | "transactions_csv" | "exceptions_csv", rounding: "line" | "aggregate" = "line"): Promise<{ ok: boolean; message?: string }> {
  try {
    const response = await fetch(`${BASE}/api/ecommerce/${marketplace}/export?period=${period}&format=${format}&rounding=${rounding}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return { ok: false, message: data.message || "The download could not be created." };
    }
    const blob = await response.blob();
    const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? `${marketplace}-${period}.${format.endsWith("csv") ? "csv" : format}`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
    return { ok: true };
  } catch {
    return { ok: false, message: "Could not reach TallyThis. Check your connection and try again." };
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Paise (integer) to "₹1,23,456.78". */
export function rupeesFromPaise(paise: number | null | undefined, options: { whole?: boolean } = {}): string {
  if (paise == null || !Number.isFinite(paise)) return "—";
  const negative = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;
  const grouped = whole.toLocaleString("en-IN");
  const text = options.whole ? grouped : `${grouped}.${String(fraction).padStart(2, "0")}`;
  return `${negative && abs > 0 ? "−" : ""}₹${text}`;
}

/** A decimal string from the database ("1234.50") to "₹1,234.50", without passing through a float. */
export function rupeesFromText(value: string | null | undefined): string {
  if (value == null || value === "") return "—";
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?/.exec(value.trim());
  if (!match) return value;
  const [, sign, int, frac = ""] = match;
  const grouped = BigInt(int).toLocaleString("en-IN");
  const negative = sign === "-" && (/[1-9]/.test(int) || /[1-9]/.test(frac));
  return `${negative ? "−" : ""}₹${grouped}.${frac.padEnd(2, "0")}`;
}

/** "2026-08" to "Aug 2026". */
export function periodLabel(period: string | null | undefined): string {
  if (!period) return "—";
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function financialYearOf(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** "07ABCDE1234F1Z2" to "07ABC•••••••1Z2": enough to recognise, not enough to copy. */
export function maskGstin(gstin: string | null | undefined): string {
  if (!gstin) return "Not given";
  return gstin.length === 15 ? `${gstin.slice(0, 5)}•••••••${gstin.slice(12)}` : gstin;
}

export function dateLabel(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: value.length === 10 ? "UTC" : undefined });
}

export function bytesLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export const STATUS_TEXT: Record<string, { label: string; tone: "good" | "warn" | "risk" | "neutral" | "info" }> = {
  ok: { label: "Ready", tone: "good" },
  matched: { label: "Matched", tone: "good" },
  reviewed: { label: "Reviewed", tone: "good" },
  cross_period: { label: "Earlier-month return", tone: "info" },
  unmatched: { label: "Unmatched return", tone: "warn" },
  missing_info: { label: "Missing details", tone: "risk" },
  tax_mismatch: { label: "Tax difference", tone: "warn" },
  return_mismatch: { label: "Return mismatch", tone: "warn" },
  duplicate: { label: "Duplicate (not counted)", tone: "neutral" },
  conflict: { label: "Different figures (held back)", tone: "warn" },
  unreviewed: { label: "Unreviewed", tone: "neutral" },
};

export const TYPE_TEXT: Record<string, string> = {
  sale: "Sale",
  return: "Return",
  cancellation: "Cancellation",
  credit_note: "Credit note",
  adjustment: "Adjustment",
};

export const REPORT_STATUS: Record<ReportState["status"], { label: string; tone: "good" | "warn" | "neutral" | "info" }> = {
  draft: { label: "Draft", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "warn" },
  reconciled: { label: "Reconciled", tone: "info" },
  approved: { label: "Approved", tone: "good" },
};

export const KIND_TEXT: Record<string, string> = {
  missing_hsn: "HSN missing",
  invalid_hsn: "HSN looks wrong",
  unknown_state: "Customer state not recognised",
  unknown_rate: "GST rate not recognised",
  rate_check: "GST rate to check",
  missing_gstin: "Seller GSTIN missing",
  invalid_gstin: "Seller GSTIN invalid",
  other_gstin: "Another GSTIN's row",
  missing_period: "Month missing",
  missing_taxable: "Taxable value missing",
  invalid_date: "Date not readable",
  tax_mismatch: "Tax differs from rate",
  invoice_value_mismatch: "Invoice value differs",
  unclear_classification: "Sale or return unclear",
  unmatched_return: "Return without its sale",
  return_exceeds_sale: "Returned more than sold",
  cross_period_return: "Return of an earlier month's sale",
  conflicting_rows: "Same order, different figures",
  duplicate: "Duplicate row",
  duplicate_file: "File imported before",
  unsupported_file: "File not recognised",
  unreadable_file: "File could not be read",
  mixed_periods: "Several months in the files",
  skipped_rows: "Rows skipped",
  rounded_amounts: "Amounts rounded",
  unmapped_columns: "Extra columns kept",
  b2cl_candidate: "Large inter-State invoice",
};

export const FIELD_TEXT: Record<string, string> = {
  subOrderId: "Sub-order number",
  orderId: "Order number",
  taxable: "Taxable value",
  gstRate: "GST rate",
  customerState: "Customer state",
  hsn: "HSN code",
  quantity: "Quantity",
  orderDate: "Order date",
  returnDate: "Return date",
  sellerGstin: "Seller GSTIN",
  tax: "Tax amount",
  invoiceValue: "Invoice value",
  month: "Month",
  financialYear: "Financial year",
  returnFlag: "Return flag",
  ecoGstin: "Marketplace GSTIN",
  documentNumber: "Invoice or credit-note number",
  documentType: "Document type",
};
