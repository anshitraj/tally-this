import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { DropZone, JobShell, Notice, PasswordPrompt, Working, getJson, isLockedPdf, postFiles, takePendingFiles, useClients } from "@/components/jobs/jobUi";
import { EmployerDetails, PayrollResult, type BankCheckData, type EmployeeData, type EmployerData, type StatutoryData } from "@/components/jobs/PayrollResult";

interface ReadResponse {
  runId: string | null;
  privacy?: boolean;
  file: string;
  employer: EmployerData;
  month: string | null;
  employees: EmployeeData[];
  statutory: StatutoryData;
  bank: BankCheckData | null;
  bankMessage: string;
  notes: string[];
  needsPassword?: boolean;
  wrongPassword?: boolean;
}

type Stage = "idle" | "working" | "done" | "error";

const STEPS = ["Reading the salary sheet", "Checking PF, ESI and TDS", "Checking the bank payment"];

export default function PayrollPage() {
  const { active } = useClients();
  const [, navigate] = useLocation();
  const [stage, setStage] = useState<Stage>("idle");
  const [sheet, setSheet] = useState<File | null>(null);
  const [bank, setBank] = useState<File | null>(null);
  const [employer, setEmployer] = useState<EmployerData>({ name: "" });
  const [month, setMonth] = useState("");
  const [error, setError] = useState("");
  const [data, setData] = useState<ReadResponse | null>(null);
  const [locked, setLocked] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");

  // The client's saved details fill the form, so the employer's name is never typed twice.
  useEffect(() => {
    let cancelled = false;
    void getJson<{ profile?: EmployerData }>(`/api/jobs/profile?clientName=${encodeURIComponent(active?.name ?? "")}`).then(response => {
      if (cancelled || !response.ok || !response.data.profile) return;
      setEmployer(current => ({ ...response.data.profile!, ...Object.fromEntries(Object.entries(current).filter(([, value]) => typeof value === "string" && value !== "")) }) as EmployerData);
    });
    return () => {
      cancelled = true;
    };
  }, [active?.id, active?.name]);

  const read = async (sheetFile: File, bankFile: File | null, pass = password) => {
    setStage("working");
    setError("");
    setPasswordError("");
    const response = await postFiles<ReadResponse>("/api/jobs/payroll/read", {
      sheet: sheetFile,
      bank: bankFile ?? undefined,
      password: pass || undefined,
      month: month || undefined,
      employer: JSON.stringify(employer),
    });
    if (!response.ok) {
      if (response.data.needsPassword) {
        setLocked(true);
        setPasswordError(response.data.wrongPassword || pass ? response.data.message ?? "" : "");
        setStage("idle");
        return;
      }
      setError(response.data.message || "This salary sheet could not be read.");
      setStage("error");
      return;
    }
    setData(response.data);
    setStage("done");
  };

  useEffect(() => {
    const pending = takePendingFiles("payroll");
    if (!pending?.length) return;
    // Home puts a bank statement first when there is one.
    const [first, second] = pending;
    const chosenSheet = second ?? first;
    setSheet(chosenSheet);
    if (second) setBank(first);
    void read(chosenSheet, second ? first : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseBank = async (file: File) => {
    setBank(file);
    const isLocked = await isLockedPdf(file);
    setLocked(isLocked);
    if (sheet && !isLocked) void read(sheet, file, "");
  };

  const reset = () => {
    setStage("idle");
    setSheet(null);
    setBank(null);
    setData(null);
    setError("");
    setLocked(false);
    setPassword("");
  };

  return (
    <JobShell
      title="Payroll"
      outcome="Upload the salary sheet to get the register with your employer details, the PF, ESI and TDS working, and a Tally salary entry."
      modeLocked={stage !== "idle" && stage !== "error"}
    >
      {(stage === "idle" || stage === "error") && (
        <div className="space-y-4">
          {stage === "error" && <Notice tone="error">{error}</Notice>}
          <label className="block text-xs font-semibold text-muted-foreground">
            Employer name
            <input
              className="fv-input mt-1 h-11 w-full text-base font-normal text-foreground"
              value={employer.name}
              onChange={event => setEmployer(current => ({ ...current, name: event.target.value }))}
              placeholder={active?.name ? `${active.name}` : "Employer name"}
            />
          </label>
          <DropZone
            size="sm"
            label="Salary sheet"
            hint="Excel or CSV with one row per employee: name, basic, gross, PF, ESI, TDS and net pay."
            files={sheet ? [sheet] : []}
            onFiles={files => {
              setSheet(files[0]);
              if (files[0] && !(locked && !password)) void read(files[0], bank);
            }}
          />
          <DropZone size="sm" label="Bank statement (optional)" hint="Add it to check that every salary was paid." files={bank ? [bank] : []} onFiles={files => files[0] && void chooseBank(files[0])} />
          {locked && bank && (
            <PasswordPrompt
              fileName={bank.name}
              error={passwordError}
              onSubmit={value => {
                setPassword(value);
                setLocked(false);
                if (sheet) void read(sheet, bank, value);
              }}
              onSkip={() => {
                setLocked(false);
                setBank(null);
              }}
            />
          )}
          <details className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium">More options</summary>
            <div className="mt-3 space-y-4">
              <label className="block text-xs font-semibold text-muted-foreground">
                Salary month (only if the file does not show it)
                <input type="month" className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground sm:max-w-xs" value={month} onChange={event => setMonth(event.target.value)} />
              </label>
              <EmployerDetails employer={employer} onChange={setEmployer} />
              <button type="button" className="text-xs font-semibold text-[var(--fv-accent-dark)] hover:underline" onClick={() => navigate("/app/payroll-register")}>
                Payroll rows imported earlier through the Upload center
              </button>
            </div>
          </details>
          <p className="text-center text-xs text-muted-foreground">We find the columns by their headings. Nothing is guessed: figures that do not add up are shown for you to fix.</p>
        </div>
      )}

      {stage === "working" && <Working steps={STEPS} />}

      {stage === "done" && data && (
        <>
          <PayrollResult
            employer={data.employer}
            month={data.month}
            employees={data.employees}
            statutory={data.statutory}
            bank={data.bank}
            bankMessage={data.bankMessage}
            notes={data.notes}
            runId={data.runId}
            privacy={data.privacy}
            onReset={reset}
          />
          {data.privacy && (
            <div className="mt-4">
              <Notice tone="success">Incognito: this sheet and result are not saved to your workspace. Download before leaving.</Notice>
            </div>
          )}
        </>
      )}
    </JobShell>
  );
}
