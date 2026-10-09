import { z } from "zod";
import { invoiceExtractionSchema, invoiceExtractionSchemaDescription } from "./schemas/invoiceExtractionSchema";
import { monthEndSummarySchema, monthEndSummarySchemaDescription } from "./schemas/monthEndSummarySchema";
import { riskExplanationSchema, riskExplanationSchemaDescription } from "./schemas/riskExplanationSchema";
import type { AIRequestPurpose } from "./types";

export const bankNarrationInterpretationSchema = z.object({
  possiblePartyName: z.string().nullable(),
  possibleReference: z.string().nullable(),
  paymentRail: z.enum(["UPI", "NEFT", "RTGS", "IMPS", "CARD", "CHEQUE", "GATEWAY", "UNKNOWN"]),
  possiblePurpose: z.string().nullable(),
  ledgerSuggestion: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  needsReview: z.boolean(),
});

export const ledgerSuggestionSchema = z.object({
  suggestedLedger: z.string().nullable(),
  ledgerCategory: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  needsCAReview: z.boolean(),
});

export const columnMappingSchema = z.object({
  sourceType: z.enum(["bank", "invoice", "tally", "zoho", "gst", "payroll", "gateway", "expense"]),
  mappings: z.array(z.object({
    originalColumn: z.string(),
    mappedField: z.string().nullable(),
    confidence: z.number().min(0).max(1),
  })),
  unmappedColumns: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const caNoteGenerationSchema = z.object({
  note: z.string(),
  confidence: z.number().min(0).max(1),
  caReviewRequired: z.boolean(),
});

export type BankNarrationInterpretation = z.infer<typeof bankNarrationInterpretationSchema>;
export type LedgerSuggestion = z.infer<typeof ledgerSuggestionSchema>;
export type ColumnMapping = z.infer<typeof columnMappingSchema>;
export type CaNoteGeneration = z.infer<typeof caNoteGenerationSchema>;

export const schemaDescriptions: Record<AIRequestPurpose, string> = {
  invoice_extraction: invoiceExtractionSchemaDescription,
  bank_narration_interpretation: `{
  "possiblePartyName": string | null,
  "possibleReference": string | null,
  "paymentRail": "UPI" | "NEFT" | "RTGS" | "IMPS" | "CARD" | "CHEQUE" | "GATEWAY" | "UNKNOWN",
  "possiblePurpose": string | null,
  "ledgerSuggestion": string | null,
  "confidence": number,
  "reason": string,
  "needsReview": boolean
}`,
  ledger_suggestion: `{
  "suggestedLedger": string | null,
  "ledgerCategory": string | null,
  "confidence": number,
  "reason": string,
  "needsCAReview": boolean
}`,
  risk_explanation: riskExplanationSchemaDescription,
  month_end_summary: monthEndSummarySchemaDescription,
  column_mapping: `{
  "sourceType": "bank" | "invoice" | "tally" | "zoho" | "gst" | "payroll" | "gateway" | "expense",
  "mappings": [{ "originalColumn": string, "mappedField": string | null, "confidence": number }],
  "unmappedColumns": string[],
  "warnings": string[]
}`,
  ca_note_generation: `{ "note": string, "confidence": number, "caReviewRequired": boolean }`,
};

export const purposeSchemas = {
  invoice_extraction: invoiceExtractionSchema,
  bank_narration_interpretation: bankNarrationInterpretationSchema,
  ledger_suggestion: ledgerSuggestionSchema,
  risk_explanation: riskExplanationSchema,
  month_end_summary: monthEndSummarySchema,
  column_mapping: columnMappingSchema,
  ca_note_generation: caNoteGenerationSchema,
} satisfies Record<AIRequestPurpose, z.ZodType<unknown>>;

export function validationErrors(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
}
