/** Deterministic review of edited marketplace rows and uploaded GST portal TCS summaries. */
import { z } from "zod";
import { normalizeAmount, parseCsvLine } from "./bankStatement";
import { buildEcommercePack, type MarketplaceSale } from "./ecommerceGst";

export const reviewedSaleSchema = z.object({
  platform: z.string().trim().min(1).max(80),
  orderId: z.string().max(120).nullable(),
  invoiceNumber: z.string().max(120).nullable(),
  invoiceDate: z.string().max(20).nullable(),
  gstin: z.string().max(30).nullable(),
  buyerState: z.string().max(100).nullable(),
  placeOfSupply: z.string().max(100).nullable(),
  taxableValue: z.number().finite().nonnegative().max(1e10),
  cgst: z.number().finite().nonnegative().max(1e10),
  sgst: z.number().finite().nonnegative().max(1e10),
  igst: z.number().finite().nonnegative().max(1e10),
  cess: z.number().finite().nonnegative().max(1e10),
  grossAmount: z.number().finite().nonnegative().max(1e10),
  refundAmount: z.number().finite().nonnegative().max(1e10),
  marketplaceFees: z.number().finite().nonnegative().max(1e10),
  tcsAmount: z.number().finite().min(-1e10).max(1e10),
  hsn: z.string().max(30).nullable(),
  gstRate: z.number().finite().min(0).max(100).nullable(),
  transactionType: z.string().max(80),
  sourceFile: z.string().max(255),
  sourceRow: z.number().int().positive().max(1_000_000),
});
export const reviewedSalesSchema = z.array(reviewedSaleSchema).min(1).max(20000);

