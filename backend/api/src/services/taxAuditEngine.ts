/**
 * Tax Audit Engine — pure logic, no express/db dependencies.
 * Implements 20 CA ledger-scrutiny / tax-audit checks over Tally-style data.
 * Imported by routes/taxAudit.ts and directly unit-testable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type DrCr = "Dr" | "Cr";
export type VoucherType = "Purchase" | "Sales" | "Receipt" | "Payment" | "Journal" | "Contra" | "Debit Note" | "Credit Note";

export interface Ledger {
  name: string;
  group: string;
  openingBalance: number;     // signed: +Dr / -Cr
  closingBalance: number;     // signed: +Dr / -Cr
  prevYearClosing?: number;
  prevYearGroup?: string;
  isMsme?: boolean;
  msmeType?: "Micro" | "Small" | "Medium" | null;
  pan?: string | null;
}

export interface VoucherLine {
  ledger: string;
  group: string;
  debit: number;
  credit: number;
}

export interface Voucher {
  date: string;
  type: VoucherType;
  number: string;
  party?: string;
  narration?: string;
  amount: number;
  mode?: "Cash" | "Bank" | "Journal";
  lines: VoucherLine[];
}

export interface AssetRow {
  name: string; block: string; rate: number;
  openingWdv: number; additions: number; additionDate?: string;
  deletions: number; deletionDate?: string; depreciation: number; closingWdv: number;
}

export type BillType = "New Ref" | "Agst Ref" | "Advance" | "On Account";

export interface Bill {
  party: string;
  group: string;
  ref: string;          // bill reference (invoice no.)
  date: string;         // ISO yyyy-mm-dd of the original bill
  amount: number;       // positive magnitude; sign derived from type
  type: BillType;
}

export interface CheckResult {
  id: string;
  clause: string;
  title: string;
  category: "Debtors & Creditors" | "Tax Audit Reporting" | "Accounts Finalisation";
  severity: "high" | "medium" | "low" | "info";
  description: string;
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: Record<string, string | number>[];
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Constants — Indian tax-audit thresholds (FY 2025-26)
// ---------------------------------------------------------------------------
export const FY_END = "2026-03-31";
export const LIMIT_269SS = 20000;
export const LIMIT_269ST = 200000;
export const LIMIT_40A3 = 10000;
export const CASH_EXPOSURE_FLAG = 0.05;
export const MSME_DUE_DAYS = 45;

export const DEBTOR_GROUP = "Sundry Debtors";
export const CREDITOR_GROUP = "Sundry Creditors";

// ---------------------------------------------------------------------------
// Embedded demo dataset — realistic Indian SME, exercises every check
// ---------------------------------------------------------------------------
export const DEMO_LEDGERS: Ledger[] = [
  { name: "Brightline Retail Pvt Ltd", group: DEBTOR_GROUP, openingBalance: 240000, closingBalance: -85000, prevYearClosing: 240000 },
  { name: "Orbit Media LLP", group: DEBTOR_GROUP, openingBalance: 120000, closingBalance: 120000, prevYearClosing: 118000 },
  { name: "Sunrise Traders", group: DEBTOR_GROUP, openingBalance: 0, closingBalance: 560000, prevYearClosing: 0 },
  { name: "Zenith Exports", group: DEBTOR_GROUP, openingBalance: 95000, closingBalance: 310000, prevYearClosing: 91000 },
  { name: "Apex Components Pvt Ltd", group: CREDITOR_GROUP, openingBalance: -180000, closingBalance: 42000, prevYearClosing: -180000, isMsme: true, msmeType: "Small" },
  { name: "Metro Logistics", group: CREDITOR_GROUP, openingBalance: -64000, closingBalance: -64000, prevYearClosing: -64000 },
  { name: "Pioneer Supplies", group: CREDITOR_GROUP, openingBalance: -210000, closingBalance: -150000, prevYearClosing: -205000, isMsme: true, msmeType: "Micro" },
  { name: "Galaxy Hardware", group: CREDITOR_GROUP, openingBalance: 0, closingBalance: -88000, prevYearClosing: 0, prevYearGroup: "Sundry Debtors" },
  { name: "Director Loan - R Sharma", group: "Unsecured Loans", openingBalance: -500000, closingBalance: -650000, prevYearClosing: -500000 },
  { name: "ICICI Loan A/c", group: "Loans (Liability)", openingBalance: -1200000, closingBalance: -980000, prevYearClosing: -1200000 },
  { name: "HDFC Bank A/c", group: "Bank Accounts", openingBalance: 850000, closingBalance: 1240000, prevYearClosing: 850000 },
  { name: "Cash-in-Hand", group: "Cash-in-Hand", openingBalance: 65000, closingBalance: 48000, prevYearClosing: 65000 },
  { name: "TDS Payable - 194C", group: "Duties & Taxes", openingBalance: -22000, closingBalance: -41000, prevYearClosing: -22000 },
  { name: "TDS Payable - 194J", group: "Duties & Taxes", openingBalance: -15000, closingBalance: -28000, prevYearClosing: -15000 },
  { name: "TCS Payable", group: "Duties & Taxes", openingBalance: 0, closingBalance: -9500, prevYearClosing: 0 },
  { name: "Output CGST", group: "Duties & Taxes", openingBalance: 0, closingBalance: -310000, prevYearClosing: 0 },
  { name: "Output SGST", group: "Duties & Taxes", openingBalance: 0, closingBalance: -310000, prevYearClosing: 0 },
  { name: "Capital - R Sharma", group: "Capital Account", openingBalance: -2500000, closingBalance: -2980000, prevYearClosing: -2500000 },
  { name: "Capital - A Mehta", group: "Capital Account", openingBalance: -1500000, closingBalance: -1760000, prevYearClosing: -1500000 },
  { name: "Sales A/c", group: "Sales Accounts", openingBalance: 0, closingBalance: -18500000, prevYearClosing: 0 },
  { name: "Purchase A/c", group: "Purchase Accounts", openingBalance: 0, closingBalance: 12200000, prevYearClosing: 0 },
  { name: "Closing Stock", group: "Stock-in-Hand", openingBalance: 1800000, closingBalance: 2150000, prevYearClosing: 1800000 },
  { name: "Salaries", group: "Indirect Expenses", openingBalance: 0, closingBalance: 2640000, prevYearClosing: 0 },
  { name: "Commission Paid", group: "Indirect Expenses", openingBalance: 0, closingBalance: 480000, prevYearClosing: 0 },
  { name: "Rent", group: "Indirect Expenses", openingBalance: 0, closingBalance: 720000, prevYearClosing: 0 },
  { name: "Interest on Unsecured Loans", group: "Indirect Expenses", openingBalance: 0, closingBalance: 96000, prevYearClosing: 0 },
  { name: "Partner Remuneration", group: "Indirect Expenses", openingBalance: 0, closingBalance: 1200000, prevYearClosing: 0 },
  { name: "Partner Interest on Capital", group: "Indirect Expenses", openingBalance: 0, closingBalance: 318000, prevYearClosing: 0 },
];

export const DEMO_VOUCHERS: Voucher[] = [
  { date: "2025-07-12", type: "Receipt", number: "RC-114", party: "Sunrise Traders", amount: 250000, mode: "Cash", narration: "Cash received against invoice", lines: [{ ledger: "Cash-in-Hand", group: "Cash-in-Hand", debit: 250000, credit: 0 }, { ledger: "Sunrise Traders", group: DEBTOR_GROUP, debit: 0, credit: 250000 }] },
  { date: "2025-09-03", type: "Receipt", number: "RC-201", party: "Zenith Exports", amount: 215000, mode: "Cash", narration: "Cash sale settlement", lines: [{ ledger: "Cash-in-Hand", group: "Cash-in-Hand", debit: 215000, credit: 0 }, { ledger: "Zenith Exports", group: DEBTOR_GROUP, debit: 0, credit: 215000 }] },
  { date: "2025-06-20", type: "Receipt", number: "RC-090", party: "Director Loan - R Sharma", amount: 150000, mode: "Cash", narration: "Unsecured loan received in cash", lines: [{ ledger: "Cash-in-Hand", group: "Cash-in-Hand", debit: 150000, credit: 0 }, { ledger: "Director Loan - R Sharma", group: "Unsecured Loans", debit: 0, credit: 150000 }] },
  { date: "2025-11-15", type: "Payment", number: "PY-310", party: "ICICI Loan A/c", amount: 50000, mode: "Cash", narration: "Loan repayment in cash", lines: [{ ledger: "ICICI Loan A/c", group: "Loans (Liability)", debit: 50000, credit: 0 }, { ledger: "Cash-in-Hand", group: "Cash-in-Hand", debit: 0, credit: 50000 }] },
  { date: "2025-08-09", type: "Payment", number: "PY-145", party: "Metro Logistics", amount: 18000, mode: "Cash", narration: "Freight paid cash", lines: [{ ledger: "Metro Logistics", group: CREDITOR_GROUP, debit: 18000, credit: 0 }, { ledger: "Cash-in-Hand", group: "Cash-in-Hand", debit: 0, credit: 18000 }] },
  { date: "2025-10-22", type: "Payment", number: "PY-260", party: "Pioneer Supplies", amount: 24500, mode: "Cash", narration: "Supplies paid cash", lines: [{ ledger: "Pioneer Supplies", group: CREDITOR_GROUP, debit: 24500, credit: 0 }, { ledger: "Cash-in-Hand", group: "Cash-in-Hand", debit: 0, credit: 24500 }] },
  { date: "2025-12-05", type: "Payment", number: "PY-301", party: "Metro Logistics", amount: 12000, mode: "Cash", narration: "Freight paid cash", lines: [{ ledger: "Metro Logistics", group: CREDITOR_GROUP, debit: 12000, credit: 0 }, { ledger: "Cash-in-Hand", group: "Cash-in-Hand", debit: 0, credit: 12000 }] },
  { date: "2025-09-30", type: "Journal", number: "JV-051", party: "Brightline Retail Pvt Ltd", amount: 85000, mode: "Journal", narration: "Balance written back via JV", lines: [{ ledger: "Brightline Retail Pvt Ltd", group: DEBTOR_GROUP, debit: 0, credit: 85000 }, { ledger: "Commission Paid", group: "Indirect Expenses", debit: 85000, credit: 0 }] },
  { date: "2025-12-31", type: "Journal", number: "JV-120", party: "Apex Components Pvt Ltd", amount: 42000, mode: "Journal", narration: "Adjustment JV", lines: [{ ledger: "Apex Components Pvt Ltd", group: CREDITOR_GROUP, debit: 42000, credit: 0 }, { ledger: "Rent", group: "Indirect Expenses", debit: 0, credit: 42000 }] },
  { date: "2025-10-10", type: "Journal", number: "JV-088", party: "Orbit Media LLP", amount: 30000, mode: "Journal", narration: "Purchase booked against debtor", lines: [{ ledger: "Orbit Media LLP", group: DEBTOR_GROUP, debit: 30000, credit: 0 }, { ledger: "Purchase A/c", group: "Purchase Accounts", debit: 0, credit: 30000 }] },
  { date: "2025-11-18", type: "Journal", number: "JV-099", party: "Galaxy Hardware", amount: 27000, mode: "Journal", narration: "Sales booked against creditor", lines: [{ ledger: "Galaxy Hardware", group: CREDITOR_GROUP, debit: 0, credit: 27000 }, { ledger: "Sales A/c", group: "Sales Accounts", debit: 27000, credit: 0 }] },
  { date: "2026-04-08", type: "Journal", number: "JV-Y01", party: "Closing Stock", amount: 350000, mode: "Journal", narration: "Closing stock provision (post year-end)", lines: [{ ledger: "Closing Stock", group: "Stock-in-Hand", debit: 350000, credit: 0 }, { ledger: "Purchase A/c", group: "Purchase Accounts", debit: 0, credit: 350000 }] },
  { date: "2026-05-02", type: "Journal", number: "JV-Y02", party: "Salaries", amount: 120000, mode: "Journal", narration: "Salary provision March (booked May)", lines: [{ ledger: "Salaries", group: "Indirect Expenses", debit: 120000, credit: 0 }, { ledger: "Apex Components Pvt Ltd", group: CREDITOR_GROUP, debit: 0, credit: 120000 }] },
  { date: "2025-05-31", type: "Payment", number: "PY-040", party: "Rent", amount: 60000, mode: "Bank", narration: "Office rent - Landlord A", lines: [{ ledger: "Rent", group: "Indirect Expenses", debit: 60000, credit: 0 }, { ledger: "HDFC Bank A/c", group: "Bank Accounts", debit: 0, credit: 60000 }] },
  { date: "2025-06-30", type: "Payment", number: "PY-070", party: "Commission Paid", amount: 90000, mode: "Bank", narration: "Sales commission - Agent X", lines: [{ ledger: "Commission Paid", group: "Indirect Expenses", debit: 90000, credit: 0 }, { ledger: "HDFC Bank A/c", group: "Bank Accounts", debit: 0, credit: 90000 }] },
];

export const DEMO_ASSETS: AssetRow[] = [
  { name: "Office Building", block: "Building", rate: 10, openingWdv: 4200000, additions: 0, deletions: 0, depreciation: 420000, closingWdv: 3780000 },
  { name: "Plant & Machinery", block: "P&M", rate: 15, openingWdv: 2600000, additions: 800000, additionDate: "2025-08-14", deletions: 150000, deletionDate: "2025-12-01", depreciation: 472500, closingWdv: 2777500 },
  { name: "Computers", block: "Computers", rate: 40, openingWdv: 320000, additions: 240000, additionDate: "2025-10-05", deletions: 0, depreciation: 176000, closingWdv: 384000 },
  { name: "Furniture", block: "Furniture", rate: 10, openingWdv: 480000, additions: 60000, additionDate: "2025-09-20", deletions: 0, depreciation: 51000, closingWdv: 489000 },
];

export const DEMO_BILLS: Bill[] = [
  // Debtors
  { party: "Sunrise Traders", group: DEBTOR_GROUP, ref: "SUN-01", date: "2025-06-10", amount: 560000, type: "New Ref" },
  { party: "Zenith Exports", group: DEBTOR_GROUP, ref: "ZEN-01", date: "2026-01-15", amount: 310000, type: "New Ref" },
  { party: "Orbit Media LLP", group: DEBTOR_GROUP, ref: "ORB-01", date: "2026-03-01", amount: 120000, type: "New Ref" },
  { party: "Brightline Retail Pvt Ltd", group: DEBTOR_GROUP, ref: "BR-01", date: "2025-09-01", amount: 240000, type: "New Ref" },
  { party: "Brightline Retail Pvt Ltd", group: DEBTOR_GROUP, ref: "BR-01", date: "2025-12-01", amount: 325000, type: "Agst Ref" }, // overpaid -> credit balance
  // Creditors
  { party: "Pioneer Supplies", group: CREDITOR_GROUP, ref: "PIO-01", date: "2025-08-01", amount: 210000, type: "New Ref" },
  { party: "Pioneer Supplies", group: CREDITOR_GROUP, ref: "PIO-01", date: "2025-11-20", amount: 60000, type: "Agst Ref" },
  { party: "Metro Logistics", group: CREDITOR_GROUP, ref: "MET-01", date: "2025-05-01", amount: 64000, type: "New Ref" },
  { party: "Galaxy Hardware", group: CREDITOR_GROUP, ref: "GAL-01", date: "2026-01-20", amount: 88000, type: "New Ref" },
  { party: "Apex Components Pvt Ltd", group: CREDITOR_GROUP, ref: "APX-01", date: "2026-02-10", amount: 42000, type: "Advance" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const r2 = (n: number) => Math.round(n * 100) / 100;

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso), b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

function ageBucket(days: number): string {
  if (days <= 0) return "Not due";
  if (days <= 30) return "0-30 days";
  if (days <= 60) return "31-60 days";
  if (days <= 90) return "61-90 days";
  if (days <= 180) return "91-180 days";
  return ">180 days";
}
const isDebtor = (l: Ledger) => l.group === DEBTOR_GROUP;
const isCreditor = (l: Ledger) => l.group === CREDITOR_GROUP;
const drcr = (signed: number): DrCr => (signed >= 0 ? "Dr" : "Cr");
function lineGroups(v: Voucher) { return new Set(v.lines.map(l => l.group)); }

// ---------------------------------------------------------------------------
// The 20 checks
// ---------------------------------------------------------------------------
export function buildChecks(ledgers: Ledger[], vouchers: Voucher[], assets: AssetRow[], bills: Bill[] = []): CheckResult[] {
  const checks: CheckResult[] = [];

  // A1 — Negative ledger balances
  {
    const rows = ledgers
      .filter(l => (isDebtor(l) && l.closingBalance < 0) || (isCreditor(l) && l.closingBalance > 0))
      .map(l => ({ ledger: l.name, group: l.group, balance: r2(Math.abs(l.closingBalance)), nature: drcr(l.closingBalance), issue: isDebtor(l) ? "Debtor with credit balance" : "Creditor with debit balance" }));
    checks.push({ id: "neg-balances", clause: "Scrutiny", title: "Negative Ledger Balances", category: "Debtors & Creditors", severity: rows.length ? "high" : "info",
      description: "Debtors carrying credit balances and creditors carrying debit balances — usually advances, wrong postings, or netting errors.",
      columns: [{ key: "ledger", label: "Ledger" }, { key: "group", label: "Group" }, { key: "balance", label: "Closing Balance", numeric: true }, { key: "nature", label: "Dr/Cr" }, { key: "issue", label: "Issue" }], rows });
  }

  // A2 — Same opening & closing balance
  {
    const rows = ledgers
      .filter(l => (isDebtor(l) || isCreditor(l)) && l.openingBalance === l.closingBalance && l.closingBalance !== 0)
      .map(l => ({ ledger: l.name, group: l.group, opening: r2(Math.abs(l.openingBalance)), closing: r2(Math.abs(l.closingBalance)), nature: drcr(l.closingBalance) }));
    checks.push({ id: "same-op-cl", clause: "Scrutiny", title: "Same Opening & Closing Balance", category: "Debtors & Creditors", severity: rows.length ? "medium" : "info",
      description: "Parties with identical opening and closing balances — no movement during the year. Often dormant or disputed accounts needing confirmation.",
      columns: [{ key: "ledger", label: "Ledger" }, { key: "group", label: "Group" }, { key: "opening", label: "Opening", numeric: true }, { key: "closing", label: "Closing", numeric: true }, { key: "nature", label: "Dr/Cr" }], rows });
  }

  // A3 — Debtors / Creditors ageing
  if (bills.length > 0) {
    // Bill-wise ageing: net each reference (New Ref/Advance positive, Agst Ref negative),
    // then age the outstanding amount from the original bill date to year-end.
    const byRef = new Map<string, { party: string; group: string; ref: string; date: string; outstanding: number }>();
    for (const b of bills) {
      const key = `${b.party}::${b.ref}`;
      const signed = b.type === "Agst Ref" ? -b.amount : b.amount;
      const existing = byRef.get(key);
      if (existing) {
        existing.outstanding += signed;
        if (b.type !== "Agst Ref" && b.date < existing.date) existing.date = b.date; // earliest original bill date
      } else {
        byRef.set(key, { party: b.party, group: b.group, ref: b.ref, date: b.date, outstanding: signed });
      }
    }
    const rows = [...byRef.values()]
      .filter(r => Math.abs(r.outstanding) >= 1)
      .map(r => {
        const days = daysBetween(r.date, FY_END);
        return { party: r.party, group: r.group, ref: r.ref, billDate: r.date, days, outstanding: r2(Math.abs(r.outstanding)), nature: r.outstanding >= 0 ? (isDebtor({ group: r.group } as Ledger) ? "Dr" : "Cr") : "(reverse)", bucket: ageBucket(days) };
      })
      .sort((a, b) => b.days - a.days);
    checks.push({ id: "ageing", clause: "Scrutiny", title: "Debtors & Creditors Ageing (Bill-wise)", category: "Debtors & Creditors", severity: rows.some(r => r.bucket === ">180 days") ? "medium" : "info",
      description: "Bill-wise outstanding aged from the original bill date to year-end. Balances over 180 days need confirmation or provisioning.",
      columns: [{ key: "party", label: "Party" }, { key: "group", label: "Group" }, { key: "ref", label: "Bill Ref" }, { key: "billDate", label: "Bill Date" }, { key: "days", label: "Days", numeric: true }, { key: "outstanding", label: "Outstanding", numeric: true }, { key: "bucket", label: "Ageing Bucket" }], rows });
  } else {
    // Fallback (no bill-wise data imported): age by ledger balance + movement heuristic.
    const rows = ledgers.filter(l => isDebtor(l) || isCreditor(l)).map(l => {
      const bal = Math.abs(l.closingBalance);
      const moved = l.openingBalance !== l.closingBalance;
      return { ledger: l.name, group: l.group, balance: r2(bal), bucket: bal === 0 ? "Nil" : moved ? "0-90 days" : ">180 days", nature: drcr(l.closingBalance) };
    }).filter(r => r.balance > 0);
    checks.push({ id: "ageing", clause: "Scrutiny", title: "Debtors & Creditors Ageing", category: "Debtors & Creditors", severity: "info",
      description: "Outstanding balances bucketed by age (ledger-level estimate — import bill-wise details for exact ageing).",
      columns: [{ key: "ledger", label: "Ledger" }, { key: "group", label: "Group" }, { key: "balance", label: "Balance", numeric: true }, { key: "bucket", label: "Ageing Bucket" }, { key: "nature", label: "Dr/Cr" }], rows });
  }

  // A4 — Debtors/creditors with JV (non purchase/sale/cash/bank) entries
  {
    const partySet = new Set(ledgers.filter(l => isDebtor(l) || isCreditor(l)).map(l => l.name));
    const rows = vouchers.filter(v => v.type === "Journal" && v.lines.some(l => partySet.has(l.ledger)))
      .flatMap(v => v.lines.filter(l => partySet.has(l.ledger)).map(l => ({ date: v.date, voucher: v.number, ledger: l.ledger, group: l.group, amount: r2(l.debit || l.credit), narration: v.narration ?? "" })));
    checks.push({ id: "party-jv", clause: "Scrutiny", title: "Party Ledgers with Journal Entries", category: "Debtors & Creditors", severity: rows.length ? "medium" : "info",
      description: "Debtors/creditors adjusted through Journal Vouchers (not Purchase/Sales/Cash/Bank). These bypass the normal trade cycle and warrant scrutiny.",
      columns: [{ key: "date", label: "Date" }, { key: "voucher", label: "Voucher" }, { key: "ledger", label: "Party" }, { key: "group", label: "Group" }, { key: "amount", label: "Amount", numeric: true }, { key: "narration", label: "Narration" }], rows });
  }

  // A5 — Debtors hit by Purchase ledger / Creditors hit by Sales ledger
  {
    const debtorNames = new Set(ledgers.filter(isDebtor).map(l => l.name));
    const creditorNames = new Set(ledgers.filter(isCreditor).map(l => l.name));
    const rows = vouchers.flatMap(v => {
      const groups = lineGroups(v);
      const out: Record<string, string | number>[] = [];
      for (const l of v.lines) {
        if (debtorNames.has(l.ledger) && groups.has("Purchase Accounts")) out.push({ date: v.date, voucher: v.number, party: l.ledger, partyType: "Debtor", hitBy: "Purchase A/c", amount: r2(l.debit || l.credit) });
        if (creditorNames.has(l.ledger) && groups.has("Sales Accounts")) out.push({ date: v.date, voucher: v.number, party: l.ledger, partyType: "Creditor", hitBy: "Sales A/c", amount: r2(l.debit || l.credit) });
      }
      return out;
    });
    checks.push({ id: "cross-posting", clause: "Scrutiny", title: "Debtor↔Purchase / Creditor↔Sales Cross-Postings", category: "Debtors & Creditors", severity: rows.length ? "high" : "info",
      description: "Debtors hit by a Purchase ledger or creditors hit by a Sales ledger — classic mis-posting that distorts turnover and party balances.",
      columns: [{ key: "date", label: "Date" }, { key: "voucher", label: "Voucher" }, { key: "party", label: "Party" }, { key: "partyType", label: "Type" }, { key: "hitBy", label: "Hit By" }, { key: "amount", label: "Amount", numeric: true }], rows });
  }

  // B1 — Clause 31: 269SS & 269T
  {
    const loanGroups = new Set(["Unsecured Loans", "Loans (Liability)", "Secured Loans"]);
    const rows = vouchers.filter(v => v.mode === "Cash" && v.lines.some(l => loanGroups.has(l.group)) && v.amount >= LIMIT_269SS)
      .map(v => {
        const accepted = v.type === "Receipt";
        return { date: v.date, voucher: v.number, party: v.party ?? "", section: accepted ? "269SS (accepted)" : "269T (repaid)", mode: v.mode ?? "", amount: r2(v.amount) };
      });
    checks.push({ id: "clause-31", clause: "Clause 31", title: "269SS & 269T — Loans/Deposits in Cash", category: "Tax Audit Reporting", severity: rows.length ? "high" : "info",
      description: `Loans/deposits accepted (269SS) or repaid (269T) otherwise than by account-payee instrument and ≥ ₹${LIMIT_269SS.toLocaleString("en-IN")}. Reportable under Clause 31.`,
      columns: [{ key: "date", label: "Date" }, { key: "voucher", label: "Voucher" }, { key: "party", label: "Party" }, { key: "section", label: "Section" }, { key: "mode", label: "Mode" }, { key: "amount", label: "Amount", numeric: true }], rows });
  }

  // B2 — 269ST: cash receipts >= 2L
  {
    const rows = vouchers.filter(v => v.mode === "Cash" && (v.type === "Receipt" || v.type === "Sales") && v.amount >= LIMIT_269ST && !v.lines.some(l => l.group === "Capital Account"))
      .map(v => ({ date: v.date, voucher: v.number, party: v.party ?? "", amount: r2(v.amount), narration: v.narration ?? "" }));
    checks.push({ id: "sec-269st", clause: "269ST", title: "Cash Receipts ≥ ₹2,00,000", category: "Tax Audit Reporting", severity: rows.length ? "high" : "info",
      description: "Single cash receipts of ₹2 lakh or more (excluding capital-account transactions). Attracts penalty u/s 271DA equal to the amount received.",
      columns: [{ key: "date", label: "Date" }, { key: "voucher", label: "Voucher" }, { key: "party", label: "Party" }, { key: "amount", label: "Amount", numeric: true }, { key: "narration", label: "Narration" }], rows });
  }

  // B3 — Clause 40: ratio analysis
  {
    const find = (n: string) => ledgers.find(l => l.name === n)?.closingBalance ?? 0;
    const sales = Math.abs(find("Sales A/c"));
    const purchases = Math.abs(find("Purchase A/c"));
    const closingStock = Math.abs(find("Closing Stock"));
    const openingStock = Math.abs(ledgers.find(l => l.name === "Closing Stock")?.openingBalance ?? 0);
    const indirectExp = ledgers.filter(l => l.group === "Indirect Expenses").reduce((s, l) => s + Math.abs(l.closingBalance), 0);
    const cogs = openingStock + purchases - closingStock;
    const grossProfit = sales - cogs;
    const netProfit = grossProfit - indirectExp;
    const avgStock = (openingStock + closingStock) / 2 || 1;
    const rows = [
      { ratio: "Gross Profit / Turnover", value: r2((grossProfit / (sales || 1)) * 100), unit: "%", basis: `GP ${r2(grossProfit)} / Sales ${r2(sales)}` },
      { ratio: "Net Profit / Turnover", value: r2((netProfit / (sales || 1)) * 100), unit: "%", basis: `NP ${r2(netProfit)} / Sales ${r2(sales)}` },
      { ratio: "Stock Turnover (times)", value: r2(cogs / avgStock), unit: "x", basis: `COGS ${r2(cogs)} / Avg Stock ${r2(avgStock)}` },
      { ratio: "Material Consumed / Turnover", value: r2((purchases / (sales || 1)) * 100), unit: "%", basis: `Purchases ${r2(purchases)} / Sales ${r2(sales)}` },
    ];
    checks.push({ id: "clause-40", clause: "Clause 40", title: "Ratio Analysis", category: "Tax Audit Reporting", severity: "info",
      description: "Accounting ratios required under Clause 40 — GP ratio, NP ratio, stock turnover and material consumption, with year-on-year comparison.",
      columns: [{ key: "ratio", label: "Ratio" }, { key: "value", label: "Value", numeric: true }, { key: "unit", label: "Unit" }, { key: "basis", label: "Basis" }], rows });
  }

  // B4 — Clause 23: material expenses party-wise
  {
    const materialLedgers = ["Salaries", "Commission Paid", "Rent", "Interest on Unsecured Loans", "Partner Remuneration", "Partner Interest on Capital"];
    const rows = materialLedgers.map(name => {
      const l = ledgers.find(x => x.name === name);
      return l ? { expense: name, amount: r2(Math.abs(l.closingBalance)), group: l.group } : null;
    }).filter(Boolean) as Record<string, string | number>[];
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    rows.forEach(r => { r.materiality = `${r2((Number(r.amount) / (total || 1)) * 100)}%`; });
    checks.push({ id: "clause-23", clause: "Clause 23", title: "Material Expenses (Party-wise)", category: "Tax Audit Reporting", severity: "info",
      description: "Specified expenses — salary, commission, rent, partner remuneration/interest, interest on unsecured loans — with materiality, to support Clause 23 (payments to specified persons u/s 40A(2)(b)).",
      columns: [{ key: "expense", label: "Expense Head" }, { key: "group", label: "Group" }, { key: "amount", label: "Amount", numeric: true }, { key: "materiality", label: "% of Material Exp" }], rows });
  }

  // B5 — Cash Exposure Ratio
  {
    const cashLedger = "Cash-in-Hand";
    let cashCr = 0, cashDr = 0;
    for (const v of vouchers) for (const l of v.lines) if (l.ledger === cashLedger) { cashCr += l.credit; cashDr += l.debit; }
    const totalPayments = vouchers.filter(v => v.type === "Payment").reduce((s, v) => s + v.amount, 0) || 1;
    const totalReceipts = vouchers.filter(v => v.type === "Receipt" || v.type === "Sales").reduce((s, v) => s + v.amount, 0) || 1;
    const payRatio = (cashCr / totalPayments) * 100;
    const recRatio = (cashDr / totalReceipts) * 100;
    const rows = [
      { metric: "Cash Payments / Total Payments", ratio: r2(payRatio), flag: payRatio > CASH_EXPOSURE_FLAG * 100 ? "⚠ Exceeds 5%" : "OK", basis: `Cash Cr ${r2(cashCr)} / Payments ${r2(totalPayments)}` },
      { metric: "Cash Receipts / Total Receipts", ratio: r2(recRatio), flag: recRatio > CASH_EXPOSURE_FLAG * 100 ? "⚠ Exceeds 5%" : "OK", basis: `Cash Dr ${r2(cashDr)} / Receipts ${r2(totalReceipts)}` },
    ];
    checks.push({ id: "cash-exposure", clause: "Tax Audit", title: "Cash Exposure Ratio", category: "Tax Audit Reporting", severity: rows.some(r => String(r.flag).includes("⚠")) ? "high" : "info",
      description: "Cash component of total payments and receipts. A ratio above 5% signals heavy cash dealing relevant to tax-audit applicability and 44AD/44AB analysis.",
      columns: [{ key: "metric", label: "Metric" }, { key: "ratio", label: "Ratio %", numeric: true }, { key: "flag", label: "Flag" }, { key: "basis", label: "Basis" }], rows });
  }

  // B6 — Creditors with opening balance AND cash payments > 10k
  {
    const creditorOpening = new Map(ledgers.filter(isCreditor).map(l => [l.name, l.openingBalance]));
    const cashPayByParty = new Map<string, number>();
    for (const v of vouchers) if (v.type === "Payment" && v.mode === "Cash" && v.party) {
      if (v.lines.some(l => l.group === CREDITOR_GROUP)) cashPayByParty.set(v.party, (cashPayByParty.get(v.party) ?? 0) + v.amount);
    }
    const rows = [...cashPayByParty.entries()].filter(([party, amt]) => creditorOpening.has(party) && creditorOpening.get(party) !== 0 && amt > LIMIT_40A3)
      .map(([party, amt]) => ({ party, openingBalance: r2(Math.abs(creditorOpening.get(party) ?? 0)), cashPaid: r2(amt) }));
    checks.push({ id: "creditor-op-cash", clause: "40A(3)", title: "Creditors with Opening Balance & Cash Payments > ₹10k", category: "Tax Audit Reporting", severity: rows.length ? "high" : "info",
      description: "Creditors carrying an opening balance to whom cash payments above ₹10,000 were made — potential 40A(3) disallowance and carry-forward scrutiny.",
      columns: [{ key: "party", label: "Creditor" }, { key: "openingBalance", label: "Opening Balance", numeric: true }, { key: "cashPaid", label: "Cash Paid", numeric: true }], rows });
  }

  // B7 — Creditors with cash payments > 10k during year
  {
    const cashPayByParty = new Map<string, number>();
    for (const v of vouchers) if (v.type === "Payment" && v.mode === "Cash" && v.party && v.lines.some(l => l.group === CREDITOR_GROUP)) {
      cashPayByParty.set(v.party, (cashPayByParty.get(v.party) ?? 0) + v.amount);
    }
    const rows = [...cashPayByParty.entries()].filter(([, amt]) => amt > LIMIT_40A3).map(([party, amt]) => ({ party, cashPaid: r2(amt), risk: "40A(3) disallowance" }));
    checks.push({ id: "creditor-cash", clause: "40A(3)", title: "Creditors — Cash Payments > ₹10k During Year", category: "Tax Audit Reporting", severity: rows.length ? "high" : "info",
      description: "All creditors to whom aggregate cash payments above ₹10,000 were made in the year (single-day limit u/s 40A(3)).",
      columns: [{ key: "party", label: "Creditor" }, { key: "cashPaid", label: "Cash Paid", numeric: true }, { key: "risk", label: "Risk" }], rows });
  }

  // B8 — Clause 44: GST breakup of expenditure
  {
    const totalExp = ledgers.filter(l => l.group === "Indirect Expenses" || l.group === "Purchase Accounts").reduce((s, l) => s + Math.abs(l.closingBalance), 0);
    const gstExp = Math.abs(ledgers.find(l => l.name === "Purchase A/c")?.closingBalance ?? 0);
    const nonGstExp = totalExp - gstExp;
    const rows = [
      { head: "Total expenditure", amount: r2(totalExp) },
      { head: "Expenditure to GST-registered (goods/services)", amount: r2(gstExp) },
      { head: "Expenditure relating to entities not registered under GST", amount: r2(nonGstExp) },
      { head: "Expenditure under composition scheme", amount: 0 },
      { head: "Expenditure exempt from GST", amount: 0 },
    ];
    checks.push({ id: "clause-44", clause: "Clause 44", title: "GST Break-up of Expenditure", category: "Tax Audit Reporting", severity: "info",
      description: "Clause 44 break-up of total expenditure into GST-registered, unregistered, composition and exempt buckets.",
      columns: [{ key: "head", label: "Expenditure Head" }, { key: "amount", label: "Amount", numeric: true }], rows });
  }

  // B9 — Clause 22: MSME
  {
    const rows = ledgers.filter(l => isCreditor(l) && l.isMsme).map(l => ({ creditor: l.name, msmeType: l.msmeType ?? "—", outstanding: r2(Math.abs(l.closingBalance)), status: drcr(l.closingBalance) === "Cr" ? "Payable" : "Advance", dueBeyond45: drcr(l.closingBalance) === "Cr" ? "Verify against bill date" : "—" }));
    checks.push({ id: "clause-22", clause: "Clause 22", title: "MSME Creditors (Sec 43B(h))", category: "Tax Audit Reporting", severity: rows.length ? "medium" : "info",
      description: "Creditors flagged as Micro/Small enterprises under MSMED Act. Amounts outstanding beyond 45 days are disallowed u/s 43B(h) until paid.",
      columns: [{ key: "creditor", label: "Creditor" }, { key: "msmeType", label: "MSME Type" }, { key: "outstanding", label: "Outstanding", numeric: true }, { key: "status", label: "Status" }, { key: "dueBeyond45", label: ">45 days" }], rows,
      notes: [`MSME payments overdue beyond ${MSME_DUE_DAYS} days are disallowed until actually paid.`] });
  }

  // B10 — Clause 18: Depreciation (asset-wise + additions/deletions)
  {
    const rows = assets.map(a => ({
      asset: a.name, block: a.block, rate: `${a.rate}%`, openingWdv: r2(a.openingWdv),
      additions: r2(a.additions), additionDate: a.additionDate ?? "—", deletions: r2(a.deletions), deletionDate: a.deletionDate ?? "—",
      depreciation: r2(a.depreciation), closingWdv: r2(a.closingWdv),
    }));
    checks.push({ id: "clause-18", clause: "Clause 18", title: "Depreciation — Asset-wise (Additions & Deletions)", category: "Tax Audit Reporting", severity: "info",
      description: "Block-wise depreciation with additions and deletions (with dates) on a single screen — supports Clause 18 and the depreciation schedule.",
      columns: [
        { key: "asset", label: "Asset" }, { key: "block", label: "Block" }, { key: "rate", label: "Rate" }, { key: "openingWdv", label: "Opening WDV", numeric: true },
        { key: "additions", label: "Additions", numeric: true }, { key: "additionDate", label: "Add Date" }, { key: "deletions", label: "Deletions", numeric: true }, { key: "deletionDate", label: "Del Date" },
        { key: "depreciation", label: "Depreciation", numeric: true }, { key: "closingWdv", label: "Closing WDV", numeric: true },
      ], rows });
  }

  // C1 — Opening / closing balance mismatch (PY close vs CY open)
  {
    const rows = ledgers.filter(l => l.prevYearClosing != null && l.prevYearClosing !== l.openingBalance)
      .map(l => ({ ledger: l.name, group: l.group, pyClosing: r2(Math.abs(l.prevYearClosing!)), cyOpening: r2(Math.abs(l.openingBalance)), difference: r2(Math.abs((l.prevYearClosing ?? 0) - l.openingBalance)) }));
    checks.push({ id: "op-cl-mismatch", clause: "Finalisation", title: "Opening vs Prior-Year Closing Mismatch", category: "Accounts Finalisation", severity: rows.length ? "high" : "info",
      description: "Ledgers where the current-year opening balance does not match last year's audited closing balance — indicates restatement or data corruption.",
      columns: [{ key: "ledger", label: "Ledger" }, { key: "group", label: "Group" }, { key: "pyClosing", label: "PY Closing", numeric: true }, { key: "cyOpening", label: "CY Opening", numeric: true }, { key: "difference", label: "Difference", numeric: true }], rows });
  }

  // C2 — Partner dashboard
  {
    const partners = ledgers.filter(l => l.group === "Capital Account");
    const remunTotal = Math.abs(ledgers.find(l => l.name === "Partner Remuneration")?.closingBalance ?? 0);
    const interestTotal = Math.abs(ledgers.find(l => l.name === "Partner Interest on Capital")?.closingBalance ?? 0);
    const totalOpening = partners.reduce((s, x) => s + Math.abs(x.openingBalance), 0) || 1;
    const rows = partners.map(p => {
      const opening = Math.abs(p.openingBalance);
      const closing = Math.abs(p.closingBalance);
      const share = opening / totalOpening;
      return { partner: p.name.replace("Capital - ", ""), openingCapital: r2(opening), interest: r2(interestTotal * share), remuneration: r2(remunTotal * share), profitShare: r2(closing - opening), closingCapital: r2(closing) };
    });
    checks.push({ id: "partner-dashboard", clause: "Finalisation", title: "Partner Capital Dashboard", category: "Accounts Finalisation", severity: "info",
      description: "Partner-wise opening capital, interest on capital, remuneration, profit share and closing capital — in one table for finalisation.",
      columns: [{ key: "partner", label: "Partner" }, { key: "openingCapital", label: "Opening Capital", numeric: true }, { key: "interest", label: "Interest", numeric: true }, { key: "remuneration", label: "Remuneration", numeric: true }, { key: "profitShare", label: "Profit Share / Drawings", numeric: true }, { key: "closingCapital", label: "Closing Capital", numeric: true }], rows });
  }

  // C3 — TDS/TCS dashboard
  {
    const rows = ledgers.filter(l => l.group === "Duties & Taxes" && /TDS|TCS/i.test(l.name))
      .map(l => ({ ledger: l.name, type: /TCS/i.test(l.name) ? "TCS" : "TDS", opening: r2(Math.abs(l.openingBalance)), closing: r2(Math.abs(l.closingBalance)), nature: drcr(l.closingBalance) }));
    checks.push({ id: "tds-tcs", clause: "Finalisation", title: "TDS / TCS Dashboard", category: "Accounts Finalisation", severity: "info",
      description: "All ledgers impacted by TDS/TCS payable, with opening and closing balances — to reconcile against returns (26Q/27EQ) and challans.",
      columns: [{ key: "ledger", label: "Ledger" }, { key: "type", label: "Type" }, { key: "opening", label: "Opening", numeric: true }, { key: "closing", label: "Closing", numeric: true }, { key: "nature", label: "Dr/Cr" }], rows });
  }

  // C4 — Grouping mismatch (LY vs CY)
  {
    const rows = ledgers.filter(l => l.prevYearGroup && l.prevYearGroup !== l.group)
      .map(l => ({ ledger: l.name, prevYearGroup: l.prevYearGroup ?? "", currentGroup: l.group, impact: "Regrouped — verify reclassification" }));
    checks.push({ id: "grouping-mismatch", clause: "Finalisation", title: "Grouping Mismatch (LY vs CY)", category: "Accounts Finalisation", severity: rows.length ? "medium" : "info",
      description: "Ledgers whose group changed between last year and current year — affects comparatives and schedule mapping.",
      columns: [{ key: "ledger", label: "Ledger" }, { key: "prevYearGroup", label: "Last-Year Group" }, { key: "currentGroup", label: "Current Group" }, { key: "impact", label: "Impact" }], rows });
  }

  // C5 — JV after 31 March
  {
    const rows = vouchers.filter(v => v.type === "Journal" && v.date > FY_END)
      .map(v => ({ date: v.date, voucher: v.number, party: v.party ?? "", amount: r2(v.amount), narration: v.narration ?? "" }));
    checks.push({ id: "post-yearend-jv", clause: "Finalisation", title: "Journal Vouchers After 31 March", category: "Accounts Finalisation", severity: rows.length ? "medium" : "info",
      description: "Year-end adjustment journals passed after 31 March — the finalisation entries. Captured on one screen to carry forward as next year's known adjustments.",
      columns: [{ key: "date", label: "Date" }, { key: "voucher", label: "Voucher" }, { key: "party", label: "Account" }, { key: "amount", label: "Amount", numeric: true }, { key: "narration", label: "Narration" }], rows });
  }

  return checks;
}
