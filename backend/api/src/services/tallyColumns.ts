/**
 * What the columns of a Tally-style ledger table are called. One list of names serves the
 * Excel/CSV/HTML reader and the PDF reader, so a heading that works in one works in the other.
 * Tally itself prints "Particulars | Vch Type | Vch No. | Debit | Credit"; exports made from other
 * tools and CA working sheets often use "Ledger Name | Voucher/Invoice | Amount | Dr/Cr".
 */
export const TALLY_FORMATS = "Excel, CSV, XML, HTML or PDF";

export type TallyColumn ="date" | "particulars" | "vchType" | "vchNo" | "debit" | "credit" | "amount" | "drcr" | "narration" | "balance";

export function classifyTallyHeader(label: string): TallyColumn | null {
  const text = label.toLowerCase().replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/^(dr ?\/ ?cr|cr ?\/ ?dr|dr or cr|drcr|dr ?\| ?cr|nature|side|type)$/.test(text)) return "drcr";
  if (/(vch|voucher) ?type/.test(text)) return "vchType";
  if (/(vch|voucher|bill|invoice|document|doc) ?(no|num|number|#)|voucher ?\/ ?invoice|^vch$|^voucher$|^ref ?(no|number)?$/.test(text)) return "vchNo";
  if (/debit|^dr$|^dr ?\(|dr amount/.test(text)) return "debit";
  if (/credit|^cr$|^cr ?\(|cr amount/.test(text)) return "credit";
  if (/balance/.test(text)) return "balance";
  if (/^amount|amount$|^amt|^value$/.test(text)) return "amount";
  if (/\bdate\b/.test(text) && !/due|value|maturity|ref/.test(text)) return "date";
  if (/narration|remark|description|^notes?\b|memo/.test(text)) return "narration";
  if (/particular|ledger|account|party|^name$|^name of/.test(text)) return "particulars";
  return null;
}

/** "Dr" or "Cr" printed beside a name, an amount or in its own column. */
export function sideOf(text: string | null | undefined): "debit" | "credit" | null {
  const value = (text ?? "").trim().toLowerCase().replace(/[.\s]/g, "");
  if (value === "dr" || value === "debit") return "debit";
  if (value === "cr" || value === "credit") return "credit";
  return null;
}

/** A marker that only says which side an entry is on, such as "To" or "By". It is not a name. */
export function isSideMarker(text: string | null | undefined): boolean {
  return /^(to|by|dr|cr)\.?$/i.test((text ?? "").trim());
}
