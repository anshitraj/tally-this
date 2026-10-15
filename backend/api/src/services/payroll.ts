/**
 * Payroll: a salary sheet in, a register with the employer's details, the statutory working,
 * a check against the bank, and a Tally journal out.
 *
 * Every figure comes from the sheet. Contribution percentages are used only to CHECK what the
 * sheet shows and to fill a column the sheet does not have; each such figure is labelled
 * "computed". Nothing here files a return or decides a tax; the CA does. Money is paise.
 */
import ExcelJS from "exceljs";
import { headerKey, textCell, toPaise, type Cell, type Table } from "./gstrRecon";
import type { NormalizedBankTxn } from "./bankStatement";

/** The employer, as printed on the register and needed for PF, ESI and TDS filings. */
export interface EmployerProfile {
  name: string;
  address?: string;
  pan?: string;
  tan?: string;
  gstin?: string;
  pfCode?: string;
  esiCode?: string;
  ptRegistration?: string;
  state?: string;
}

export const PF_WAGE_CEILING = 15000_00;
export const ESI_GROSS_LIMIT = 21000_00;

export interface Employee {
  row: number;
  code: string;
  name: string;
  designation: string;
  uan: string;
  esicNumber: string;
  pan: string;
  account: string;
  ifsc: string;
  paidDays: number | null;
  basic: number;
  /** Basic plus dearness allowance: the wage PF is worked on. */
  pfWage: number;
  /** Every earning column, by its heading. */
  earnings: Array<{ head: string; amount: number }>;
  gross: number;
  pf: number;
  esi: number;
  pt: number;
  tds: number;
  otherDeductions: Array<{ head: string; amount: number }>;
  deductions: number;
  net: number;
  /** The employer's own PF and ESI contribution when the sheet shows it. */
  employerPf: number | null;
  employerEsi: number | null;
  flags: string[];
  blocked: boolean;
}

export interface PayrollRead {
  employer: string;
  month: string | null;
  employees: Employee[];
  earningHeads: string[];
  deductionHeads: string[];
  notes: string[];
}

const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

interface Role {
  field: string;
  test: RegExp;
}

// First match wins; the order is the order of the checks.
const ROLES: Role[] = [
  { field: "uan", test: /\buan\b|universal account/ },
  { field: "esicNumber", test: /\besic?\b.*\b(no|number|ip)\b|\bip (no|number)\b|insurance (no|number)/ },
  { field: "pan", test: /^pan\b|\bpan (no|number)\b|^pan$/ },
  { field: "ifsc", test: /\bifsc\b/ },
  { field: "account", test: /(bank )?(a\/c|account|acct)( no| number| num)?$|^account number$|^bank a\/c/ },
  { field: "code", test: /^(emp(loyee)?\.? ?(code|id|no|number)|e ?code|staff (id|code)|code|sr no|s no)$/ },
  { field: "name", test: /^(employee )?name$|^employee$|name of (the )?employee|^emp(loyee)?\.? name$|^staff name$|^name of employee$/ },
  { field: "designation", test: /designation|^post$|^role$/ },
  { field: "paidDays", test: /paid days|days paid|payable days|^days$|working days|^present( days)?$|days worked|^total days$|attendance/ },
  { field: "employerPf", test: /(employer|er|company)\b.*\b(pf|epf|provident)|\b(pf|epf)\b.*\b(employer|er)\b|eps|employer.*contribution.*pf/ },
  { field: "employerEsi", test: /(employer|er|company)\b.*\b(esi|esic)|\b(esi|esic)\b.*\b(employer|er)\b/ },
  { field: "pf", test: /\b(epf|pf|provident fund)\b/ },
  { field: "esi", test: /\b(esi|esic)\b/ },
  { field: "pt", test: /prof(essional)?\.? ?tax|^p\.? ?tax|^pt$|\bptax\b/ },
  { field: "tds", test: /^tds\b|income tax|^it$|^i\.? ?tax|tax deducted|tds on salary|^tax$/ },
  { field: "gross", test: /^gross( salary| pay| earnings| wages| total)?$|total earnings?|gross total|^total salary$/ },
  { field: "net", test: /^net( salary| pay| payable| amount| wages)?$|net pay|take home|amount payable|salary payable|net payment/ },
  { field: "totalDeductions", test: /total deductions?|^deductions$|total ded/ },
  { field: "basic", test: /^basic( salary| pay| wages)?( \+ da)?$|^basic$|basic \+ da|basic and da/ },
  { field: "da", test: /^(da|dearness allowance|d\.a\.?)$/ },
];

