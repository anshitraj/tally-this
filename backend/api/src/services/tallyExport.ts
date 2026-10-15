/**
 * Reads whatever a CA can export from Tally: Excel, CSV, XML, HTML or a printed PDF.
 * Every format ends as the same TallyRow list the comparison already understands.
 * Nothing here uses AI. A PDF is read by column position and, when Tally printed totals,
 * the rows are added up and compared with them; a difference is reported, never hidden.
 */
import { normalizeAmount, normalizeDate } from "./bankStatement";
import { UnreadableFileError, extensionOf, sheetToCsvText, type UploadedFile } from "./fileDetect";
import { readTallyPdf } from "./tallyPdf";
import { TALLY_FORMATS } from "./tallyColumns";
import { parseTallyLedgerCsv, type TallyRow } from "./statementCompare";

export type TallySource = "sheet" | "pdf" | "xml" | "html";

export interface TallyRead {
  ok: boolean;
  rows: TallyRow[];
  source: TallySource | "none";
  /** Shown to the person when ok is false. */
  message: string;
  /** Plain remarks about how the file was read (a ledger chosen, totals that did not add up). */
  notes: string[];
}

export { TALLY_FORMATS };
const NO_ENTRIES = `No entries were found in this Tally file. Export the bank ledger or Day Book from Tally as ${TALLY_FORMATS} and try again.`;

function ok(rows: TallyRow[], source: TallySource, notes: string[] = []): TallyRead {
  return { ok: true, rows, source, message: "", notes };
}

function fail(message: string, extra: Partial<TallyRead> = {}): TallyRead {
  return { ok: false, rows: [], source: "none", message, notes: [], ...extra };
}

// ── XML ─────────────────────────────────────────────────────────────────────

function decodeXml(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => (Number(code) < 32 ? "" : String.fromCharCode(Number(code))))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

const BANK_LIKE = /\bbank\b|\bbanking\b|\b(?:current|savings|od|cc)\s+a\/?c\b|\boverdraft\b|\b(?:hdfc|icici|sbi|axis|kotak|indusind|idfc|pnb|canara|rbl|idbi|bandhan|federal|hsbc)\b/i;
// Expense and loan ledgers that carry the word "bank" are not the bank account itself.
const NOT_THE_ACCOUNT = /charge|interest|loan|guarantee|commission|\bfees?\b|reconcil|\bgst\b|\btds\b|\bemi\b|credit\s*card|payable|receivable/i;

function isBankLedger(name: string) {
  return BANK_LIKE.test(name) && !NOT_THE_ACCOUNT.test(name);
}

