import * as XLSX from "xlsx";
import { PDFParse } from "pdf-parse";
import { extractHybrid, type ExtractionMethod } from "./pdfTableExtractor";
import { scanCsvTable } from "./bankStatement";
import { recognizeStatement } from "./statementOcr";

export interface ParsedFileResult {
  parser: "csv" | "excel" | "pdf" | "image" | "unsupported";
  rowCount: number;
  detectedColumns: string[];
  parsedRows?: Record<string, unknown>[];
  sheetNames?: string[];
  pageCount?: number;
  textPreview?: string;
  textLength?: number;
  tablesDetected?: number;
  status: "parsed" | "metadata_only";
  notes: string[];
  extractionMethod?: ExtractionMethod;
  extractionConfidence?: number;
  extractedText?: string;
  ocrStatus?: "unavailable" | "pending_review";
}

// ─── PDF table extraction ────────────────────────────────────────────────────
// PDFs are page-description documents. pdf-parse gives us raw text with
// inconsistent spacing. We try three strategies in order:
//   1. Multi-space column split (works when columns align with 2+ spaces)
//   2. Date-anchored line parse (each row starts with a date)
//   3. Give up — return empty (text still stored for AI extraction)

const HEADER_KEYWORDS = /\b(date|narration|description|particulars|amount|debit|credit|balance|ledger|account|invoice|voucher|employee|salary|settlement|vendor|name|total|net|gross)\b/gi;
const SKIP_LINES = /^(total|subtotal|page|opening|closing|brought forward|carried forward|statement of|account no|period|balance as on)/i;

function countKeywords(line: string) {
  return (line.match(HEADER_KEYWORDS) ?? []).length;
}

function splitColumns(line: string): string[] {
  // Split on 2+ spaces or tab, then also strip any currency prefixes from cells
  return line.split(/\s{2,}|\t/).map(c => c.trim().replace(/^(?:INR|Rs\.?|\u20b9)\s*/i, "")).filter(Boolean);
}

function findHeaderLine(lines: string[]): { idx: number; columns: string[] } | null {
  // Scan first 40 lines for a header (≥3 financial keywords, ≥2 split columns)
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const line = lines[i];
    if (countKeywords(line) < 3) continue;
    const cols = splitColumns(line);
    if (cols.length >= 2) return { idx: i, columns: cols };
  }
  return null;
}

function extractByColumnSplit(lines: string[], headerIdx: number, columns: string[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || SKIP_LINES.test(line)) continue;
    const cells = splitColumns(line);
    if (cells.length < 2) continue;
    const row: Record<string, unknown> = {};
    columns.forEach((col, idx) => { row[col] = cells[idx] ?? ""; });
    rows.push(row);
  }
  return rows;
}

// Date-anchored: each data row starts with a date like 01/05/2026 or 2026-05-01
const DATE_PREFIX = /^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{2}[\/\-]\d{2})/;

function extractByDateAnchor(lines: string[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  // Find lines that start with a date pattern — treat them as data rows
  for (const line of lines) {
    if (!DATE_PREFIX.test(line)) continue;
    if (SKIP_LINES.test(line)) continue;
    // Strip currency prefixes before splitting columns
    const cleaned = line.replace(/(?:INR|Rs\.?|\u20b9)\s*/gi, "");
    const cells = splitColumns(cleaned);
    if (cells.length < 2) continue;
    // Heuristic column names: Date, Narration, Debit, Credit, Balance (last N numeric cells)
    const row: Record<string, unknown> = {
      Date: cells[0] ?? "",
      Narration: cells.slice(1, cells.length > 4 ? cells.length - 2 : cells.length).join(" "),
    };
    // If last 1-3 cells look numeric, call them Debit/Credit/Balance
    const numeric = cells.slice(-3).filter(c => /^[\d,\u20b9\.\-\(\)]+$/.test(c));
    if (numeric.length === 3) {
      row["Debit"] = numeric[0]; row["Credit"] = numeric[1]; row["Balance"] = numeric[2];
    } else if (numeric.length === 2) {
      row["Amount"] = numeric[0]; row["Balance"] = numeric[1];
    } else if (numeric.length === 1) {
      row["Amount"] = numeric[0];
    }
    rows.push(row);
  }
  return rows;
}

function extractTableRowsFromPdf(text: string): { columns: string[]; rows: Record<string, unknown>[] } | null {
  // PDF text from pdf-parse may be a single continuous line.
  // Split into logical lines by inserting breaks before date patterns.
  let lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length <= 3) {
    // Likely a single continuous line — split before each date pattern
    const splitText = text.replace(
      /\s+(?=\d{4}[\/\-]\d{2}[\/\-]\d{2}\b|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b)/g,
      "\n"
    );
    lines = splitText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  }

  // Strategy 1: header + column split
  const header = findHeaderLine(lines);
  if (header) {
    const rows = extractByColumnSplit(lines, header.idx, header.columns);
    if (rows.length > 0) return { columns: header.columns, rows };
  }

  // Strategy 2: date-anchored rows
  const rows = extractByDateAnchor(lines);
  if (rows.length > 0) {
    const columns = rows[0] ? Object.keys(rows[0]) : [];
    return { columns, rows };
  }

  return null;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.map(cell => cell.replace(/^"|"$/g, ""));
}

