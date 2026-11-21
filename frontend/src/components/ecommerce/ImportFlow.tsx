import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Circle, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropZone, Notice } from "@/components/jobs/jobUi";
import { FIELD_TEXT, api, financialYearOf, periodLabel, send, uploadReports, type ImportJob } from "@/lib/ecommerce";
import { cn } from "@/lib/utils";

const ACCEPT = ".xlsx,.xls,.csv,.zip";
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function lastMonth(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Choose files, the GSTIN and the month, then upload with real progress. The server takes over from there. */
export function UploadDialog({
  open,
  onOpenChange,
  marketplace,
  marketplaceName,
  sourceFiles,
  defaultGstin,
  defaultPeriod,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplace: string;
  marketplaceName: string;
  sourceFiles: string[];
  defaultGstin: string | null;
  defaultPeriod: string | null;
  onStarted: (jobId: string) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [gstin, setGstin] = useState(defaultGstin ?? "");
  const [period, setPeriod] = useState(defaultPeriod ?? lastMonth());
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFiles([]);
      setGstin(defaultGstin ?? "");
      setPeriod(defaultPeriod ?? lastMonth());
      setPercent(null);
      setError(null);
    }
  }, [open, defaultGstin, defaultPeriod]);

  const cleanGstin = gstin.trim().toUpperCase();
  const gstinProblem = cleanGstin && !GSTIN.test(cleanGstin) ? "A GSTIN has 15 characters, like 07ABCDE1234F1Z2." : null;
  const refused = files.filter(f => !/\.(xlsx|xls|csv|zip)$/i.test(f.name));
  const busy = percent != null;

  const submit = async () => {
    setError(null);
    setPercent(0);
    const result = await uploadReports(marketplace, files, { sellerGstin: cleanGstin || undefined, period: period || undefined, financialYear: period ? financialYearOf(period) : undefined }, setPercent);
    if (!result.ok || !result.jobId) {
      setPercent(null);
      setError(result.message ?? "The upload did not go through. Try again.");
      return;
    }
    onStarted(result.jobId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={value => !busy && onOpenChange(value)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload {marketplaceName} reports</DialogTitle>
          <DialogDescription>Excel, CSV or a ZIP of them, as downloaded from the {marketplaceName} Supplier Panel.</DialogDescription>
        </DialogHeader>

        <DropZone
          label={`Choose ${marketplaceName} report files`}
          hint="XLSX, XLS, CSV or ZIP · several at once is fine"
          accept={ACCEPT}
          multiple
          files={files}
          onFiles={picked => setFiles(picked)}
          busy={busy}
          size="sm"
        />
        <ul className="-mt-1 space-y-0.5 text-xs text-muted-foreground">
          {sourceFiles.map(name => <li key={name}>• {name}</li>)}
        </ul>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">Month</span>
            <input
              type="month"
              value={period}
              onChange={event => setPeriod(event.target.value)}
              disabled={busy}
              className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
              aria-describedby="period-help"
            />
            <span id="period-help" className="mt-1 block text-xs text-muted-foreground">{period ? `FY ${financialYearOf(period)}. Rows keep their own month.` : "Used only when a row has no month."}</span>
          </label>
          <label className="block text-sm">
            <span className="font-medium">Seller GSTIN</span>
            <input
              value={gstin}
              onChange={event => setGstin(event.target.value)}
              disabled={busy}
              placeholder="Read from the reports"
              maxLength={15}
              autoCapitalize="characters"
              className={cn("mt-1 h-10 w-full rounded-lg border bg-background px-3 text-sm uppercase tracking-wide", gstinProblem ? "border-red-300" : "border-border")}
              aria-invalid={Boolean(gstinProblem)}
              aria-describedby="gstin-help"
            />
            <span id="gstin-help" className={cn("mt-1 block text-xs", gstinProblem ? "text-red-700" : "text-muted-foreground")}>{gstinProblem ?? "Rows for another GSTIN are flagged, never mixed in."}</span>
          </label>
        </div>

        {refused.length > 0 && <Notice tone="warn">{refused.map(f => f.name).join(", ")}: only XLSX, XLS, CSV and ZIP files can be imported.</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {busy && (
          <div role="status" aria-live="polite">
            <div className="mb-1 flex justify-between text-xs font-medium text-muted-foreground"><span>Uploading</span><span className="tabular-nums">{percent}%</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-[var(--fv-accent)] transition-[width] duration-200" style={{ width: `${percent}%` }} /></div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <button type="button" className="fv-button-ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</button>
          <button type="button" className="fv-button-primary" onClick={() => void submit()} disabled={busy || files.length === 0 || refused.length > 0 || Boolean(gstinProblem)}>
            {busy ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Uploading…</> : `Import ${files.length || ""} ${files.length === 1 ? "file" : "files"}`.replace("  ", " ")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Follows an import through the server's own stages. The stage and percentage shown are the ones the server writes as it
 * goes; nothing here is a timer pretending to be progress.
 */
export function ImportProgress({
  marketplace,
  jobId,
  stages,
  onFinished,
  onDismiss,
}: {
  marketplace: string;
  jobId: string;
  stages: Array<{ id: string; label: string }>;
  onFinished: (job: ImportJob) => void;
  onDismiss: () => void;
}) {
  const [mapping, setMapping] = useState(false);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, refetch } = useQuery<{ job: ImportJob }>({
    queryKey: ["ecommerce", marketplace, "import", jobId],
    queryFn: () => api(`/ecommerce/${marketplace}/imports/${jobId}`),
    refetchInterval: query => {
      const status = query.state.data?.job.status;
      return status === "completed" || status === "failed" || status === "needs_mapping" ? false : 900;
    },
  });
  const job = data?.job;
  const [reported, setReported] = useState<string | null>(null);
  useEffect(() => {
    if (job && (job.status === "completed") && reported !== job.id + job.status) {
      setReported(job.id + job.status);
      onFinished(job);
    }
  }, [job, onFinished, reported]);

  const shown = stages.filter(s => s.id !== "queued" && s.id !== "completed");
  const current = job ? shown.findIndex(s => s.id === job.stage) : -1;
  const done = job?.status === "completed";

  const retry = async () => {
    setActing(true);
    setActionError(null);
    const result = await send("POST", `/ecommerce/${marketplace}/imports/${jobId}/retry`);
    setActing(false);
    if (!result.ok) setActionError(result.message ?? "Could not start again.");
    void refetch();
  };
  const remove = async () => {
    setActing(true);
    const result = await send("DELETE", `/ecommerce/${marketplace}/imports/${jobId}`);
    setActing(false);
    if (result.ok) onDismiss();
    else setActionError(result.message ?? "Could not remove the import.");
  };

  return (
    <section className="fv-reveal rounded-2xl border border-border bg-card p-5" role="status" aria-live="polite" data-testid="import-progress">
      <div className="flex items-center gap-3">
        {job?.status === "failed" ? <AlertTriangle className="h-5 w-5 text-red-600" aria-hidden="true" />
          : job?.status === "needs_mapping" ? <AlertTriangle className="h-5 w-5 text-amber-600" aria-hidden="true" />
          : done ? <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
          : <Loader2 className="h-5 w-5 animate-spin text-[var(--fv-accent)]" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {!job ? "Starting the import" : job.status === "failed" ? "The import did not finish" : job.status === "needs_mapping" ? "Some columns need choosing" : done ? "Import finished" : job.stageLabel}
          </div>
          {job?.uploads.length ? <div className="truncate text-xs text-muted-foreground">{job.uploads.map(u => u.name).join(", ")}</div> : null}
        </div>
        {job && !done && job.status !== "failed" && job.status !== "needs_mapping" && <div className="text-sm tabular-nums text-muted-foreground">{job.progress}%</div>}
      </div>

      {job && job.status !== "failed" && job.status !== "needs_mapping" && !done && (
        <>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-[var(--fv-accent)] transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${job.progress}%` }} />
          </div>
          <ol className="mt-4 grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
            {shown.map((stage, i) => (
              <li key={stage.id} className={cn("flex items-center gap-2", i < current && "text-emerald-700", i === current && "font-semibold text-foreground")}>
                {i < current ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : i === current ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Circle className="h-3.5 w-3.5" aria-hidden="true" />}
                {stage.label}
              </li>
            ))}
          </ol>
        </>
      )}

      {done && job && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="import-summary">
          {(job.counted ?? 0).toLocaleString("en-IN")} {job.counted === 1 ? "transaction" : "transactions"} imported
          {job.duplicates ? `, ${job.duplicates.toLocaleString("en-IN")} already imported and not counted again` : ""}
          {job.conflicts ? `, ${job.conflicts.toLocaleString("en-IN")} held back because an earlier row for the same order has different figures` : ""}
          {job.periods.length > 0 ? ` · ${job.periods.map(periodLabel).join(", ")}` : ""}.
        </p>
      )}

      {job?.status === "failed" && (
        <div className="mt-3 space-y-3">
          <Notice tone="error">{job.message ?? "Something went wrong while importing."}</Notice>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="fv-button-primary" onClick={() => void retry()} disabled={acting}><RotateCcw className="h-4 w-4" aria-hidden="true" />Try again</button>
            <button type="button" className="fv-button-ghost" onClick={() => void remove()} disabled={acting}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove import</button>
          </div>
        </div>
      )}

      {job?.status === "needs_mapping" && (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-muted-foreground">{job.message} Nothing has been imported yet.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="fv-button-primary" onClick={() => setMapping(true)}>Choose columns</button>
            <button type="button" className="fv-button-ghost" onClick={() => void remove()} disabled={acting}>Cancel import</button>
          </div>
          <MappingDialog open={mapping} onOpenChange={setMapping} marketplace={marketplace} job={job} onSaved={() => { setMapping(false); void refetch(); }} />
        </div>
      )}

      {actionError && <div className="mt-3"><Notice tone="error">{actionError}</Notice></div>}
      {done && <button type="button" className="mt-3 text-sm font-medium text-muted-foreground underline-offset-2 hover:underline" onClick={onDismiss}>Dismiss</button>}
    </section>
  );
}

/** For a file whose required columns were not recognised: pick each from the file's own headers. Nothing is guessed. */
export function MappingDialog({ open, onOpenChange, marketplace, job, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; marketplace: string; job: ImportJob; onSaved: () => void }) {
  const initial = useMemo(() => {
    const out: Record<string, Record<string, string>> = {};
    for (const item of job.needsMapping) out[item.key] = {};
    return out;
  }, [job.needsMapping]);
  const [chosen, setChosen] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setChosen(initial), [initial]);

  const complete = job.needsMapping.every(item => item.missing.every(field => chosen[item.key]?.[field]));
  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await send("POST", `/ecommerce/${marketplace}/imports/${job.id}/mapping`, { mappings: chosen });
    setSaving(false);
    if (!result.ok) {
      setError(result.message ?? "The columns could not be saved.");
      return;
    }
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose the missing columns</DialogTitle>
          <DialogDescription>These files use column names TallyThis does not know. Pick the column that holds each value; every other column is kept as it is.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {job.needsMapping.map(item => (
            <fieldset key={item.key} className="space-y-3 rounded-xl border border-border p-4">
              <legend className="px-1 text-sm font-semibold">{item.fileName}{item.sheetName ? ` · ${item.sheetName}` : ""}</legend>
              {item.missing.map(field => (
                <label key={field} className="block text-sm">
                  <span className="font-medium">{FIELD_TEXT[field] ?? field}</span>
                  <select
                    value={chosen[item.key]?.[field] ?? ""}
                    onChange={event => setChosen(prev => ({ ...prev, [item.key]: { ...prev[item.key], [field]: event.target.value } }))}
                    className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-2 text-sm"
                  >
                    <option value="">Choose a column…</option>
                    {item.headers.map(header => <option key={header} value={header}>{header}</option>)}
                  </select>
                  {item.aliases[field]?.length ? <span className="mt-1 block text-xs text-muted-foreground">Usually called {item.aliases[field].slice(0, 3).map(a => `“${a}”`).join(", ")}</span> : null}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <DialogFooter className="gap-2 sm:gap-0">
          <button type="button" className="fv-button-ghost" onClick={() => onOpenChange(false)}>Cancel</button>
          <button type="button" className="fv-button-primary" disabled={!complete || saving} onClick={() => void save()}>{saving ? "Saving…" : "Import with these columns"}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
