import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, FileSpreadsheet, Landmark } from "lucide-react";
import { BigStat, Choice, MoreOptions, Notice, ResultCard, downloadBlob, downloadText, inr, postDownload, postJson } from "@/components/jobs/jobUi";
import { SendToTally, type TallySendResult } from "@/components/jobs/SendToTally";
import { NextSteps } from "@/components/jobs/NextSteps";
import { getActiveClient } from "@/lib/activeClient";
import { cn } from "@/lib/utils";

export interface EmployerData {
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

export interface EmployeeData {
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
  pfWage: number;
  earnings: Array<{ head: string; amount: number }>;
  gross: number;
  pf: number;
  esi: number;
  pt: number;
  tds: number;
  otherDeductions: Array<{ head: string; amount: number }>;
  deductions: number;
  net: number;
  employerPf: number | null;
  employerEsi: number | null;
  flags: string[];
  blocked: boolean;
}

export interface StatutoryData {
  employees: number;
  gross: number;
  net: number;
  pf: { wages: number; employee: number; employer: number; employerComputed: boolean; pension: number; employerPf: number; adminCharges: number; edli: number; challan: number };
  esi: { wages: number; employee: number; employer: number; employerComputed: boolean; challan: number; covered: number };
  pt: number;
  tds: number;
  otherDeductions: number;
}

export interface BankCheckData {
  matches: Array<{ employee: string; row: number; net: number; status: "paid" | "bulk" | "not_found"; date: string | null; narration: string | null; why: string }>;
  paid: number;
  notFound: number;
  unexplained: Array<{ date: string; narration: string; amount: number; bankRow: number }>;
  bulk: { amount: number; date: string; narration: string } | null;
}

const money = (paise: number) => inr(paise / 100);

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthLabel(month: string | null) {
  const match = month ? /^(\d{4})-(\d{2})$/.exec(month) : null;
  return match ? `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` : "Month not found";
}

const DETAIL_FIELDS: Array<[keyof EmployerData, string, string]> = [
  ["address", "Address", "Registered office address"],
  ["pan", "PAN", "ABCDE1234F"],
  ["tan", "TAN", "ABCD12345E"],
  ["pfCode", "PF establishment code", "MHBAN1234567000"],
  ["esiCode", "ESI code", "31000123450000999"],
  ["ptRegistration", "Professional tax registration", ""],
];

export function EmployerDetails({ employer, onChange, onSave, saving, saved }: { employer: EmployerData; onChange: (next: EmployerData) => void; onSave?: () => void; saving?: boolean; saved?: boolean }) {
  return (
    <div className="space-y-3">
      <label className="block text-xs font-semibold text-muted-foreground">
        Employer name
        <input className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground" value={employer.name} onChange={event => onChange({ ...employer, name: event.target.value })} placeholder="As it should print on the register" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {DETAIL_FIELDS.map(([key, label, placeholder]) => (
          <label key={key} className={cn("block text-xs font-semibold text-muted-foreground", key === "address" && "sm:col-span-2")}>
            {label}
            <input
              className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground"
              value={(employer[key] as string | undefined) ?? ""}
              placeholder={placeholder}
              onChange={event => onChange({ ...employer, [key]: key === "pan" || key === "tan" || key === "pfCode" ? event.target.value.toUpperCase() : event.target.value })}
            />
          </label>
        ))}
      </div>
      {onSave && (
        <div className="flex items-center gap-3">
          <button type="button" className="fv-button-secondary h-9 text-sm" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save for this client"}</button>
          {saved && <span className="inline-flex items-center gap-1 text-xs text-emerald-800"><CheckCircle2 className="h-3.5 w-3.5" />Saved. It will be filled in next time.</span>}
        </div>
      )}
    </div>
  );
}

