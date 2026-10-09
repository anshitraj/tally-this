import type { z } from "zod";
import { validationErrors } from "./validators";

export type SafeParseAIJsonResult<T> =
  | { ok: true; data: T; jsonText: string }
  | { ok: false; error: string; validationErrors?: string[]; jsonText?: string };

function stripMarkdownFences(rawText: string): string {
  return rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractBalancedJson(rawText: string): string | null {
  const text = stripMarkdownFences(rawText);
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const opener = text[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === opener) depth += 1;
    if (char === closer) depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }

  return null;
}

export function safeParseAIJson<T>(rawText: string, schema: z.ZodType<T>): SafeParseAIJsonResult<T> {
  const jsonText = extractBalancedJson(rawText);
  if (!jsonText) {
    return { ok: false, error: "AI response did not contain a JSON object or array" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "AI response was not valid JSON", jsonText };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: "AI response failed schema validation",
      validationErrors: validationErrors(result.error),
      jsonText,
    };
  }

  return { ok: true, data: result.data, jsonText };
}

export function buildRepairPrompt(rawText: string, schemaDescription: string): string {
  return `Repair this model output into valid JSON that exactly matches the schema. Return only JSON. Do not add new facts. Use null for unsupported or missing fields.

Schema:
${schemaDescription}

Broken output:
${rawText.slice(0, 12_000)}`;
}
