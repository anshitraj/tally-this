import fs from "node:fs";
import { createRequire } from "node:module";
import type { Download } from "@playwright/test";

/** Reading what a job gives back: saved downloads, Tally XML and Excel workbooks. */

const requireFromApi = createRequire(new URL("../../backend/api/package.json", import.meta.url));

export async function savedDownload(download: Download): Promise<{ name: string; path: string; bytes: Buffer }> {
  const target = await download.path();
  if (!target) throw new Error("the download did not finish");
  return { name: download.suggestedFilename(), path: target, bytes: fs.readFileSync(target) };
}

const decode = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export interface VoucherEntry {
  ledger: string;
  /** Tally's signed amount in paise: a debit is negative. */
  paise: number;
}

export interface Voucher {
  type: string;
  date: string; // yyyymmdd
  number: string;
  narration: string;
  reference: string;
  entries: VoucherEntry[];
}

const field = (block: string, tag: string) => {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decode(match[1].trim()) : "";
};

const toPaise = (text: string) => Math.round(Number(text) * 100);

/** The vouchers in a Tally import file. Throws if the file is not the envelope Tally expects. */
export function parseVouchers(xml: string): Voucher[] {
  if (!/^<\?xml[^>]*\?>\s*<ENVELOPE>/.test(xml.trimStart())) throw new Error("not a Tally import envelope");
  const vouchers: Voucher[] = [];
  for (const match of xml.matchAll(/<VOUCHER\b[^>]*>([\s\S]*?)<\/VOUCHER>/g)) {
    const block = match[1];
    const entries: VoucherEntry[] = [];
    for (const entry of block.matchAll(/<(?:ALL)?LEDGERENTRIES\.LIST>([\s\S]*?)<\/(?:ALL)?LEDGERENTRIES\.LIST>/g)) {
      entries.push({ ledger: field(entry[1], "LEDGERNAME"), paise: toPaise(field(entry[1], "AMOUNT")) });
    }
    vouchers.push({
      type: field(block, "VOUCHERTYPENAME"),
      date: field(block, "DATE"),
      number: field(block, "VOUCHERNUMBER"),
      narration: field(block, "NARRATION"),
      reference: field(block, "REFERENCE"),
      entries,
    });
  }
  return vouchers;
}

/** The master ledgers an import file creates. */
export function parseLedgers(xml: string): Array<{ name: string; parent: string }> {
  return [...xml.matchAll(/<LEDGER\b[^>]*>([\s\S]*?)<\/LEDGER>/g)].map(match => ({ name: field(match[1], "NAME"), parent: field(match[1], "PARENT") }));
}

/** Every voucher balances to the paise, which Tally requires. */
export function unbalancedVouchers(vouchers: Voucher[]): Voucher[] {
  return vouchers.filter(voucher => voucher.entries.reduce((sum, entry) => sum + entry.paise, 0) !== 0);
}

export interface Sheet {
  name: string;
  rows: unknown[][];
}

export async function readWorkbook(bytes: Buffer): Promise<Sheet[]> {
  const ExcelJS = requireFromApi("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook.worksheets.map((sheet: { name: string; eachRow: (options: { includeEmpty: boolean }, callback: (row: { values: unknown[] }) => void) => void }) => {
    const rows: unknown[][] = [];
    sheet.eachRow({ includeEmpty: false }, row => rows.push((row.values as unknown[]).slice(1)));
    return { name: sheet.name, rows };
  });
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
