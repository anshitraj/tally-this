/**
 * Tally voucher XML for bank statement import.
 * Receipt when money enters the bank. Payment when money leaves the bank.
 * Amounts follow the public Tally convention: debit lines are negative with ISDEEMEDPOSITIVE Yes.
 */

import type { NormalizedBankTxn } from "./bankStatement";
import { paise } from "./money";

export interface LedgerMapping {
  counterparty: string;
  ledgerName: string;
}

export type VoucherType = "Receipt" | "Payment" | "Contra";

/** A bank row plus the reviewer's own choices for that one row. */
export type TallyBankTxn = NormalizedBankTxn & {
  /** Overrides the party's ledger for this row only. */
  ledgerName?: string | null;
  voucherType?: VoucherType | null;
};

export interface TallyXmlInput {
  companyName: string;
  bankLedger: string;
  transactions: TallyBankTxn[];
  mappings?: LedgerMapping[];
  /** Adds create-only ledger masters so the import does not stop on a missing ledger. Existing ledgers are left untouched. */
  createLedgers?: boolean;
  bankGroup?: "Bank Accounts" | "Current Assets";
  /** Tally company to import into when sending straight to Tally. A downloaded file goes into whichever company is open. */
  tallyCompany?: string;
  /** An existing Tally ledger that takes the place of "Suspense", e.g. "Suspense A/c". */
  suspenseLedger?: string;
}

