/**
 * GST state and union-territory codes, as printed in the first two digits of a GSTIN and in
 * "Place of supply". Pure lookup; nothing here decides tax.
 */

export const GST_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman and Diu",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (old)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "96": "Other Country",
  "97": "Other Territory",
};

function plain(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\band\b/g, " and ")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BY_NAME = new Map<string, string>();
for (const [code, name] of Object.entries(GST_STATES)) BY_NAME.set(plain(name), code);
// Names people actually type.
for (const [alias, code] of [
  ["orissa", "21"],
  ["pondicherry", "34"],
  ["new delhi", "07"],
  ["nct of delhi", "07"],
  ["delhi ncr", "07"],
  ["jammu kashmir", "01"],
  ["j and k", "01"],
  ["uttaranchal", "05"],
  ["chattisgarh", "22"],
  ["andaman nicobar", "35"],
  ["dadra and nagar haveli", "26"],
  ["daman diu", "26"],
  ["other country", "96"],
  ["export", "96"],
  ["outside india", "96"],
] as const) BY_NAME.set(alias, code);

export function stateName(code: string | null | undefined): string | null {
  if (!code) return null;
  return GST_STATES[code.padStart(2, "0")] ?? null;
}

/** "27", "27-Maharashtra", "Maharashtra (27)", "maharashtra" → "27". Null when it is none of them. */
export function stateCode(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const digits = /(?:^|[^0-9])(\d{2})(?:[^0-9]|$)/.exec(text);
  if (digits && GST_STATES[digits[1]]) return digits[1];
  const name = plain(text.replace(/\(\s*\d{2}\s*\)/g, " ").replace(/^\d{2}\s*[-:]?\s*/, ""));
  if (!name) return null;
  const exact = BY_NAME.get(name);
  if (exact) return exact;
  // "Maharashtra State" and similar.
  for (const [known, code] of BY_NAME) {
    if (known.length >= 5 && name.startsWith(known)) return code;
  }
  return null;
}

export function stateFromGstin(gstin: string | null | undefined): string | null {
  const text = String(gstin ?? "").trim().toUpperCase();
  return /^\d{2}[A-Z0-9]{13}$/.test(text) && GST_STATES[text.slice(0, 2)] ? text.slice(0, 2) : null;
}
