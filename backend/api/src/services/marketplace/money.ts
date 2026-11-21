/**
 * Money for marketplace reconciliation, held as whole paise (a safe integer) and read from the source text.
 *
 * Marketplace exports often carry more than two decimals ("229.66101694915255"). Those are rounded to the paisa once,
 * half away from zero, when the row is read; `exact` says whether anything was dropped. Every later step adds and
 * compares whole paise, so no total is ever the sum of floating-point rupees.
 */

export type Paise = number;

export interface ReadAmount {
  paise: Paise;
  /** False when digits beyond the paisa were rounded away. */
  exact: boolean;
}

function plainNumberText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Shortest text that reads back as the same double; expand exponent notation.
    const text = String(value);
    if (!/e/i.test(text)) return text;
    return value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  }
  let text = String(value).trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[₹,\s]/g, "").replace(/^(rs\.?|inr)/i, "");
  if (/^[+-]?(\d+\.?\d*|\.\d+)e[+-]?\d+$/i.test(text)) {
    const n = Number(text);
    if (!Number.isFinite(n)) return null;
    text = n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (text.endsWith("-") && !text.startsWith("-")) text = `-${text.slice(0, -1)}`; // "123.45-"
  if (negative) text = text.startsWith("-") ? text.slice(1) : `-${text}`;
  return text;
}

/** Reads an amount. Null for an empty cell, a dash or text that is not a number. */
export function readAmount(value: unknown): ReadAmount | null {
  const text = plainNumberText(value);
  if (text == null || text === "-" || text === "") return null;
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) return null;
  const whole = BigInt(match[2] || "0");
  const fraction = match[3] ?? "";
  let cents = whole * 100n + BigInt((fraction + "00").slice(0, 2));
  const rest = fraction.slice(2);
  if (rest && rest[0] >= "5") cents += 1n;
  const exact = !/[1-9]/.test(rest);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const paise = Number(cents);
  return { paise: match[1] === "-" && paise !== 0 ? -paise : paise, exact };
}

/** A quantity or rate as a decimal string with up to `places` decimals, or null. */
export function readDecimal(value: unknown, places = 3): string | null {
  const text = plainNumberText(value);
  if (text == null) return null;
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) return null;
  const fraction = (match[3] ?? "").slice(0, places).replace(/0+$/, "");
  const whole = (match[2] || "0").replace(/^0+(?=\d)/, "");
  return `${match[1] === "-" ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** "1234.50" — the form stored in numeric(16,2) columns. */
export function paiseToText(paise: Paise): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Reads a numeric(16,2) value back from the database (a string) into paise. */
export function textToPaise(value: string | number | null | undefined): Paise {
  if (value == null || value === "") return 0;
  const read = readAmount(value);
  return read ? read.paise : 0;
}

/** Rupees for display and JSON only. Totals are always added in paise first. */
export function rupees(paise: Paise): number {
  return paise / 100;
}

export function sum(values: Iterable<Paise>): Paise {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error("Money total exceeds the supported range.");
  }
  return total;
}

/** "₹1,23,456.78" in the Indian grouping, for PDFs and messages. */
export function formatInr(paise: Paise): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const whole = String(Math.trunc(abs / 100));
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${sign}₹${grouped}.${String(abs % 100).padStart(2, "0")}`;
}
