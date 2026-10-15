/**
 * Turns the two uploaded files of the GSTR-2B job into documents.
 * The portal file may be JSON, Excel or CSV; the books file is an Excel or CSV purchase register.
 */
import * as XLSX from "xlsx";
import {
  applySuggestions,
  guessHeaderRow,
  parsePortalJson,
  profileColumns,
  readDocsFromTable,
  readPortalWorkbook,
  type ColumnProfile,
  type ColumnSuggestion,
  type GstDoc,
  type PortalRead,
  type Table,
} from "./gstrRecon";

export interface UploadedBuffer {
  originalname: string;
  buffer: Buffer;
}

export type GstFileKind = "portal" | "register" | "unknown";

function isJson(file: UploadedBuffer) {
  return /\.json$/i.test(file.originalname);
}

function isTextTable(file: UploadedBuffer) {
  return /\.(csv|tsv|txt)$/i.test(file.originalname);
}

function decode(buffer: Buffer) {
  return buffer.toString("utf8").replace(/^﻿/, "");
}

export function sheetsOf(file: UploadedBuffer): Array<{ name: string; table: Table }> {
  const workbook = isTextTable(file)
    ? XLSX.read(decode(file.buffer), { type: "string", raw: true })
    : XLSX.read(file.buffer, { type: "buffer", raw: true });
  return workbook.SheetNames.map(name => ({
    name,
    table: XLSX.utils.sheet_to_json<Table[number]>(workbook.Sheets[name], { header: 1, raw: true, defval: null }),
  }));
}

/** Which of the two the file looks like, so a swapped upload can be put right without asking. */
export function kindOfGstFile(file: UploadedBuffer): GstFileKind {
  try {
    if (isJson(file)) {
      const text = decode(file.buffer);
      return /"docdata"|"b2b"|"b2bData"|"cdnr"/.test(text.slice(0, 4000)) ? "portal" : "unknown";
    }
    const sheets = sheetsOf(file);
    const names = sheets.map(sheet => sheet.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (names.includes("b2b") || names.includes("b2bcdnr") || names.includes("itcavailable")) return "portal";
    return "register";
  } catch {
    return "unknown";
  }
}

export function readPortalFile(file: UploadedBuffer): PortalRead {
  if (isJson(file)) return parsePortalJson(decode(file.buffer));
  let sheets: ReturnType<typeof sheetsOf>;
  try {
    sheets = sheetsOf(file);
  } catch {
    throw new Error("This GSTR-2B file could not be opened. Upload the JSON or Excel file downloaded from the GST portal.");
  }
  const names = sheets.map(sheet => sheet.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (names.includes("b2b") || names.includes("b2bcdnr")) return readPortalWorkbook(sheets);
  // A plain CSV or single sheet with the same columns.
  const best = sheets.find(sheet => sheet.table.length > 1) ?? sheets[0];
  if (!best) throw new Error("This GSTR-2B file is empty.");
  const read = readDocsFromTable(best.table, "portal");
  return { docs: read.docs, period: null, recipientGstin: null, notes: read.notes };
}

export interface RegisterRead {
  docs: GstDoc[];
  notes: string[];
  sheet: string;
}

/**
 * Asked only when the headings were not recognised. It sees heading names and what each column's
 * cells look like, never the cells, and answers with suggestions that are checked before use.
 */
export type ColumnAssist = (columns: ColumnProfile[]) => Promise<ColumnSuggestion[]>;

export async function readRegisterFile(file: UploadedBuffer, assist?: ColumnAssist): Promise<RegisterRead> {
  if (isJson(file)) {
    throw new Error("This looks like a GSTR-2B download. Upload your purchase register here, as Excel or CSV.");
  }
  if (/\.xml$/i.test(file.originalname)) {
    throw new Error("Upload the purchase register as Excel or CSV. In TallyPrime: Display More Reports → Account Books → Purchase Register → Export.");
  }
  let sheets: ReturnType<typeof sheetsOf>;
  try {
    sheets = sheetsOf(file);
  } catch {
    throw new Error("This file could not be opened. Upload the purchase register as an Excel or CSV file.");
  }
  // Use the sheet that reads as the most purchase documents; the others are summaries or notes.
  let best: { read: ReturnType<typeof readDocsFromTable>; sheet: string } | null = null;
  let firstError: Error | null = null;
  let widest: (typeof sheets)[number] | null = null;
  for (const sheet of sheets) {
    if (sheet.table.length < 2) continue;
    if (!widest || sheet.table.length > widest.table.length) widest = sheet;
    try {
      const read = readDocsFromTable(sheet.table, "books");
      if (!best || read.docs.length > best.read.docs.length) best = { read, sheet: sheet.name };
    } catch (error) {
      firstError = firstError ?? (error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (best) return { docs: best.read.docs, notes: best.read.notes, sheet: best.sheet };

  // The rules could not place the columns. An assistant may name them, and the data checks it.
  if (assist && widest) {
    const headerRow = guessHeaderRow(widest.table);
    if (headerRow >= 0) {
      const profile = profileColumns(widest.table, headerRow);
      let suggestions: ColumnSuggestion[] = [];
      try {
        suggestions = await assist(profile);
      } catch {
        suggestions = [];
      }
      const { override, used } = applySuggestions(profile, suggestions);
      try {
        const read = readDocsFromTable(widest.table, "books", "", { override, headerRow });
        const summary = used.map(entry => `${entry.field.replace(/_/g, " ")} = “${entry.header}”`).join(", ");
        return {
          docs: read.docs,
          notes: [
            `The column headings were not recognised, so an assistant matched them and each match was checked against the data: ${summary}. Check they are right.`,
            ...read.notes,
          ],
          sheet: widest.name,
        };
      } catch {
        // Fall through to the plain message below.
      }
    }
  }
  throw firstError ?? new Error("No purchase register was found in this file.");
}
