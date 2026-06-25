import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, X, AlertTriangle, FileSpreadsheet, ChevronRight } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { PageTransition } from "@/components/app/finverify-ui";

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

export default function TaxAuditPage() {
  const [openCheck, setOpenCheck] = useState<string | null>(null);

  const { data, isLoading } = useQuery<TaxAuditIndex>({
    queryKey: ["tax-audit"],
    queryFn: () => fetch(`${BASE}/api/tax-audit`).then(r => r.json()),
  });

  const { data: detail } = useQuery<{ ok: boolean; check: CheckDetail }>({
    queryKey: ["tax-audit-detail", openCheck],
    queryFn: () => fetch(`${BASE}/api/tax-audit/${openCheck}`).then(r => r.json()),
    enabled: Boolean(openCheck),
  });

  return (
    <PageTransition className="mx-auto max-w-6xl">
      <PageHeader
        title="Tax Audit & Ledger Scrutiny"
        subtitle={data
          ? `FY ending ${data.fyEnd} · ${data.stats.flagged} of ${data.stats.total} checks flagged · ${data.stats.highSeverity} high-severity`
          : "Loading ledger scrutiny…"}
      />

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
              <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileSpreadsheet className="h-3.5 w-3.5" /> {detail.check.rows.length} row(s) · export via Reports → CA-ready pack
              </div>
            )}
          </div>
        </div>
      )}
    </PageTransition>
  );
}
