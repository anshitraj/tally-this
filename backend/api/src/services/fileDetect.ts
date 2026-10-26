/**
 * File type detection. Pure: no database or network, so it is unit-tested directly.
 */
import * as XLSX from "xlsx";
import { scanCsvTable } from "./bankStatement";
import type { MarketplacePlatform } from "./ecommerceGst";

export type UploadedFile = Pick<Express.Multer.File, "originalname" | "mimetype" | "buffer">;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"]);

/** A spreadsheet that cannot be opened. The message is safe to show as it is. */
export class UnreadableFileError extends Error {
  constructor(message = "This Excel file could not be opened. It may be damaged or password-protected. Save it again as .xlsx or CSV and try again.") {
    super(message);
    this.name = "UnreadableFileError";
  }
}

// Uploaded workbooks are untrusted: formulas and styles are never needed, and the row count is bounded.
const WORKBOOK_LIMITS = { cellFormula: false, cellHTML: false, cellStyles: false, sheetRows: 250_000 } as const;

export function extensionOf(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

export function isDocumentFile(file: UploadedFile) {
  const ext = extensionOf(file.originalname);
  return ext === "pdf" || IMAGE_EXT.has(ext) || (file.mimetype ?? "").startsWith("image/");
}

/** CSV or a single populated Excel table. Never silently omit another financial sheet. */
export function sheetToCsvText(file: UploadedFile, maxRows: number = WORKBOOK_LIMITS.sheetRows): string {
  const ext = extensionOf(file.originalname);
  if (ext !== "xlsx" && ext !== "xls" && ext !== "xlsm") return file.buffer.toString("utf8").replace(/^\uFEFF/, "");
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: false, ...WORKBOOK_LIMITS, sheetRows: maxRows });
  } catch {
    throw new UnreadableFileError();
  }
  let best = "";
  let bestRows = -1;
  const populatedTables: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    if (sheet["!fullref"] && sheet["!fullref"] !== sheet["!ref"]) throw new UnreadableFileError("This Excel sheet exceeds the reading limit and would be incomplete. Save a smaller period as CSV and try again.");
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const rows = scanCsvTable(csv)?.rows.length ?? 0;
    if (rows > 0) populatedTables.push(name);
    if (rows > bestRows) {
      best = csv;
      bestRows = rows;
    }
  }
  if (populatedTables.length > 1) throw new UnreadableFileError("This workbook has multiple populated financial tables. Save each sheet as CSV and upload those files separately so no rows are missed.");
  return best;
}

// ── Detection ───────────────────────────────────────────────────────────────

const PLATFORM_HINTS: Array<[MarketplacePlatform, RegExp]> = [
  ["amazon", /amazon|amzn|(^|[^a-z])mtr([^a-z]|$)|merchant tax report|asin/i],
  ["flipkart", /flipkart|(^|[^a-z])fk[-_ ]|(^|[^a-z])fsn([^a-z]|$)/i],
  ["meesho", /meesho|supplier id|sub order/i],
  ["myntra", /myntra|ppmp|\bstyle id/i],
  ["jiomart", /jiomart|jio mart/i],
  ["glowroad", /glow\s?road/i],
  ["shop101", /shop\s?101/i],
  ["paytm", /paytm/i],
  ["snapdeal", /snapdeal/i],
  ["ajio", /ajio/i],
  ["citymall", /city\s?mall/i],
  ["limeroad", /lime\s?road/i],
];

/** Guesses the marketplace from the file name, then the header and first rows. */
export function detectMarketplace(fileName: string, text: string): MarketplacePlatform {
  const head = text.split(/\r?\n/).slice(0, 6).join(" ");
  for (const [platform, pattern] of PLATFORM_HINTS) {
    if (pattern.test(fileName)) return platform;
  }
  for (const [platform, pattern] of PLATFORM_HINTS) {
    if (pattern.test(head)) return platform;
  }
  return "generic";
}

/** What to say when a file that should be a bank statement is not one. */
export const NOT_A_STATEMENT =
  "This doesn't look like a bank statement. It looks like something else, so there is nothing to convert. Upload your bank statement as a PDF, Excel or CSV.";

/**
 * Names what the file looks like when it is another kind of file TallyThis knows, and points to the
 * right job; otherwise says plainly that it looks like something else.
 */
export function notAStatementMessage(file: UploadedFile): string {
  if (isDocumentFile(file)) return NOT_A_STATEMENT;
  let kind: FileKind = "unknown";
  try {
    kind = detectFileKind(file).kind;
  } catch {
    // An unreadable file is simply "something else".
  }
  if (kind === "tally_export") return "This looks like a Tally export, not a bank statement. To compare it with your bank, use Bank ↔ Tally and add the bank statement too.";
  if (kind === "marketplace_report") return "This looks like a marketplace sales report, not a bank statement. Use E-commerce GST for it.";
  if (kind === "invoice_register") return "This looks like an invoice list, not a bank statement. Use Invoice ↔ Bank and add the bank statement too.";
  if (kind === "sales_register") return "This looks like a sales register, not a bank statement. Use Sales → GSTR-1 for it.";
  if (kind === "purchase_register") return "This looks like a purchase list, not a bank statement. Use Bills → Tally for it.";
  if (kind === "payroll_sheet") return "This looks like a salary sheet, not a bank statement. Use Payroll for it.";
  return NOT_A_STATEMENT;
}

