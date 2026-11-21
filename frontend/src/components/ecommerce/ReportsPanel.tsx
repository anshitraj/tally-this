import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, FileSpreadsheet, FileText, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Notice } from "@/components/jobs/jobUi";
import { useToast } from "@/hooks/use-toast";
import { refreshAfterChange } from "@/lib/refresh";
import { REPORT_STATUS, api, download, periodLabel, send, type ImportJob, type ReportState } from "@/lib/ecommerce";
import { Tone } from "./TransactionsPanel";

const HISTORY_TEXT: Record<string, string> = { approve: "Approved", reopen_report: "Approval withdrawn" };

/**
 * The period's report: its status (never "Reconciled" while anything blocking is open, "Approved" only while the data is
 * what was approved), the approval with its history, the downloads and the imports that fed it.
 */
export function ReportsPanel({ marketplace, period, jobs, canApprove, onReviewItems }: { marketplace: string; period: string; jobs: ImportJob[]; canApprove: boolean; onReviewItems: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [rounding, setRounding] = useState<"line" | "aggregate">("line");
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"approve" | "reopen" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ImportJob | null>(null);
  const { data } = useQuery<{ state: ReportState | null; history: Array<{ id: number; action: string; note: string | null; actor: string | null; at: string }> }>({
    queryKey: ["ecommerce", marketplace, "report", period],
    queryFn: () => api(`/ecommerce/${marketplace}/report?period=${period}`),
  });
  const state = data?.state;
  const info = state ? REPORT_STATUS[state.status] : null;

  const get = async (format: "xlsx" | "pdf" | "transactions_csv" | "exceptions_csv") => {
    setBusy(format);
    const result = await download(marketplace, period, format, rounding);
    setBusy(null);
    if (!result.ok) toast({ title: "Download failed", description: result.message, variant: "destructive" });
  };

  const decide = async () => {
    setError(null);
    const result = await send("POST", `/ecommerce/${marketplace}/report/${dialog}`, { period, note: note.trim() || undefined });
    if (!result.ok) {
      setError(result.message ?? "That could not be saved.");
      return;
    }
    toast({ title: dialog === "approve" ? `${periodLabel(period)} approved` : "Approval withdrawn" });
    setDialog(null);
    setNote("");
    await refreshAfterChange(qc, [["ecommerce", marketplace]]);
  };

  const remove = async (job: ImportJob) => {
    const result = await send<{ reread: string[] }>("DELETE", `/ecommerce/${marketplace}/imports/${job.id}`);
    setRemoving(null);
    if (!result.ok) {
      toast({ title: "Could not remove the import", description: result.message, variant: "destructive" });
      return;
    }
    toast({ title: "Import removed", description: result.reread?.length ? `${result.reread.length} later import(s) are being read again so nothing they held is lost.` : undefined });
    await refreshAfterChange(qc, [["ecommerce", marketplace]]);
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-card p-5" aria-label="Report status">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold">{periodLabel(period)} report</h3>
              {info && <Tone tone={info.tone}>{info.label}</Tone>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground" data-testid="report-status-text">
              {!state ? "Loading…"
                : state.status === "approved" ? `Approved by ${state.approver ?? "a reviewer"} on ${new Date(state.approvedAt!).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}.`
                : state.status === "needs_review" ? `${state.openBlocking} item(s) still need review before this month can be approved.`
                : state.status === "reconciled" ? "Nothing needs review. A CA or admin can approve this month."
                : "Nothing imported for this month yet."}
            </p>
            {state?.approvalOutdated && <p className="mt-2 text-sm text-amber-800">The data changed after it was approved (a new import or decision), so the approval no longer applies.</p>}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {state?.status === "needs_review" && <button type="button" className="fv-button-primary" onClick={onReviewItems}>Review {state.openBlocking} {state.openBlocking === 1 ? "item" : "items"}</button>}
            {state?.status === "reconciled" && canApprove && <button type="button" className="fv-button-primary" onClick={() => { setDialog("approve"); setError(null); }}><ShieldCheck className="h-4 w-4" aria-hidden="true" />Approve {periodLabel(period)}</button>}
            {state?.status === "approved" && canApprove && <button type="button" className="fv-button-ghost" onClick={() => { setDialog("reopen"); setError(null); }}><RotateCcw className="h-4 w-4" aria-hidden="true" />Withdraw approval</button>}
          </div>
        </div>
        {state?.status === "reconciled" && !canApprove && <p className="mt-3 text-xs text-muted-foreground">Only a CA or admin can approve a month.</p>}
        {data && data.history.length > 0 && (
          <ol className="mt-4 space-y-2 border-t border-border pt-4 text-xs">
            {data.history.map(h => (
              <li key={h.id} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{HISTORY_TEXT[h.action] ?? h.action}</span>
                <span className="text-muted-foreground">{h.actor ?? "Someone"} · {new Date(h.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
                {h.note && <span className="w-full">{h.note}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-label="Downloads" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Working papers</h3>
          <label className="flex items-center gap-2 text-xs font-medium">Tax rounding
            <select value={rounding} onChange={event => setRounding(event.target.value as "line" | "aggregate")} className="h-8 rounded-lg border border-border bg-background px-2 text-xs" aria-label="Rounding for downloads">
              <option value="line">Each line as reported</option>
              <option value="aggregate">Once per group</option>
            </select>
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" onClick={() => void get("xlsx")} disabled={busy != null} className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/25 disabled:opacity-60">
            <FileSpreadsheet className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" aria-hidden="true" />
            <span><span className="block text-sm font-semibold">{busy === "xlsx" ? "Preparing…" : "Excel working papers"}</span><span className="block text-xs text-muted-foreground">Ten sheets: summary, every source row, sales, returns, HSN, States, GSTR-1 working, exceptions, audit trail and file details.</span></span>
          </button>
          <button type="button" onClick={() => void get("pdf")} disabled={busy != null} className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/25 disabled:opacity-60">
            <FileText className="mt-0.5 h-5 w-5 shrink-0 text-red-700" aria-hidden="true" />
            <span><span className="block text-sm font-semibold">{busy === "pdf" ? "Preparing…" : "PDF summary"}</span><span className="block text-xs text-muted-foreground">Figures, HSN and State summary and open items, for the client file.</span></span>
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="fv-button-ghost h-9" disabled={busy != null} onClick={() => void get("transactions_csv")}><Download className="h-4 w-4" aria-hidden="true" />Transactions CSV</button>
          <button type="button" className="fv-button-ghost h-9" disabled={busy != null} onClick={() => void get("exceptions_csv")}><Download className="h-4 w-4" aria-hidden="true" />Exceptions CSV</button>
        </div>
        {state && state.status !== "approved" && <p className="text-xs text-muted-foreground">Downloads before approval are marked with the month's status ({info?.label}).</p>}
      </section>

      <section aria-label="Import history" className="space-y-2">
        <h3 className="text-sm font-semibold">Imports</h3>
        {jobs.length === 0 ? <p className="text-sm text-muted-foreground">No imports yet.</p> : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {jobs.map(job => (
              <li key={job.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{job.uploads.map(u => u.name).join(", ") || "Import"}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(job.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                    {job.status === "completed" ? ` · ${job.counted ?? 0} counted${job.duplicates ? `, ${job.duplicates} duplicates` : ""}${job.periods.length ? ` · ${job.periods.map(periodLabel).join(", ")}` : ""}` : ` · ${job.status === "failed" ? "Failed" : job.status === "needs_mapping" ? "Waiting for columns" : "In progress"}`}
                  </div>
                </div>
                {job.status !== "running" && job.status !== "queued" && (
                  <button type="button" className="fv-button-ghost h-8 shrink-0 px-3 text-xs" onClick={() => setRemoving(job)}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Remove</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={dialog != null} onOpenChange={value => { if (!value) setDialog(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{dialog === "approve" ? `Approve ${periodLabel(period)}` : "Withdraw approval"}</DialogTitle>
            <DialogDescription>{dialog === "approve" ? "Your name and the time are recorded. If a later import or decision changes this month, the approval stops applying." : "Say why, so the history makes sense later."}</DialogDescription>
          </DialogHeader>
          <textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={2000} aria-label="Approval note" placeholder={dialog === "approve" ? "Note (optional)" : "Reason (required)"} className="w-full rounded-lg border border-border bg-background p-2 text-sm" />
          {error && <Notice tone="error">{error}</Notice>}
          <DialogFooter className="gap-2 sm:gap-0">
            <button type="button" className="fv-button-ghost" onClick={() => setDialog(null)}>Cancel</button>
            <button type="button" className="fv-button-primary" disabled={dialog === "reopen" && !note.trim()} onClick={() => void decide()}>{dialog === "approve" ? <><CheckCircle2 className="h-4 w-4" aria-hidden="true" />Approve</> : "Withdraw approval"}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removing != null} onOpenChange={value => { if (!value) setRemoving(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this import?</DialogTitle>
            <DialogDescription>Its transactions, review items and stored files are deleted. Decisions on them are lost, and an approved month that used them stops being approved. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <button type="button" className="fv-button-ghost" onClick={() => setRemoving(null)}>Keep it</button>
            <button type="button" className="fv-button-primary !bg-red-600 hover:!bg-red-700" onClick={() => removing && void remove(removing)}>Remove import</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
