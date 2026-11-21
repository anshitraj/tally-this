/**
 * Turns uploaded report files into plain tables of cell text, keeping where every row came from.
 *
 * CSV, XLSX, XLS and ZIPs of them are read; each populated sheet of a workbook becomes its own table. Cell values are
 * kept as the text a spreadsheet holds (numbers in their full stored precision, dates as yyyy-mm-dd) so the adapter can
 * read amounts exactly. Long numeric identifiers in a CSV are never turned into numbers.
 */
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { isZip, readZip, ZipError } from "./zip";

export const TABLE_LIMITS = { maxRowsPerSheet: 250_000, maxCells: 6_000_000 };

export interface SourceTable {
  /** The file the table came from (the member name when it came out of a ZIP). */
  fileName: string;
  containerName: string | null;
  sheetName: string | null;
  sha256: string;
  sizeBytes: number;
  /** All rows, as text. `rowNumbers[i]` is the spreadsheet row number of `rows[i]`. */
  rows: string[][];
  rowNumbers: number[];
}

export interface ReadProblem { fileName: string; message: string }

export interface UploadedReport { name: string; buffer: Buffer }

const SUPPORTED = new Set(["csv", "xlsx", "xls", "xlsm", "txt", "zip"]);

function extension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    // SheetJS gives dates at UTC midnight for date-only cells; keep the calendar day.
    const shifted = new Date(value.getTime() + 12 * 3600 * 1000);
    return shifted.toISOString().slice(0, 10);
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value).replace(/ /g, " ").trim();
}

function isEncryptedOffice(buffer: Buffer) {
  // An encrypted .xlsx is stored inside an OLE container that names its EncryptionInfo stream.
  return buffer.length > 8 && buffer.readUInt32LE(0) === 0xe011cfd0 && buffer.includes(Buffer.from("E\0n\0c\0r\0y\0p\0t\0i\0o\0n\0I\0n\0f\0o", "latin1"));
}

function readWorkbook(name: string, buffer: Buffer, container: string | null): SourceTable[] {
  const ext = extension(name);
  if (isEncryptedOffice(buffer)) throw new Error("This file is password-protected. Open it in Excel, remove the password, save it and upload it again.");
  let workbook: XLSX.WorkBook;
  try {
    workbook = ext === "csv" || ext === "txt"
      ? XLSX.read(buffer.toString("utf8").replace(/^﻿/, ""), { type: "string", raw: true, cellFormula: false, cellHTML: false, sheetRows: TABLE_LIMITS.maxRowsPerSheet + 1 })
      : XLSX.read(buffer, { type: "buffer", cellDates: true, cellFormula: false, cellHTML: false, cellStyles: false, sheetRows: TABLE_LIMITS.maxRowsPerSheet + 1 });
  } catch (error) {
    const text = error instanceof Error ? error.message : "";
    if (/password|encrypt/i.test(text)) throw new Error("This file is password-protected. Open it in Excel, remove the password, save it and upload it again.");
    throw new Error("This file could not be opened as a spreadsheet. It may be damaged or in another format.");
  }
  const hash = sha256(buffer);
  const tables: SourceTable[] = [];
  let cells = 0;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet["!ref"]) continue;
    if (sheet["!fullref"] && sheet["!fullref"] !== sheet["!ref"]) {
      throw new Error(`The sheet "${sheetName}" has more than ${TABLE_LIMITS.maxRowsPerSheet.toLocaleString("en-IN")} rows. Split it into smaller files.`);
    }
    const start = XLSX.utils.decode_range(sheet["!ref"]).s.r;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "", blankrows: true });
    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    raw.forEach((row, index) => {
      const text = (row as unknown[]).map(cellText);
      if (!text.some(cell => cell !== "")) return;
      cells += text.length;
      rows.push(text);
      rowNumbers.push(start + index + 1);
    });
    if (cells > TABLE_LIMITS.maxCells) throw new Error("This file is too large to read in one go. Split it by month and upload the parts.");
    if (rows.length === 0) continue;
    tables.push({
      fileName: name,
      containerName: container,
      sheetName: ext === "csv" || ext === "txt" ? null : sheetName,
      sha256: hash,
      sizeBytes: buffer.length,
      rows,
      rowNumbers,
    });
  }
  return tables;
}

/** Reads every uploaded file. A file that cannot be read is reported, never silently dropped. */
export function readReports(files: UploadedReport[]): { tables: SourceTable[]; problems: ReadProblem[] } {
  const tables: SourceTable[] = [];
  const problems: ReadProblem[] = [];
  for (const file of files) {
    const ext = extension(file.name);
    try {
      if (ext === "zip" || isZip(file.buffer) && ext !== "xlsx" && ext !== "xlsm") {
        const { entries, skipped } = readZip(file.buffer);
        for (const note of skipped) problems.push({ fileName: file.name, message: note });
        let found = 0;
        for (const entry of entries) {
          const inner = extension(entry.name);
          if (!SUPPORTED.has(inner) || inner === "zip") {
            problems.push({ fileName: `${file.name} › ${entry.name}`, message: "Not a spreadsheet or CSV; not read." });
            continue;
          }
          try {
            const read = readWorkbook(entry.name, entry.data, file.name);
            tables.push(...read);
            found += read.length;
          } catch (error) {
            problems.push({ fileName: `${file.name} › ${entry.name}`, message: error instanceof Error ? error.message : "Could not be read." });
          }
        }
        if (found === 0 && entries.length === 0) problems.push({ fileName: file.name, message: "This ZIP has no spreadsheet or CSV files in it." });
        continue;
      }
      if (ext === "pdf") {
        problems.push({ fileName: file.name, message: "PDFs are not read as transaction data. Upload the original Excel or CSV report; a PDF printed from a spreadsheet loses rows and columns." });
        continue;
      }
      if (!SUPPORTED.has(ext)) {
        problems.push({ fileName: file.name, message: "Only Excel (.xlsx, .xls), CSV and ZIP files are read." });
        continue;
      }
      const read = readWorkbook(file.name, file.buffer, null);
      if (read.length === 0) problems.push({ fileName: file.name, message: "This file is empty." });
      tables.push(...read);
    } catch (error) {
      problems.push({ fileName: file.name, message: error instanceof ZipError || error instanceof Error ? error.message : "Could not be read." });
    }
  }
  return { tables, problems };
}