export type FileKind =
  | "bank_statement"
  | "tally_export"
  | "marketplace_report"
  | "invoice_register"
  | "invoice_document"
  | "sales_register"
  | "purchase_register"
  | "payroll_sheet"
  | "unknown";

/** A register that carries GST columns is a sales or purchase register, whichever way it is named. */
function gstRegisterKind(header: string, name: string, preamble: string, text: string): "sales_register" | "purchase_register" | null {
  if (!/igst|cgst|sgst/.test(header)) return null;
  if (!/taxable|gross total|invoice value|total/.test(header)) return null;
  if (!/voucher|invoice|bill|particulars|party|gstin|customer|supplier/.test(header)) return null;
  const label = `${name} ${preamble} ${header}`;
  const head = text.split(/\r?\n/).slice(0, 60).join(" ").toLowerCase();
  const sales = (label.match(/\bsales?\b|customer|buyer|outward|debtor/g) ?? []).length + (head.match(/\bsales?\b/g) ?? []).length;
  const purchases = (label.match(/\bpurchases?\b|supplier|vendor|inward|creditor/g) ?? []).length + (head.match(/\bpurchases?\b/g) ?? []).length;
  if (sales === purchases) return null;
  return sales > purchases ? "sales_register" : "purchase_register";
}

/** Classifies a file so the home page can send it to the right job without questions. */
export function detectFileKind(file: UploadedFile): { kind: FileKind; platform?: MarketplacePlatform } {
  const name = file.originalname.toLowerCase();
  if (isDocumentFile(file)) {
    if (extensionOf(name) === "pdf" && /tally|day[-_ ]?book|ledger|voucher|vch/i.test(name)) return { kind: "tally_export" };
    if (/invoice|bill|inv[-_ ]?\d/i.test(name)) return { kind: "invoice_document" };
    return { kind: "bank_statement" };
  }
  // Tally's own XML and HTML exports are not spreadsheets, so they are recognised by their markup.
  const ext = extensionOf(name);
  if (ext === "xml" || ext === "html" || ext === "htm") {
    const head = file.buffer.subarray(0, 4096).toString("utf8");
    if (/<ENVELOPE\b|<TALLYMESSAGE\b|<VOUCHER\b/i.test(head) || /tally|day[-_ ]?book|ledger|voucher/i.test(name)) return { kind: "tally_export" };
    return { kind: "unknown" };
  }
  let text = "";
  try {
    text = sheetToCsvText(file);
  } catch {
    return { kind: "unknown" };
  }
  const header = (scanCsvTable(text)?.columns ?? []).join(" ").toLowerCase();
  const preamble = text.split(/\r?\n/).slice(0, 8).join(" ").toLowerCase();
  const platformByName = /amazon|flipkart|meesho|myntra|jiomart|glowroad|shop101|paytm|snapdeal|ajio|citymall|limeroad/.test(name);
  if (/order id|order_id|sub order|asin|fsn|\bsku\b/.test(header) || platformByName) {
    return { kind: "marketplace_report", platform: detectMarketplace(file.originalname, text) };
  }
  // A salary sheet has an employee column and pay heads; a bank statement has neither. Its title
  // lines sit above the heading row, so the first lines of the file are read, not only the heading.
  const top = text.split(/\r?\n/).slice(0, 30).join("\n").toLowerCase();
  if (/employee|emp\.? name|staff name/.test(top) && /\bbasic\b|net pay|net salary/.test(top) && /\bpf\b|\besi\b|\bgross\b|net pay|net salary/.test(top) && !/withdrawal|deposit|narration/.test(top)) {
    return { kind: "payroll_sheet" };
  }
  const register = gstRegisterKind(header, name, preamble, text);
  if (register) return { kind: register };
  if (/taxable value|place of supply|tcs/.test(header)) {
    return { kind: "marketplace_report", platform: detectMarketplace(file.originalname, text) };
  }
  if (/vch|voucher|particulars/.test(header) && !/balance|withdrawal|deposit/.test(header)) return { kind: "tally_export" };
  if (/tally|daybook|day book|ledger/.test(name) || /tally/.test(preamble)) return { kind: "tally_export" };
  if (/invoice|bill no|bill number/.test(header) && /total|amount/.test(header) && !/balance|withdrawal|deposit/.test(header)) {
    return { kind: "invoice_register" };
  }
  if (/narration|withdrawal|deposit|balance|debit|credit|particulars|description/.test(header)) return { kind: "bank_statement" };
  return { kind: "unknown" };
}
