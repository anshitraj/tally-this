import type { MarketplaceSale } from "./ecommerceGst";
import { paise } from "./money";

export const isCreditNote = (sale: Pick<MarketplaceSale, "transactionType">) => /credit[\s_-]*note/i.test(sale.transactionType);
const fields = ["taxableValue", "cgst", "sgst", "igst", "cess", "grossAmount"] as const;

/** Strict supported case: a note links to one original invoice row in this upload. */
export function checkCreditNoteLinks(rows: MarketplaceSale[]) {
  const used = new Map<MarketplaceSale, Record<string, number>>();
  for (const note of rows.filter(isCreditNote)) {
    const complain = (text: string) => note.issues.push(`${text} Potential risk — needs CA review.`);
    if (!note.originalInvoiceNumber) { complain("Credit note needs its original invoice number."); continue; }
    const originals = rows.filter(row => row.platform === note.platform && row.invoiceNumber === note.originalInvoiceNumber && !/credit|cancel|return|refund|adjustment|settlement|fee/i.test(row.transactionType));
    if (originals.length !== 1) { complain("Original invoice must be included once; multi-line or missing originals are not supported yet."); continue; }
    const original = originals[0];
    if (original.issues.length) complain("Fix the original invoice before linking this credit note.");
    if (note.invoiceNumber === original.invoiceNumber) complain("Credit note needs a separate document number.");
    if (note.refundAmount !== 0 && Math.abs(note.refundAmount) !== Math.abs(note.grossAmount)) complain("Refund and credit-note totals differ; the refund breakdown needs review.");
    if (!note.invoiceDate || !original.invoiceDate || note.invoiceDate < original.invoiceDate) complain("Credit note date cannot precede its original invoice.");
    if ((note.gstin ?? "").toUpperCase() !== (original.gstin ?? "").toUpperCase() || note.placeOfSupply?.toLowerCase() !== original.placeOfSupply?.toLowerCase() || note.hsn !== original.hsn || note.gstRate !== original.gstRate) complain("Credit note buyer, place of supply, HSN and rate must match the original invoice.");
    const nonzero = fields.map(field => note[field]).filter(value => value !== 0);
    if (nonzero.some(value => value < 0) && nonzero.some(value => value > 0)) complain("Credit note amount signs are inconsistent.");
    const consumed = used.get(original) ?? {};
    for (const field of fields) {
      const cents = paise(Math.abs(note[field]));
      const source = paise(original[field]);
      consumed[field] = (consumed[field] ?? 0) + (cents ?? 0);
      if (cents == null || source == null || consumed[field] > source) complain(`Credit notes exceed or cannot be checked against the original ${field}.`);
    }
    used.set(original, consumed);
  }
}