// ─── Python worker delegation ────────────────────────────────────────────────
// When the Python extraction worker is running, route CSV and Excel parsing to
// it (pandas handles malformed files + Indian bank column aliases better than
// the JS implementation). Falls back to the TS parser silently on any error.

const PYTHON_WORKER_URL = process.env.PYTHON_WORKER_URL ?? "http://localhost:8091";

async function tryPythonWorker(
  file: Express.Multer.File,
  sourceType: string,
  endpoint: "csv" | "excel",
): Promise<ParsedFileResult | null> {
  try {
    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || "application/octet-stream" }), file.originalname);
    formData.append("source_type", sourceType);

    const url = `${PYTHON_WORKER_URL}/parse/${endpoint}`;
    const res = await fetch(url, { method: "POST", body: formData, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;

    const data = await res.json() as {
      ok: boolean;
      rows: Record<string, unknown>[];
      metadata?: { detected_columns?: string[]; raw_row_count?: number };
      warnings?: string[];
      errors?: string[];
    };
    if (!data.ok && data.rows.length === 0) return null;

    const detectedColumns = (data.metadata?.detected_columns ?? []).slice(0, 30);
    const notes: string[] = [];
    if (data.warnings?.length) notes.push(...data.warnings);
    if (!data.ok) notes.push(...(data.errors ?? []));

    return {
      parser: endpoint === "csv" ? "csv" : "excel",
      rowCount: data.rows.length,
      detectedColumns,
      parsedRows: data.rows,
      status: data.rows.length > 0 ? "parsed" : "metadata_only",
      textPreview: data.rows.slice(0, 3).map(r => JSON.stringify(r)).join("\n").slice(0, 1000),
      notes: notes.length > 0 ? notes : [`${endpoint.toUpperCase()} parsed via Python worker (pandas). ${data.rows.length} rows.`],
    };
  } catch {
    return null; // Silently fall back to TS parser
  }
}
// ─────────────────────────────────────────────────────────────────────────────

async function tryPythonPdfTable(file: Express.Multer.File, sourceType: string): Promise<ParsedFileResult | null> {
  try {
    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || "application/pdf" }), file.originalname);
    formData.append("source_type", sourceType);

    const res = await fetch(`${PYTHON_WORKER_URL}/parse/pdf-table`, { method: "POST", body: formData, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;

    const data = await res.json() as {
      rows?: Record<string, unknown>[];
      headers?: string[];
      page_count?: number;
      warnings?: string[];
      errors?: string[];
      metadata?: { detected_columns?: string[] };
    };
    const rows = data.rows ?? [];
    if (rows.length === 0) return null;

    const detectedColumns = (data.headers ?? data.metadata?.detected_columns ?? Object.keys(rows[0] ?? {})).slice(0, 30);
    return {
      parser: "pdf",
      rowCount: rows.length,
      detectedColumns,
      parsedRows: rows,
      pageCount: data.page_count,
      tablesDetected: 1,
      status: "parsed",
      textPreview: rows.slice(0, 3).map(row => JSON.stringify(row)).join("\n").slice(0, 1000),
      extractionMethod: "generic_rules",
      extractionConfidence: 0.8,
      notes: [
        `PDF table parsed via Python worker (pdfplumber). ${rows.length} rows.`,
        ...(data.warnings ?? []),
        ...(data.errors ?? []),
      ],
    };
  } catch {
    return null;
  }
}

