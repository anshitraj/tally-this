/**
 * Turns any uploaded file into rows the deterministic parsers understand.
 * Order: CSV/Excel → PDF text tables → OCR → Claude/Gemini document reading.
 * Anything read by OCR or AI is labelled pending review.
 */
import { parseUploadedFile } from "./fileParser";
import { applyStatementMeta, parseBankStatement, extractionFailureMessage, type BankStatementSummary } from "./bankStatement";
import { aiDocumentReadingAvailable, mimeFor, readBankStatementPages, readBankStatementWithAI, readInvoicesWithAI } from "./aiDocumentReader";
import { openPdfRenderer, readStatementPdf, renderPdfPages } from "./pdfStatement";
import { AI_CALLS_IN_FLIGHT, AI_READ_BUDGET_MS, PAGES_PER_AI_CALL, pageGroups, pageRanges, planAiRead } from "./statementReadPlan";
import { checkRunningBalance, chronological, type StatementCheck } from "./statementCheck";
import { recallStatement, rememberStatement, statementCacheKey } from "./statementCache";
import { AI_BLOCKED_MESSAGE, AI_CONSENT_MESSAGE, aiDecision } from "./privacyPolicy";
import { parseInvoiceCsv, type InvoiceRow } from "./invoiceVerify";
import { extractInvoicesFromText, readPdfText } from "./invoicePdf";
import { NOT_A_STATEMENT, extensionOf, isDocumentFile, notAStatementMessage, sheetToCsvText } from "./fileDetect";

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
const NO_ROWS = NOT_A_STATEMENT;
const AI_DOWN = "The AI reader is not available right now, so this scan could not be read. Try again in a little while, or use the bank's Excel/CSV download or a PDF from net banking.";

/** Fewer failed rows wins; then more proved rows. */
function better(a: { check: StatementCheck }, b: { check: StatementCheck }) {
  if (a.check.verified !== b.check.verified) return a.check.verified ? a : b;
  if (a.check.failed !== b.check.failed) return a.check.failed < b.check.failed ? a : b;
  return a.check.passed >= b.check.passed ? a : b;
}

interface StatementReadContext {
  password?: string;
  companyId?: number | null;
  userId?: number | null;
  privacy?: boolean;
  allowAi?: boolean;
  /** Called while a long scan is being read, with a percentage and a plain description. */
  onProgress?: (percent: number, step: string) => void;
}

/**
 * Reads a bank statement. The same document uploaded again by the same company is answered from
 * memory (never in privacy mode, and spreadsheets are quick enough to read again).
 */
export async function readBankStatementFile(file: UploadedFile, ctx: StatementReadContext = {}): Promise<StatementRead> {
  const cacheKey = ctx.privacy !== true && ctx.companyId != null && isDocumentFile(file)
    ? statementCacheKey({ companyId: ctx.companyId, buffer: file.buffer, password: ctx.password, allowAi: ctx.allowAi === true })
    : null;
  if (cacheKey) {
    const remembered = recallStatement(cacheKey);
    if (remembered) {
      ctx.onProgress?.(95, "Statement already read");
      return remembered;
    }
  }
  const read = await readStatementUncached(file, ctx);
  if (cacheKey) rememberStatement(cacheKey, read);
  return read;
}

