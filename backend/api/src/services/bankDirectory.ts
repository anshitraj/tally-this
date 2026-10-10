/**
 * Indian banks by IFSC prefix and printed name.
 * The IFSC printed next to "IFSC" in the statement header is the most reliable signal:
 * it names the account's own branch, while narrations mention other banks' codes.
 */

interface BankEntry {
  // Some RBI-listed banks are matched by their printed name until a branch IFSC is verified.
  ifsc?: string;
  name: string;
  pattern: RegExp;
  shortNames?: string[];
}

const BANKS: BankEntry[] = [
  { ifsc: "HDFC", name: "HDFC Bank", pattern: /\bhdfc\s*bank\b/i, shortNames: ["HDFC"] },
  { ifsc: "ICIC", name: "ICICI Bank", pattern: /\bicici\s*bank\b/i, shortNames: ["ICICI"] },
  { ifsc: "SBIN", name: "State Bank of India", pattern: /\bstate\s+bank\s+of\s+india\b|\bsbi\b/i, shortNames: ["SBI"] },
  { ifsc: "UTIB", name: "Axis Bank", pattern: /\baxis\s*bank\b/i, shortNames: ["AXIS"] },
  { ifsc: "KKBK", name: "Kotak Mahindra Bank", pattern: /\bkotak\s+mahindra\b|\bkotak\s+bank\b/i, shortNames: ["KOTAK"] },
  { ifsc: "INDB", name: "IndusInd Bank", pattern: /\bindusind\b/i },
  { ifsc: "YESB", name: "Yes Bank", pattern: /\byes\s*bank\b/i },
  { ifsc: "IDFB", name: "IDFC FIRST Bank", pattern: /\bidfc\s*first\b|\bidfc\s*bank\b/i, shortNames: ["IDFC", "IDFC FIRST"] },
  { ifsc: "PUNB", name: "Punjab National Bank", pattern: /\bpunjab\s+national\s+bank\b/i },
  { ifsc: "BARB", name: "Bank of Baroda", pattern: /\bbank\s+of\s+baroda\b/i, shortNames: ["BOB"] },
  { ifsc: "CNRB", name: "Canara Bank", pattern: /\bcanara\s+bank\b/i },
  { ifsc: "UBIN", name: "Union Bank of India", pattern: /\bunion\s+bank\s+of\s+india\b/i },
  { ifsc: "CBIN", name: "Central Bank of India", pattern: /\bcentral\s+bank\s+of\s+india\b/i },
  { ifsc: "BKID", name: "Bank of India", pattern: /(?<!union\s|central\s)\bbank\s+of\s+india\b/i },
  { ifsc: "MAHB", name: "Bank of Maharashtra", pattern: /\bbank\s+of\s+maharashtra\b/i },
  { ifsc: "IOBA", name: "Indian Overseas Bank", pattern: /\bindian\s+overseas\s+bank\b/i },
  { ifsc: "IDIB", name: "Indian Bank", pattern: /\bindian\s+bank\b/i },
  { ifsc: "UCBA", name: "UCO Bank", pattern: /\buco\s+bank\b/i },
  { ifsc: "PSIB", name: "Punjab & Sind Bank", pattern: /\bpunjab\s+(?:&|and)\s+sind\b/i },
  { ifsc: "FDRL", name: "Federal Bank", pattern: /\bfederal\s+bank\b/i },
  { ifsc: "RATN", name: "RBL Bank", pattern: /\brbl\s+bank\b|\bratnakar\s+bank\b/i },
  { ifsc: "DCBL", name: "DCB Bank", pattern: /\bdcb\s+bank\b/i },
  { ifsc: "BDBL", name: "Bandhan Bank", pattern: /\bbandhan\s+bank\b/i },
  { ifsc: "AUBL", name: "AU Small Finance Bank", pattern: /\bau\s+small\s+finance\b/i },
  { ifsc: "ESFB", name: "Equitas Small Finance Bank", pattern: /\bequitas\b/i },
  { ifsc: "UJVN", name: "Ujjivan Small Finance Bank", pattern: /\bujjivan\b/i },
  { ifsc: "JSFB", name: "Jana Small Finance Bank", pattern: /\bjana\s+small\s+finance\b/i },
  { ifsc: "SURY", name: "Suryoday Small Finance Bank", pattern: /\bsuryoday\b/i },
  { ifsc: "UTKS", name: "Utkarsh Small Finance Bank", pattern: /\butkarsh\s+small\b/i },
  { ifsc: "ESMF", name: "ESAF Small Finance Bank", pattern: /\besaf\b/i },
  { name: "Capital Small Finance Bank", pattern: /\bcapital\s+small\s+finance\s+bank\b/i },
  { ifsc: "SMCB", name: "Shivalik Small Finance Bank", pattern: /\bshivalik\s+(?:small\s+finance\s+)?bank\b/i },
  { name: "Unity Small Finance Bank", pattern: /\bunity\s+small\s+finance\s+bank\b/i },
  { name: "slice Small Finance Bank", pattern: /\bslice\s+small\s+finance\s+bank\b/i },
  { ifsc: "CIUB", name: "City Union Bank", pattern: /\bcity\s+union\s+bank\b/i },
  { ifsc: "KARB", name: "Karnataka Bank", pattern: /\bkarnataka\s+bank\b/i },
  { ifsc: "KVBL", name: "Karur Vysya Bank", pattern: /\bkarur\s+vysya\b/i },
  { ifsc: "SIBL", name: "South Indian Bank", pattern: /\bsouth\s+indian\s+bank\b/i },
  { ifsc: "TMBL", name: "Tamilnad Mercantile Bank", pattern: /\btamilnad\s+mercantile\b/i },
  { ifsc: "DLXB", name: "Dhanlaxmi Bank", pattern: /\bdhanlaxmi\b/i },
  { ifsc: "CSBK", name: "CSB Bank", pattern: /\bcsb\s+bank\b|\bcatholic\s+syrian\b/i },
  { ifsc: "IBKL", name: "IDBI Bank", pattern: /\bidbi\s+bank\b/i },
  { ifsc: "JAKA", name: "Jammu & Kashmir Bank", pattern: /\bj\s*&\s*k\s+bank\b|\bjammu\s+(?:&|and)\s+kashmir\s+bank\b/i },
  { ifsc: "NTBL", name: "Nainital Bank", pattern: /\bnainital\s+bank\b/i },
  { ifsc: "SRCB", name: "Saraswat Co-operative Bank", pattern: /\bsaraswat\b/i },
  { ifsc: "COSB", name: "Cosmos Co-operative Bank", pattern: /\bcosmos\s+(?:co-?op|bank)/i },
  { ifsc: "TJSB", name: "TJSB Sahakari Bank", pattern: /\btjsb\b/i },
  { ifsc: "SVCB", name: "SVC Co-operative Bank", pattern: /\bsvc\s+co-?op/i },
  { ifsc: "SCBL", name: "Standard Chartered Bank", pattern: /\bstandard\s+chartered\b/i },
  { ifsc: "HSBC", name: "HSBC", pattern: /\bhsbc\b/i },
  { ifsc: "CITI", name: "Citibank", pattern: /\bcitibank\b|\bciti\s+bank\b/i },
  { ifsc: "DBSS", name: "DBS Bank India", pattern: /\bdbs\s+bank\b/i },
  { name: "SBM Bank (India)", pattern: /\bsbm\s+bank\b/i },
  { ifsc: "DEUT", name: "Deutsche Bank", pattern: /\bdeutsche\s+bank\b/i },
  { ifsc: "BARC", name: "Barclays Bank", pattern: /\bbarclays\b/i },
  { ifsc: "PYTM", name: "Paytm Payments Bank", pattern: /\bpaytm\s+payments\s+bank\b/i },
  { ifsc: "AIRP", name: "Airtel Payments Bank", pattern: /\bairtel\s+payments\s+bank\b/i },
  { ifsc: "IPOS", name: "India Post Payments Bank", pattern: /\bindia\s+post\s+payments\b/i },
  { ifsc: "FINO", name: "Fino Payments Bank", pattern: /\bfino\s+payments\b/i },
  { ifsc: "NSPB", name: "NSDL Payments Bank", pattern: /\bnsdl\s+payments\b/i },
  { ifsc: "JIOP", name: "Jio Payments Bank", pattern: /\bjio\s+payments\b/i },
];