const DEDUCTION_WORDS = /loan|advance|recovery|lwf|labour welfare|other deduction|canteen|mess|insurance|fine|penalty|deduction|lop|loss of pay|late/;
const EARNING_WORDS = /allowance|hra|house rent|conveyance|travel|medical|special|bonus|incentive|commission|overtime|\bot\b|arrear|reimburse|washing|uniform|leave encash|ltc|lta|performance|variable|shift|attendance|other earning|others?$|gratuity|ex gratia/;

function money(value: Cell): number | null {
  if (value == null || String(value).trim() === "") return 0;
  if (value instanceof Date) return null;
  return toPaise(value, true);
}

/** The month from the title lines above the table, "Salary for April 2026" or "Apr-26". */
function monthFromPreamble(lines: string[]): string | null {
  const text = lines.join(" ").toLowerCase();
  for (let index = 0; index < MONTHS.length; index += 1) {
    const full = MONTHS[index];
    const short = full.slice(0, 3);
    const match = new RegExp(`\\b(?:${full}|${short})[a-z]*[\\s,.\\-/']*(?:(20\\d{2})|(\\d{2})\\b)`).exec(text);
    if (match) {
      const year = match[1] ?? `20${match[2]}`;
      return `${year}-${String(index + 1).padStart(2, "0")}`;
    }
  }
  const numeric = /\b(0?[1-9]|1[0-2])[\/\-](20\d{2})\b/.exec(text);
  return numeric ? `${numeric[2]}-${numeric[1].padStart(2, "0")}` : null;
}

function employerFromPreamble(lines: string[]): string {
  for (const line of lines) {
    const text = line.trim();
    if (text.length < 3 || text.length > 100) continue;
    if (/salary|payroll|pay ?sheet|register|statement|month of|for the month|wages|period|^\d/i.test(text)) continue;
    if (/gstin|pan\b|tan\b|address/i.test(text)) continue;
    return text;
  }
  return "";
}

