/**
 * Invoice register vs bank comparison for one run.
 * Extracted invoice fields stay "AI extracted — pending review" until a person accepts them.
 */
import { calculateConfidenceScore, calculateDateDistance, calculateNameSimilarity } from "./matchingEngine";
import { normalizeAmount, normalizeDate, parseCsvLine } from "./bankStatement";
import type { NormalizedBankTxn } from "./bankStatement";
import { suggestLedger } from "./tallyVoucherXml";

export interface InvoiceRow {
  invoiceNumber: string;
  invoiceDate: string | null;
  vendorName: string;
  vendorGstin: string | null;
  customerName: string | null;
  total: number;
  tax: number | null;
  rowNumber: number;
  label: "AI extracted — pending review" | "Imported from spreadsheet";
}

export function parseInvoiceCsv(text: string): InvoiceRow[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(cell => cell.toLowerCase());
  const idx = (aliases: string[]) => headers.findIndex(header => aliases.some(alias => header.includes(alias)));
  const numberIdx = idx(["invoice", "bill"]);
  const dateIdx = idx(["date"]);
  const vendorIdx = idx(["vendor", "supplier", "party"]);
  const gstinIdx = idx(["gstin"]);
  const customerIdx = idx(["customer", "buyer"]);
  const totalIdx = idx(["total", "amount", "gross"]);
  const taxIdx = idx(["tax", "gst amount"]);
  return lines.slice(1).flatMap((line, index) => {
    const cells = parseCsvLine(line);
    const invoiceNumber = (cells[numberIdx] ?? "").trim();
    const total = normalizeAmount(cells[totalIdx] ?? "");
    if (!invoiceNumber || total == null) return [];
    return [{
      invoiceNumber,
      invoiceDate: normalizeDate(cells[dateIdx] ?? ""),
      vendorName: (cells[vendorIdx] ?? "").trim() || "Unknown vendor",
      vendorGstin: (cells[gstinIdx] ?? "").trim() || null,
      customerName: (cells[customerIdx] ?? "").trim() || null,
      total: Math.abs(total),
      tax: normalizeAmount(cells[taxIdx] ?? ""),
      rowNumber: index + 2,
      label: "Imported from spreadsheet" as const,
    }];
  });
}

export interface InvoiceMatchItem {
  key: string;
  bucket: string;
  status: "suggested" | "needs_info";
  confidence: number;
  why: string[];
  bank?: NormalizedBankTxn;
  invoice?: InvoiceRow;
}

const NO_INVOICE_LEDGERS = new Set([
  "Salary Expenses", "Cash", "Bank Charges", "Interest Paid", "Interest Received",
  "GST Payable", "TDS Payable", "Income Tax", "Loan Account",
]);

export function compareInvoicesWithBank(bank: NormalizedBankTxn[], invoices: InvoiceRow[]) {
  const used = new Set<string>();
  const items: InvoiceMatchItem[] = bank.map(txn => {
    const amount = txn.debit ?? txn.credit ?? 0;
    let best: { invoice: InvoiceRow; score: number; amountMatches: boolean; referenceMatches: boolean } | null = null;
    for (const invoice of invoices) {
      if (used.has(invoice.invoiceNumber)) continue;
      const amountMatches = Math.abs(amount - invoice.total) <= 1;
      const referenceMatches = txn.narration.toUpperCase().includes(invoice.invoiceNumber.toUpperCase());
      const score = calculateConfidenceScore({
        amountMatches,
        dateDistance: invoice.invoiceDate ? calculateDateDistance(txn.date, invoice.invoiceDate) : 30,
        nameSimilarity: Math.max(
          calculateNameSimilarity(txn.narration, invoice.vendorName),
          calculateNameSimilarity(txn.counterparty ?? "", invoice.vendorName),
        ),
        referenceMatches,
        sourceConsistent: txn.debit != null,
      });
      if (!best || score > best.score) best = { invoice, score, amountMatches, referenceMatches };
    }
    const score = best?.score ?? 0;
    if (!best || score < 45) {
      if (NO_INVOICE_LEDGERS.has(suggestLedger(txn.narration))) {
        return { key: `pay-${txn.rowNumber}`, bucket: "no_invoice_expected", status: "suggested" as const, confidence: score, why: ["Salary, cash, tax, loan or bank charge — these usually have no invoice."], bank: txn };
      }
      return { key: `pay-${txn.rowNumber}`, bucket: "payment_without_invoice", status: "needs_info" as const, confidence: score, why: ["Payment without a matching invoice."], bank: txn };
    }
    used.add(best.invoice.invoiceNumber);
    // Exact amount plus the invoice number in the narration is as strong as evidence gets.
    const bucket = best.amountMatches ? (best.score >= 85 || best.referenceMatches ? "matched" : "suggested") : "amount_mismatch";
    return {
      key: `inv-${best.invoice.invoiceNumber}`,
      bucket,
      status: "suggested" as const,
      confidence: best.score,
      why: [
        best.amountMatches ? "Amount matches" : "Amount mismatch",
        ...(best.referenceMatches ? ["Invoice number found in the bank narration"] : []),
        `Vendor similarity checked against ${best.invoice.vendorName}`,
      ],
      bank: txn,
      invoice: best.invoice,
    };
  });
  invoices.forEach(invoice => {
    if (used.has(invoice.invoiceNumber)) return;
    items.push({
      key: `open-${invoice.invoiceNumber}`,
      bucket: "invoice_without_payment",
      status: "needs_info",
      confidence: 0,
      why: ["Invoice without a matching bank payment."],
      invoice,
    });
  });
  return { items };
}
