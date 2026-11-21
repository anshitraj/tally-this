/**
 * Matching returns to the sales they reverse, by sub-order. Marketplace-independent and pure.
 *
 * A return reduces the period in which it is reported, whether or not its sale is found. One that cannot be matched
 * is kept and counted, and listed for review; it is never dropped.
 */
import type { Paise } from "./money";

export interface MatchSale { id: number; subOrderId: string | null; period: string; quantity: number; taxable: Paise }
export interface MatchReturn extends MatchSale {}

export type ReturnMatch =
  | { returnId: number; status: "matched" | "partial"; saleId: number; crossPeriod: boolean; salePeriod: string }
  | { returnId: number; status: "exceeds_sale"; saleId: number; crossPeriod: boolean; salePeriod: string; returnedTaxable: Paise; saleTaxable: Paise }
  | { returnId: number; status: "unmatched" };

export function matchReturns(returns: MatchReturn[], sales: MatchSale[]): ReturnMatch[] {
  const salesBySub = new Map<string, MatchSale[]>();
  for (const sale of sales) {
    if (!sale.subOrderId) continue;
    salesBySub.set(sale.subOrderId, [...(salesBySub.get(sale.subOrderId) ?? []), sale]);
  }
  // What has already been returned against each sale, so a second partial return is judged against the remainder.
  const returnedTaxable = new Map<number, Paise>();
  const returnedQuantity = new Map<number, number>();
  const ordered = [...returns].sort((a, b) => a.period.localeCompare(b.period) || a.id - b.id);
  const results: ReturnMatch[] = [];
  for (const ret of ordered) {
    const candidates = ret.subOrderId ? salesBySub.get(ret.subOrderId) ?? [] : [];
    // The sale it reverses is the latest one not after the return's period.
    const sale = candidates.filter(s => s.period <= ret.period).sort((a, b) => b.period.localeCompare(a.period))[0] ?? candidates[0];
    if (!sale) {
      results.push({ returnId: ret.id, status: "unmatched" });
      continue;
    }
    const taxableSoFar = (returnedTaxable.get(sale.id) ?? 0) + ret.taxable;
    const quantitySoFar = (returnedQuantity.get(sale.id) ?? 0) + ret.quantity;
    returnedTaxable.set(sale.id, taxableSoFar);
    returnedQuantity.set(sale.id, quantitySoFar);
    const crossPeriod = sale.period !== ret.period;
    if (taxableSoFar > sale.taxable + 1) {
      results.push({ returnId: ret.id, status: "exceeds_sale", saleId: sale.id, crossPeriod, salePeriod: sale.period, returnedTaxable: taxableSoFar, saleTaxable: sale.taxable });
    } else {
      const partial = quantitySoFar < sale.quantity || taxableSoFar < sale.taxable - 1;
      results.push({ returnId: ret.id, status: partial ? "partial" : "matched", saleId: sale.id, crossPeriod, salePeriod: sale.period });
    }
  }
  return results;
}