export interface TallyXmlResult {
  ok: boolean;
  xml?: string;
  /** Ledger masters on their own, for sending to Tally before the vouchers. */
  mastersXml?: string;
  fileName?: string;
  voucherCount?: number;
  errors: string[];
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tallyDate(iso: string) {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (actual.getUTCFullYear() !== year || actual.getUTCMonth() !== month - 1 || actual.getUTCDate() !== day) return null;
  return `${match[1]}${match[2]}${match[3]}`;
}

function money(value: number) {
  return value.toFixed(2);
}

/** Ledgers offered as choices in the review screen. Users pick; they do not type. */
export const LEDGER_OPTIONS = [
  "Sundry Debtors",
  "Sundry Creditors",
  "Sales",
  "Purchase",
  "Salary Expenses",
  "Rent",
  "Electricity Expenses",
  "Telephone & Internet",
  "Software Expenses",
  "Professional Fees",
  "Office Expenses",
  "Travelling Expenses",
  "Advertisement Expenses",
  "Bank Charges",
  "Interest Received",
  "Interest Paid",
  "Cashback Received",
  "Fixed Deposits",
  "Insurance Premium",
  "Loan Account",
  "Credit Card Payable",
  "GST Payable",
  "TDS Payable",
  "Income Tax",
  "PF Payable",
  "ESI Payable",
  "Professional Tax Payable",
  "Payment Gateway Settlements",
  "Marketplace Settlements",
  "Cash",
  "Capital A/c",
  "Drawings",
  "Suspense",
] as const;

interface LedgerRule {
  pattern: RegExp;
  ledger: string;
  /** The rule fits only money in, or only money out. */
  direction?: "in" | "out";
  /** A likely ledger the reviewer must still confirm, because the narration alone cannot settle it. */
  hint?: boolean;
}

const rule = (pattern: RegExp, ledger: string, extra: Omit<LedgerRule, "pattern" | "ledger"> = {}): LedgerRule => ({ pattern, ledger, ...extra });

const MARKETPLACES = /amazon seller|flipkart|meesho|myntra|jiomart|ajio|snapdeal|glowroad/;

/** First match wins. Sources and reasons for each treatment: docs/BANK_LEDGER_RULES.md. */
const LEDGER_RULES: LedgerRule[] = [
  // Google Pay handles say what the money was for; the "Google" name printed beside them does not.
  rule(/goog-payments@|cashback|scratch ?card|gpay ?reward/, "Cashback Received", { direction: "in", hint: true }),
  rule(/gpay-?creditcard@|credit ?card|card ?bill|cc ?bill|cred\.club|@cred\b/, "Credit Card Payable", { direction: "out", hint: true }),
  rule(/gpayrecharge@|recharge/, "Telephone & Internet", { direction: "out", hint: true }),
  rule(/gpayvoucher@|gift ?card/, "Suspense"),
  rule(/playstore@|google ?play/, "Software Expenses", { direction: "out", hint: true }),
  // Statutory dues deducted from salaries are paid out of a payable, not booked as a fresh expense.
  rule(/epfo|\bepf\b|provident fund|pf challan|pf contribution/, "PF Payable"),
  rule(/esic|\besi\b/, "ESI Payable"),
  rule(/ptax|p\.tax|prof(essional|\.)? ?tax|\bpt challan/, "Professional Tax Payable"),
  rule(/salary|salaries|payroll|wages/, "Salary Expenses"),
  // Settlement ledgers hold money a gateway or marketplace pays you. Paying out through a gateway
  // handle (vil.payu@, shop.rzp@) is a purchase, so the merchant name decides the ledger.
  rule(/razorpay|cashfree|payu|ccavenue|paytm pg|stripe|phonepe pg|billdesk/, "Payment Gateway Settlements", { direction: "in" }),
  rule(MARKETPLACES, "Marketplace Settlements", { direction: "in" }),
  // Buying on a marketplace says nothing about what was bought.
  rule(MARKETPLACES, "Suspense", { direction: "out" }),
  rule(/\brent\b|lease/, "Rent"),
  rule(/electricity|bescom|msedcl|tata power|adani elec|power bill|bses/, "Electricity Expenses"),
  rule(/airtel|jio|vodafone|\bvi\b|bsnl|broadband|internet|mobile bill/, "Telephone & Internet"),
  rule(/facebook|meta ads|google ads|advert|marketing/, "Advertisement Expenses"),
  rule(/google ?(cloud|workspace|one)|g ?suite|workspace|aws|amazon web|microsoft|zoho|adobe|github|atlassian|slack|notion|software|saas/, "Software Expenses"),
  rule(/\bca fees|consult|professional|legal|audit fee/, "Professional Fees"),
  rule(/\buber\b|\bola\b|irctc|makemytrip|indigo|air india|vistara|travel|hotel/, "Travelling Expenses"),
  rule(/charges|chrg|chgs|sms alert|annual fee|gst on charges|commission/, "Bank Charges"),
  rule(/\bfd\b|fixed deposit|term deposit|\btd\b.*(maturity|booking|closure)/, "Fixed Deposits"),
  rule(/insurance|\blic\b|premium|(hdfc|sbi|kotak mahindra|max|bajaj allianz|tata aia|aditya birla sun|pnb met|star health) ?life|icici pru/, "Insurance Premium"),
  rule(/\bemi\b|loan|nach.*finance/, "Loan Account"),
  rule(/\bgst\b|gstn|cbic|gst challan/, "GST Payable"),
  rule(/\btds\b|26q|24q|tin-nsdl/, "TDS Payable"),
  rule(/income tax|advance tax|itns|\bitd\b/, "Income Tax"),
  // Moving money to the holder's own account could be a bank transfer, capital or drawings.
  rule(/self ?(transfer|trf)|own account/, "Suspense"),
  rule(/\batm\b|\bnwd\b|\batw\b|cash wdl|cash withdrawal|cash dep|by cash|\bcdm\b/, "Cash"),
  // A cheque drawn to "self" is usually cash withdrawn at the branch.
  rule(/\bself\b/, "Cash", { hint: true }),
];

/** Interest the bank pays you ("Int.Pd", "Credit Interest") versus interest you pay on a loan. */
const INTEREST = /\bint\.?\s*(pd|paid|cr|credit)\b|interest|\bsb\s*int\b|loan\s*int\b/;

export interface LedgerSuggestion {
  ledger: string;
  /** False for a likely ledger the reviewer must confirm, and for Suspense. */
  sure: boolean;
}

export function suggestLedgerDetail(narration: string, direction?: "in" | "out"): LedgerSuggestion {
  const text = narration.toLowerCase();
  if (INTEREST.test(text)) return { ledger: direction === "out" ? "Interest Paid" : "Interest Received", sure: true };
  for (const candidate of LEDGER_RULES) {
    if (candidate.direction && direction && candidate.direction !== direction) continue;
    if (!candidate.pattern.test(text)) continue;
    if (candidate.ledger === "Suspense") return { ledger: "Suspense", sure: false };
    // Money coming back into an expense is a refund, reversal or cashback; only the reviewer can say which.
    const refundLike = direction === "in" && (LEDGER_GROUPS[candidate.ledger] === "Indirect Expenses" || candidate.ledger === "Purchase");
    return { ledger: candidate.ledger, sure: !candidate.hint && !refundLike };
  }
  return { ledger: "Suspense", sure: false };
}

export function suggestLedger(narration: string, mappings: LedgerMapping[] = [], direction?: "in" | "out") {
  const text = narration.toLowerCase();
  const remembered = mappings.find(mapping => mapping.counterparty && text.includes(mapping.counterparty.toLowerCase()));
  if (remembered) return remembered.ledgerName;
  return suggestLedgerDetail(narration, direction).ledger;
}

/** Tally parent group for each choice. Ledgers outside this list are assumed to exist already. */
const LEDGER_GROUPS: Record<string, string> = {
  "Sales": "Sales Accounts",
  "Purchase": "Purchase Accounts",
  "Salary Expenses": "Indirect Expenses",
  "Rent": "Indirect Expenses",
  "Electricity Expenses": "Indirect Expenses",
  "Telephone & Internet": "Indirect Expenses",
  "Software Expenses": "Indirect Expenses",
  "Professional Fees": "Indirect Expenses",
  "Office Expenses": "Indirect Expenses",
  "Travelling Expenses": "Indirect Expenses",
  "Advertisement Expenses": "Indirect Expenses",
  "Bank Charges": "Indirect Expenses",
  "Interest Paid": "Indirect Expenses",
  "Interest Received": "Indirect Incomes",
  "Cashback Received": "Indirect Incomes",
  "Fixed Deposits": "Investments",
  "Insurance Premium": "Indirect Expenses",
  "Loan Account": "Loans (Liability)",
  "Credit Card Payable": "Current Liabilities",
  "GST Payable": "Duties & Taxes",
  "TDS Payable": "Duties & Taxes",
  "Income Tax": "Loans & Advances (Asset)",
  "PF Payable": "Current Liabilities",
  "ESI Payable": "Current Liabilities",
  "Professional Tax Payable": "Current Liabilities",
  "Payment Gateway Settlements": "Current Assets",
  "Marketplace Settlements": "Current Assets",
  "Capital A/c": "Capital Account",
  "Drawings": "Capital Account",
  "Suspense": "Suspense A/c",
};

/** "Sundry Debtors" and "Sundry Creditors" are Tally groups; the party gets its own ledger inside them. */
const PARTY_GROUPS = new Set(["Sundry Debtors", "Sundry Creditors"]);

/** Ledgers every Tally company already has. */
const BUILT_IN_LEDGERS = new Set(["cash", "profit & loss a/c"]);

/** Cash in or out of the bank is a Contra entry; everything else follows the direction of money. */
export function defaultVoucherType(credit: number | null, ledgerName: string): VoucherType {
  if (ledgerName.toLowerCase() === "cash") return "Contra";
  return credit != null && credit > 0 ? "Receipt" : "Payment";
}

/** Contra moves money between cash and bank, so the other side must be Cash or a bank account. */
function contraAllowed(ledger: { name: string; group: string | null }) {
  return ledger.name.toLowerCase() === "cash" || ledger.group === "Bank Accounts" || ledger.group === "Cash-in-Hand";
}

function partyName(label: string) {
  const cleaned = label.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!/[a-z]{2,}/i.test(cleaned)) return null;
  return cleaned === cleaned.toUpperCase()
    ? cleaned.toLowerCase().replace(/\b([a-z])/g, letter => letter.toUpperCase())
    : cleaned;
}

