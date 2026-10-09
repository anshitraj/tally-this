import { z } from "zod";

export const invoiceExtractionSchema = z.object({
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  vendorName: z.string().nullable(),
  customerName: z.string().nullable(),
  vendorGstin: z.string().nullable(),
  customerGstin: z.string().nullable(),
  subtotalAmount: z.number().nullable(),
  gstAmount: z.number().nullable(),
  totalAmount: z.number().nullable(),
  currency: z.string().nullable(),
  lineItems: z.array(z.object({
    description: z.string().nullable(),
    quantity: z.number().nullable(),
    unitPrice: z.number().nullable(),
    amount: z.number().nullable(),
    gstRate: z.number().nullable(),
  })),
  confidence: z.number().min(0).max(1),
  missingFields: z.array(z.string()),
  warnings: z.array(z.string()),
  sourceQuotes: z.array(z.string()),
});

export type InvoiceExtraction = z.infer<typeof invoiceExtractionSchema>;

export const invoiceExtractionSchemaDescription = `{
  "invoiceNumber": string | null,
  "invoiceDate": string | null,
  "vendorName": string | null,
  "customerName": string | null,
  "vendorGstin": string | null,
  "customerGstin": string | null,
  "subtotalAmount": number | null,
  "gstAmount": number | null,
  "totalAmount": number | null,
  "currency": "INR" | string | null,
  "lineItems": [
    {
      "description": string | null,
      "quantity": number | null,
      "unitPrice": number | null,
      "amount": number | null,
      "gstRate": number | null
    }
  ],
  "confidence": number,
  "missingFields": string[],
  "warnings": string[],
  "sourceQuotes": string[]
}

sourceQuotes must be short snippets from the provided text. If no source text supports a field, return null. Do not guess GSTIN, invoice number, dates, vendors, or amounts.`;
