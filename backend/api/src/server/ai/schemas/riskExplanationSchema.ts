import { z } from "zod";

export const riskExplanationSchema = z.object({
  riskTitle: z.string(),
  riskCategory: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  explanation: z.string().refine((value) => value.includes("Potential risk"), {
    message: "explanation must include Potential risk language",
  }),
  suggestedAction: z.string(),
  requiredDocuments: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  caReviewRequired: z.literal(true),
});

export type RiskExplanation = z.infer<typeof riskExplanationSchema>;

export const riskExplanationSchemaDescription = `{
  "riskTitle": string,
  "riskCategory": string,
  "severity": "low" | "medium" | "high",
  "explanation": string,
  "suggestedAction": string,
  "requiredDocuments": string[],
  "confidence": number,
  "caReviewRequired": true
}

The explanation must include: "Potential risk — needs CA review." Do not state legal, tax, fraud, or audit certainty.`;
