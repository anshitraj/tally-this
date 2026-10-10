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

/** CSV or Excel to CSV text. Picks the sheet with the most table rows. */
export function sheetToCsvText(file: UploadedFile): string {
  const ext = extensionOf(file.originalname);
  if (ext !== "xlsx" && ext !== "xls" && ext !== "xlsm") return file.buffer.toString("utf8").replace(/^\uFEFF/, "");
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: false, ...WORKBOOK_LIMITS });
  } catch {
    throw new UnreadableFileError();
  }
  let best = "";
  let bestRows = -1;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const rows = scanCsvTable(csv)?.rows.length ?? 0;
    if (rows > bestRows) {
      best = csv;
      bestRows = rows;
    }
  }
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

export type FileKind = "bank_statement" | "tally_export" | "marketplace_report" | "invoice_register" | "invoice_document" | "unknown";

/** Classifies a file so the home page can send it to the right job without questions. */
export function detectFileKind(file: UploadedFile): { kind: FileKind; platform?: MarketplacePlatform } {
  const name = file.originalname.toLowerCase();
  if (isDocumentFile(file)) {
    if (/invoice|bill|inv[-_ ]?\d/i.test(name)) return { kind: "invoice_document" };
    return { kind: "bank_statement" };
  }
  let text = "";
  try {
    text = sheetToCsvText(file);
  } catch {
    return { kind: "unknown" };
  }
  const header = (scanCsvTable(text)?.columns ?? []).join(" ").toLowerCase();
  const preamble = text.split(/\r?\n/).slice(0, 8).join(" ").toLowerCase();
  if (/order id|order_id|sub order|asin|fsn|taxable value|place of supply|tcs/.test(header) || /amazon|flipkart|meesho|myntra|jiomart|glowroad|shop101|paytm|snapdeal|ajio|citymall|limeroad/.test(name)) {
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
