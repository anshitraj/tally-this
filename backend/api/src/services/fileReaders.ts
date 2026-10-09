/**
 * Turns any uploaded file into rows the deterministic parsers understand.
 * Order: CSV/Excel → PDF text tables → OCR → Claude/Gemini document reading.
 * Anything read by OCR or AI is labelled pending review.
 */
import { parseUploadedFile } from "./fileParser";
import { applyStatementMeta, parseBankStatement, extractionFailureMessage, type BankStatementSummary } from "./bankStatement";
import { aiDocumentReadingAvailable, mimeFor, readBankStatementWithAI, readInvoicesWithAI } from "./aiDocumentReader";
import { readStatementPdf, renderPdfPages } from "./pdfStatement";
import { checkRunningBalance, chronological, type StatementCheck } from "./statementCheck";
import { AI_BLOCKED_MESSAGE, AI_CONSENT_MESSAGE, aiDecision } from "./privacyPolicy";
import { parseInvoiceCsv, type InvoiceRow } from "./invoiceVerify";
import { extensionOf, isDocumentFile, sheetToCsvText } from "./fileDetect";

export { detectFileKind, detectMarketplace, sheetToCsvText } from "./fileDetect";

export type UploadedFile = Express.Multer.File;

function rowsToCsv(columns: string[], rows: Record<string, unknown>[]) {
  const quote = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map(quote).join(","), ...rows.map(row => columns.map(column => quote(row[column])).join(","))].join("\n");
}

export interface StatementRead {
  ok: boolean;
  summary: BankStatementSummary | null;
  /**
   * How the rows were read. "pdf_layout" = read from the PDF table by column position.
   * "ai" and "ocr" rows are pending review unless the running-balance check proves them.
   */
  source: "sheet" | "pdf_layout" | "pdf_text" | "ocr" | "ai" | "none";
  check?: StatementCheck;
  aiProvider?: string;
  needsPassword?: boolean;
  wrongPassword?: boolean;
  /** Privacy mode: a scan needs AI and the person has not agreed yet. */
  needsAiConsent?: boolean;
  message: string;
}

const LOCKED = "This PDF is password-protected. Enter the PDF password to continue.";
const WRONG = "That password did not open the PDF. Check it and try again.";

/** Fewer failed rows wins; then more proved rows. */
function better(a: { check: StatementCheck }, b: { check: StatementCheck }) {
  if (a.check.verified !== b.check.verified) return a.check.verified ? a : b;
  if (a.check.failed !== b.check.failed) return a.check.failed < b.check.failed ? a : b;
  return a.check.passed >= b.check.passed ? a : b;
}

