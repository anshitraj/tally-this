import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Upload, BadgeIndianRupee, CheckCircle2, AlertTriangle, FileX2, FileQuestion } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { PageTransition, EmptyState } from "@/components/app/finverify-ui";
import { formatCurrencyFull } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ReconResult {
  ok: boolean;
  period: string;
  summary: { matched: number; valueMismatches: number; missingInBooks: number; missingIn2B: number; itcAtRisk: number; itcGain: number };
  results: Array<{
    status: "matched" | "value_mismatch" | "missing_in_books" | "missing_in_2b" | "gstin_mismatch";
    supplierGstin: string;
    invoiceNumber: string;
    bookValue: number | null;
    portalValue: number | null;
    bookGst: number | null;
    portalGst: number | null;
    itcImpact: number;
    explanation: string;
  }>;
}

const STATUS_LABELS: Record<string, { label: string; tone: string; icon: typeof CheckCircle2 }> = {
  matched: { label: "Matched", tone: "fv-status-verified", icon: CheckCircle2 },
  value_mismatch: { label: "Value mismatch", tone: "fv-status-review", icon: AlertTriangle },
  missing_in_books: { label: "Missing in books", tone: "fv-status-missing", icon: FileQuestion },
  missing_in_2b: { label: "Missing in 2B (ITC at risk)", tone: "fv-status-risk", icon: FileX2 },
  gstin_mismatch: { label: "GSTIN mismatch", tone: "fv-status-risk", icon: AlertTriangle },
};

export default function Gstr2bReconPage() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [period, setPeriod] = useState<string>(new Date().toISOString().slice(0, 7));
  const [reconResult, setReconResult] = useState<ReconResult | null>(null);
  const [filter, setFilter] = useState<string>("all");

  const { data: rows = [], refetch } = useQuery<{ id: number; supplier_gstin: string; invoice_number: string; return_period: string }[]>({
    queryKey: ["gstr-2b", period],
    queryFn: () => fetch(`${BASE}/api/gstr-2b?period=${period}`).then(r => r.json()),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("period", period);
      const r = await fetch(`${BASE}/api/gstr-2b/upload`, { method: "POST", body: fd });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.detail || body?.error || "Upload failed");
      return body;
    },
    onSuccess: result => {
      toast({ title: "GSTR-2B uploaded", description: `${result.inserted} rows added for ${result.period}` });
      refetch();
    },
    onError: err => toast({ title: "Upload failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" }),
  });

  const reconMutation = useMutation({
    mutationFn: () => fetch(`${BASE}/api/gstr-2b/reconcile`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ period }),
    }).then(r => r.json() as Promise<ReconResult>),
    onSuccess: r => {
      setReconResult(r);
      toast({ title: "Reconciliation complete", description: `${r.summary.matched} matched, ${r.summary.missingIn2B} ITC-at-risk` });
    },
  });

  const filtered = reconResult?.results.filter(r => filter === "all" || r.status === filter) ?? [];

  return (
    <PageTransition className="mx-auto max-w-6xl">
      <PageHeader
        title="GSTR-2B Reconciliation"
        subtitle="Compare GSTR-2B (supplier filings on GST portal) with your purchase register. Flag ITC at risk."
        actions={
          <div className="flex items-center gap-2">
            <input type="month" value={period} onChange={e => setPeriod(e.target.value)} className="fv-input" />
            <input
              ref={fileRef}
              type="file"
              accept=".json,.csv"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) uploadMutation.mutate(f); e.currentTarget.value = ""; }}
            />
            <button type="button" onClick={() => fileRef.current?.click()} className="fv-button-secondary">
              <Upload className="h-4 w-4" /> Upload GSTR-2B
            </button>
            <button type="button" onClick={() => reconMutation.mutate()} disabled={rows.length === 0 || reconMutation.isPending} className="fv-button-primary disabled:opacity-50">
              <BadgeIndianRupee className="h-4 w-4" /> Reconcile
            </button>
          </div>
        }
      />

      <div className="fv-status-review mb-6 rounded-2xl border p-4 text-sm leading-6">
        Download GSTR-2B JSON from GST portal → Returns → GSTR-2B → JSON download. Upload here. We compare with your purchase invoices and flag mismatches. Potential ITC risk → needs CA review.
      </div>

      {rows.length === 0 && !reconResult ? (
        <EmptyState
          icon={BadgeIndianRupee}
          title="No GSTR-2B data uploaded"
          description="Upload GSTR-2B JSON (or CSV with columns: supplier_gstin, invoice_number, taxable_value, igst, cgst, sgst) for the selected period."
        />
      ) : (
        <>
          <div className="mb-4 grid gap-3 grid-cols-2 sm:grid-cols-5">
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="text-[11px] text-muted-foreground uppercase">2B records ({period})</div>
              <div className="mt-1 text-xl font-bold text-foreground">{rows.length}</div>
            </div>
            {reconResult && (
              <>
                <div className="rounded-xl border border-success/25 bg-success/5 p-3">
                  <div className="text-[11px] text-success uppercase">Matched</div>
                  <div className="mt-1 text-xl font-bold text-success">{reconResult.summary.matched}</div>
                </div>
                <div className="rounded-xl border border-warning/25 bg-warning/10 p-3">
                  <div className="text-[11px] text-warning uppercase">Value mismatch</div>
                  <div className="mt-1 text-xl font-bold text-warning">{reconResult.summary.valueMismatches}</div>
                </div>
                <div className="rounded-xl border border-destructive/25 bg-destructive/5 p-3">
                  <div className="text-[11px] text-destructive uppercase">ITC at risk</div>
                  <div className="mt-1 text-xl font-bold text-destructive">{formatCurrencyFull(reconResult.summary.itcAtRisk)}</div>
                </div>
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
                  <div className="text-[11px] text-blue-700 uppercase">Missing in books</div>
                  <div className="mt-1 text-xl font-bold text-blue-700">{reconResult.summary.missingInBooks}</div>
                </div>
              </>
            )}
          </div>

          {reconResult && (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                {["all", "missing_in_2b", "value_mismatch", "missing_in_books", "matched"].map(k => (
                  <button key={k} type="button" onClick={() => setFilter(k)}
                    className={filter === k ? "fv-button-primary capitalize text-xs" : "fv-button-secondary capitalize text-xs"}>
                    {k.replace(/_/g, " ")}
                  </button>
                ))}
              </div>

              <div className="fv-card-flat overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">GSTIN</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Invoice No</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Book Value</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Portal Value</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Book GST</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Portal GST</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r, i) => {
                      const meta = STATUS_LABELS[r.status];
                      const Icon = meta?.icon ?? AlertTriangle;
                      return (
                        <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/30">
                          <td className="px-3 py-2">
                            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta?.tone}`}>
                              <Icon className="h-3 w-3" /> {meta?.label}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">{r.supplierGstin}</td>
                          <td className="px-3 py-2 font-mono text-xs">{r.invoiceNumber}</td>
                          <td className="px-3 py-2 text-right font-mono">{r.bookValue !== null ? formatCurrencyFull(r.bookValue) : "—"}</td>
                          <td className="px-3 py-2 text-right font-mono">{r.portalValue !== null ? formatCurrencyFull(r.portalValue) : "—"}</td>
                          <td className="px-3 py-2 text-right font-mono">{r.bookGst !== null ? formatCurrencyFull(r.bookGst) : "—"}</td>
                          <td className="px-3 py-2 text-right font-mono">{r.portalGst !== null ? formatCurrencyFull(r.portalGst) : "—"}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">{r.explanation}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </PageTransition>
  );
}