async function readStatementUncached(file: UploadedFile, ctx: StatementReadContext): Promise<StatementRead> {
  const fileName = file.originalname || "statement";
  const privacy = ctx.privacy === true;
  if (!isDocumentFile(file)) {
    const text = sheetToCsvText(file);
    const summary = parseBankStatement(text, fileName);
    if (summary.transactions.length === 0) {
      // A sheet that is plainly another kind of file gets a message that says so.
      const other = notAStatementMessage(file);
      return { ok: false, summary, source: "none", message: other === NOT_A_STATEMENT && /statement|narration|withdrawal|deposit|balance/i.test(text.slice(0, 600)) ? summary.message : other };
    }
    const ordered = chronological(summary.transactions);
    // The opening balance of a sheet is derived from its first row, so it cannot prove anything.
    const check = checkRunningBalance(ordered, null, {});
    return { ok: true, summary, source: "sheet", check, message: summary.message };
  }

  const isPdf = extensionOf(fileName) === "pdf" || file.mimetype === "application/pdf";
  let layout: { summary: BankStatementSummary; check: StatementCheck } | null = null;
  let textLength = 0;
  let pageCount = 0;

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
    pageCount = read?.pageCount ?? 0;
  }

  // 2. Scanned, photographed or unusual statements, or a table read that did not fully prove:
  //    a second, independent read by AI. Locked PDFs are sent as page images.
  //    In privacy mode a file the table reader already read never goes to AI, and a scan only
  //    goes with the person's agreement.
  const decision = aiDecision({ privacy, allowAi: ctx.allowAi === true, aiConfigured: aiDocumentReadingAvailable(privacy), readWithoutAi: layout != null });
  if (decision === "ask_consent") return { ok: false, summary: null, source: "none", needsAiConsent: true, message: AI_CONSENT_MESSAGE };
  if (decision === "ai_blocked") return { ok: false, summary: null, source: "none", message: AI_BLOCKED_MESSAGE };
  let aiFailed = false;
  // The AI could read the file but found no transactions in it: not an outage.
  let aiFoundNothing = false;
  // Pages of a long scan that could not be read, so the message can name them.
  let unreadPages: number[] = [];
  // A long statement the table reader got through is not sent whole to AI: no single answer can hold it.
  const plan = planAiRead({ hasTableRead: layout != null, check: layout?.check, pageCount: isPdf ? pageCount : 0 });
  if (decision === "use_ai" && plan === "by_pages" && aiDocumentReadingAvailable(privacy)) {
    const renderer = await openPdfRenderer(file.buffer, ctx.password).catch(() => null);
    if (renderer) {
      try {
        ctx.onProgress?.(8, `Reading ${renderer.pageCount} pages`);
        const outcome = await readBankStatementPages({
          fileName,
          totalPages: renderer.pageCount,
          groups: pageGroups(renderer.pageCount),
          render: async pages => (await renderer.render(pages)).map(data => ({ data, mimeType: "image/png" })),
          concurrency: AI_CALLS_IN_FLIGHT,
          budgetMs: AI_READ_BUDGET_MS,
          companyId: privacy ? null : ctx.companyId,
          userId: privacy ? null : ctx.userId,
          privacy,
          onProgress: (done, total) => {
            const pagesDone = Math.min(done * PAGES_PER_AI_CALL, renderer.pageCount);
            ctx.onProgress?.(Math.min(90, 8 + Math.round((82 * done) / Math.max(1, total))), `Reading page ${pagesDone} of ${renderer.pageCount}`);
          },
          onRepair: groups => ctx.onProgress?.(92, `Checking ${groups} page ${groups === 1 ? "group" : "groups"} again`),
        });
        if (outcome.ok) {
          const summary = outcome.read.summary;
          if (!outcome.read.check.verified) summary.warnings = [...summary.warnings, "AI extracted — pending review."];
          return { ok: true, summary, source: "ai", aiProvider: outcome.read.provider, check: outcome.read.check, message: summary.message };
        }
        if (outcome.error === "no_transactions_read") aiFoundNothing = true;
        else {
          aiFailed = true;
          unreadPages = outcome.failedPages;
        }
      } finally {
        await renderer.close();
      }
    }
  } else if (decision === "use_ai" && plan === "whole_document" && aiDocumentReadingAvailable(privacy)) {
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
      } else if (ai.error === "no_transactions_read") {
        aiFoundNothing = true;
      } else {
        aiFailed = true;
      }
    }
  }
  if (layout) return { ok: true, summary: layout.summary, source: "pdf_layout", check: layout.check, message: layout.summary.message };
  // Privacy mode keeps to the in-memory readers: no temp files, no local OCR, no helper services.
  if (privacy) {
    const pagesMessage = `Page${unreadPages.length === 1 ? "" : "s"} ${pageRanges(unreadPages)} of this ${pageCount}-page scan could not be read, so nothing was created. Try again in a little while, or use the bank's Excel or CSV download.`;
    return { ok: false, summary: null, source: "none", message: aiFailed && unreadPages.length > 0 ? pagesMessage : aiFailed ? AI_DOWN : aiFoundNothing ? NO_ROWS : "No transactions could be read from this file. Try the bank's Excel or CSV download." };
  }

  // 3. Last resort: the older text-table and OCR pipeline.
  let ruleSummary: BankStatementSummary | null = null;
  let source: StatementRead["source"] = "none";
  try {
    const parsed = await parseUploadedFile(file, "bank", { password: ctx.password, onProgress: ctx.onProgress });
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
    message: aiFailed && unreadPages.length > 0
      ? `Page${unreadPages.length === 1 ? "" : "s"} ${pageRanges(unreadPages)} of this ${pageCount}-page scan could not be read, so nothing was created. Try again in a little while, or use the bank's Excel or CSV download.`
      : aiFailed
      ? AI_DOWN
      : aiFoundNothing
      ? NO_ROWS
      : aiDocumentReadingAvailable()
      ? `${base} Try the bank's Excel or CSV download.`
      : `${base} Add a Claude or Gemini API key to read scanned statements, or upload the bank's Excel/CSV download.`,
  };
}

