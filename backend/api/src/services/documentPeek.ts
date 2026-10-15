/**
 * A quick look at the first pages of a PDF so the home page can tell a Tally report, an invoice and a
 * bank statement apart even when the file name says nothing. Pure text rules, no AI.
 */
import { PDFParse } from "pdf-parse";

export type PdfKind = "tally_export" | "invoice_document" | "bank_statement" | "unknown";

/** Decides from text alone. Exported so it can be tested without a PDF. */
export function kindFromText(text: string): PdfKind {
  const sample = text.slice(0, 6000);
  const tallyColumns = /\bvch\.?\s*type\b|\bvoucher\s*type\b/i.test(sample) && /\bvch\.?\s*no\b|\bvoucher\s*(no|number)\b/i.test(sample);
  if (tallyColumns && /\bparticulars\b/i.test(sample)) return "tally_export";
  if (/\bday\s*book\b|\bledger\s*vouchers?\b/i.test(sample) && /\bparticulars\b/i.test(sample) && /\bdebit\b/i.test(sample) && /\bcredit\b/i.test(sample)) return "tally_export";
  const bank = /\bwithdrawal|\bdeposit|\bnarration\b|\bchq\b|\bopening\s+balance\b|\bclosing\s+balance\b|statement\s+of\s+account|account\s+statement|\bifsc\b/i.test(sample);
  if (bank) return "bank_statement";
  if (/\btax\s+invoice\b|\binvoice\s*(no|number|#|date)\b|\bbill\s+of\s+supply\b|\bproforma\s+invoice\b/i.test(sample)) return "invoice_document";
  return "unknown";
}

export async function peekPdfKind(buffer: Buffer): Promise<PdfKind> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    await parser.getInfo();
    const result = await parser.getText({ first: 2 });
    return kindFromText(result.text ?? "");
  } catch {
    // Locked, damaged or a scan: the file name decides.
    return "unknown";
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
