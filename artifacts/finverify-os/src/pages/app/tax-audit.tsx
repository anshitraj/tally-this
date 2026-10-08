import { useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, X, AlertTriangle, FileSpreadsheet, ChevronRight, Upload, Loader2, RotateCcw, Download, Building2, ArrowLeft, Plug } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { PageTransition } from "@/components/app/finverify-ui";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface CheckSummary {
  id: string;
  clause: string;
  title: string;
  category: string;
  severity: "high" | "medium" | "low" | "info";
  count: number;
  description: string;
}

interface TaxAuditIndex {
  ok: boolean;
  source: "tally" | "demo";
  fyEnd: string;
  summary: CheckSummary[];
  stats: { flagged: number; total: number; highSeverity: number };
}

interface CheckDetail {
  id: string;
  clause: string;
  title: string;
  category: string;
  severity: string;
  description: string;
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: Record<string, string | number>[];
  notes?: string[];
}

const CATEGORIES = ["Debtors & Creditors", "Tax Audit Reporting", "Accounts Finalisation"] as const;

const SEVERITY_TONE: Record<string, string> = {
  high: "bg-red-50 text-red-700 border-red-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  low: "bg-blue-50 text-blue-700 border-blue-200",
  info: "bg-muted text-muted-foreground border-border",
};

function num(v: string | number): string {
  if (typeof v === "number") return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return v;
}

