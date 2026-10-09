/**
 * Tally voucher XML for bank statement import.
 * Receipt when money enters the bank. Payment when money leaves the bank.
 * Amounts follow the public Tally convention: debit lines are negative with ISDEEMEDPOSITIVE Yes.
 */

import type { NormalizedBankTxn } from "./bankStatement";

export interface LedgerMapping {
  counterparty: string;
  ledgerName: string;
}

export interface TallyXmlInput {
  companyName: string;
  bankLedger: string;
  transactions: NormalizedBankTxn[];
  mappings?: LedgerMapping[];
  /** Adds create-only ledger masters so the import does not stop on a missing ledger. Existing ledgers are left untouched. */
  createLedgers?: boolean;
  bankGroup?: "Bank Accounts" | "Current Assets";
}

export interface TallyXmlResult {
  ok: boolean;
  xml?: string;
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
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
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
  "Fixed Deposits",
  "Insurance Premium",
  "Loan Account",
  "GST Payable",
  "TDS Payable",
  "Income Tax",
  "Payment Gateway Settlements",
  "Marketplace Settlements",
  "Cash",
  "Capital A/c",
  "Drawings",
  "Suspense",
] as const;

const LEDGER_RULES: Array<[RegExp, string]> = [
  [/salary|salaries|payroll|wages/, "Salary Expenses"],
  [/razorpay|cashfree|payu|ccavenue|paytm pg|stripe|phonepe pg|billdesk/, "Payment Gateway Settlements"],
  [/amazon seller|flipkart|meesho|myntra|jiomart|ajio|snapdeal|glowroad/, "Marketplace Settlements"],
  [/\brent\b|lease/, "Rent"],
  [/electricity|bescom|msedcl|tata power|adani elec|power bill|bses/, "Electricity Expenses"],
  [/airtel|jio|vodafone|\bvi\b|bsnl|broadband|internet|mobile bill/, "Telephone & Internet"],
  [/facebook|meta ads|google ads|advert|marketing/, "Advertisement Expenses"],
  [/google|workspace|aws|amazon web|microsoft|zoho|adobe|github|atlassian|slack|notion|software|saas/, "Software Expenses"],
  [/\bca fees|consult|professional|legal|audit fee/, "Professional Fees"],
  [/\buber\b|\bola\b|irctc|makemytrip|indigo|air india|vistara|travel|hotel/, "Travelling Expenses"],
  [/charges|chrg|chgs|sms alert|annual fee|gst on charges|commission/, "Bank Charges"],
  [/\bfd\b|fixed deposit|term deposit|\btd\b.*(maturity|booking|closure)/, "Fixed Deposits"],
  [/insurance|\blic\b|premium|(hdfc|sbi|kotak mahindra|max|bajaj allianz|tata aia|aditya birla sun|pnb met|star health) ?life|icici pru/, "Insurance Premium"],
  [/\bemi\b|loan|nach.*finance/, "Loan Account"],
  [/\bgst\b|gstn|cbic|gst challan/, "GST Payable"],
  [/\btds\b|26q|24q|tin-nsdl/, "TDS Payable"],
  [/income tax|advance tax|itns|\bitd\b/, "Income Tax"],
  [/\batm\b|cash wdl|cash withdrawal|self/, "Cash"],
];

/** Interest the bank pays you ("Int.Pd", "Credit Interest") versus interest you pay on a loan. */
const INTEREST = /\bint\.?\s*(pd|paid|cr|credit)\b|interest|\bsb\s*int\b|loan\s*int\b/;

export function suggestLedger(narration: string, mappings: LedgerMapping[] = [], direction?: "in" | "out") {
  const text = narration.toLowerCase();
  const remembered = mappings.find(mapping => mapping.counterparty && text.includes(mapping.counterparty.toLowerCase()));
  if (remembered) return remembered.ledgerName;
  if (INTEREST.test(text)) return direction === "out" ? "Interest Paid" : "Interest Received";
  for (const [pattern, ledger] of LEDGER_RULES) {
    if (pattern.test(text)) return ledger;
  }
  return "Suspense";
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
  "Fixed Deposits": "Investments",
  "Insurance Premium": "Indirect Expenses",
  "Loan Account": "Loans (Liability)",
  "GST Payable": "Duties & Taxes",
  "TDS Payable": "Duties & Taxes",
  "Income Tax": "Loans & Advances (Asset)",
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

export function resolveLedger(txn: NormalizedBankTxn, mappings: LedgerMapping[] = []): { name: string; group: string | null } {
  const narration = txn.narration || txn.description;
  const text = narration.toLowerCase();
  const key = partyKey(txn).toLowerCase();
  const remembered = mappings.find(mapping => mapping.counterparty && mapping.counterparty.toLowerCase() === key)
    ?? mappings.find(mapping => mapping.counterparty && text.includes(mapping.counterparty.toLowerCase()));
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
    if (amount == null || amount <= 0) {
      errors.push(`Row ${txn.rowNumber}: amount is missing.`);
      return;
    }
    if (txn.debit != null && txn.credit != null) {
      errors.push(`Row ${txn.rowNumber}: both debit and credit are set.`);
      return;
    }
    const isReceipt = txn.credit != null && txn.credit > 0;
    const voucherType = isReceipt ? "Receipt" : "Payment";
    const resolved = resolveLedger(txn, input.mappings);
    const partyLedger = resolved.name;
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

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
${input.createLedgers === false ? "" : `${[...masters.values()].join("\n")}\n`}${vouchers.join("\n")}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;

  const validation = validateTallyVoucherXml(xml, vouchers.length);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const safeName = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
  return { ok: true, xml, fileName: `${safeName}-bank-vouchers.xml`, voucherCount: vouchers.length, errors: [] };
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
  const types = xml.match(/<VOUCHERTYPENAME>(Receipt|Payment)<\/VOUCHERTYPENAME>/g) ?? [];
  if (types.length !== expectedVouchers) errors.push("Voucher type must be Receipt or Payment.");
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
    const sum = Math.round(amounts.reduce((total, value) => total + value, 0) * 100) / 100;
    if (sum !== 0) errors.push(`Voucher ${index + 1} does not balance (${sum}).`);
  });
  return { ok: errors.length === 0, errors };
}
