/**
 * Reads the two files of the 26AS ↔ books TDS check.
 *
 * Form 26AS comes from TRACES as a text file with "^" between fields (or as Excel/CSV). The
 * books side is usually a ledger report from Tally with a party name and an amount, and no TAN.
 * Both are read into the same plain entries; nothing is guessed about amounts.
 */
import * as XLSX from "xlsx";
import type { TdsEntry } from "./tdsReconEngine";

export interface TdsUpload {
  originalname: string;
  buffer: Buffer;
}

export interface TdsFileRead {
  entries: TdsEntry[];
  notes: string[];
  source: "traces-text" | "table";
}

const TAN = /^[A-Z]{4}\d{5}[A-Z]$/;
const SECTION = /^(19[2-6][A-Z]{0,3}|206[A-Z]{1,3}|1[0-9]{2}[A-Z]{0,3})$/;

export function normalizeSection(value: string): string {
  return value.toUpperCase().replace(/SECTION|SEC\.?|U\/S/g, "").replace(/[^0-9A-Z]/g, "");
}

function number(value: string): number | null {
  const cleaned = value.replace(/[₹,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function decode(buffer: Buffer): string {
  return buffer.toString("utf8").replace(/^﻿/, "");
}

/** A 26AS text file: PART-I (or PART A) lists each deductor, then one line per booked transaction. */
function readTracesText(text: string): TdsFileRead {
  const entries: TdsEntry[] = [];
  const notes: string[] = [];
  let inTds = false;
  let deductor = "";
  let tan = "";
  let skippedStatus = 0;

  for (const line of text.split(/\r?\n/)) {
    const cells = line.split("^").map(cell => cell.trim());
    const joined = cells.filter(Boolean).join(" ");
    if (!joined) continue;

    // Part headings decide which block the lines belong to.
    const part = /^PART[-\s]*([A-Z0-9]+)\b/i.exec(joined);
    if (part) {
      const id = part[1].toUpperCase();
      // Part I (older) and Part A (newer) are TDS on income other than 15G/15H and property.
      inTds = id === "I" || id === "A";
      continue;
    }
    if (!inTds) continue;

    const tanCell = cells.find(cell => TAN.test(cell.toUpperCase()));
    const sectionCell = cells.find(cell => SECTION.test(normalizeSection(cell)) && /^\s*(?:section\s*)?\d{3}/i.test(cell));

    if (tanCell && !sectionCell) {
      // A deductor row: the name is the longest text cell that is not the TAN or a number.
      tan = tanCell.toUpperCase();
      deductor =
        cells
          .filter(cell => cell && cell.toUpperCase() !== tan && number(cell) === null && !/^\d+$/.test(cell))
          .sort((a, b) => b.length - a.length)[0] ?? deductor;
      continue;
    }

    if (sectionCell && tan) {
      const at = cells.indexOf(sectionCell);
      const after = cells.slice(at + 1);
      // 26AS prints every amount with two decimals; dates and serial numbers have none.
      const amounts = after.filter(cell => /^-?[\d,]+\.\d{2}$/.test(cell)).map(cell => number(cell) as number);
      const status = after.find(cell => /^[A-Z]$/.test(cell));
      // Amount paid, tax deducted, TDS deposited: the last two are the credit.
      if (amounts.length < 2) continue;
      const deducted = amounts[amounts.length - 2];
      if (status && status !== "F") {
        skippedStatus += 1;
        continue;
      }
      entries.push({ deductor, tan, section: normalizeSection(sectionCell), amount: deducted });
    }
  }

  if (skippedStatus > 0) {
    notes.push(`${skippedStatus} 26AS ${skippedStatus === 1 ? "line has" : "lines have"} a booking status other than F (final) and ${skippedStatus === 1 ? "was" : "were"} left out. Credit is only available for final bookings.`);
  }
  return { entries, notes, source: "traces-text" };
}

type Cell = string | number | boolean | Date | null | undefined;

const HEADER_NAMES = {
  deductor: ["name of deductor", "deductor name", "deductor", "party name", "party", "particulars", "name of the deductor", "name"],
  tan: ["tan of deductor", "tan number", "tan no", "tan"],
  section: ["section", "tds section", "sec"],
  amount: ["tax deducted", "tds deducted", "amount of tds", "tds amount", "tax deducted at source", "tds", "tds deposited", "amount"],
  status: ["status of booking", "booking status"],
} as const;

function headerKey(value: Cell) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function findColumn(headers: string[], names: readonly string[]) {
  // The first name in the list wins, so "tax deducted" beats a looser "amount".
  for (const name of names) {
    const exact = headers.findIndex(header => header === name);
    if (exact >= 0) return exact;
  }
  for (const name of names) {
    if (name.length < 4) continue;
    const loose = headers.findIndex(header => header.includes(name));
    if (loose >= 0) return loose;
  }
  return -1;
}

function readTable(rows: Cell[][]): TdsFileRead {
  const notes: string[] = [];
  // The heading is not always the first row: reports carry a title block above it.
  let headerAt = -1;
  let columns = { deductor: -1, tan: -1, section: -1, amount: -1, status: -1 };
  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    const headers = (rows[i] ?? []).map(headerKey);
    const found = {
      deductor: findColumn(headers, HEADER_NAMES.deductor),
      tan: findColumn(headers, HEADER_NAMES.tan),
      section: findColumn(headers, HEADER_NAMES.section),
      amount: findColumn(headers, HEADER_NAMES.amount),
      status: findColumn(headers, HEADER_NAMES.status),
    };
    if (found.amount >= 0 && (found.deductor >= 0 || found.tan >= 0)) {
      headerAt = i;
      columns = found;
      break;
    }
  }
  if (headerAt < 0) return { entries: [], notes: ["No column with the TDS amount was found."], source: "table" };

  const entries: TdsEntry[] = [];
  let skipped = 0;
  let unreadable = 0;
  for (const row of rows.slice(headerAt + 1)) {
    const cells = row ?? [];
    const raw = cells[columns.amount];
    const amount = typeof raw === "number" ? Math.round(raw * 100) / 100 : number(String(raw ?? ""));
    const name = String(cells[columns.deductor] ?? "").trim();
    const tan = String(cells[columns.tan] ?? "").trim().toUpperCase();
    if (!name && !tan) continue;
    if (/^(grand\s+)?total\b/i.test(name)) continue;
    if (amount === null) {
      if (String(raw ?? "").trim() !== "") unreadable += 1;
      continue;
    }
    const status = columns.status >= 0 ? String(cells[columns.status] ?? "").trim().toUpperCase() : "";
    if (status && status !== "F") {
      skipped += 1;
      continue;
    }
    entries.push({
      deductor: name,
      tan: TAN.test(tan) ? tan : "",
      section: columns.section >= 0 ? normalizeSection(String(cells[columns.section] ?? "")) : "",
      amount,
    });
  }
  if (skipped > 0) notes.push(`${skipped} ${skipped === 1 ? "line has" : "lines have"} a booking status other than F (final) and ${skipped === 1 ? "was" : "were"} left out.`);
  if (unreadable > 0) notes.push(`${unreadable} ${unreadable === 1 ? "amount" : "amounts"} could not be read and ${unreadable === 1 ? "was" : "were"} left out. Check the file.`);
  return { entries, notes, source: "table" };
}

function splitLine(line: string, delimiter: string): string[] {
  if (delimiter !== ",") return line.split(delimiter).map(cell => cell.trim());
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      out.push(current.trim());
      current = "";
    } else current += char;
  }
  out.push(current.trim());
  return out;
}