export function readPayroll(table: Table, options: { employerFallback?: string } = {}): PayrollRead {
  let headerRow = -1;
  let best = 0;
  for (let i = 0; i < Math.min(table.length, 30); i += 1) {
    const keys = (table[i] ?? []).map(headerKey);
    const hits = keys.filter(key => key && ROLES.some(role => role.test.test(key))).length;
    const hasName = keys.some(key => /name|employee/.test(key));
    const hasPay = keys.some(key => /\b(gross|net|basic|earnings?|salary)\b/.test(key));
    const score = hits + (hasName ? 3 : 0) + (hasPay ? 3 : 0);
    if (hasName && hasPay && score > best) {
      best = score;
      headerRow = i;
    }
  }
  if (headerRow < 0) {
    throw new Error("We could not find the columns in this file. Upload the salary sheet with one row per employee: name, basic, gross, deductions and net pay.");
  }
  const preamble = table.slice(0, headerRow).map(row => row.map(textCell).filter(Boolean).join(" "));
  const header = table[headerRow] ?? [];
  const keys = header.map(headerKey);

  const columns = new Map<string, number>();
  const earningColumns: Array<{ index: number; head: string }> = [];
  const deductionColumns: Array<{ index: number; head: string }> = [];
  const used = new Set<number>();
  keys.forEach((key, index) => {
    if (!key) return;
    const role = ROLES.find(candidate => candidate.test.test(key));
    if (role && !columns.has(role.field)) {
      columns.set(role.field, index);
      used.add(index);
    }
  });
  keys.forEach((key, index) => {
    if (!key || used.has(index)) return;
    const head = textCell(header[index]);
    if (DEDUCTION_WORDS.test(key)) deductionColumns.push({ index, head });
    else if (EARNING_WORDS.test(key)) earningColumns.push({ index, head });
  });
  if (!columns.has("name")) throw new Error("This file has no employee name column. Add one and upload again.");
  if (!columns.has("net") && !columns.has("gross") && !columns.has("basic")) throw new Error("This file has no gross, basic or net pay column. Add one and upload again.");

  const cell = (cells: Cell[], field: string) => (columns.has(field) ? cells[columns.get(field)!] : undefined);
  const employees: Employee[] = [];
  const notes: string[] = [];
  const seen = new Map<string, number>();
  for (let i = headerRow + 1; i < table.length; i += 1) {
    const cells = table[i] ?? [];
    if (cells.every(value => String(value ?? "").trim() === "")) continue;
    const name = textCell(cell(cells, "name"));
    if (!name || /^(grand )?total\b|^sub ?total|^net total|^totals?$/i.test(name)) continue;
    const row = i + 1;
    const flags: string[] = [];
    let blocked = false;
    const read = (value: Cell, label: string): number => {
      const parsed = money(value);
      if (parsed === null) {
        flags.push(`The ${label} "${String(value)}" is not an amount.`);
        blocked = true;
        return 0;
      }
      return parsed;
    };
    const basic = read(cell(cells, "basic"), "basic");
    const da = read(cell(cells, "da"), "dearness allowance");
    const earnings: Employee["earnings"] = [];
    if (columns.has("basic")) earnings.push({ head: textCell(header[columns.get("basic")!]) || "Basic", amount: basic });
    if (columns.has("da")) earnings.push({ head: textCell(header[columns.get("da")!]) || "DA", amount: da });
    for (const column of earningColumns) {
      const amount = read(cells[column.index], column.head.toLowerCase());
      if (amount !== 0) earnings.push({ head: column.head, amount });
    }
    const earnedSum = earnings.reduce((sum, item) => sum + item.amount, 0);
    const printedGross = columns.has("gross") && textCell(cell(cells, "gross")) !== "" ? read(cell(cells, "gross"), "gross") : null;
    const gross = printedGross ?? earnedSum;
    if (printedGross !== null && earnings.length > 0 && Math.abs(printedGross - earnedSum) > 100) {
      flags.push(`Earnings add up to ${(earnedSum / 100).toFixed(2)} but gross is ${(printedGross / 100).toFixed(2)}.`);
    }
    const pf = read(cell(cells, "pf"), "PF");
    const esi = read(cell(cells, "esi"), "ESI");
    const pt = read(cell(cells, "pt"), "professional tax");
    const tds = read(cell(cells, "tds"), "TDS");
    const other: Employee["otherDeductions"] = [];
    for (const column of deductionColumns) {
      const amount = read(cells[column.index], column.head.toLowerCase());
      if (amount !== 0) other.push({ head: column.head, amount });
    }
    const otherSum = other.reduce((sum, item) => sum + item.amount, 0);
    const known = pf + esi + pt + tds + otherSum;
    const printedTotal = columns.has("totalDeductions") && textCell(cell(cells, "totalDeductions")) !== "" ? read(cell(cells, "totalDeductions"), "total deductions") : null;
    // A "total deductions" column that is bigger than the heads shown means some heads are not in the sheet.
    const deductions = printedTotal !== null && printedTotal > known ? printedTotal : known;
    if (printedTotal !== null && printedTotal > known + 100) {
      other.push({ head: "Other deductions (in total, not itemised)", amount: printedTotal - known });
    }
    const otherDeductions = other;
    const printedNet = columns.has("net") && textCell(cell(cells, "net")) !== "" ? read(cell(cells, "net"), "net pay") : null;
    const net = printedNet ?? gross - deductions;
    if (printedNet !== null && Math.abs(gross - deductions - printedNet) > 100) {
      flags.push(`Gross less deductions is ${((gross - deductions) / 100).toFixed(2)} but net pay is ${(printedNet / 100).toFixed(2)}.`);
      blocked = true;
    }
    if (net < 0) {
      flags.push("Net pay is negative.");
      blocked = true;
    }
    const daysText = textCell(cell(cells, "paidDays"));
    const paidDays = daysText !== "" && Number.isFinite(Number(daysText)) ? Number(daysText) : null;
    const uan = textCell(cell(cells, "uan")).replace(/\D/g, "");
    const pan = textCell(cell(cells, "pan")).toUpperCase().replace(/\s/g, "");
    const ifsc = textCell(cell(cells, "ifsc")).toUpperCase().replace(/\s/g, "");
    const pfWage = basic + da;
    const employee: Employee = {
      row,
      code: textCell(cell(cells, "code")),
      name,
      designation: textCell(cell(cells, "designation")),
      uan,
      esicNumber: textCell(cell(cells, "esicNumber")),
      pan,
      account: textCell(cell(cells, "account")).replace(/\s/g, ""),
      ifsc,
      paidDays,
      basic,
      pfWage,
      earnings,
      gross,
      pf,
      esi,
      pt,
      tds,
      otherDeductions,
      deductions,
      net,
      employerPf: columns.has("employerPf") ? read(cell(cells, "employerPf"), "employer PF") : null,
      employerEsi: columns.has("employerEsi") ? read(cell(cells, "employerEsi"), "employer ESI") : null,
      flags,
      blocked,
    };
    employees.push(employee);
  }
  if (employees.length === 0) throw new Error("No employees were found in this file.");

  // Checks that need the whole list.
  for (const employee of employees) {
    const key = (employee.code || employee.name).toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const employee of employees) {
    const key = (employee.code || employee.name).toLowerCase();
    if ((seen.get(key) ?? 0) > 1) employee.flags.push("This employee appears more than once.");
    if (employee.pf > 0 && !employee.uan) employee.flags.push("PF is deducted but there is no UAN. The PF return needs it.");
    if (employee.uan && employee.uan.length !== 12) employee.flags.push("UAN should have 12 digits.");
    if (employee.pan && !PAN.test(employee.pan)) employee.flags.push("PAN does not look right.");
    if (employee.tds > 0 && !employee.pan) employee.flags.push("TDS is deducted but there is no PAN.");
    if (employee.ifsc && !IFSC.test(employee.ifsc)) employee.flags.push("IFSC does not look right.");
    if (employee.esi > 0 && employee.gross > ESI_GROSS_LIMIT) employee.flags.push("ESI is deducted but gross is above ₹21,000. Check whether the employee is covered.");
    if (employee.esi === 0 && employee.gross > 0 && employee.gross <= ESI_GROSS_LIMIT && columns.has("esi")) employee.flags.push("Gross is ₹21,000 or less but no ESI is deducted. Check whether the employee is covered.");
    if (employee.pf > 0 && employee.pfWage > 0) {
      const onWage = Math.round(employee.pfWage * 0.12);
      const onCeiling = Math.round(Math.min(employee.pfWage, PF_WAGE_CEILING) * 0.12);
      if (Math.abs(employee.pf - onWage) > 100 && Math.abs(employee.pf - onCeiling) > 100) {
        employee.flags.push(`PF is ${(employee.pf / 100).toFixed(2)}; 12% of basic is ${(onWage / 100).toFixed(2)}${onCeiling !== onWage ? ` (or ${(onCeiling / 100).toFixed(2)} on the ₹15,000 ceiling)` : ""}.`);
      }
    }
    if (employee.paidDays !== null && (employee.paidDays < 0 || employee.paidDays > 31)) employee.flags.push("Paid days should be between 0 and 31.");
    if (employee.net > 0 && !employee.account) employee.flags.push("No bank account number, so the payment cannot be matched by account.");
  }
  const employer = employerFromPreamble(preamble) || options.employerFallback || "";
  const month = monthFromPreamble(preamble);
  if (!employer) notes.push("The employer's name is not in the file. Add it in the employer details.");
  if (!month) notes.push("The salary month is not in the file. Choose it in the employer details.");
  return {
    employer,
    month,
    employees,
    earningHeads: [...new Set(employees.flatMap(employee => employee.earnings.map(item => item.head)))],
    deductionHeads: [...new Set(employees.flatMap(employee => employee.otherDeductions.map(item => item.head)))],
    notes,
  };
}

