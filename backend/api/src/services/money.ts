/** Exact INR source amounts. Extra non-zero decimal places are unsupported, never silently rounded. */
export function paise(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || /[1-9]/.test((match[3] ?? "").slice(2))) return null;
  const integer = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0").slice(0, 2));
  return Number.isSafeInteger(integer) ? (match[1] ? -integer : integer) : null;
}

export function sumMoney(values: number[]): number {
  let total = 0;
  for (const value of values) {
    const cents = paise(value);
    if (cents == null) throw new Error("An amount is not a finite value with at most two decimal places.");
    total += cents;
    if (!Number.isSafeInteger(total)) throw new Error("Money total exceeds the supported range.");
  }
  return total / 100;
}