/** Invoice register (CSV/Excel) or invoice documents (PDF/images, read by AI). */
export async function readInvoiceFiles(
  files: UploadedFile[],
  ctx: { companyId?: number | null; userId?: number | null; privacy?: boolean; allowAi?: boolean } = {},
): Promise<{ rows: InvoiceRow[]; aiRead: number; pdfRead: number; failed: string[]; needsAiConsent?: boolean; aiBlocked?: boolean; aiUnavailable?: boolean }> {
  const privacy = ctx.privacy === true;
  let aiBlocked = false;
  let aiUnavailable = false;
  const rows: InvoiceRow[] = [];
  const failed: string[] = [];
  let aiRead = 0;
  let pdfRead = 0;
  for (const file of files) {
    if (!isDocumentFile(file)) {
      let parsed: InvoiceRow[] = [];
      try {
        parsed = parseInvoiceCsv(sheetToCsvText(file));
      } catch {
        // A file that cannot be opened is reported by name below, not as a server error.
      }
      if (parsed.length === 0) failed.push(file.originalname);
      rows.push(...parsed);
      continue;
    }
    // A PDF with a text layer is read by its printed labels first: no AI, nothing leaves the server.
    if (extensionOf(file.originalname) === "pdf" || file.mimetype === "application/pdf") {
      const text = await readPdfText(file.buffer);
      if (text.status === "ok") {
        const byRules = extractInvoicesFromText(text.text);
        if (byRules.length > 0) {
          pdfRead += byRules.length;
          rows.push(...byRules.map(row => ({ ...row, rowNumber: rows.length + 1 })));
          continue;
        }
      }
    }
    const decision = aiDecision({ privacy, allowAi: ctx.allowAi === true, aiConfigured: aiDocumentReadingAvailable(privacy), readWithoutAi: false });
    if (decision === "ask_consent") return { rows: [], aiRead: 0, pdfRead: 0, failed: [], needsAiConsent: true };
    if (decision === "ai_blocked") {
      aiBlocked = true;
      failed.push(file.originalname);
      continue;
    }
    if (!aiDocumentReadingAvailable(privacy)) {
      aiUnavailable = true;
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
  return { rows, aiRead, pdfRead, failed, aiBlocked, aiUnavailable };
}