/** Same grouping as the review screen: the party name, else the start of the narration. */
export function partyKey(txn: Pick<NormalizedBankTxn, "counterparty" | "narration">) {
  return (txn.counterparty || txn.narration.slice(0, 40)).trim();
}

export function resolveLedger(txn: Pick<NormalizedBankTxn, "narration" | "description" | "counterparty" | "credit">, mappings: LedgerMapping[] = []): { name: string; group: string | null } {
  const narration = txn.narration || txn.description;
  const text = narration.toLowerCase();
  const key = partyKey(txn).toLowerCase();
  const remembered = mappings.find(mapping => mapping.counterparty && mapping.counterparty.trim().toLowerCase() === key);
  const choice = remembered?.ledgerName ?? suggestLedger(narration, [], txn.credit != null ? "in" : "out");
  if (PARTY_GROUPS.has(choice)) {
    const party = remembered ? partyName(remembered.counterparty) : null;
    return party ? { name: party, group: choice } : { name: "Suspense", group: LEDGER_GROUPS.Suspense };
  }
  return { name: choice, group: LEDGER_GROUPS[choice] ?? null };
}

function ledgerMaster(name: string, group: string) {
  return `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${xmlEscape(name)}" ACTION="Create">
            <NAME.LIST><NAME>${xmlEscape(name)}</NAME></NAME.LIST>
            <PARENT>${xmlEscape(group)}</PARENT>
          </LEDGER>
        </TALLYMESSAGE>`;
}

