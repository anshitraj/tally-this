import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ShieldCheck, AlertTriangle, ArrowUpRight, Building2, Plus, X, Loader2 } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { PageTransition } from "@/components/app/finverify-ui";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ClientSummary {
  companyId: number | null;
  linkId: number | null;
  name: string;
  source: "tally" | "demo";
  flagged: number;
  total: number;
  highSeverity: number;
  byCategory: Record<string, number>;
  topClauses: { clause: string; title: string; count: number; severity: string }[];
}

interface PracticeData {
  ok: boolean;
  source: "links" | "demo";
  clients: ClientSummary[];
  totals: { clients: number; flagged: number; highSeverity: number; needsAttention: number };
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "default" }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className={`text-3xl font-bold ${tone === "danger" && value > 0 ? "text-red-600" : ""}`}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default function PracticePage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  const { data, isLoading } = useQuery<PracticeData>({
    queryKey: ["practice-clients"],
    queryFn: () => fetch(`${BASE}/api/practice/clients`).then(r => r.json()),
  });

  const addMutation = useMutation({
    mutationFn: async (name: string) => {
      const r = await fetch(`${BASE}/api/practice/clients`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.ok) throw new Error(body?.error || "Add failed");
    },
    onSuccess: () => {
      toast({ title: "Client linked" });
      setNewName(""); setAdding(false);
      qc.invalidateQueries({ queryKey: ["practice-clients"] });
    },
    onError: (e: Error) => toast({ title: "Could not add client", description: e.message, variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (linkId: number) => {
      const r = await fetch(`${BASE}/api/practice/clients/${linkId}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Remove failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["practice-clients"] }),
    onError: (e: Error) => toast({ title: "Could not remove", description: e.message, variant: "destructive" }),
  });

  const openClient = (c: ClientSummary) => {
    if (c.companyId && c.companyId > 0) navigate(`/app/tax-audit?client=${c.companyId}&name=${encodeURIComponent(c.name)}`);
    else navigate("/app/tax-audit");
  };

  return (
    <PageTransition className="mx-auto max-w-6xl">
      <PageHeader
        title="Practice Console"
        subtitle={data ? `${data.totals.clients} clients · ${data.totals.flagged} total flags · ${data.totals.needsAttention} need attention` : "Loading your client book…"}
        actions={
          <button type="button" onClick={() => setAdding(v => !v)} className="fv-button-primary">
            <Plus className="h-4 w-4" /> Add client
          </button>
        }
      />

      {adding && (
        <form
          onSubmit={e => { e.preventDefault(); if (newName.trim()) addMutation.mutate(newName.trim()); }}
          className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3"
        >
          <input
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Client company name"
            className="h-10 flex-1 min-w-[220px] rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/50"
          />
          <button type="submit" disabled={addMutation.isPending || !newName.trim()} className="fv-button-primary disabled:opacity-60">
            {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Link client
          </button>
          <button type="button" onClick={() => { setAdding(false); setNewName(""); }} className="fv-button-secondary">Cancel</button>
        </form>
      )}

      {data?.source === "demo" && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Showing <strong>demo clients</strong>. Link client companies to your CA workspace to scrutinise their real books here.
        </div>
      )}

      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Scrutinising every client…</div>
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-4">
            <Stat label="Clients" value={data?.totals.clients ?? 0} />
            <Stat label="Total flags" value={data?.totals.flagged ?? 0} />
            <Stat label="High-severity" value={data?.totals.highSeverity ?? 0} tone="danger" />
            <Stat label="Need attention" value={data?.totals.needsAttention ?? 0} tone="danger" />
          </div>

          <div className="space-y-3">
            {(data?.clients ?? []).map(c => (
              <div
                key={`${c.name}-${c.companyId}`}
                role="button"
                tabIndex={0}
                onClick={() => openClient(c)}
                onKeyDown={e => { if (e.key === "Enter") openClient(c); }}
                className="group flex w-full cursor-pointer flex-col gap-3 rounded-2xl border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:shadow-md sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3">
                  <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${c.highSeverity > 0 ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-600"}`}>
                    <Building2 className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="font-semibold">{c.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span>{c.flagged}/{c.total} checks flagged</span>
                      {c.highSeverity > 0 && <span className="rounded-full bg-red-50 px-2 py-0.5 font-semibold text-red-600">{c.highSeverity} high</span>}
                      {Object.entries(c.byCategory).map(([cat, n]) => (
                        <span key={cat} className="rounded-full bg-muted px-2 py-0.5">{cat.split(" ")[0]}: {n}</span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="hidden max-w-xs flex-wrap justify-end gap-1 lg:flex">
                    {c.topClauses.map(tc => (
                      <span key={tc.clause + tc.title} className="rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">{tc.clause}</span>
                    ))}
                  </div>
                  <span className="flex items-center gap-1 text-sm font-semibold text-primary opacity-0 transition group-hover:opacity-100">
                    Open <ArrowUpRight className="h-4 w-4" />
                  </span>
                  {c.linkId != null && (
                    <button
                      type="button"
                      title="Unlink client"
                      onClick={e => { e.stopPropagation(); removeMutation.mutate(c.linkId!); }}
                      className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-red-600"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Each client is scrutinised with the same 20 tax-audit checks. Open a client to drill into its findings and export an evidence pack.
          </div>
        </>
      )}
    </PageTransition>
  );
}
