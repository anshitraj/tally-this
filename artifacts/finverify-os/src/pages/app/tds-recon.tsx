import { useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FileCheck, AlertTriangle, Upload, Loader2 } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { PageTransition } from "@/components/app/finverify-ui";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ReconRow {
  deductor: string; tan: string; section: string;
  as26: number; books: number; difference: number; status: string;
}
interface ReconResult {
  ok: boolean; source: "demo" | "upload";
  rows: ReconRow[];
  totals: { as26: number; books: number; difference: number; matched: number; mismatched: number };
}

const STATUS_TONE: Record<string, string> = {
  "Matched": "bg-emerald-50 text-emerald-700",
  "Short credit in books": "bg-amber-50 text-amber-700",
  "Excess in books": "bg-amber-50 text-amber-700",
  "Not in 26AS": "bg-red-50 text-red-700",
  "Not in books": "bg-red-50 text-red-700",
};

const inr = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

export default function TdsReconPage() {
  const { toast } = useToast();
  const as26Ref = useRef<HTMLInputElement>(null);
  const booksRef = useRef<HTMLInputElement>(null);
  const [as26File, setAs26File] = useState<File | null>(null);
  const [booksFile, setBooksFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<ReconResult | null>(null);

  const { data: demo, isLoading } = useQuery<ReconResult>({
    queryKey: ["tds-recon"],
    queryFn: () => fetch(`${BASE}/api/tax-audit/tds-recon`).then(r => r.json()),
  });

  const matchMutation = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("as26", as26File!);
      form.append("books", booksFile!);
      const r = await fetch(`${BASE}/api/tax-audit/tds-recon`, { method: "POST", body: form });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.ok) throw new Error(body?.error || "Match failed");
      return body as ReconResult;
    },
    onSuccess: (body) => { setUploaded(body); toast({ title: "Reconciliation complete", description: `${body.totals.mismatched} mismatches found.` }); },
    onError: (e: Error) => toast({ title: "Could not reconcile", description: e.message, variant: "destructive" }),
  });

  const data = uploaded ?? demo;

  return (
    <PageTransition className="mx-auto max-w-5xl">
      <PageHeader
        title="26AS vs Books — TDS Reconciliation"
        subtitle={data ? `26AS ₹${inr(data.totals.as26)} · Books ₹${inr(data.totals.books)} · ${data.totals.mismatched} mismatches` : "Loading…"}
      />

      {data?.source === "demo" && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Demo reconciliation. Upload your <strong>26AS</strong> and <strong>books TDS</strong> CSVs (columns: deductor, TAN, section, amount) to match real data.
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-4">
        <input ref={as26Ref} type="file" accept=".csv" className="hidden" onChange={e => setAs26File(e.target.files?.[0] ?? null)} />
        <input ref={booksRef} type="file" accept=".csv" className="hidden" onChange={e => setBooksFile(e.target.files?.[0] ?? null)} />
        <div>
          <div className="mb-1 text-xs font-semibold text-muted-foreground">Form 26AS (CSV)</div>
          <button type="button" onClick={() => as26Ref.current?.click()} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted">
            <Upload className="h-4 w-4" /> {as26File ? as26File.name.slice(0, 22) : "Choose 26AS file"}
          </button>
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold text-muted-foreground">Books / 26Q (CSV)</div>
          <button type="button" onClick={() => booksRef.current?.click()} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted">
            <Upload className="h-4 w-4" /> {booksFile ? booksFile.name.slice(0, 22) : "Choose books file"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => matchMutation.mutate()}
          disabled={!as26File || !booksFile || matchMutation.isPending}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {matchMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck className="h-4 w-4" />} Reconcile
        </button>
        {uploaded && <button type="button" onClick={() => setUploaded(null)} className="text-xs font-medium text-muted-foreground hover:underline">Reset to demo</button>}
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-border bg-card p-4"><div className="text-2xl font-bold text-emerald-600">{data?.totals.matched ?? 0}</div><div className="text-xs text-muted-foreground">Matched</div></div>
            <div className="rounded-2xl border border-border bg-card p-4"><div className="text-2xl font-bold text-red-600">{data?.totals.mismatched ?? 0}</div><div className="text-xs text-muted-foreground">Mismatched</div></div>
            <div className="rounded-2xl border border-border bg-card p-4"><div className="text-2xl font-bold">₹{inr(data?.totals.difference ?? 0)}</div><div className="text-xs text-muted-foreground">Net difference (26AS − Books)</div></div>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Deductor</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">TAN</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Section</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">26AS</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">Books</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">Difference</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((r, i) => (
                  <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium">{r.deductor || "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.tan || "—"}</td>
                    <td className="px-3 py-2">{r.section || "—"}</td>
                    <td className="px-3 py-2 text-right font-mono">{inr(r.as26)}</td>
                    <td className="px-3 py-2 text-right font-mono">{inr(r.books)}</td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${Math.abs(r.difference) < 1 ? "" : "text-red-600"}`}>{inr(r.difference)}</td>
                    <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[r.status] ?? "bg-muted"}`}>{r.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PageTransition>
  );
}