export async function readBankStatementFile(
  file: UploadedFile,
  ctx: { password?: string; companyId?: number | null; userId?: number | null; privacy?: boolean; allowAi?: boolean } = {},
): Promise<StatementRead> {
  const fileName = file.originalname || "statement";
  const privacy = ctx.privacy === true;
  if (!isDocumentFile(file)) {
    const text = sheetToCsvText(file);
    const summary = parseBankStatement(text, fileName);
    if (summary.transactions.length === 0) {
      return { ok: false, summary, source: "none", message: extractionFailureMessage({ textLength: 100, rowCount: 0, parser: "csv" }) ?? summary.message };
    }
    const ordered = chronological(summary.transactions);
    // The opening balance of a sheet is derived from its first row, so it cannot prove anything.
    const check = checkRunningBalance(ordered, null, {});
    return { ok: true, summary, source: "sheet", check, message: summary.message };
  }

  const isPdf = extensionOf(fileName) === "pdf" || file.mimetype === "application/pdf";
  let layout: { summary: BankStatementSummary; check: StatementCheck } | null = null;
  let textLength = 0;

  // 1. Text PDF: read the table by column position and prove each row with the running balance.
  if (isPdf) {
    const read = await readStatementPdf(file.buffer, { password: ctx.password, fileName }).catch(() => null);
    if (read?.status === "needs_password") return { ok: false, summary: null, source: "none", needsPassword: true, message: LOCKED };
    if (read?.status === "wrong_password") return { ok: false, summary: null, source: "none", needsPassword: true, wrongPassword: true, message: WRONG };
    if (read?.status === "ok" && read.summary && read.check) {
      layout = { summary: read.summary, check: read.check };
      if (read.check.verified) return { ok: true, summary: read.summary, source: "pdf_layout", check: read.check, message: read.summary.message };
    }
    textLength = read?.headerText.length ?? 0;
  }

  // 2. Scanned, photographed or unusual statements, or a table read that did not fully prove:
  //    a second, independent read by AI. Locked PDFs are sent as page images.
  //    In privacy mode a file the table reader already read never goes to AI, and a scan only
  //    goes with the person's agreement.
  const decision = aiDecision({ privacy, allowAi: ctx.allowAi === true, aiConfigured: aiDocumentReadingAvailable(), readWithoutAi: layout != null });
  if (decision === "ask_consent") return { ok: false, summary: null, source: "none", needsAiConsent: true, message: AI_CONSENT_MESSAGE };
  if (decision === "ai_blocked") return { ok: false, summary: null, source: "none", message: AI_BLOCKED_MESSAGE };
  if (decision === "use_ai" && aiDocumentReadingAvailable()) {
    let files: Array<{ data: Buffer; mimeType: string }> = [];
    if (isPdf && ctx.password) files = (await renderPdfPages(file.buffer, ctx.password).catch(() => [])).map(data => ({ data, mimeType: "image/png" }));
    else files = [{ data: file.buffer, mimeType: mimeFor(fileName, file.mimetype) }];
    if (files.length > 0) {
      const ai = await readBankStatementWithAI({ files, fileName, companyId: privacy ? null : ctx.companyId, userId: privacy ? null : ctx.userId, privacy });
      if (ai.ok) {
        const pick = layout ? better(layout, ai.read) : ai.read;
        if (pick === ai.read) {
          const summary = ai.read.summary;
          if (!ai.read.check.verified) summary.warnings = [...summary.warnings, "AI extracted — pending review."];
          return { ok: true, summary, source: "ai", aiProvider: ai.read.provider, check: ai.read.check, message: summary.message };
        }
      }
    }
  }
  if (layout) return { ok: true, summary: layout.summary, source: "pdf_layout", check: layout.check, message: layout.summary.message };
  // Privacy mode keeps to the in-memory readers: no temp files, no local OCR, no helper services.
  if (privacy) return { ok: false, summary: null, source: "none", message: "No transactions could be read from this file. Try the bank's Excel or CSV download." };

  // 3. Last resort: the older text-table and OCR pipeline.
  let ruleSummary: BankStatementSummary | null = null;
  let source: StatementRead["source"] = "none";
  try {
    const parsed = await parseUploadedFile(file, "bank", { password: ctx.password });
    textLength = Math.max(textLength, parsed.textLength ?? parsed.textPreview?.length ?? 0);
    if (parsed.parsedRows?.length) {
      const columns = parsed.detectedColumns.length > 0 ? parsed.detectedColumns : Object.keys(parsed.parsedRows[0] ?? {});
      ruleSummary = applyStatementMeta(parseBankStatement(rowsToCsv(columns, parsed.parsedRows), fileName), parsed.textPreview ?? "", fileName);
      source = parsed.ocrStatus === "pending_review" ? "ocr" : "pdf_text";
    } else if (parsed.ocrStatus === "pending_review" && parsed.extractedText) {
      ruleSummary = parseBankStatement(parsed.extractedText, fileName);
      source = "ocr";
    }
  } catch (err) {
    const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
    if (/password|encrypt/i.test(text)) return { ok: false, summary: null, source: "none", needsPassword: true, wrongPassword: Boolean(ctx.password), message: ctx.password ? WRONG : LOCKED };
  }
  if (ruleSummary && ruleSummary.transactions.length > 0) {
    ruleSummary.status = "needs_review";
    const check = checkRunningBalance(chronological(ruleSummary.transactions), null, {});
    return { ok: true, summary: ruleSummary, source, check, message: ruleSummary.message };
  }

  const parserKind = isPdf ? "pdf" : "image";
  const base = extractionFailureMessage({ textLength, rowCount: 0, parser: parserKind }) ?? "No transactions were found in this file.";
  return {
    ok: false,
    summary: null,
    source: "none",
    message: aiDocumentReadingAvailable()
      ? `${base} Try the bank's Excel or CSV download.`
      : `${base} Add a Claude or Gemini API key to read scanned statements, or upload the bank's Excel/CSV download.`,
  };
}

/** Invoice register (CSV/Excel) or invoice documents (PDF/images, read by AI). */
export async function readInvoiceFiles(
  files: UploadedFile[],
  ctx: { companyId?: number | null; userId?: number | null; privacy?: boolean; allowAi?: boolean } = {},
): Promise<{ rows: InvoiceRow[]; aiRead: number; failed: string[]; needsAiConsent?: boolean; aiBlocked?: boolean }> {
  const privacy = ctx.privacy === true;
  let aiBlocked = false;
  const rows: InvoiceRow[] = [];
  const failed: string[] = [];
  let aiRead = 0;
  for (const file of files) {
    if (!isDocumentFile(file)) {
      const parsed = parseInvoiceCsv(sheetToCsvText(file));
      if (parsed.length === 0) failed.push(file.originalname);
      rows.push(...parsed);
      continue;
    }
    const decision = aiDecision({ privacy, allowAi: ctx.allowAi === true, aiConfigured: aiDocumentReadingAvailable(), readWithoutAi: false });
    if (decision === "ask_consent") return { rows: [], aiRead: 0, failed: [], needsAiConsent: true };
    if (decision === "ai_blocked") {
      aiBlocked = true;
      failed.push(file.originalname);
      continue;
    }
    if (!aiDocumentReadingAvailable()) {
      failed.push(file.originalname);
      continue;
    }
    const result = await readInvoicesWithAI({
      buffer: file.buffer,
      fileName: file.originalname,
      mimeType: mimeFor(file.originalname, file.mimetype),
      companyId: privacy ? null : ctx.companyId,
      userId: privacy ? null : ctx.userId,
      privacy,
    });
    if (!result.ok || result.rows.length === 0) {
      failed.push(file.originalname);
      continue;
    }
    aiRead += result.rows.length;
    rows.push(...result.rows);
  }
  return { rows, aiRead, failed, aiBlocked };
}
