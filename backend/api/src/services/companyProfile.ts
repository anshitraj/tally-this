/**
 * What the Settings page may change about a company, and how it is checked.
 * Only fields the companies table really stores are accepted; anything else is ignored, so a request
 * cannot set the plan, the retention period or any other column.
 */
import { gstinChecksumOk, normalizeGstin } from "./gstrRecon";

export interface CompanyUpdate {
  name?: string;
  gstin?: string | null;
  pan?: string | null;
  caEmail?: string | null;
  financialYearStart?: string;
}

export type CompanyUpdateResult = { ok: true; update: CompanyUpdate } | { ok: false; error: string };

export const FINANCIAL_YEAR_STARTS = ["January", "April", "July", "October"] as const;

function text(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

export function validateCompanyUpdate(body: unknown): CompanyUpdateResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Nothing to save." };
  const input = body as Record<string, unknown>;
  const update: CompanyUpdate = {};

  if ("name" in input) {
    const name = text(input.name);
    if (!name || name.length > 160 || /[\u0000-\u001f]/.test(name)) return { ok: false, error: "Enter the company name (up to 160 characters)." };
    update.name = name;
  }

  if ("gstin" in input) {
    const raw = text(input.gstin);
    if (input.gstin !== null && raw === null) return { ok: false, error: "GSTIN must be text." };
    if (!raw) update.gstin = null;
    else {
      const gstin = normalizeGstin(raw);
      if (gstin.length !== 15 || !gstinChecksumOk(gstin)) return { ok: false, error: "That GSTIN is not valid. Check all 15 characters, for example 29ABCDE1234F1Z5." };
      update.gstin = gstin;
    }
  }

  if ("pan" in input) {
    const raw = text(input.pan);
    if (input.pan !== null && raw === null) return { ok: false, error: "PAN must be text." };
    if (!raw) update.pan = null;
    else {
      const pan = raw.toUpperCase().replace(/\s+/g, "");
      if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return { ok: false, error: "That PAN is not valid. It has 10 characters, for example ABCDE1234F." };
      update.pan = pan;
    }
  }

  if ("caEmail" in input) {
    const raw = text(input.caEmail);
    if (input.caEmail !== null && raw === null) return { ok: false, error: "The CA's email must be text." };
    if (!raw) update.caEmail = null;
    else {
      const email = raw.toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: "That email address does not look right." };
      update.caEmail = email;
    }
  }

  if ("financialYearStart" in input) {
    const raw = text(input.financialYearStart);
    const month = FINANCIAL_YEAR_STARTS.find(candidate => candidate.toLowerCase() === raw?.toLowerCase());
    if (!month) return { ok: false, error: "Choose when the financial year starts: January, April, July or October." };
    update.financialYearStart = month;
  }

  if (Object.keys(update).length === 0) return { ok: false, error: "Nothing to save." };
  return { ok: true, update };
}
