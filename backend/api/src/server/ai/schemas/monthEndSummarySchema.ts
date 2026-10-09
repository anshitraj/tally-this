import { z } from "zod";

export const monthEndSummarySchema = z.object({
  summary: z.string(),
  verificationScore: z.number().min(0).max(100),
  readyForCA: z.boolean(),
  topIssues: z.array(z.object({
    title: z.string(),
    count: z.number(),
    amount: z.number().nullable(),
    severity: z.enum(["low", "medium", "high"]),
  })),
  nextActions: z.array(z.string()),
  caReviewRequired: z.boolean(),
  disclaimer: z.literal("This is an AI-assisted summary. Potential risks need CA review."),
});

export type MonthEndSummary = z.infer<typeof monthEndSummarySchema>;

export const monthEndSummarySchemaDescription = `{
  "summary": string,
  "verificationScore": number,
  "readyForCA": boolean,
  "topIssues": [
    {
      "title": string,
      "count": number,
      "amount": number | null,
      "severity": "low" | "medium" | "high"
    }
  ],
  "nextActions": string[],
  "caReviewRequired": boolean,
  "disclaimer": "This is an AI-assisted summary. Potential risks need CA review."
}`;