function readTallyXml(text: string, bankHint: string | null | undefined): TallyRead {
  const vouchers = [...text.matchAll(/<VOUCHER\b[^>]*>([\s\S]*?)<\/VOUCHER>/gi)].map(match => match[1]);
  if (vouchers.length === 0) return fail("This XML file has no vouchers in it. In Tally use Export → Format: XML (Data Interchange) on the Day Book or bank ledger.");
  interface Entry { ledger: string; amount: number }
  const parsed = vouchers.map(block => {
    const entries: Entry[] = [...block.matchAll(/<(?:ALL)?LEDGERENTRIES\.LIST>([\s\S]*?)<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi)].flatMap(match => {
      const ledger = tag(match[1], "LEDGERNAME");
      const amount = normalizeAmount(tag(match[1], "AMOUNT"));
      return ledger && amount != null && amount !== 0 ? [{ ledger, amount }] : [];
    });
    return {
      date: normalizeDate(tag(block, "DATE").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")),
      type: tag(block, "VOUCHERTYPENAME"),
      number: tag(block, "VOUCHERNUMBER"),
      narration: tag(block, "NARRATION"),
      party: tag(block, "PARTYLEDGERNAME"),
      cancelled: /^yes$/i.test(tag(block, "ISCANCELLED")) || /^yes$/i.test(tag(block, "ISOPTIONAL")),
      entries,
    };
  });
  const live = parsed.filter(voucher => !voucher.cancelled && voucher.date);
  const cancelled = parsed.length - live.length;

  // The bank ledger: the one named like a bank. A bank name from the statement breaks ties.
  const counts = new Map<string, number>();
  for (const voucher of live) {
    for (const entry of voucher.entries) if (isBankLedger(entry.ledger)) counts.set(entry.ledger, (counts.get(entry.ledger) ?? 0) + 1);
  }
  // No ledger is named like a bank. An export of one ledger has that ledger in nearly every voucher.
  let guessed = false;
  if (counts.size === 0) {
    for (const voucher of live) {
      for (const ledger of new Set(voucher.entries.map(entry => entry.ledger))) counts.set(ledger, (counts.get(ledger) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top || top[1] < live.length * 0.6) {
      return fail("Tally ledger names in this XML do not say which one is the bank. Export the bank ledger itself as Excel or XML, so only its entries are in the file.");
    }
    guessed = true;
  }
  const hint = (bankHint ?? "").toLowerCase().replace(/\s*(bank|ltd\.?|limited)\s*/g, " ").trim();
  const ranked = [...counts.entries()].sort((a, b) => {
    const aHint = hint && a[0].toLowerCase().includes(hint) ? 1 : 0;
    const bHint = hint && b[0].toLowerCase().includes(hint) ? 1 : 0;
    return bHint - aHint || b[1] - a[1];
  });
  const bankLedger = ranked[0][0];

  const rows: TallyRow[] = [];
  for (const voucher of live) {
    const others = voucher.entries.filter(entry => entry.ledger !== bankLedger);
    for (const entry of voucher.entries.filter(item => item.ledger === bankLedger)) {
      // In Tally data a debit is negative and a credit positive.
      const isDebit = entry.amount < 0;
      rows.push({
        id: `tally-${rows.length + 1}`,
        date: voucher.date as string,
        ledgerName: voucher.party || others[0]?.ledger || voucher.type || bankLedger,
        voucherNumber: voucher.number || null,
        debit: isDebit ? Math.abs(entry.amount) : null,
        credit: isDebit ? null : Math.abs(entry.amount),
        narration: voucher.narration,
        rowNumber: rows.length + 1,
      });
    }
  }
  if (rows.length === 0) return fail(NO_ENTRIES);
  const notes = guessed
    ? [`Potential risk — needs CA review. No ledger in this XML is named like a bank, so "${bankLedger}" was used because it is in most vouchers. If that is not your bank ledger, export only the bank ledger from Tally.`]
    : [`Compared against the Tally ledger "${bankLedger}".`];
  if (!guessed && ranked.length > 1) notes.push(`This file also has ${ranked.slice(1).map(([name]) => `"${name}"`).join(", ")}. Entries on those were not compared. If your statement belongs to one of them, export only that ledger.`);
  if (cancelled > 0) notes.push(`${cancelled} cancelled or optional ${cancelled === 1 ? "voucher was" : "vouchers were"} left out.`);
  return ok(rows, "xml", notes);
}

// ── HTML ────────────────────────────────────────────────────────────────────

function htmlToCsv(html: string): string {
  const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines: string[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell =>
      decodeXml(cell[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ")),
    );
    if (cells.some(Boolean)) lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\n");
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** Reads one uploaded Tally file in any supported format. `bankName` helps pick the ledger in XML. */
export async function readTallyExportFile(file: UploadedFile, ctx: { bankName?: string | null } = {}): Promise<TallyRead> {
  const ext = extensionOf(file.originalname);
  const head = file.buffer.subarray(0, 2048).toString("latin1");
  const isPdf = ext === "pdf" || file.mimetype === "application/pdf" || head.startsWith("%PDF");
  if (isPdf) {
    const read = await readTallyPdf(file.buffer);
    return read.ok ? ok(read.rows, "pdf", read.notes) : fail(read.message);
  }
  if ((file.mimetype ?? "").startsWith("image/") || ["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"].includes(ext)) {
    return fail(`A picture of a Tally report cannot be read reliably. Export it from Tally as ${TALLY_FORMATS}.`);
  }
  const isXml = ext === "xml" || /^\s*<\?xml|<ENVELOPE\b/i.test(head);
  if (isXml) return readTallyXml(file.buffer.toString("utf8").replace(/^﻿/, ""), ctx.bankName);
  const isHtml = ext === "html" || ext === "htm" || /^\s*<(!doctype html|html)\b/i.test(head);
  let csv: string;
  let source: TallySource = "sheet";
  if (isHtml) {
    csv = htmlToCsv(file.buffer.toString("utf8"));
    source = "html";
  } else {
    try {
      csv = sheetToCsvText(file);
    } catch (err) {
      if (err instanceof UnreadableFileError) return fail(err.message);
      throw err;
    }
  }
  if (!csv.trim()) return fail(NO_ENTRIES);
  const rows = parseTallyLedgerCsv(csv);
  if (rows.length === 0) return fail(NO_ENTRIES);
  return ok(rows, source);
}