function downloadCsv(check: CheckDetail) {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = check.columns.map(c => esc(c.label)).join(",");
  const lines = check.rows.map(r => check.columns.map(c => esc(r[c.key] ?? "")).join(","));
  const csv = [header, ...lines].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${check.id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function TaxAuditPage() {
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const params = new URLSearchParams(useSearch());
  const client = params.get("client");
  const clientName = params.get("name");
  const clientQs = client ? `?client=${encodeURIComponent(client)}` : "";

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["tax-audit", client] });
    qc.invalidateQueries({ queryKey: ["tax-audit-detail"] });
    qc.invalidateQueries({ queryKey: ["monthly-close-workflow"] });
    qc.invalidateQueries({ queryKey: ["ledger"] });
    qc.invalidateQueries({ queryKey: ["reconciliation"] });
    qc.invalidateQueries({ queryKey: ["action-history"] });
  };

  const { data, isLoading } = useQuery<TaxAuditIndex>({
    queryKey: ["tax-audit", client],
    queryFn: () => fetch(`${BASE}/api/tax-audit${clientQs}`).then(r => r.json()),
  });

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch(`${BASE}/api/tax-audit/import${clientQs}`, { method: "POST", body: form });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.ok) throw new Error(body?.error || `Import failed (${r.status})`);
      return body as { counts?: Record<string, number> };
    },
    onSuccess: (body) => {
      const c = body.counts ?? {};
      toast({ title: "Tally data imported", description: `${c.ledgers ?? 0} ledgers, ${c.vouchers ?? 0} vouchers, ${c.ledgerEntries ?? 0} reconciliation rows.` });
      refresh();
    },
    onError: (e: Error) => toast({ title: "Import failed", description: e.message, variant: "destructive" }),
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/tax-audit/import${clientQs}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Reset failed");
    },
    onSuccess: () => {
      toast({ title: "Reverted to demo data" });
      refresh();
    },
  });

  const packMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/tax-audit/evidence-pack${clientQs}`, { method: "POST" });
      if (!r.ok) throw new Error(`Export failed (${r.status})`);
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition") || "";
      const name = /filename="?([^"]+)"?/.exec(cd)?.[1] || "TallyThis_Tax_Audit.xlsx";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    },
    onError: (e: Error) => toast({ title: "Export failed", description: e.message, variant: "destructive" }),
  });

  const { data: detail } = useQuery<{ ok: boolean; check: CheckDetail }>({
    queryKey: ["tax-audit-detail", openCheck, client],
    queryFn: () => fetch(`${BASE}/api/tax-audit/${openCheck}${clientQs}`).then(r => r.json()),
    enabled: Boolean(openCheck),
  });

  const [connectOpen, setConnectOpen] = useState(false);
  const [conn, setConn] = useState({ host: "localhost", port: "9000", company: clientName || "", fromDate: "2025-04-01", toDate: "2026-03-31" });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/tax-audit/connector/sync${clientQs}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...conn, port: Number(conn.port) }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.ok) throw new Error(body?.error || `Sync failed (${r.status})`);
      return body as { counts?: Record<string, number> };
    },
    onSuccess: (body) => {
      const c = body.counts ?? {};
      toast({ title: "Synced from Tally", description: `${c.ledgers ?? 0} ledgers, ${c.vouchers ?? 0} vouchers, ${c.ledgerEntries ?? 0} reconciliation rows pulled.` });
      setConnectOpen(false);
      refresh();
    },
    onError: (e: Error) => toast({ title: "Tally sync failed", description: e.message, variant: "destructive" }),
  });

  return (
    <PageTransition className="mx-auto max-w-6xl">
      <PageHeader
        title="Tax Audit & Ledger Scrutiny"
        subtitle={data
          ? `FY ending ${data.fyEnd} · ${data.stats.flagged} of ${data.stats.total} checks flagged · ${data.stats.highSeverity} high-severity`
          : "Loading ledger scrutiny…"}
      />

      {client && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm">
            <Building2 className="h-4 w-4 text-primary" />
            <span className="text-muted-foreground">Viewing client</span>
            <span className="font-bold text-foreground">{clientName || `#${client}`}</span>
          </div>
          <button
            type="button"
            onClick={() => navigate("/app/tax-audit")}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to my workspace
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".xml,text/xml,application/xml"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) importMutation.mutate(f); e.target.value = ""; }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={importMutation.isPending}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {importMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {importMutation.isPending ? "Importing…" : "Import Tally Export (XML)"}
        </button>
        <button
          type="button"
          onClick={() => setConnectOpen(true)}
          className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          <Plug className="h-4 w-4" /> Connect to Tally
        </button>
        <button
          type="button"
          onClick={() => packMutation.mutate()}
          disabled={packMutation.isPending}
          className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
        >
          {packMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Evidence Pack (Excel)
        </button>
        {data?.source === "tally" && (
          <button
            type="button"
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending}
            className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-60"
          >
            <RotateCcw className="h-4 w-4" /> Reset to demo
          </button>
        )}
        <span className="text-xs text-muted-foreground">Tally → Gateway of Tally → Display → Day Book → Alt+E → XML</span>
      </div>

      {data?.source === "demo" && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Showing <strong>demo data</strong>. Import a Tally export (or connect the Tally Connector) to scrutinise your own books.
        </div>
      )}

      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Running 20 audit checks…</div>
      ) : (
        <div className="space-y-8">
          {CATEGORIES.map(cat => {
            const checks = (data?.summary ?? []).filter(c => c.category === cat);
            if (checks.length === 0) return null;
            return (
              <section key={cat}>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted-foreground">
                  <ShieldCheck className="h-4 w-4" /> {cat}
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {checks.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setOpenCheck(c.id)}
                      className="group flex flex-col rounded-2xl border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:shadow-md"
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">{c.clause}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${SEVERITY_TONE[c.severity]}`}>
                          {c.count > 0 ? `${c.count} flagged` : "Clear"}
                        </span>
                      </div>
                      <div className="mb-1 flex items-center gap-1 font-semibold text-foreground">
                        {c.title}
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                      </div>
                      <p className="line-clamp-2 text-xs text-muted-foreground">{c.description}</p>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {connectOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConnectOpen(false)}>
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2 text-base font-bold"><Plug className="h-4 w-4 text-primary" /> Connect to Tally</div>
                <p className="mt-1 text-xs text-muted-foreground">Pull the Day Book live from a running Tally gateway — no manual export.</p>
              </div>
              <button type="button" onClick={() => setConnectOpen(false)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
            </div>
            <form onSubmit={e => { e.preventDefault(); syncMutation.mutate(); }} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="block"><span className="mb-1 block text-xs font-semibold text-muted-foreground">Host</span>
                  <input value={conn.host} onChange={e => setConn(c => ({ ...c, host: e.target.value }))} className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
                <label className="block"><span className="mb-1 block text-xs font-semibold text-muted-foreground">Port</span>
                  <input value={conn.port} onChange={e => setConn(c => ({ ...c, port: e.target.value }))} className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
              </div>
              <label className="block"><span className="mb-1 block text-xs font-semibold text-muted-foreground">Company (exact Tally name)</span>
                <input value={conn.company} onChange={e => setConn(c => ({ ...c, company: e.target.value }))} placeholder="As shown in Tally" className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block"><span className="mb-1 block text-xs font-semibold text-muted-foreground">From date</span>
                  <input type="date" value={conn.fromDate} onChange={e => setConn(c => ({ ...c, fromDate: e.target.value }))} className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
                <label className="block"><span className="mb-1 block text-xs font-semibold text-muted-foreground">To date</span>
                  <input type="date" value={conn.toDate} onChange={e => setConn(c => ({ ...c, toDate: e.target.value }))} className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
              </div>
              <div className="rounded-lg bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
                In Tally: F1 → Settings → Connectivity → enable "act as server" (default port 9000). Tally must be reachable from the API host.
              </div>
              <button type="submit" disabled={syncMutation.isPending || !conn.company.trim()} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                {syncMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Syncing…</> : <><Plug className="h-4 w-4" /> Sync now</>}
              </button>
            </form>
          </div>
        </div>
      )}

      {openCheck && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpenCheck(null)}>
          <div className="w-full max-w-4xl rounded-2xl border border-border bg-card p-5 shadow-xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">{detail?.check.clause}</span>
                  <span className="text-base font-bold text-foreground">{detail?.check.title}</span>
                </div>
                <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{detail?.check.description}</p>
              </div>
              <button type="button" onClick={() => setOpenCheck(null)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>

            {!detail ? (
              <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
            ) : detail.check.rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <ShieldCheck className="h-8 w-8 text-emerald-500" />
                <div className="text-sm font-medium text-foreground">No exceptions found</div>
                <div className="text-xs text-muted-foreground">This check passed — nothing to report.</div>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      {detail.check.columns.map(col => (
                        <th key={col.key} className={`px-3 py-2 font-medium text-muted-foreground ${col.numeric ? "text-right" : "text-left"}`}>{col.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.check.rows.map((row, i) => (
                      <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20">
                        {detail.check.columns.map(col => (
                          <td key={col.key} className={`px-3 py-2 ${col.numeric ? "text-right font-mono" : ""}`}>{num(row[col.key] ?? "—")}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {detail?.check.notes && detail.check.notes.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                {detail.check.notes.map((n, i) => <li key={i} className="flex gap-1.5"><span>•</span>{n}</li>)}
              </ul>
            )}

            {detail && detail.check.rows.length > 0 && (
              <div className="mt-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <FileSpreadsheet className="h-3.5 w-3.5" /> {detail.check.rows.length} row(s)
                </div>
                <button
                  type="button"
                  onClick={() => downloadCsv(detail.check)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  <Download className="h-3.5 w-3.5" /> Download CSV
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </PageTransition>
  );
}
