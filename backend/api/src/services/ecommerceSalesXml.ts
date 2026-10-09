/** Accounting voucher working copy. The target Tally company and ledgers require an import test. */
import { z } from "zod";
import { reviewMarketplaceSales } from "./ecommerceReview";

export const salesXmlSchema = z.object({
  clientName: z.string().trim().min(1).max(160),
  salesLedger: z.string().trim().min(1).max(120).default("Sales"),
  debtorLedger: z.string().trim().min(1).max(120).default("Marketplace Customers"),
  cgstLedger: z.string().trim().min(1).max(120).default("Output CGST"),
  sgstLedger: z.string().trim().min(1).max(120).default("Output SGST"),
  igstLedger: z.string().trim().min(1).max(120).default("Output IGST"),
  cessLedger: z.string().trim().min(1).max(120).default("Output Cess"),
  partyLedgers: z.record(z.string().max(30), z.string().trim().min(1).max(120)).default({}),
  sales: z.array(z.unknown()).min(1).max(5000),
});

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const amount = (value: number) => value.toFixed(2);
const entry = (name: string, value: number) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${escape(name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${value < 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${amount(value)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;

export function buildEcommerceSalesXml(input: unknown) {
  const parsed = salesXmlSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, errors: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}: ${issue.message}`) };
  const config = parsed.data;
  const reviewed = reviewMarketplaceSales(config.sales, "marketplace");
  if (!reviewed.ok) return reviewed;
  const saleIssues = reviewed.pack.sales.filter(sale => sale.issues.length);
  if (saleIssues.length) return { ok: false as const, errors: [`${saleIssues.length} sale rows need review before Sales vouchers can be created.`, ...saleIssues.slice(0, 3).map(sale => `Row ${sale.sourceRow}: ${sale.issues[0]}`)] };
  const missingParties = [...new Set(reviewed.pack.tabs.b2b.map(sale => sale.gstin!).filter(gstin => !config.partyLedgers[gstin]))];
  if (missingParties.length) return { ok: false as const, errors: [`Choose existing Tally party ledgers for ${missingParties.length} B2B GSTIN${missingParties.length === 1 ? "" : "s"}.`] };
  const vouchers: string[] = [];
  const errors: string[] = [];
  for (const sale of reviewed.pack.sales) {
    if (!sale.invoiceDate || !sale.invoiceNumber) continue;
    const tax = sale.cgst + sale.sgst + sale.igst + sale.cess;
    if (Math.round((sale.taxableValue + tax - sale.grossAmount) * 100) !== 0) {
      errors.push(`Row ${sale.sourceRow}: invoice amount does not balance against taxable value and tax.`);
      continue;
    }
    const party = sale.gstin ? config.partyLedgers[sale.gstin] : config.debtorLedger;
    const entries = [entry(party, -sale.grossAmount), entry(config.salesLedger, sale.taxableValue)];
    if (sale.cgst) entries.push(entry(config.cgstLedger, sale.cgst));
    if (sale.sgst) entries.push(entry(config.sgstLedger, sale.sgst));
    if (sale.igst) entries.push(entry(config.igstLedger, sale.igst));
    if (sale.cess) entries.push(entry(config.cessLedger, sale.cess));
    vouchers.push(`<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>${sale.invoiceDate.replace(/-/g, "")}</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>${escape(sale.invoiceNumber)}</VOUCHERNUMBER><REFERENCE>${escape(sale.orderId ?? "")}</REFERENCE><PARTYLEDGERNAME>${escape(party)}</PARTYLEDGERNAME><NARRATION>${escape(`${sale.platform} sale ${sale.invoiceNumber}`)}</NARRATION>${entries.join("")}</VOUCHER></TALLYMESSAGE>`);
  }
  if (errors.length || vouchers.length !== reviewed.pack.sales.length) return { ok: false as const, errors: errors.length ? errors : ["Sales voucher count does not match the reviewed rows."] };
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${escape(config.clientName)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${vouchers.join("")}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  return { ok: true as const, xml, voucherCount: vouchers.length, fileName: "TallyThis_Marketplace_Sales_Review.xml", errors: [] as string[] };
}