export async function parseUploadedFile(
  file: Express.Multer.File,
  sourceType: string = "unknown",
  options: { password?: string } = {},
): Promise<ParsedFileResult> {
  const extension = file.originalname.split(".").pop()?.toLowerCase();

  if (extension === "csv" || file.mimetype === "text/csv") {
    // Try Python worker first (better Indian bank normalization)
    const pythonResult = await tryPythonWorker(file, sourceType, "csv");
    if (pythonResult) return pythonResult;

    // TS fallback — skip bank preamble lines until a financial header is found.
    const text = file.buffer.toString("utf8");
    const scanned = scanCsvTable(text);
    if (scanned) {
      const rows = scanned.rows.map(({ _rowNumber, ...rest }) => rest);
      return {
        parser: "csv",
        rowCount: rows.length,
        detectedColumns: scanned.columns.slice(0, 30),
        parsedRows: rows,
        status: rows.length > 0 ? "parsed" : "metadata_only",
        textPreview: text.split(/\r?\n/).slice(0, 6).join("\n").slice(0, 1000),
        notes: rows.length > 0
          ? [`CSV parsed server-side (Python worker unavailable). Header row ${scanned.headerIndex + 1}. ${rows.length} data rows.`]
          : ["CSV header was found, but no data rows were detected."],
      };
    }
    const lines = text.split(/\r?\n/).filter((line: string) => line.trim().length > 0);
    const detectedColumns = lines.length > 0 ? parseCsvLine(lines[0]).filter(Boolean).slice(0, 30) : [];
    const rows = lines.slice(1).map((line: string) => {
      const cells = parseCsvLine(line);
      return Object.fromEntries(detectedColumns.map((column, index) => [column, cells[index] ?? ""]));
    });
    return {
      parser: "csv",
      rowCount: Math.max(lines.length - 1, 0),
      detectedColumns,
      parsedRows: rows,
      status: rows.length > 0 ? "parsed" : "metadata_only",
      textPreview: lines.slice(0, 4).join("\n").slice(0, 1000),
      notes: ["CSV parsed server-side (Python worker unavailable). No financial header detected; first row used as columns."],
    };
  }

  if (extension === "xlsx" || extension === "xls") {
    // Try Python worker first (pandas with 20-row header scan)
    const pythonResult = await tryPythonWorker(file, sourceType, "excel");
    if (pythonResult) return pythonResult;

    // TS fallback (xlsx.js)
    const workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: true });
    // Scan all sheets, pick the one whose detected header row maximizes financial-keyword score.
    let best: { rows: Record<string, unknown>[]; columns: string[]; sheet: string; score: number } | null = null;
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      // Raw 2D array — find best header row
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false });
      let bestHeaderIdx = 0;
      let bestHeaderScore = -1;
      const scanLimit = Math.min(matrix.length, 20);
      for (let i = 0; i < scanLimit; i++) {
        const cells = (matrix[i] ?? []).map(c => String(c ?? "").trim());
        const nonEmpty = cells.filter(Boolean);
        if (nonEmpty.length < 2) continue;
        const joined = nonEmpty.join(" ").toLowerCase();
        const score = (joined.match(/date|narration|description|particulars|debit|credit|amount|balance|ledger|account|invoice|voucher|gst|gstin|reference|utr|cheque|deposit|withdrawal|payment|receipt|vendor|customer|party|employee|salary/g) ?? []).length + nonEmpty.length * 0.1;
        if (score > bestHeaderScore) {
          bestHeaderScore = score;
          bestHeaderIdx = i;
        }
      }
      if (bestHeaderScore < 1) continue;
      const headerRow = (matrix[bestHeaderIdx] ?? []).map((c, i) => {
        const trimmed = String(c ?? "").trim();
        return trimmed || `column_${i + 1}`;
      });
      const dataRows = matrix.slice(bestHeaderIdx + 1)
        .map(r => {
          const obj: Record<string, unknown> = {};
          headerRow.forEach((h, i) => { obj[h] = (r as unknown[])[i] ?? ""; });
          return obj;
        })
        .filter(r => Object.values(r).some(v => String(v ?? "").trim()));
      if (!best || bestHeaderScore > best.score) {
        best = { rows: dataRows, columns: headerRow, sheet: sheetName, score: bestHeaderScore };
      }
    }
    const finalRows = best?.rows ?? [];
    const finalColumns = best?.columns ?? [];
    return {
      parser: "excel",
      rowCount: finalRows.length,
      detectedColumns: finalColumns.slice(0, 30),
      parsedRows: finalRows,
      sheetNames: workbook.SheetNames,
      status: "parsed",
      textPreview: finalRows.slice(0, 3).map(row => JSON.stringify(row)).join("\n").slice(0, 1000),
      notes: best
        ? [`Excel parsed from sheet "${best.sheet}" with header row auto-detected (financial-keyword score ${best.score.toFixed(1)}).`]
        : ["Excel parsed but no header row with financial keywords detected. Verify the file structure."],
    };
  }

  if (extension === "pdf" || file.mimetype === "application/pdf") {
    const pythonPdfResult = options.password ? null : await tryPythonPdfTable(file, sourceType);
    if (pythonPdfResult) return pythonPdfResult;

    const parser = new PDFParse({ data: file.buffer, password: options.password || undefined });
    const parsed = await parser.getText();
    await parser.destroy();
    let pdfText = parsed.text ?? "";
    let ocrStatus: ParsedFileResult["ocrStatus"];
    if (pdfText.trim().length < 40) {
      const ocr = await recognizeStatement({ buffer: file.buffer, fileName: file.originalname, kind: "pdf" });
      if (!ocr.available) {
        return {
          parser: "pdf",
          rowCount: 0,
          detectedColumns: [],
          status: "metadata_only",
          pageCount: parsed.total,
          textLength: pdfText.trim().length,
          textPreview: pdfText.replace(/\s+/g, " ").trim().slice(0, 1000),
          ocrStatus: "unavailable",
          notes: [ocr.note],
        };
      }
      pdfText = ocr.text;
      ocrStatus = "pending_review";
    }
    const lines = pdfText.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean);

    // Hybrid pipeline: bank/gateway/GST-specific patterns → generic rules → AI fallback.
    const hybrid = await extractHybrid(pdfText, sourceType, extractTableRowsFromPdf);
    const parsedRows = hybrid.rows;
    const detectedColumns = hybrid.columns.length > 0 ? hybrid.columns : lines
      .find((line: string) => /invoice|date|amount|gst|vendor|narration/i.test(line))
      ?.split(/\s{2,}|\t/)
      .map((c: string) => c.trim())
      .filter(Boolean)
      .slice(0, 12) ?? [];

    return {
      parser: "pdf",
      rowCount: ocrStatus === "pending_review" ? parsedRows.length : (parsedRows.length > 0 ? parsedRows.length : lines.length),
      detectedColumns,
      parsedRows: parsedRows.length > 0 ? parsedRows : undefined,
      pageCount: parsed.total,
      textLength: pdfText.length,
      tablesDetected: parsedRows.length > 0 ? 1 : 0,
      status: ocrStatus === "pending_review" ? "metadata_only" : "parsed",
      textPreview: pdfText.replace(/\s+/g, " ").trim().slice(0, 1000),
      extractedText: ocrStatus === "pending_review" ? pdfText : undefined,
      ocrStatus,
      extractionMethod: hybrid.method,
      extractionConfidence: hybrid.confidence,
      notes: ocrStatus === "pending_review"
        ? [`OCR extracted — pending review. These rows are not verified books.`, ...hybrid.notes]
        : parsedRows.length > 0
        ? [`PDF extraction (${hybrid.method}, ${Math.round(hybrid.confidence * 100)}% confidence): ${parsedRows.length} rows. AI/auto rows are pending CA review before final use.`, ...hybrid.notes]
        : ["PDF text extracted but no structured rows could be derived. Upload CSV/Excel or wait for AI fallback (requires GEMINI_API_KEY).", ...hybrid.notes],
    };
  }

  const imageExtensions = new Set(["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"]);
  if (imageExtensions.has(extension ?? "") || (file.mimetype ?? "").startsWith("image/")) {
    const ocr = await recognizeStatement({ buffer: file.buffer, fileName: file.originalname, kind: "image" });
    if (!ocr.available) {
      return {
        parser: "image",
        rowCount: 0,
        detectedColumns: [],
        status: "metadata_only",
        textLength: 0,
        ocrStatus: "unavailable",
        notes: [ocr.note],
      };
    }
    const hybrid = await extractHybrid(ocr.text, sourceType, extractTableRowsFromPdf);
    return {
      parser: "image",
      rowCount: hybrid.rows.length,
      detectedColumns: hybrid.columns.slice(0, 30),
      parsedRows: hybrid.rows.length > 0 ? hybrid.rows : undefined,
      status: "metadata_only",
      textLength: ocr.text.length,
      textPreview: ocr.text.replace(/\s+/g, " ").trim().slice(0, 1000),
      extractedText: ocr.text,
      ocrStatus: "pending_review",
      extractionMethod: hybrid.method,
      extractionConfidence: hybrid.confidence,
      notes: ["OCR extracted — pending review. These rows are not verified books.", ...hybrid.notes],
    };
  }

  return {
    parser: "unsupported",
    rowCount: 0,
    detectedColumns: [],
    status: "metadata_only",
    notes: ["Unsupported parser for this file type. Stored metadata only."],
  };
}