export function buildTallyVoucherXml(input: TallyXmlInput): TallyXmlResult {
  const errors: string[] = [];
  const companyName = input.companyName.trim();
  const bankLedger = input.bankLedger.trim();
  if (!companyName) errors.push("Client or company name is required.");
  if (!bankLedger) errors.push("Bank ledger name is required.");
  if (input.transactions.length === 0) errors.push("No transactions to export.");

  const vouchers: string[] = [];
  const masters = new Map<string, string>();
  const bankGroup = input.bankGroup ?? "Bank Accounts";
  if (bankLedger) masters.set(bankLedger.toLowerCase(), ledgerMaster(bankLedger, bankGroup));
  input.transactions.forEach((txn, index) => {
    const date = tallyDate(txn.date);
    const amount = txn.debit ?? txn.credit;
    if (!date) {
      errors.push(`Row ${txn.rowNumber}: date ${txn.date} is not a valid ISO date.`);
      return;
    }
    if (amount == null || amount <= 0 || paise(amount) == null) {
      errors.push(`Row ${txn.rowNumber}: amount is missing.`);
      return;
    }
    if (txn.debit != null && txn.credit != null) {
      errors.push(`Row ${txn.rowNumber}: both debit and credit are set.`);
      return;
    }
    const isReceipt = txn.credit != null && txn.credit > 0;
    const chosen = resolveLedger(txn, txn.ledgerName ? [{ counterparty: partyKey(txn), ledgerName: txn.ledgerName }] : input.mappings);
    const suspense = input.suspenseLedger?.trim();
    const resolved = chosen.name === "Suspense" && suspense ? { name: suspense, group: null } : chosen;
    const partyLedger = resolved.name;
    if (partyLedger.trim().toLowerCase() === bankLedger.toLowerCase()) {
      errors.push(`Row ${txn.rowNumber}: the other ledger cannot be the same bank account.`);
      return;
    }
    if ([bankLedger, partyLedger, txn.narration, txn.reference, input.tallyCompany].some(value => value && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))) {
      errors.push(`Row ${txn.rowNumber}: text contains characters XML cannot represent.`);
      return;
    }
    const voucherType = txn.voucherType ?? defaultVoucherType(txn.credit, partyLedger);
    if (voucherType === "Contra" && !contraAllowed(resolved)) {
      errors.push(`Row ${txn.rowNumber}: a Contra entry needs Cash or another bank account, not ${partyLedger}.`);
      return;
    }
    if ((voucherType === "Receipt" && !isReceipt) || (voucherType === "Payment" && isReceipt)) {
      errors.push(`Row ${txn.rowNumber}: a ${voucherType} cannot be money ${isReceipt ? "in" : "out"}.`);
      return;
    }
    if (resolved.group && !BUILT_IN_LEDGERS.has(partyLedger.toLowerCase()) && !masters.has(partyLedger.toLowerCase())) {
      masters.set(partyLedger.toLowerCase(), ledgerMaster(partyLedger, resolved.group));
    }
    const narration = xmlEscape(txn.narration || txn.description || "Bank transaction");
    const reference = txn.reference ? xmlEscape(txn.reference) : "";
    const number = `FV-${String(index + 1).padStart(4, "0")}`;
    const bankLine = isReceipt
      ? ledgerEntry(bankLedger, true, -amount)
      : ledgerEntry(bankLedger, false, amount);
    const partyLine = isReceipt
      ? ledgerEntry(partyLedger, false, amount)
      : ledgerEntry(partyLedger, true, -amount);
    vouchers.push(`        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${voucherType}" ACTION="Create">
            <DATE>${date}</DATE>
            <VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${number}</VOUCHERNUMBER>
            <NARRATION>${narration}</NARRATION>
            <PARTYLEDGERNAME>${xmlEscape(partyLedger)}</PARTYLEDGERNAME>
            ${reference ? `<REFERENCE>${reference}</REFERENCE>` : ""}
            ${bankLine}
            ${partyLine}
          </VOUCHER>
        </TALLYMESSAGE>`);
  });

  if (errors.length > 0 || vouchers.length !== input.transactions.length) {
    return { ok: false, errors: errors.length > 0 ? errors : ["Voucher count does not match source rows."] };
  }

  const xml = importEnvelope("Vouchers", `${input.createLedgers === false ? "" : `${[...masters.values()].join("\n")}\n`}${vouchers.join("\n")}`, input.tallyCompany);

  const validation = validateTallyVoucherXml(xml, vouchers.length);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const safeName = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
  return {
    ok: true,
    xml,
    mastersXml: importEnvelope("All Masters", [...masters.values()].join("\n"), input.tallyCompany),
    fileName: `${safeName}-bank-vouchers.xml`,
    voucherCount: vouchers.length,
    errors: [],
  };
}

