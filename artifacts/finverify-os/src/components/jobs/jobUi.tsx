import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, FileText, Loader2, Lock, ShieldCheck, UploadCloud, X } from "lucide-react";
import { getActiveClient, setActiveClient, type ActiveClient } from "@/lib/activeClient";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface PracticeClient {
  companyId: number | null;
  linkId: number | null;
  name: string;
}

export function useClients() {
  const [clients, setClients] = useState<PracticeClient[]>([]);
  const [active, setActive] = useState<ActiveClient | null>(() => getActiveClient());
  const [source, setSource] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/api/practice/clients`)
      .then(response => response.json())
      .then(data => {
        if (cancelled) return;
        const rows = (data.clients ?? []).filter((client: PracticeClient) => (client.companyId ?? 0) > 0);
        setClients(rows);
        setSource(data.source ?? "");
        if (!getActiveClient() && rows[0]) {
          const next = { id: rows[0].companyId, name: rows[0].name, accounting: "Tally" as const, linkId: rows[0].linkId };
          setActiveClient(next);
          setActive(next);
        }
      })
      .catch(() => undefined);
    const sync = () => setActive(getActiveClient());
    window.addEventListener("finverify-client", sync);
    return () => {
      cancelled = true;
      window.removeEventListener("finverify-client", sync);
    };
  }, []);

  const choose = (client: ActiveClient) => {
    setActiveClient(client);
    setActive(client);
  };

  return { clients, active, source, choose };
}

export function downloadText(filename: string, content: string, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>) {
  const quote = (value: unknown) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.map(quote).join(","), ...rows.map(row => row.map(quote).join(","))].join("\n");
}

export function inr(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/** Sends files with the active client attached. */
export async function postFiles<T>(path: string, fields: Record<string, File | File[] | string | undefined>): Promise<{ ok: boolean; status: number; data: T & { ok?: boolean; message?: string } }> {
  const body = new FormData();
  const client = getActiveClient();
  if (client?.id) body.append("clientId", String(client.id));
  if (client?.name) body.append("clientName", client.name);
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (Array.isArray(value)) value.forEach(file => body.append(key, file));
    else body.append(key, value);
  }
  try {
    const response = await fetch(`${BASE}${path}`, { method: "POST", body });
    const data = await response.json().catch(() => ({ ok: false, message: "The server sent an unreadable reply." }));
    return { ok: response.ok && data.ok !== false, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: { ok: false, message: "Could not reach TallyThis. Check your connection and try again." } as T & { ok?: boolean; message?: string } };
  }
}

export async function postJson<T>(path: string, payload: unknown): Promise<{ ok: boolean; data: T & { ok?: boolean; message?: string; errors?: string[] } }> {
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({ ok: false }));
    return { ok: response.ok && data.ok !== false, data };
  } catch {
    return { ok: false, data: { ok: false, message: "Could not reach TallyThis." } as T & { ok?: boolean; message?: string } };
  }
}

// ── Layout ──────────────────────────────────────────────────────────────────

export function JobShell({ title, outcome, children }: { title: string; outcome: string; children: ReactNode }) {
  const { active } = useClients();
  return (
    <div className="fv-job-shell mx-auto w-full px-4 py-6 sm:py-10">
      <div className="fv-job-header">
        <div className="fv-job-client">{active ? `FOR ${active.name.toUpperCase()}` : "YOUR ACCOUNTING WORKSPACE"}</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground sm:text-base">{outcome}</p>
        <div className="fv-job-flow" aria-label="Upload, review, export"><span><i>01</i> Upload</span><span><i>02</i> Review</span><span><i>03</i> Export</span></div>
      </div>
      {children}
    </div>
  );
}

/** Shows which client the work is for. One tap to switch. */
export function ClientChip() {
  const { clients, active, choose } = useClients();
  if (!active && clients.length === 0) return null;
  return (
    <label className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-card py-1 pl-3 pr-1 text-xs text-muted-foreground">
      <span className="shrink-0">Client</span>
      <select
        aria-label="Client"
        value={active?.name ?? ""}
        onChange={event => {
          const client = clients.find(item => item.name === event.target.value);
          if (client) choose({ id: client.companyId, name: client.name, accounting: active?.accounting ?? "Tally", linkId: client.linkId });
        }}
        className="max-w-[14rem] truncate rounded-full bg-muted px-2 py-1 text-xs font-semibold text-foreground focus:outline-none"
      >
        {active && !clients.some(client => client.name === active.name) && <option value={active.name}>{active.name}</option>}
        {clients.map(client => <option key={`${client.linkId}-${client.name}`} value={client.name}>{client.name}</option>)}
      </select>
    </label>
  );
}

// ── Upload ──────────────────────────────────────────────────────────────────

export function DropZone({
  label,
  hint,
  accept = ".pdf,.csv,.xlsx,.xls,.png,.jpg,.jpeg,.webp",
  multiple = false,
  files,
  onFiles,
  busy = false,
  size = "lg",
}: {
  label: string;
  hint?: string;
  accept?: string;
  multiple?: boolean;
  files?: File[];
  onFiles: (files: File[]) => void;
  busy?: boolean;
  size?: "lg" | "sm";
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const chosen = files ?? [];
  const take = (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    if (picked.length > 0) onFiles(multiple ? picked : picked.slice(0, 1));
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !busy && input.current?.click()}
      aria-label={label}
      aria-disabled={busy}
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!busy) input.current?.click(); } }}
      onDragOver={event => { event.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={event => { event.preventDefault(); setOver(false); if (!busy) take(event.dataTransfer.files); }}
      className={cn(
        "fv-dropzone group flex w-full cursor-pointer flex-col items-center justify-center border border-dashed text-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fv-accent)]",
        size === "lg" ? "px-6 py-12 sm:py-16" : "px-4 py-7",
        over ? "is-dragging" : chosen.length > 0 ? "border-emerald-300 bg-emerald-50/40" : "",
        busy && "cursor-wait opacity-70",
      )}
    >
      <input ref={input} type="file" accept={accept} multiple={multiple} className="hidden" onChange={event => { take(event.target.files); event.target.value = ""; }} />
      {busy ? (
        <Loader2 className={cn("animate-spin text-[var(--fv-accent)]", size === "lg" ? "h-10 w-10" : "h-7 w-7")} />
      ) : chosen.length > 0 ? (
        <CheckCircle2 className={cn("text-emerald-600", size === "lg" ? "h-10 w-10" : "h-7 w-7")} />
      ) : (
        <UploadCloud className={cn("text-muted-foreground transition group-hover:text-[var(--fv-accent)]", size === "lg" ? "h-10 w-10" : "h-7 w-7")} />
      )}
      {chosen.length > 0 ? (
        <div className="mt-3 w-full max-w-md space-y-1">
          {chosen.slice(0, 4).map(file => (
            <div key={`${file.name}-${file.size}`} className="flex items-center justify-center gap-1.5 truncate text-sm font-semibold">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{file.name}</span>
            </div>
          ))}
          {chosen.length > 4 && <div className="text-xs text-muted-foreground">+{chosen.length - 4} more</div>}
          {!busy && <div className="text-xs text-muted-foreground">Tap to change</div>}
        </div>
      ) : (
        <>
          <div className={cn("mt-3 font-semibold", size === "lg" ? "text-base" : "text-sm")}>{label}</div>
          <div className="mt-1 text-xs text-muted-foreground">{hint ?? "Drag & drop, or tap to choose"}</div>
        </>
      )}
    </div>
  );
}

/** One request, several plain-language steps so the wait feels like progress. */
export function Working({ steps }: { steps: string[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setIndex(current => Math.min(current + 1, steps.length - 1)), 1800);
    return () => window.clearInterval(timer);
  }, [steps.length]);
  const percent = Math.round(((index + 1) / (steps.length + 1)) * 100);
  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--fv-accent)]" />
        <div className="text-sm font-semibold">{steps[index]}</div>
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-[var(--fv-accent)] transition-all duration-700" style={{ width: `${percent}%` }} />
      </div>
      <ol className="mt-4 grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
        {steps.map((step, i) => (
          <li key={step} className={cn("flex items-center gap-2", i < index && "text-emerald-700", i === index && "font-semibold text-foreground")}>
            {i < index ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5 rounded-full border border-current" />}
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ProgressBar({ percent, step }: { percent: number; step: string }) {
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-muted-foreground">
        <span>{step}</span>
        <span>{percent}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-[var(--fv-accent)] transition-all" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

// ── Results ─────────────────────────────────────────────────────────────────

export function ResultCard({ eyebrow, children, actions }: { eyebrow?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      {eyebrow && <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{eyebrow}</div>}
      {children}
      {actions && <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">{actions}</div>}
    </section>
  );
}

export function BigStat({ value, label, tone = "neutral" }: { value: ReactNode; label: string; tone?: "neutral" | "good" | "attention" }) {
  return (
    <div className="min-w-0">
      <div className={cn(
        "text-3xl font-bold tracking-tight sm:text-4xl",
        tone === "good" && "text-emerald-700",
        tone === "attention" && "text-amber-600",
      )}>{value}</div>
      <div className="mt-1 text-sm text-muted-foreground">{label}</div>
    </div>
  );
}

export function Notice({ tone = "info", children, onClose }: { tone?: "info" | "warn" | "error" | "success"; children: ReactNode; onClose?: () => void }) {
  return (
    <div className={cn(
      "flex items-start gap-3 rounded-xl border px-4 py-3 text-sm",
      tone === "info" && "border-sky-200 bg-sky-50 text-sky-900",
      tone === "warn" && "border-amber-200 bg-amber-50 text-amber-900",
      tone === "error" && "border-red-200 bg-red-50 text-red-900",
      tone === "success" && "border-emerald-200 bg-emerald-50 text-emerald-900",
    )}>
      <div className="min-w-0 flex-1">{children}</div>
      {onClose && <button type="button" aria-label="Dismiss" onClick={onClose} className="shrink-0 opacity-60 hover:opacity-100"><X className="h-4 w-4" /></button>}
    </div>
  );
}

/** Hides power-user controls until asked for. */
export function MoreOptions({ label = "More options", children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4">
      <button type="button" onClick={() => setOpen(value => !value)} className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
        {label}
        <ChevronDown className={cn("h-4 w-4 transition", open && "rotate-180")} />
      </button>
      {open && <div className="mt-3 space-y-4 rounded-2xl border border-border bg-muted/30 p-4">{children}</div>}
    </div>
  );
}

/** Pick-one buttons. Used instead of typing wherever the answer set is known. */
export function Choice<T extends string>({
  options,
  value,
  onChange,
  size = "md",
}: {
  options: ReadonlyArray<{ value: T; label: string; tone?: "good" | "bad" | "neutral" }>;
  value: T | null | undefined;
  onChange: (value: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(option => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
            className={cn(
              "rounded-full border font-semibold transition",
              size === "sm" ? "px-3 py-1 text-xs" : "px-4 py-2 text-sm",
              selected
                ? option.tone === "bad" ? "border-red-300 bg-red-50 text-red-800"
                  : option.tone === "good" ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : "border-[var(--fv-accent)] bg-orange-50 text-orange-900"
                : "border-border bg-card text-foreground hover:border-foreground/30",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Pending files: Home and the landing page hand files to a job page ───────

let pending: { job: string; files: File[] } | null = null;

export function setPendingFiles(job: string, files: File[]) {
  pending = { job, files };
}

export function takePendingFiles(job: string): File[] | null {
  if (!pending || pending.job !== job) return null;
  const files = pending.files;
  pending = null;
  return files;
}

export function peekPendingJob(): string | null {
  return pending?.job ?? null;
}

/** "2026-05-25" → "25 May 2026". Leaves anything else as it is. */
export function fmtDate(value: string | null | undefined) {
  if (!value) return "";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// ── Bank statements: locked PDFs and the running-balance proof ──────────────

/** True when the PDF is encrypted. Checked in the browser so the password is asked for at once. */
export async function isLockedPdf(file: File): Promise<boolean> {
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return false;
  try {
    const text = new TextDecoder("latin1").decode(await file.arrayBuffer());
    return text.includes("/Encrypt");
  } catch {
    return false;
  }
}

export function PasswordPrompt({
  fileName,
  error,
  busy = false,
  onSubmit,
  onSkip,
  onCancel,
}: {
  fileName: string;
  error?: string;
  busy?: boolean;
  onSubmit: (password: string) => void;
  onSkip?: () => void;
  onCancel?: () => void;
}) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700"><Lock className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">This PDF is locked</div>
          <p className="mt-1 truncate text-sm text-muted-foreground">{fileName}</p>
          <p className="mt-1 text-sm text-muted-foreground">Enter the password the bank set — often your customer ID, date of birth (DDMMYYYY) or name + birth year.</p>
          {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
          <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={event => { event.preventDefault(); if (password && !busy) onSubmit(password); }}>
            <div className="relative flex-1">
              <input
                autoFocus
                type={show ? "text" : "password"}
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder="PDF password"
                autoComplete="off"
                className="fv-input h-11 w-full pr-16"
              />
              <button type="button" onClick={() => setShow(value => !value)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground">
                {show ? "Hide" : "Show"}
              </button>
            </div>
            <button type="submit" className="fv-button-primary h-11" disabled={!password || busy}>{busy ? "Opening…" : "Unlock and continue"}</button>
          </form>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {onSkip && <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onSkip}>It opens without a password</button>}
            {onCancel && <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onCancel}>Use a different file</button>}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">The password is used only to open this file and is not stored.</p>
        </div>
      </div>
    </section>
  );
}

export interface StatementCheck {
  rows: number;
  checked: number;
  passed: number;
  failed: number;
  failedRows: number[];
  openingBalance: number | null;
  closingBalance: number | null;
  printedClosing: number | null;
  closingMatches: boolean | null;
  serialComplete: boolean | null;
  verified: boolean;
}

/** One line a CA can trust: did every row agree with the bank's own running balance? */
export function StatementProof({ check }: { check: StatementCheck | null | undefined }) {
  if (!check || check.rows === 0) return null;
  if (check.verified) {
    return (
      <div className="mt-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-semibold">Every row matches the bank's running balance</div>
          <div className="text-xs text-emerald-800">
            {check.checked} of {check.rows} rows proved
            {check.openingBalance != null && <> · opening {inr(check.openingBalance)}</>}
            {check.closingBalance != null && <> · closing {inr(check.closingBalance)}</>}
            {check.closingMatches && <> · closing matches the statement</>}
            {check.serialComplete && <> · no rows missing</>}
          </div>
        </div>
      </div>
    );
  }
  if (check.checked === 0) return null;
  return (
    <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <div className="font-semibold">
          {check.failed > 0 ? `${check.failed} ${check.failed === 1 ? "row does" : "rows do"} not match the running balance` : "Some rows could not be checked against the balance"}
        </div>
        <div className="text-xs text-amber-800">
          {check.passed} of {check.rows} rows proved{check.closingMatches === false ? " · closing balance differs from the statement" : ""}. Review the flagged rows before export.
        </div>
      </div>
    </div>
  );
}