export function reviewMarketplaceSales(input: unknown, platform: string, annualTurnoverAbove5Cr?: boolean) {
  const parsed = reviewedSalesSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, errors: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}: ${issue.message}`) };
  const dates = parsed.data.filter(sale => sale.invoiceDate && !validIsoDate(sale.invoiceDate));
  if (dates.length) return { ok: false as const, errors: dates.slice(0, 5).map(sale => `Row ${sale.sourceRow}: invoice date must be a real YYYY-MM-DD date.`) };
  return { ok: true as const, pack: buildEcommercePack(parsed.data.map(sale => ({ ...sale, issues: [] })) as MarketplaceSale[], platform.slice(0, 100), annualTurnoverAbove5Cr) };
}

function validIsoDate(text: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3];
}

const STATE_NAMES = [
  ["01", "Jammu and Kashmir"], ["02", "Himachal Pradesh"], ["03", "Punjab"], ["04", "Chandigarh"],
  ["05", "Uttarakhand"], ["06", "Haryana"], ["07", "Delhi"], ["08", "Rajasthan"],
  ["09", "Uttar Pradesh"], ["10", "Bihar"], ["11", "Sikkim"], ["12", "Arunachal Pradesh"],
  ["13", "Nagaland"], ["14", "Manipur"], ["15", "Mizoram"], ["16", "Tripura"],
  ["17", "Meghalaya"], ["18", "Assam"], ["19", "West Bengal"], ["20", "Jharkhand"],
  ["21", "Odisha"], ["22", "Chhattisgarh"], ["23", "Madhya Pradesh"], ["24", "Gujarat"],
  ["26", "Dadra and Nagar Haveli and Daman and Diu"], ["27", "Maharashtra"], ["29", "Karnataka"],
  ["30", "Goa"], ["31", "Lakshadweep"], ["32", "Kerala"], ["33", "Tamil Nadu"],
  ["34", "Puducherry"], ["35", "Andaman and Nicobar Islands"], ["36", "Telangana"], ["37", "Andhra Pradesh"], ["38", "Ladakh"],
] as const;
const byCode = new Map<string, string>(STATE_NAMES);
const byName = new Map<string, string>(STATE_NAMES.map(([code, name]) => [name.toLowerCase().replace(/[^a-z]/g, ""), code]));

export function stateKey(value: string | null | undefined) {
  const text = (value ?? "").trim();
  const code = /^\d{1,2}(?=$|\D)/.exec(text)?.[0]?.padStart(2, "0");
  if (code && byCode.has(code)) return code;
  return byName.get(text.toLowerCase().replace(/[^a-z]/g, "")) ?? "";
}

export interface TcsRow { state: string; amount: number; }
export function readPortalTcs(text: string): { ok: true; rows: TcsRow[] } | { ok: false; message: string } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(parseCsvLine);
  const headerIndex = lines.findIndex(row => row.some(cell => /state|place of supply|state code/i.test(cell)) && row.some(cell => /tcs|tax collected/i.test(cell)));
  if (headerIndex < 0) return { ok: false, message: "The portal TCS file needs State and TCS amount columns." };
  const header = lines[headerIndex].map(cell => cell.trim().toLowerCase());
  const stateCol = header.findIndex(cell => /state|place of supply/.test(cell));
  const amountCol = header.findIndex(cell => /tcs|tax collected/.test(cell));
  const rows: TcsRow[] = [];
  for (const [index, row] of lines.entries()) {
    if (index <= headerIndex || row.every(cell => !cell.trim())) continue;
    const state = stateKey(row[stateCol]);
    const amount = normalizeAmount(row[amountCol]);
    if (!state || amount == null || !Number.isFinite(amount)) return { ok: false, message: `Portal TCS row ${index + 1} needs a recognized Indian state and numeric TCS amount.` };
    rows.push({ state, amount });
  }
  if (!rows.length) return { ok: false, message: "No portal TCS rows were found." };
  return { ok: true, rows };
}

export function comparePortalTcs(sales: MarketplaceSale[], portal: TcsRow[]) {
  const totals = new Map<string, { uploaded: number; portal: number }>();
  for (const sale of sales) {
    if (!sale.tcsAmount) continue;
    const key = stateKey(sale.placeOfSupply);
    if (!key) return { ok: false as const, message: `Sale row ${sale.sourceRow} has TCS but no recognized place of supply.` };
    const current = totals.get(key) ?? { uploaded: 0, portal: 0 };
    current.uploaded += sale.tcsAmount;
    totals.set(key, current);
  }
  for (const row of portal) {
    const key = stateKey(row.state);
    if (!key) return { ok: false as const, message: `Portal TCS state ${row.state} was not recognized.` };
    const current = totals.get(key) ?? { uploaded: 0, portal: 0 };
    current.portal += row.amount;
    totals.set(key, current);
  }
  const rows = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([code, totals]) => {
    const uploaded = Math.round(totals.uploaded * 100) / 100;
    const portalAmount = Math.round(totals.portal * 100) / 100;
    return { state: byCode.get(code) ?? code, code, uploaded, portal: portalAmount, difference: Math.round((uploaded - portalAmount) * 100) / 100 };
  });
  return { ok: true as const, rows, mismatches: rows.filter(row => row.difference !== 0).length };
}

export function documentSummary(sales: MarketplaceSale[]) {
  const byPlatform = new Map<string, { platform: string; issued: Set<string>; cancelled: Set<string> }>();
  for (const sale of sales) {
    const entry = byPlatform.get(sale.platform) ?? { platform: sale.platform, issued: new Set<string>(), cancelled: new Set<string>() };
    if (sale.invoiceNumber) entry.issued.add(sale.invoiceNumber);
    if (/cancel/i.test(sale.transactionType) && sale.invoiceNumber) entry.cancelled.add(sale.invoiceNumber);
    byPlatform.set(sale.platform, entry);
  }
  return [...byPlatform.values()].map(entry => ({ platform: entry.platform, issued: entry.issued.size, cancelled: entry.cancelled.size, source: "uploaded reports" as const }));
}

export const documentRowSchema = z.object({
  platform: z.string().trim().min(1).max(80),
  issued: z.number().int().nonnegative().max(1_000_000),
  cancelled: z.number().int().nonnegative().max(1_000_000),
  source: z.enum(["uploaded reports", "accountant correction"]).default("accountant correction"),
}).refine(row => row.cancelled <= row.issued, "Cancelled documents cannot exceed issued documents.");
export const documentRowsSchema = z.array(documentRowSchema).max(100);

export function reviewDocumentSummary(value: unknown, sales: MarketplaceSale[]) {
  if (value == null) return { ok: true as const, rows: documentSummary(sales) };
  const parsed = documentRowsSchema.safeParse(value);
  if (!parsed.success) return { ok: false as const, errors: parsed.error.issues.slice(0, 5).map(issue => issue.message) };
  const seen = new Set<string>();
  for (const row of parsed.data) {
    const key = row.platform.toLowerCase();
    if (seen.has(key)) return { ok: false as const, errors: [`${row.platform} appears twice in the document summary.`] };
    seen.add(key);
  }
  const derived = new Map(documentSummary(sales).map(row => [row.platform.toLowerCase(), row]));
  const rows = parsed.data.map(row => row.source === "uploaded reports" ? derived.get(row.platform.toLowerCase()) ?? row : row);
  for (const row of derived.values()) {
    if (!seen.has(row.platform.toLowerCase())) rows.push(row);
  }
  return { ok: true as const, rows };
}