export function readTdsFile(file: TdsUpload): TdsFileRead {
  const lower = file.originalname.toLowerCase();
  if (/\.(xlsx|xls|xlsm)$/.test(lower)) {
    const book = XLSX.read(file.buffer, { type: "buffer", raw: true });
    let best: TdsFileRead = { entries: [], notes: [], source: "table" };
    for (const name of book.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<Cell[]>(book.Sheets[name], { header: 1, raw: true, defval: null });
      const read = readTable(rows);
      if (read.entries.length > best.entries.length) best = read;
    }
    return best;
  }
  if (/\.pdf$/.test(lower)) {
    throw new Error("A PDF of Form 26AS cannot be read reliably. In TRACES, download the text (.txt) or Excel version and upload that.");
  }
  const text = decode(file.buffer);
  const sample = text.split(/\r?\n/).slice(0, 40).join("\n");
  if ((sample.match(/\^/g) ?? []).length > 10 && /PART[-\s]*(I|A)\b/i.test(text)) return readTracesText(text);
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const delimiter = [",", "\t", ";", "|", "^"]
    .map(char => ({ char, count: (lines[0] ?? "").split(char).length }))
    .sort((a, b) => b.count - a.count)[0].char;
  return readTable(lines.map(line => splitLine(line, delimiter)));
}