function importEnvelope(report: "Vouchers" | "All Masters", data: string, company?: string) {
  const target = company?.trim()
    ? `\n        <STATICVARIABLES>\n          <SVCURRENTCOMPANY>${xmlEscape(company.trim())}</SVCURRENTCOMPANY>\n        </STATICVARIABLES>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>${report}</REPORTNAME>${target}
      </REQUESTDESC>
      <REQUESTDATA>
${data}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;
}

function ledgerEntry(name: string, deemedPositive: boolean, amount: number) {
  return `<ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(name)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${deemedPositive ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
              <AMOUNT>${money(amount)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>`;
}

export function validateTallyVoucherXml(xml: string, expectedVouchers: number): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!xml.startsWith("<?xml")) errors.push("XML declaration is missing.");
  if (!xml.includes("<ENVELOPE>") || !xml.includes("</ENVELOPE>")) errors.push("ENVELOPE root is missing.");
  if (!xml.includes("<TALLYREQUEST>Import Data</TALLYREQUEST>")) errors.push("Tally import request is missing.");
  const voucherMatches = xml.match(/<VOUCHER\b/g) ?? [];
  if (voucherMatches.length !== expectedVouchers) errors.push(`Expected ${expectedVouchers} vouchers, found ${voucherMatches.length}.`);
  const dates = xml.match(/<DATE>\d{8}<\/DATE>/g) ?? [];
  if (dates.length !== expectedVouchers) errors.push("One or more vouchers have an invalid DATE.");
  const types = xml.match(/<VOUCHERTYPENAME>(Receipt|Payment|Contra)<\/VOUCHERTYPENAME>/g) ?? [];
  if (types.length !== expectedVouchers) errors.push("Voucher type must be Receipt, Payment or Contra.");
  if (xml.includes("<LEDGERNAME></LEDGERNAME>") || xml.includes("<LEDGERNAME> </LEDGERNAME>")) {
    errors.push("A voucher has an empty ledger name.");
  }
  const chunks = xml.split("<VOUCHER ").slice(1);
  chunks.forEach((chunk, index) => {
    const amounts = [...chunk.matchAll(/<AMOUNT>(-?\d+\.\d{2})<\/AMOUNT>/g)].map(match => Number(match[1]));
    if (amounts.length < 2) {
      errors.push(`Voucher ${index + 1} does not have two ledger lines.`);
      return;
    }
    const cents = amounts.map(paise);
    if (cents.some(value => value == null) || cents.reduce<number>((total, value) => total + (value ?? 0), 0) !== 0) errors.push(`Voucher ${index + 1} does not balance to the paise.`);
  });
  return { ok: errors.length === 0, errors };
}
