import { invoiceExtractionSchema, invoiceExtractionSchemaDescription, type InvoiceExtraction } from "./schemas/invoiceExtractionSchema";
import { runAIJsonTask } from "./providerRouter";
import type { AIProviderName } from "./types";

export interface ExtractInvoiceFieldsInput {
  uploadId?: number | null;
  companyId: number;
  userId?: number | null;
  extractedText: string;
  fileName: string;
}

export interface ExtractInvoiceFieldsResult {
  ok: boolean;
  provider: AIProviderName;
  model?: string;
  data: InvoiceExtraction;
  confidence: number;
  usedFallback: boolean;
  error?: string;
}

export async function extractInvoiceFields(input: ExtractInvoiceFieldsInput): Promise<ExtractInvoiceFieldsResult> {
  const result = await runAIJsonTask<InvoiceExtraction>({
    companyId: input.companyId,
    userId: input.userId,
    purpose: "invoice_extraction",
    schemaName: "invoice_extraction",
    schema: invoiceExtractionSchema,
    schemaDescription: invoiceExtractionSchemaDescription,
    input: {
      text: input.extractedText,
      fileName: input.fileName,
      uploadId: input.uploadId ?? null,
    },
    prompt: [
      "Extract invoice fields from the provided text only.",
      "Return strict JSON matching the schema.",
      "Do not invent values. If a field is missing or ambiguous, return null and add a warning.",
      "GSTIN must be valid-looking or null.",
      "Dates should be ISO format when clearly parseable.",
      "Mark every result as AI extracted — pending review; never verified.",
    ].join(" "),
  });

  if (!result.data) {
    throw new Error(result.error || "invoice_extraction_failed");
  }

  return {
    ok: result.ok,
    provider: result.provider,
    model: result.model,
    data: result.data,
    confidence: result.confidence,
    usedFallback: result.usedFallback,
    error: result.error,
  };
}