export function PayrollResult({
  employer: initialEmployer,
  month: initialMonth,
  employees,
  statutory,
  bank,
  bankMessage,
  notes = [],
  runId,
  privacy = false,
  onReset,
}: {
  employer: EmployerData;
  month: string | null;
  employees: EmployeeData[];
  statutory: StatutoryData;
  bank?: BankCheckData | null;
  bankMessage?: string;
  notes?: string[];
  runId: string | null;
  privacy?: boolean;
  onReset?: () => void;
}) {
  const [employer, setEmployer] = useState<EmployerData>(initialEmployer);
  const [month, setMonth] = useState(initialMonth ?? "");
  const [tab, setTab] = useState<"people" | "statutory" | "bank">("people");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"" | "excel" | "xml" | "profile">("");
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);
  const [ledgers, setLedgers] = useState({
    salaryExpense: "Salary Expenses",
    salaryPayable: "Salary Payable",
    pfPayable: "PF Payable",
    esiPayable: "ESI Payable",
    ptPayable: "Professional Tax Payable",
    tdsPayable: "TDS Payable",
    otherDeductionLedger: "Employee Advances",
    employerPfExpense: "Employer PF Contribution",
    employerEsiExpense: "Employer ESI Contribution",
  });
  const [tallyNames, setTallyNames] = useState<string[]>([]);
  const client = getActiveClient();
  const blocked = employees.filter(employee => employee.blocked);
  const flagged = employees.filter(employee => employee.flags.length > 0);
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

  const needsEmployerName = !employer.name.trim();
  const flaggedCount = flagged.length;
  const body = useMemo(() => ({ employer, month: validMonth ? month : null, employees, bank: bank ?? undefined }), [employer, month, validMonth, employees, bank]);

  const excel = async () => {
    setBusy("excel");
    setMessage(null);
    const response = await postDownload("/api/jobs/payroll/excel", body);
    setBusy("");
    if (!response.ok || !response.blob) {
      setMessage({ tone: "error", text: response.message || "The Excel file could not be created." });
      return;
    }
    downloadBlob("TallyThis_Payroll_Register.xlsx", response.blob);
  };

  const journalPayload = () => ({ employer, month, employees, runId: runId ?? undefined, ...ledgers });

  const journal = async () => {
    if (!validMonth) {
      setMessage({ tone: "error", text: "Choose the salary month first." });
      return;
    }
    setBusy("xml");
    setMessage(null);
    const response = await postJson<{ xml: string; fileName: string; message: string }>("/api/jobs/payroll/journal", journalPayload());
    setBusy("");
    if (!response.ok || !response.data.xml) {
      setMessage({ tone: "error", text: response.data.errors?.[0] || response.data.message || "The Tally entry was not created." });
      return;
    }
    downloadText(response.data.fileName || "salary-journal.xml", response.data.xml, "application/xml");
    setMessage({ tone: "success", text: `${response.data.message} Import it in TallyPrime: Gateway of Tally → Import → Vouchers.` });
  };

  const saveProfile = async () => {
    setBusy("profile");
    const response = await postJson("/api/jobs/profile", { clientId: client?.id, clientName: client?.name, profile: employer });
    setBusy("");
    if (!response.ok) setMessage({ tone: "error", text: response.data.message || "The details could not be saved." });
    else setProfileSaved(true);
  };

  const sendJournal = async (company: string): Promise<TallySendResult> => {
    const response = await postJson<TallySendResult>("/api/jobs/payroll/send", { ...journalPayload(), tallyCompany: company });
    return { ...response.data, ok: response.ok && response.data.ok !== false } as TallySendResult;
  };

  return (
    <div className="space-y-4">
      <ResultCard
        eyebrow={`${employer.name || "Employer not found"} · ${monthLabel(validMonth ? month : null)}`}
        actions={
          <>
            <button type="button" className="fv-button-primary h-11 px-6" onClick={() => void excel()} disabled={busy === "excel"}>
              <FileSpreadsheet className="mr-2 inline h-4 w-4" />{busy === "excel" ? "Preparing…" : "Download Register"}
            </button>
            <button type="button" className="fv-button-secondary h-11" onClick={() => void journal()} disabled={busy === "xml" || blocked.length > 0}>
              {busy === "xml" ? "Preparing…" : "Salary entry for Tally"}
            </button>
            {onReset && <button type="button" className="text-sm font-medium text-muted-foreground hover:text-foreground sm:ml-auto" onClick={onReset}>Upload another sheet</button>}
          </>
        }
      >
        <div className="grid grid-cols-3 gap-6">
          <BigStat value={employees.length} label={employees.length === 1 ? "employee" : "employees"} />
          <BigStat value={money(statutory.net)} label="net pay" tone="good" />
          <BigStat value={flaggedCount} label={flaggedCount === 1 ? "needs a look" : "need a look"} tone={flaggedCount > 0 ? "attention" : "good"} />
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Gross {money(statutory.gross)} · PF {money(statutory.pf.employee)} · ESI {money(statutory.esi.employee)} · TDS {money(statutory.tds)}
        </p>
        {bank && (
          <p className="mt-2 text-sm text-muted-foreground">
            <Landmark className="mr-1 inline h-4 w-4" />
            {bank.bulk ? `Paid in one bank payment of ${money(bank.bulk.amount)} on ${bank.bulk.date}.` : `${bank.paid} of ${employees.length} salaries found in the bank statement.`}
          </p>
        )}
      </ResultCard>

      {(needsEmployerName || !validMonth) && (
        <Notice tone="warn">
          {needsEmployerName ? "The employer's name is not in the file: add it under Employer details. " : ""}
          {!validMonth ? "The salary month is not in the file: choose it under Employer details." : ""}
        </Notice>
      )}
      {blocked.length > 0 && <Notice tone="error">{blocked.length} {blocked.length === 1 ? "employee's figures do" : "employees' figures do"} not add up, so the Tally entry is held back. Correct the sheet and upload it again.</Notice>}
      {message && <Notice tone={message.tone} onClose={() => setMessage(null)}>{message.text}</Notice>}
      {bankMessage && <Notice tone="warn">{bankMessage}</Notice>}
      {notes.length > 0 && <Notice tone="info">{notes.join(" ")}</Notice>}

      <Choice<"people" | "statutory" | "bank">
        size="sm"
        value={tab}
        onChange={setTab}
        options={[
          { value: "people", label: "Employees" },
          { value: "statutory", label: "PF, ESI and TDS" },
          ...(bank ? [{ value: "bank" as const, label: "Bank payment" }] : []),
        ]}
      />

      {tab === "people" && (
        <section className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/50 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--fv-accent-dark)]">
              <tr>
                <th className="px-3 py-3 sm:px-4">Employee</th>
                <th className="hidden px-4 py-3 text-right sm:table-cell">Gross</th>
                <th className="hidden px-4 py-3 text-right sm:table-cell">Deductions</th>
                <th className="px-3 py-3 text-right sm:px-4">Net pay</th>
                <th className="hidden px-4 py-3 md:table-cell">Check</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {employees.slice(0, open ? employees.length : 25).map(employee => (
                <tr key={employee.row} className="align-top">
                  <td className="px-3 py-3 sm:px-4">
                    <div className="font-medium">{employee.name}</div>
                    <div className="text-xs text-muted-foreground">{[employee.code, employee.designation].filter(Boolean).join(" · ")}</div>
                    <div className="text-xs text-muted-foreground sm:hidden">Gross {money(employee.gross)} · Deductions {money(employee.deductions)}</div>
                    {employee.flags.length > 0 && (
                      <div className={cn("mt-1 text-xs md:hidden", employee.blocked ? "text-red-700" : "text-amber-800")}>{employee.flags[0]}</div>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-right sm:table-cell">{money(employee.gross)}</td>
                  <td className="hidden px-4 py-3 text-right sm:table-cell">{money(employee.deductions)}</td>
                  <td className="px-3 py-3 text-right font-semibold sm:px-4">{money(employee.net)}</td>
                  <td className="hidden px-4 py-3 text-xs md:table-cell">
                    {employee.flags.length === 0 ? (
                      <span className="inline-flex items-center gap-1 text-emerald-800"><CheckCircle2 className="h-3.5 w-3.5" />Fine</span>
                    ) : (
                      <span className={cn("inline-flex items-start gap-1", employee.blocked ? "text-red-700" : "text-amber-800")}>
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{employee.flags[0]}{employee.flags.length > 1 ? ` (+${employee.flags.length - 1} more)` : ""}</span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {employees.length > 25 && (
            <button type="button" className="flex w-full items-center justify-center gap-1 border-t border-border px-4 py-3 text-sm font-semibold text-[var(--fv-accent-dark)] hover:bg-muted/40" onClick={() => setOpen(value => !value)}>
              {open ? <>Show fewer <ChevronUp className="h-4 w-4" /></> : <>Show all {employees.length} <ChevronDown className="h-4 w-4" /></>}
            </button>
          )}
        </section>
      )}

      {tab === "statutory" && (
        <section className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <tbody className="divide-y divide-border">
              {([
                ["PF wages", statutory.pf.wages, "Basic + DA of employees with PF"],
                ["PF: employee share", statutory.pf.employee, "From the sheet"],
                ["PF: employer share", statutory.pf.employer, statutory.pf.employerComputed ? "Computed as equal to the employee share" : "From the sheet"],
                ["    of which pension (A/c 10)", statutory.pf.pension, "Computed: 8.33% up to ₹15,000 wages"],
                ["PF admin charges (A/c 2)", statutory.pf.adminCharges, "Computed: 0.5%, at least ₹500"],
                ["EDLI (A/c 21)", statutory.pf.edli, "Computed: 0.5% up to ₹15,000 wages"],
                ["PF challan, total", statutory.pf.challan, "Employee + employer + admin + EDLI"],
                ["ESI: employee share", statutory.esi.employee, `${statutory.esi.covered} covered employees`],
                ["ESI: employer share", statutory.esi.employer, statutory.esi.employerComputed ? "Computed: 3.25% of gross" : "From the sheet"],
                ["ESI challan, total", statutory.esi.challan, ""],
                ["Professional tax", statutory.pt, "Total deducted in the sheet"],
                ["TDS on salary", statutory.tds, "Section 192, from the sheet"],
                ["Other deductions", statutory.otherDeductions, "Loans, advances, recoveries"],
              ] as Array<[string, number, string]>).map(([label, value, hint]) => (
                <tr key={label}>
                  <td className="whitespace-pre px-4 py-2.5">{label}</td>
                  <td className="px-4 py-2.5 text-right font-medium">{money(value)}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">A working to check the challans. EPFO and ESIC's own calculation decides the amounts. Potential risk — needs CA review.</p>
        </section>
      )}

      {tab === "bank" && bank && (
        <section className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full min-w-[620px] border-collapse text-sm">
            <thead className="bg-muted/50 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--fv-accent-dark)]">
              <tr><th className="px-4 py-3">Employee</th><th className="px-4 py-3 text-right">Net pay</th><th className="px-4 py-3">Bank</th><th className="px-4 py-3">Note</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {bank.matches.map(match => (
                <tr key={match.row}>
                  <td className="px-4 py-2.5 font-medium">{match.employee}</td>
                  <td className="px-4 py-2.5 text-right">{money(match.net)}</td>
                  <td className="px-4 py-2.5">
                    {match.status === "not_found" ? <span className="text-red-700">Not found</span> : <span className="text-emerald-800">{match.status === "bulk" ? "In bulk payment" : "Paid"} · {match.date}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{match.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {bank.unexplained.length > 0 && (
            <div className="border-t border-border px-4 py-3 text-xs text-amber-900">
              {bank.unexplained.length} salary-like {bank.unexplained.length === 1 ? "debit does" : "debits do"} not match an employee: {bank.unexplained.slice(0, 3).map(item => `${item.date} ${item.narration.slice(0, 40)} ${money(item.amount)}`).join(" · ")}
            </div>
          )}
        </section>
      )}

      <MoreOptions label="Employer details">
        <div className="space-y-4">
          <label className="block text-xs font-semibold text-muted-foreground">
            Salary month
            <input type="month" className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground sm:max-w-xs" value={month} onChange={event => setMonth(event.target.value)} />
          </label>
          <EmployerDetails employer={employer} onChange={setEmployer} onSave={privacy ? undefined : () => void saveProfile()} saving={busy === "profile"} saved={profileSaved} />
        </div>
      </MoreOptions>

      <MoreOptions label="Tally ledger names and direct send">
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            {([
              ["salaryExpense", "Salary expense"],
              ["salaryPayable", "Salary payable"],
              ["pfPayable", "PF payable"],
              ["esiPayable", "ESI payable"],
              ["ptPayable", "Professional tax payable"],
              ["tdsPayable", "TDS on salary payable"],
              ["employerPfExpense", "Employer PF contribution (expense)"],
              ["employerEsiExpense", "Employer ESI contribution (expense)"],
              ["otherDeductionLedger", "Loans and advances recovered"],
            ] as const).map(([field, label]) => (
              <label key={field} className="block text-xs font-semibold text-muted-foreground">
                {label}
                <input className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground" list="payroll-ledger-names" value={ledgers[field]} onChange={event => setLedgers(current => ({ ...current, [field]: event.target.value }))} />
              </label>
            ))}
            <datalist id="payroll-ledger-names">{tallyNames.map(name => <option key={name} value={name} />)}</datalist>
          </div>
          <p className="text-xs text-muted-foreground">In Bank → Tally, choose “Salary Payable” for salary payments so they clear this entry.</p>
          <SendToTally
            entries={1}
            noun="salary entry"
            nounPlural="salary entries"
            showBankChoices={false}
            blockedReason={blocked.length > 0 ? "Some employees' figures do not add up." : !validMonth ? "Choose the salary month first." : null}
            bankHint={[]}
            defaultBankLedger=""
            onLedgers={setTallyNames}
            onSend={sendJournal}
          />
        </div>
      </MoreOptions>

      <NextSteps
        steps={[
          { label: "Book the salary payments", hint: "Bank → Tally: choose Salary Payable for the salary rows", href: "/app/jobs/bank-to-tally" },
          { label: "Check TDS credit", hint: "26AS TDS: compare TDS in 26AS with your books", href: "/app/tds-recon" },
        ]}
      />
    </div>
  );
}