const BY_IFSC = new Map(BANKS.filter(bank => bank.ifsc).map(bank => [bank.ifsc!, bank.name]));

export const BANK_NAMES = BANKS.map(bank => bank.name);

export interface BankDetection {
  name: string;
  ifsc: string | null;
  how: "ifsc_label" | "name" | "ifsc" | "file_name";
}

/**
 * `header` is text printed above the transaction table (account details block).
 * Order: IFSC next to its label → bank name (earliest mention) → any IFSC → file name.
 */
export function detectBankFromStatement(header: string, fileName = ""): BankDetection | null {
  const labeled = header.match(/(?:branch\s+)?IFSC(?:\s*Code)?\s*[:\-.]?\s*([A-Z]{4})0([A-Z0-9]{6})\b/i);
  if (labeled) {
    const name = BY_IFSC.get(labeled[1].toUpperCase());
    if (name) return { name, ifsc: `${labeled[1]}0${labeled[2]}`.toUpperCase(), how: "ifsc_label" };
  }
  let earliest: { name: string; at: number } | null = null;
  for (const bank of BANKS) {
    const match = bank.pattern.exec(header);
    if (match && (!earliest || match.index < earliest.at)) earliest = { name: bank.name, at: match.index };
    // Some downloaded sheets print only a short bank wordmark above the table.
    for (const alias of bank.shortNames ?? []) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const short = new RegExp(`(?:^|[\\r\\n,])\\s*(?:bank(?:\\s+name)?\\s*[:\\-]\\s*)?${escaped}\\s*(?=$|[\\r\\n,])`, "im").exec(header);
      if (short && (!earliest || short.index < earliest.at)) earliest = { name: bank.name, at: short.index };
    }
  }
  if (earliest) return { name: earliest.name, ifsc: null, how: "name" };
  for (const match of header.matchAll(/\b([A-Z]{4})0[A-Z0-9]{6}\b/g)) {
    const name = BY_IFSC.get(match[1]);
    if (name) return { name, ifsc: match[0], how: "ifsc" };
  }
  for (const bank of BANKS) {
    const tokens = [bank.ifsc, ...(bank.shortNames ?? [])].filter((token): token is string => Boolean(token));
    if (bank.pattern.test(fileName) || tokens.some(token => new RegExp(`(^|[^a-z])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(fileName))) {
      return { name: bank.name, ifsc: null, how: "file_name" };
    }
  }
  return null;
}