// ── Statutory working ───────────────────────────────────────────────────────

export interface Statutory {
  employees: number;
  gross: number;
  net: number;
  pf: {
    wages: number;
    employee: number;
    /** Employer share, from the sheet when it has the column, otherwise worked out. */
    employer: number;
    employerComputed: boolean;
    /** Employer share split: pension (A/c 10) and provident fund (A/c 01). */
    pension: number;
    employerPf: number;
    adminCharges: number;
    edli: number;
    /** Employee + employer + admin + EDLI. What the PF challan should be about. */
    challan: number;
  };
  esi: { wages: number; employee: number; employer: number; employerComputed: boolean; challan: number; covered: number };
  pt: number;
  tds: number;
  otherDeductions: number;
}

function pct(value: number, rate: number) {
  return Math.round((value * rate) / 100);
}

export function statutoryOf(employees: Employee[]): Statutory {
  const active = employees;
  let pfWages = 0;
  let pfEmployee = 0;
  let pfEmployer = 0;
  let pfComputed = false;
  let pension = 0;
  let admin = 0;
  let edli = 0;
  let esiWages = 0;
  let esiEmployee = 0;
  let esiEmployer = 0;
  let esiComputed = false;
  let esiCovered = 0;
  for (const employee of active) {
    pfEmployee += employee.pf;
    if (employee.pf > 0) {
      const capped = Math.min(employee.pfWage, PF_WAGE_CEILING);
      pfWages += employee.pfWage;
      const employerShare = employee.employerPf ?? employee.pf;
      if (employee.employerPf === null) pfComputed = true;
      pfEmployer += employerShare;
      pension += Math.min(pct(capped, 8.33), 1250_00);
      edli += Math.min(pct(capped, 0.5), 75_00);
      admin += pct(capped, 0.5);
    }
    if (employee.esi > 0 || (employee.gross > 0 && employee.gross <= ESI_GROSS_LIMIT && employee.employerEsi)) {
      esiCovered += 1;
      esiWages += employee.gross;
      esiEmployee += employee.esi;
      if (employee.employerEsi === null) {
        esiComputed = true;
        esiEmployer += pct(employee.gross, 3.25);
      } else esiEmployer += employee.employerEsi;
    }
  }
  const adminCharges = pfEmployee > 0 ? Math.max(admin, 500_00) : 0;
  const employerPf = Math.max(0, pfEmployer - pension);
  const challan = pfEmployee + pfEmployer + adminCharges + edli;
  return {
    employees: active.length,
    gross: active.reduce((sum, employee) => sum + employee.gross, 0),
    net: active.reduce((sum, employee) => sum + employee.net, 0),
    pf: {
      wages: pfWages,
      employee: pfEmployee,
      employer: pfEmployer,
      employerComputed: pfComputed,
      pension,
      employerPf,
      adminCharges,
      edli,
      challan,
    },
    esi: { wages: esiWages, employee: esiEmployee, employer: esiEmployer, employerComputed: esiComputed, challan: esiEmployee + esiEmployer, covered: esiCovered },
    pt: active.reduce((sum, employee) => sum + employee.pt, 0),
    tds: active.reduce((sum, employee) => sum + employee.tds, 0),
    otherDeductions: active.reduce((sum, employee) => sum + employee.otherDeductions.reduce((inner, item) => inner + item.amount, 0), 0),
  };
}

