import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CalendarDays, CheckCircle, FileCheck2, FolderOpen, HelpCircle, Send, XCircle, Zap } from "lucide-react";
import { useLocation } from "wouter";
import { APP_ROUTES } from "@/lib/routes";
import PageHeader from "@/components/app/PageHeader";
import StatusBadge from "@/components/app/StatusBadge";
import { ConfidenceBar, EmptyState, PageTransition } from "@/components/app/finverify-ui";
import ReconciliationGuide from "@/components/reconciliation/ReconciliationGuide";
import { formatCurrencyFull, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ReconciliationMatch {
  id: number;
  bankTransactionId?: number | null;
  invoiceId?: number | null;
  ledgerEntryId?: number | null;
  matchType: string;
  confidenceScore: number;
  reason: string;
  status: string;
  createdAt: string;
  bankTransaction?: {
    id: number; date: string; narration: string; amount: number;
    type: string; source: string; bankName?: string | null;
    reference?: string | null; status: string; confidenceScore: number;
    matchedInvoiceId?: number | null; note?: string | null;
  } | null;
  invoice?: {
    id: number; invoiceNumber: string; vendorName: string;
    customerName?: string | null; gstin?: string | null;
    date: string; amount: number; gstAmount?: number | null;
    type: string; paymentStatus: string; status: string;
    linkedTransactionId?: number | null;
  } | null;
}

interface RunResult {
  matchesFound: number;
  newVerified: number;
  newPotential: number;
  newUnverified: number;
  message: string;
  runId?: string;
}

interface ReconciliationFolder {
  runId: string;
  name: string;
  title: string;
  runType: string;
  status: string;
  createdAt: string;
  completedAt?: string | null;
  matchCount: number;
  sourceFiles: string[];
  sourceTypes: string[];
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-background p-4">
      <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

export default function ReconciliationPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState("all");
  const [confirmRunOpen, setConfirmRunOpen] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(() => {
    try { return localStorage.getItem("finverify.activeWorkspace"); } catch { return null; }
  });

  // Sync with global WorkspacePill selection
  useEffect(() => {
    const onChange = (e: Event) => setActiveRunId((e as CustomEvent).detail);
    window.addEventListener("workspace-changed", onChange);
    return () => window.removeEventListener("workspace-changed", onChange);
  }, []);

  const { data: folders = [] } = useQuery<ReconciliationFolder[]>({
    queryKey: ["reconciliation-runs"],
    queryFn: () => fetch(`${BASE}/api/reconciliation/runs`).then(r => r.json()),
  });

  useEffect(() => {
    if (!activeRunId && folders.some(folder => folder.matchCount > 0)) {
      setActiveRunId(folders.find(folder => folder.matchCount > 0)?.runId ?? null);
    }
  }, [activeRunId, folders]);

  const activeFolder = folders.find(folder => folder.runId === activeRunId) ?? null;

  const { data = [], isLoading } = useQuery<ReconciliationMatch[]>({
    queryKey: ["reconciliation", activeRunId ?? "all"],
    queryFn: () => fetch(`${BASE}/api/reconciliation${activeRunId ? `?runId=${encodeURIComponent(activeRunId)}` : ""}`).then(r => r.json()),
  });

  const runMutation = useMutation({
    mutationFn: () => fetch(`${BASE}/api/reconciliation/run`, { method: "POST" }).then(r => r.json()) as Promise<RunResult>,
    onSuccess: result => {
      qc.invalidateQueries({ queryKey: ["reconciliation"] });
      qc.invalidateQueries({ queryKey: ["reconciliation-runs"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      if (result.runId) setActiveRunId(result.runId);
      setConfirmRunOpen(false);
      toast({ title: "Reconciliation complete", description: result.message });
    },
  });

  const approveMutation = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/reconciliation/${id}/approve`, { method: "POST" }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reconciliation"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      toast({ title: "Match approved", description: "Transaction marked as verified." });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/reconciliation/${id}/reject`, { method: "POST" }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reconciliation"] });
      toast({ title: "Match rejected" });
    },
  });

  const needsInfoMutation = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/reconciliation/${id}/needs-info`, { method: "POST" }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reconciliation"] });
      toast({ title: "Marked: Needs more info", description: "Match moved to CA review queue." });
    },
  });

  const sendToCaMutation = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/reconciliation/${id}/send-to-ca`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reconciliation"] });
      qc.invalidateQueries({ queryKey: ["action-history"] });
      toast({ title: "Sent to CA review", description: "Item added to CA Review queue." });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/reconciliation/finalize`, { method: "POST" });
      const result = await r.json() as { ok: boolean; message: string; pending: number };
      if (!result.ok) return { result, pdfDownloaded: false };
      try {
        const pdfRes = await fetch(`${BASE}/api/reports/export-ca-pack?format=pdf`, {
          method: "POST",
          headers: { Accept: "application/pdf" },
        });
        if (pdfRes.ok) {
          const blob = await pdfRes.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `finverify-ca-pack-${new Date().toISOString().slice(0, 10)}.pdf`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          return { result, pdfDownloaded: true };
        }
      } catch {
        // fall through — JSON pack still available on Reports page
      }
      return { result, pdfDownloaded: false };
    },
    onSuccess: ({ result, pdfDownloaded }) => {
      qc.invalidateQueries({ queryKey: ["action-history"] });
      qc.invalidateQueries({ queryKey: ["reconciliation"] });
      toast({
        title: result.ok ? "CA-ready pack generated" : "Still pending review",
        description: pdfDownloaded ? `${result.message} PDF downloaded.` : result.message,
      });
      if (result.ok && !pdfDownloaded) navigate(APP_ROUTES.reports);
    },
  });

  const [, navigate] = useLocation();

  const filtered = filter === "all" ? data : data.filter(match => match.status === filter);
  const pending = data.filter(match => match.status === "pending").length;
  const approved = data.filter(match => match.status === "approved").length;
  const needsInfo = data.filter(match => match.status === "needs_info").length;

  return (
    <PageTransition className="mx-auto max-w-7xl">
      <PageHeader
        title={activeFolder?.name ?? "Reconciliation"}
        subtitle={`${data.length} suggested matches / ${pending} pending CA review / ${approved} approved / ${needsInfo} needs more info. Each match needs CA review before the final report.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setConfirmRunOpen(true)} disabled={runMutation.isPending} className="fv-button-secondary disabled:opacity-60">
              <Zap className="h-4 w-4" />
              {runMutation.isPending ? "Running..." : "Open preflight"}
            </button>
            <button
              type="button"
              onClick={() => finalizeMutation.mutate()}
              disabled={finalizeMutation.isPending || data.length === 0}
              className="fv-button-primary disabled:opacity-60"
              title={pending > 0 ? `${pending} pending review` : "All matches reviewed"}
            >
              <FileCheck2 className="h-4 w-4" />
              {finalizeMutation.isPending ? "Finalizing..." : "Generate CA-ready Report"}
            </button>
          </div>
        }
      />

      <ReconciliationGuide />

      <div className="mb-5 rounded-2xl border border-border bg-card">
        <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-semibold text-foreground">Reconciliation folders</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Each run is kept by date and source files, so Bank/Tally checks stay separate.
            </div>
          </div>
          <div className="text-xs text-muted-foreground">{folders.length} folder{folders.length === 1 ? "" : "s"}</div>
        </div>
        {folders.length === 0 ? (
          <div className="px-5 py-6 text-sm text-muted-foreground">No reconciliation folders yet. Run reconciliation to create Reconciliation 1.</div>
        ) : (
          <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">
            <button
              type="button"
              onClick={() => setActiveRunId(null)}
              className={`rounded-xl border p-4 text-left transition ${
                activeRunId === null ? "border-primary/40 bg-primary/5" : "border-border bg-background hover:border-primary/30"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <FolderOpen className="h-4 w-4 text-primary" />
                    All matches
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">Legacy and current reconciliation suggestions</div>
                </div>
                <span className="rounded-full border border-border bg-muted px-2 py-1 text-[11px] font-semibold text-muted-foreground">All</span>
              </div>
            </button>
            {folders.map(folder => {
              const active = folder.runId === activeRunId;
              const sourceLabel = folder.sourceFiles.length > 0
                ? folder.sourceFiles.slice(0, 2).join(" + ")
                : folder.sourceTypes.length > 0
                  ? folder.sourceTypes.join(" + ")
                  : "All imported records";
              return (
                <button
                  key={folder.runId}
                  type="button"
                  onClick={() => setActiveRunId(folder.runId)}
                  className={`rounded-xl border p-4 text-left transition ${
                    active ? "border-primary/40 bg-primary/5" : "border-border bg-background hover:border-primary/30"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <FolderOpen className="h-4 w-4 text-primary" />
                        {folder.name}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground" title={sourceLabel}>{sourceLabel}</div>
                    </div>
                    <StatusBadge status={folder.status} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <CalendarDays className="h-3.5 w-3.5" />
                      {formatDate(folder.createdAt)}
                    </span>
                    <span>{folder.matchCount} match{folder.matchCount === 1 ? "" : "es"}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {confirmRunOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-xl">
            <div className="text-base font-bold text-foreground">Run reconciliation preflight</div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              This will compare imported bank records against available invoices and ledger entries. For source-specific runs, use the Smart Next Step panel in Upload Center.
            </p>
            <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              {["Match by amount", "Match by date", "Match by party/vendor name", "Match by reference/UTR if available", "Detect unmatched bank transactions", "Detect missing documents"].map(option => (
                <label key={option} className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                  <input type="checkbox" checked readOnly className="accent-primary" />
                  {option}
                </label>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={() => setConfirmRunOpen(false)} className="fv-button-secondary">Cancel</button>
              <button type="button" onClick={() => runMutation.mutate()} disabled={runMutation.isPending} className="fv-button-primary">
                <Zap className="h-4 w-4" />
                Generate Reconciliation Report
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mb-5 flex flex-wrap gap-2">
        {["all", "pending", "approved", "rejected", "needs_info"].map(item => (
          <button
            key={item}
            type="button"
            onClick={() => setFilter(item)}
            className={filter === item ? "fv-button-primary capitalize" : "fv-button-secondary capitalize"}
          >
            {item}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading...</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No matches yet"
          description="Run reconciliation to generate suggested matches from existing bank, invoice, and ledger records."
        />
      ) : (
        <div className="space-y-4">
          {filtered.map(match => (
            <div key={match.id} className="fv-card-flat p-5">
              <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-semibold capitalize text-muted-foreground">{match.matchType} match</span>
                    <StatusBadge status={match.status} />
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{match.reason}</p>
                </div>
                <div className="flex items-center gap-3">
                  <ConfidenceBar score={match.confidenceScore} />
                  {(match.status === "pending" || match.status === "needs_info") && (
                    <>
                      <button type="button" onClick={() => approveMutation.mutate(match.id)} disabled={approveMutation.isPending} className="rounded-xl bg-success/10 p-2 text-success hover:bg-success/20" aria-label="Mark correct" title="Correct">
                        <CheckCircle className="h-4 w-4" />
                      </button>
                      <button type="button" onClick={() => rejectMutation.mutate(match.id)} disabled={rejectMutation.isPending} className="rounded-xl bg-destructive/10 p-2 text-destructive hover:bg-destructive/20" aria-label="Mark wrong" title="Wrong">
                        <XCircle className="h-4 w-4" />
                      </button>
                      <button type="button" onClick={() => needsInfoMutation.mutate(match.id)} disabled={needsInfoMutation.isPending} className="rounded-xl bg-warning/10 p-2 text-warning hover:bg-warning/20" aria-label="Needs more info" title="Needs more info">
                        <HelpCircle className="h-4 w-4" />
                      </button>
                      <button type="button" onClick={() => sendToCaMutation.mutate(match.id)} disabled={sendToCaMutation.isPending} className="fv-status-review rounded-xl p-2 hover:opacity-85" aria-label="Send to CA" title="Send to CA review">
                        <Send className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <DetailBlock title="Bank transaction">
                  {match.bankTransaction ? (
                    <div className="space-y-2 text-sm">
                      <div className="font-semibold">{match.bankTransaction.narration}</div>
                      <div className="flex justify-between gap-4 text-xs"><span className="text-muted-foreground">Date</span><span>{formatDate(match.bankTransaction.date)}</span></div>
                      <div className="flex justify-between gap-4 text-xs"><span className="text-muted-foreground">Amount</span><span className="font-mono font-semibold">{formatCurrencyFull(match.bankTransaction.amount)}</span></div>
                      <div className="flex justify-between gap-4 text-xs"><span className="text-muted-foreground">Reference</span><span className="font-mono">{match.bankTransaction.reference || "-"}</span></div>
                    </div>
                  ) : <div className="text-sm text-muted-foreground">Transaction unavailable</div>}
                </DetailBlock>

                <DetailBlock title="Suggested match">
                  <div className="space-y-3 text-sm">
                    <div className="flex items-center justify-between"><span className="text-muted-foreground">Confidence</span><ConfidenceBar score={match.confidenceScore} /></div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <span className="fv-status-verified rounded-lg px-2 py-1 font-medium">Amount match</span>
                      <span className="fv-status-review rounded-lg px-2 py-1 font-medium">Date proximity</span>
                      <span className="fv-status-missing rounded-lg px-2 py-1 font-medium">Name similarity</span>
                      <span className="rounded-lg bg-muted px-2 py-1 font-medium text-muted-foreground">UTR/reference</span>
                    </div>
                  </div>
                </DetailBlock>

                <DetailBlock title="Invoice / ledger">
                  {match.invoice ? (
                    <div className="space-y-2 text-sm">
                      <div className="font-mono text-xs font-semibold">{match.invoice.invoiceNumber}</div>
                      <div className="font-semibold">{match.invoice.vendorName}</div>
                      <div className="flex justify-between gap-4 text-xs"><span className="text-muted-foreground">Amount</span><span className="font-mono font-semibold">{formatCurrencyFull(match.invoice.amount)}</span></div>
                      <div className="flex justify-between gap-4 text-xs"><span className="text-muted-foreground">GSTIN</span><span className="font-mono">{match.invoice.gstin || "Missing"}</span></div>
                    </div>
                  ) : <div className="text-sm text-muted-foreground">No invoice linked. Ledger candidate may need CA review.</div>}
                </DetailBlock>
              </div>
            </div>
          ))}
        </div>
      )}
    </PageTransition>
  );
}
