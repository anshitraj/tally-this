/**
 * The GST arithmetic every marketplace adapter shares. Pure: no database, no marketplace knowledge.
 *
 * Rates are held in milli-percent (5% = 5000, 0.25% = 250) so halves of every rate (2.5%, 0.125%) stay whole numbers,
 * and tax is worked out in BigInt so no product of a large taxable value and a rate can lose a paisa.
 * Nothing here decides a liability: a check that fails becomes an exception for a CA to review.
 */
import { stateCode, stateFromGstin } from "../gstStates";
import type { Paise } from "./money";

export type SupplyType = "intra" | "inter" | "unknown";
export type RoundingMode = "line" | "aggregate";

/** The GST rate rationalisation took effect on 22 September 2025 (5% / 18% / 40% for most goods). */
export const RATE_RATIONALISATION_DATE = "2025-09-22";

const RATES_BEFORE = [0, 100, 250, 1000, 1500, 3000, 5000, 6000, 7500, 12000, 18000, 28000];
const RATES_FROM = [0, 100, 250, 1000, 1500, 3000, 5000, 6000, 7500, 18000, 40000];
/** Still notified for a few goods after the rationalisation, but no longer usual: worth a second look. */
const RATES_FROM_CHECK = [12000, 28000];

export function parseRate(value: unknown): number | null {
  const text = String(value ?? "").replace(/%/g, "").replace(/,/g, "").trim();
  if (!text || !/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (/[1-9]/.test(fraction.slice(3))) return null;
  return Number(whole) * 1000 + Number((fraction + "000").slice(0, 3));
}

export function rateText(milli: number | null | undefined): string {
  if (milli == null) return "";
  const whole = Math.trunc(milli / 1000);
  const fraction = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** "valid" for a rate in force on the date, "check" for one that is rare after the rationalisation, else "unknown". */
export function rateStatus(milli: number, isoDate: string | null): "valid" | "check" | "unknown" {
  const after = !isoDate || isoDate >= RATE_RATIONALISATION_DATE;
  if (after) {
    if (RATES_FROM.includes(milli)) return "valid";
    if (RATES_FROM_CHECK.includes(milli)) return "check";
    return "unknown";
  }
  return RATES_BEFORE.includes(milli) ? "valid" : "unknown";
}

/**
 * Apparel (HSN chapters 61 and 62) is taxed by the sale value of each piece. Before 22 September 2025: up to ₹1,000 at
 * 5%, above at 12%. From that date: up to ₹2,500 at 5%, above at 18%. Returns the expected rate, or null when the rule
 * does not apply or the value per piece is unknown. A difference is a potential risk for a CA to review, never a ruling.
 */
export function expectedApparelRate(hsn: string | null, taxablePerPiece: Paise | null, isoDate: string | null): number | null {
  if (!hsn || taxablePerPiece == null || taxablePerPiece <= 0) return null;
  const chapter = hsn.replace(/\D/g, "").slice(0, 2);
  if (chapter !== "61" && chapter !== "62") return null;
  const after = !isoDate || isoDate >= RATE_RATIONALISATION_DATE;
  if (after) return taxablePerPiece <= 250_000 ? 5000 : 18000;
  return taxablePerPiece <= 100_000 ? 5000 : 12000;
}

/** Half away from zero, in BigInt. */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

/** Tax on a taxable value at a rate, rounded to the paisa. */
export function taxOn(taxable: Paise, rateMilli: number): Paise {
  return Number(roundDiv(BigInt(taxable) * BigInt(rateMilli), 100_000n));
}

export function sellerState(gstin: string | null | undefined): string | null {
  return stateFromGstin(gstin);
}

export function placeOfSupply(value: unknown): string | null {
  return stateCode(value);
}

/**
 * Intra-State when the supplier's State (from its GSTIN) is the place of supply, inter-State when they differ, unknown
 * when either is missing. The place of supply for goods delivered to a consumer is where delivery ends, which is the
 * customer State a marketplace reports; a CA confirms special cases (SEZ, exports, bill-to-ship-to).
 */
export function supplyType(sellerGstin: string | null, posCode: string | null): SupplyType {
  const seller = sellerState(sellerGstin);
  if (!seller || !posCode) return "unknown";
  return seller === posCode ? "intra" : "inter";
}

export interface TaxSplit { igst: Paise; cgst: Paise; sgst: Paise }

/**
 * Splits one total tax amount. Inter-State: all IGST. Intra-State: CGST and SGST each half; an odd paisa goes to CGST,
 * so the two always add back to the total the document showed. Unknown: nothing is split.
 */
export function splitTax(total: Paise, type: SupplyType): TaxSplit {
  if (type === "inter") return { igst: total, cgst: 0, sgst: 0 };
  if (type === "intra") {
    const sgst = total >= 0 ? Math.floor(total / 2) : Math.ceil(total / 2);
    return { igst: 0, cgst: total - sgst, sgst };
  }
  return { igst: 0, cgst: 0, sgst: 0 };
}

/**
 * Tax for a group of lines under the "aggregate" rounding: the group's taxable value times the rate, rounded once.
 * Intra-State groups work out CGST and SGST separately at half the rate each, as a return summary does.
 */
export function aggregateTax(taxable: Paise, rateMilli: number, type: SupplyType): TaxSplit {
  if (type === "inter") return { igst: taxOn(taxable, rateMilli), cgst: 0, sgst: 0 };
  if (type === "intra") {
    const half = Number(roundDiv(BigInt(taxable) * BigInt(rateMilli), 200_000n));
    return { igst: 0, cgst: half, sgst: half };
  }
  return { igst: 0, cgst: 0, sgst: 0 };
}

/** One paisa either way is rounding; more is a difference worth a look. */
export const TAX_TOLERANCE_PAISE = 1;

export interface TaxCheck {
  computed: Paise;
  source: Paise | null;
  difference: Paise;
  withinTolerance: boolean;
}

export function checkTax(taxable: Paise, rateMilli: number, source: Paise | null): TaxCheck {
  const computed = taxOn(taxable, rateMilli);
  const difference = source == null ? 0 : source - computed;
  return { computed, source, difference, withinTolerance: Math.abs(difference) <= TAX_TOLERANCE_PAISE };
}

/** GSTIN format and check character (the GSTN mod-36 scheme). */
export function isValidGstin(value: string | null | undefined): boolean {
  const gstin = String(value ?? "").trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return false;
  if (!stateFromGstin(gstin)) return false;
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = chars.indexOf(gstin[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(value / 36) + (value % 36);
  }
  return chars[(36 - (sum % 36)) % 36] === gstin[14];
}

/** HSN codes are 4, 6 or 8 digits (SAC codes are 6 digits starting 99). */
export function hsnStatus(value: string | null | undefined): "valid" | "missing" | "invalid" {
  const text = String(value ?? "").trim();
  if (!text) return "missing";
  return /^(\d{4}|\d{6}|\d{8})$/.test(text) ? "valid" : "invalid";
}

/** Indian financial year of a YYYY-MM period: 2026-08 → "2026-27". */
export function financialYearOf(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Inter-State B2C invoices above this are B2C (Large) from the August 2024 return period (₹2.5 lakh before). */
export function b2clThreshold(period: string): Paise {
  return period >= "2024-08" ? 10_000_000 : 25_000_000;
}