// ── Bank payment match ──────────────────────────────────────────────────────

export interface PaymentMatch {
  employee: string;
  row: number;
  net: number;
  status: "paid" | "bulk" | "not_found";
  date: string | null;
  narration: string | null;
  bankRow: number | null;
  why: string;
}

export interface BankCheck {
  matches: PaymentMatch[];
  paid: number;
  notFound: number;
  /** Debits in the window that look like salary but match no employee. */
  unexplained: Array<{ date: string; narration: string; amount: number; bankRow: number }>;
  bulk: { amount: number; date: string; narration: string; bankRow: number } | null;
}

const nameTokens = (value: string) => value.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(token => token.length >= 3);
const SALARY_WORDS = /salary|salaries|payroll|wages|sal\b|stipend/i;

/** Pure: matches each employee's net pay to one bank debit by amount, then by name or account. */
export function matchSalaryPayments(employees: Employee[], bank: NormalizedBankTxn[], month: string | null): BankCheck {
  const debits = bank
    .filter(txn => txn.debit != null && txn.debit > 0)
    .map(txn => ({ txn, paise: Math.round((txn.debit as number) * 100) }))
    .filter(entry => !month || (entry.txn.date >= `${month}-01` && entry.txn.date <= `${nextMonth(month)}-20`));
  const used = new Set<number>();
  const matches: PaymentMatch[] = [];
  const totalNet = employees.reduce((sum, employee) => sum + employee.net, 0);
  const bulkDebit = debits.find(entry => Math.abs(entry.paise - totalNet) <= 100 && totalNet > 0 && employees.length > 1);
  if (bulkDebit) {
    used.add(bulkDebit.txn.rowNumber);
    for (const employee of employees) {
      matches.push({ employee: employee.name, row: employee.row, net: employee.net, status: "bulk", date: bulkDebit.txn.date, narration: bulkDebit.txn.narration, bankRow: bulkDebit.txn.rowNumber, why: "Included in one bulk salary payment that equals the total net pay." });
    }
    return { matches, paid: employees.length, notFound: 0, unexplained: [], bulk: { amount: bulkDebit.paise, date: bulkDebit.txn.date, narration: bulkDebit.txn.narration, bankRow: bulkDebit.txn.rowNumber } };
  }
  // Strongest evidence first: exact amount with the account tail or the name in the narration.
  const scored: Array<{ employee: Employee; entry: (typeof debits)[number]; score: number; why: string }> = [];
  for (const employee of employees) {
    const tokens = nameTokens(employee.name);
    for (const entry of debits) {
      if (Math.abs(entry.paise - employee.net) > 100) continue;
      const text = `${entry.txn.narration} ${entry.txn.counterparty ?? ""}`.toLowerCase();
      const nameHits = tokens.filter(token => text.includes(token)).length;
      const accountTail = employee.account.slice(-4);
      const accountHit = accountTail.length === 4 && text.includes(accountTail);
      const score = 40 + nameHits * 20 + (accountHit ? 30 : 0) + (SALARY_WORDS.test(text) ? 5 : 0) + (entry.paise === employee.net ? 5 : 0);
      scored.push({
        employee,
        entry,
        score,
        why: nameHits > 0 ? "Amount and name agree." : accountHit ? "Amount and account number agree." : "Amount agrees; the narration does not name the employee.",
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const done = new Set<number>();
  for (const candidate of scored) {
    if (done.has(candidate.employee.row) || used.has(candidate.entry.txn.rowNumber)) continue;
    done.add(candidate.employee.row);
    used.add(candidate.entry.txn.rowNumber);
    matches.push({
      employee: candidate.employee.name,
      row: candidate.employee.row,
      net: candidate.employee.net,
      status: "paid",
      date: candidate.entry.txn.date,
      narration: candidate.entry.txn.narration,
      bankRow: candidate.entry.txn.rowNumber,
      why: candidate.why,
    });
  }
  for (const employee of employees) {
    if (!done.has(employee.row)) {
      matches.push({ employee: employee.name, row: employee.row, net: employee.net, status: "not_found", date: null, narration: null, bankRow: null, why: "No bank debit of this amount was found." });
    }
  }
  matches.sort((a, b) => a.row - b.row);
  const unexplained = debits
    .filter(entry => !used.has(entry.txn.rowNumber) && SALARY_WORDS.test(entry.txn.narration))
    .map(entry => ({ date: entry.txn.date, narration: entry.txn.narration, amount: entry.paise, bankRow: entry.txn.rowNumber }));
  return { matches, paid: matches.filter(match => match.status === "paid").length, notFound: matches.filter(match => match.status === "not_found").length, unexplained, bulk: null };
}

function nextMonth(month: string) {
  const [year, number] = month.split("-").map(Number);
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, "0")}`;
}

// ── Tally journal ───────────────────────────────────────────────────────────

export interface JournalConfig {
  clientName: string;
  tallyCompany?: string;
  /** Voucher date, ISO. Defaults to the last day of the salary month. */
  date?: string;
  month: string;
  salaryExpense: string;
  salaryPayable: string;
  pfPayable: string;
  esiPayable: string;
  ptPayable: string;
  tdsPayable: string;
  otherDeductionLedger: string;
  employerPfExpense: string;
  employerEsiExpense: string;
}

export interface JournalResult {
  ok: boolean;
  xml?: string;
  mastersXml?: string;
  fileName?: string;
  errors: string[];
  lines: Array<{ ledger: string; debit: number; credit: number }>;
}

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function lastDay(month: string) {
  const [year, number] = month.split("-").map(Number);
  const day = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

/** One Journal voucher for the month: expense and employer contributions against payables. */
export function buildPayrollJournal(statutory: Statutory, employees: Employee[], config: JournalConfig): JournalResult {
  const errors: string[] = [];
  if (!/^\d{4}-\d{2}$/.test(config.month)) errors.push("Choose the salary month.");
  if (!config.clientName.trim()) errors.push("Client or company name is required.");
  const blocked = employees.filter(employee => employee.blocked);
  if (blocked.length > 0) errors.push(`${blocked.length} ${blocked.length === 1 ? "employee needs" : "employees need"} attention before the Tally entry can be made.`);
  const names = [config.salaryExpense, config.salaryPayable, config.pfPayable, config.esiPayable, config.ptPayable, config.tdsPayable, config.otherDeductionLedger, config.employerPfExpense, config.employerEsiExpense];
  if (names.some(name => !name.trim())) errors.push("Every ledger name is required.");
  if (errors.length > 0) return { ok: false, errors, lines: [] };

  const debits: Array<[string, number]> = [[config.salaryExpense, statutory.gross]];
  const credits: Array<[string, number]> = [];
  const employerPf = statutory.pf.employer + statutory.pf.adminCharges + statutory.pf.edli;
  if (employerPf > 0) debits.push([config.employerPfExpense, employerPf]);
  if (statutory.esi.employer > 0) debits.push([config.employerEsiExpense, statutory.esi.employer]);
  credits.push([config.salaryPayable, statutory.net]);
  const pfCredit = statutory.pf.employee + employerPf;
  if (pfCredit > 0) credits.push([config.pfPayable, pfCredit]);
  const esiCredit = employees.reduce((sum, employee) => sum + employee.esi, 0) + statutory.esi.employer;
  if (esiCredit > 0) credits.push([config.esiPayable, esiCredit]);
  if (statutory.pt > 0) credits.push([config.ptPayable, statutory.pt]);
  if (statutory.tds > 0) credits.push([config.tdsPayable, statutory.tds]);
  if (statutory.otherDeductions > 0) credits.push([config.otherDeductionLedger, statutory.otherDeductions]);

  let debitTotal = debits.reduce((sum, [, amount]) => sum + amount, 0);
  let creditTotal = credits.reduce((sum, [, amount]) => sum + amount, 0);
  // Paise differences of up to ₹1 per employee come from rounding in the sheet; they go to Round Off.
  const gap = debitTotal - creditTotal;
  if (gap !== 0 && Math.abs(gap) <= 100 * employees.length) {
    if (gap > 0) credits.push(["Round Off", gap]);
    else debits.push(["Round Off", -gap]);
    debitTotal = debits.reduce((sum, [, amount]) => sum + amount, 0);
    creditTotal = credits.reduce((sum, [, amount]) => sum + amount, 0);
  }
  if (debitTotal !== creditTotal) {
    return { ok: false, errors: [`The entry does not balance: debits ${(debitTotal / 100).toFixed(2)}, credits ${(creditTotal / 100).toFixed(2)}. Check gross, net and deductions in the sheet.`], lines: [] };
  }
  const date = (config.date || lastDay(config.month)).replace(/-/g, "");
  const line = (name: string, debit: boolean, amount: number) =>
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${((debit ? -amount : amount) / 100).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
  const narration = `Salary for ${config.month} — ${statutory.employees} employees`;
  const voucher =
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Journal" ACTION="Create"><DATE>${date}</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>` +
    `<NARRATION>${esc(narration)}</NARRATION>` +
    debits.filter(([, amount]) => amount > 0).map(([name, amount]) => line(name, true, amount)).join("") +
    credits.filter(([, amount]) => amount > 0).map(([name, amount]) => line(name, false, amount)).join("") +
    `</VOUCHER></TALLYMESSAGE>`;
  const target = config.tallyCompany?.trim() ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(config.tallyCompany.trim())}</SVCURRENTCOMPANY></STATICVARIABLES>` : "";
  const wrap = (report: string, data: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME>${target}</REQUESTDESC><REQUESTDATA>${data}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const group = (name: string): string => {
    if (name === config.salaryExpense || name === config.employerPfExpense || name === config.employerEsiExpense || name === "Round Off") return "Indirect Expenses";
    if (name === config.otherDeductionLedger) return "Current Assets";
    return "Current Liabilities";
  };
  const masters = [...new Set([...debits, ...credits].filter(([, amount]) => amount > 0).map(([name]) => name))]
    .map(name => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(name)}" ACTION="Create"><NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST><PARENT>${group(name)}</PARENT></LEDGER></TALLYMESSAGE>`)
    .join("");
  const safe = config.clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
  return {
    ok: true,
    xml: wrap("Vouchers", voucher),
    mastersXml: wrap("All Masters", masters),
    fileName: `${safe}-salary-journal-${config.month}.xml`,
    errors: [],
    lines: [
      ...debits.filter(([, amount]) => amount > 0).map(([ledger, amount]) => ({ ledger, debit: amount / 100, credit: 0 })),
      ...credits.filter(([, amount]) => amount > 0).map(([ledger, amount]) => ({ ledger, debit: 0, credit: amount / 100 })),
    ],
  };
}

// ── Excel ───────────────────────────────────────────────────────────────────

const MONEY = "#,##0.00;[Red](#,##0.00)";
const rupees = (value: number) => value / 100;

export function buildPayrollWorkbook(input: { employer: EmployerProfile; month: string | null; employees: Employee[]; statutory: Statutory; bank?: BankCheck | null }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TallyThis";
  const { employer, employees, statutory } = input;
  const sheet = workbook.addWorksheet("Payroll register", { views: [{ state: "frozen", ySplit: 9 }] });
  sheet.getCell("A1").value = employer.name || "Employer";
  sheet.getCell("A1").font = { bold: true, size: 14 };
  const details: Array<[string, string | undefined]> = [
    ["Address", employer.address],
    ["PAN", employer.pan],
    ["TAN", employer.tan],
    ["PF establishment code", employer.pfCode],
    ["ESI code", employer.esiCode],
  ];
  sheet.getCell("A2").value = `Salary for ${input.month ?? "—"}`;
  sheet.getCell("A2").font = { bold: true };
  details.forEach(([label, value], index) => {
    sheet.getCell(3 + (index % 5), 1).value = label;
    sheet.getCell(3 + (index % 5), 2).value = value || "—";
  });
  const heads = [...new Set(employees.flatMap(employee => employee.earnings.map(item => item.head)))];
  const other = [...new Set(employees.flatMap(employee => employee.otherDeductions.map(item => item.head)))];
  const header = ["Code", "Employee", "Designation", "UAN", "PAN", "Paid days", ...heads, "Gross", "PF", "ESI", "Prof. tax", "TDS", ...other, "Total deductions", "Net pay", "Checks"];
  const headerRow = sheet.getRow(9);
  headerRow.values = header;
  headerRow.font = { bold: true };
  headerRow.alignment = { wrapText: true, vertical: "middle" };
  const first = 10;
  employees.forEach((employee, index) => {
    const row = sheet.getRow(first + index);
    const earned = heads.map(head => rupees(employee.earnings.filter(item => item.head === head).reduce((sum, item) => sum + item.amount, 0)));
    const deducted = other.map(head => rupees(employee.otherDeductions.filter(item => item.head === head).reduce((sum, item) => sum + item.amount, 0)));
    row.values = [
      employee.code,
      employee.name,
      employee.designation,
      employee.uan,
      employee.pan,
      employee.paidDays ?? "",
      ...earned,
      rupees(employee.gross),
      rupees(employee.pf),
      rupees(employee.esi),
      rupees(employee.pt),
      rupees(employee.tds),
      ...deducted,
      rupees(employee.deductions),
      rupees(employee.net),
      employee.flags.join(" "),
    ];
    for (let column = 7; column <= header.length - 1; column += 1) row.getCell(column).numFmt = MONEY;
  });
  const totalRow = sheet.getRow(first + employees.length + 1);
  totalRow.getCell(2).value = "Total";
  totalRow.font = { bold: true };
  for (let column = 7; column <= header.length - 1; column += 1) {
    const letter = sheet.getColumn(column).letter;
    totalRow.getCell(column).value = { formula: `SUM(${letter}${first}:${letter}${first + employees.length - 1})` };
    totalRow.getCell(column).numFmt = MONEY;
  }
  sheet.columns.forEach((column, index) => {
    column.width = index === 1 ? 28 : index === header.length - 1 ? 60 : index < 6 ? 16 : 14;
  });

  const stat = workbook.addWorksheet("Statutory working");
  stat.columns = [{ width: 44 }, { width: 18 }, { width: 62 }];
  stat.getCell("A1").value = `${employer.name || "Employer"} · Statutory working for ${input.month ?? "—"}`;
  stat.getCell("A1").font = { bold: true, size: 13 };
  stat.getCell("A2").value = "A working to check the challans. Contribution amounts the sheet does not show are computed from the usual percentages and marked.";
  const rows: Array<[string, number | string, string]> = [
    ["Employees", statutory.employees, ""],
    ["Gross salary", rupees(statutory.gross), ""],
    ["Net pay", rupees(statutory.net), ""],
    ["", "", ""],
    ["PF wages", rupees(statutory.pf.wages), "Basic + DA of employees with PF."],
    ["PF — employee share", rupees(statutory.pf.employee), "From the sheet."],
    ["PF — employer share", rupees(statutory.pf.employer), statutory.pf.employerComputed ? "Computed: same as the employee share (12%)." : "From the sheet."],
    ["  of which pension (A/c 10)", rupees(statutory.pf.pension), "Computed: 8.33% on wages up to ₹15,000, at most ₹1,250 per employee."],
    ["  of which provident fund (A/c 01)", rupees(statutory.pf.employerPf), "Employer share less pension."],
    ["PF admin charges (A/c 02)", rupees(statutory.pf.adminCharges), "Computed: 0.5% of wages up to ₹15,000, at least ₹500."],
    ["EDLI contribution (A/c 21)", rupees(statutory.pf.edli), "Computed: 0.5% of wages up to ₹15,000, at most ₹75 per employee."],
    ["PF challan total", rupees(statutory.pf.challan), "Employee + employer + admin + EDLI."],
    ["", "", ""],
    ["ESI wages", rupees(statutory.esi.wages), `${statutory.esi.covered} covered employees.`],
    ["ESI — employee share", rupees(statutory.esi.employee), "From the sheet."],
    ["ESI — employer share", rupees(statutory.esi.employer), statutory.esi.employerComputed ? "Computed: 3.25% of gross." : "From the sheet."],
    ["ESI challan total", rupees(statutory.esi.challan), ""],
    ["", "", ""],
    ["Professional tax deducted", rupees(statutory.pt), "Rates differ by state; this is the total in the sheet."],
    ["TDS on salary deducted", rupees(statutory.tds), "Section 192. From the sheet."],
    ["Other deductions", rupees(statutory.otherDeductions), "Loans, advances and recoveries."],
  ];
  rows.forEach((entry, index) => {
    const row = stat.getRow(4 + index);
    row.values = entry;
    if (typeof entry[1] === "number" && index > 0) row.getCell(2).numFmt = MONEY;
  });

  if (input.bank) {
    const pay = workbook.addWorksheet("Bank payment");
    pay.columns = [{ width: 28 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 60 }, { width: 50 }];
    pay.getRow(1).values = ["Employee", "Net pay", "Status", "Bank date", "Bank narration", "Note"];
    pay.getRow(1).font = { bold: true };
    input.bank.matches.forEach((match, index) => {
      const row = pay.getRow(2 + index);
      row.values = [match.employee, rupees(match.net), match.status === "not_found" ? "Not found in bank" : match.status === "bulk" ? "In bulk payment" : "Paid", match.date ?? "", match.narration ?? "", match.why];
      row.getCell(2).numFmt = MONEY;
    });
  }
  return workbook;
}
