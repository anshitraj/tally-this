/**
 * Vendor Payment Aging
 * Shows unpaid AP invoices in aging buckets.
 * "Who hasn't been paid in >60 days?" — founders love this.
 */
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { AlertTriangle, Building2, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import PageHeader from "@/components/app/PageHeader";
import { PageTransition } from "@/components/app/finverify-ui";
import { formatCurrency } from "@/lib/format";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface VendorRow {
  vendor: string;
  current: number;
  b1_30: number;
  b31_60: number;
  b61_90: number;
  over90: number;
  total: number;
  invoiceCount: number;
  invoices: {
    invoice_number: string;
    amount: string;
    invoice_date: string;
    due_date: string;
    days_overdue: number;
    aging_bucket: string;
    status: string;
  }[];
}

interface AgingResponse {
  ok: boolean;
  asOf: string;
  vendors: VendorRow[];
  totals: { current: number; b1_30: number; b31_60: number; b61_90: number; over90: number; total: number };
  invoiceCount: number;
}

const BUCKETS = [
  { key: "current", label: "Current", color: "text-success", bg: "bg-success/10" },
  { key: "b1_30", label: "1–30 days", color: "text-warning", bg: "bg-warning/10" },
  { key: "b31_60", label: "31–60 days", color: "text-orange-600", bg: "bg-orange-50" },
  { key: "b61_90", label: "61–90 days", color: "text-red-500", bg: "bg-red-50" },
  { key: "over90", label: "90+ days", color: "text-destructive", bg: "bg-destructive/10" },
] as const;

function bucketColor(bucket: string): string {
  if (bucket === "current") return "text-success";
  if (bucket === "1_30") return "text-warning";
  if (bucket === "31_60") return "text-orange-600";
  if (bucket === "61_90") return "text-red-500";
  return "text-destructive font-semibold";
}

export default function VendorAgingPage() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sort, setSort] = useState<"total" | "over90">("total");

  const { data, isLoading, isError } = useQuery<AgingResponse>({
    queryKey: ["vendorAging"],
    queryFn: async () => {
      const response = await fetch(`${BASE}/api/vendor-aging`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || "Vendor aging failed");
      return body as AgingResponse;
    },
  });

  const sorted = [...(data?.vendors ?? [])].sort((a, b) => (sort === "over90" ? b.over90 - a.over90 : b.total - a.total));

  const criticalVendors = sorted.filter(v => v.over90 > 0);

  return (
    <PageTransition className="mx-auto max-w-6xl">
      <PageHeader
        title="Vendor Payment Aging"
        subtitle={`Unpaid AP invoices by age bucket · as of ${data?.asOf ?? "today"}`}
      />

      {/* Alert for 90+ day invoices */}
      {criticalVendors.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-5 flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <div className="text-sm">
            <strong className="text-destructive">{criticalVendors.length} vendor{criticalVendors.length > 1 ? "s" : ""}</strong>
            {" "}have invoices overdue by more than 90 days.{" "}
            <span className="text-muted-foreground">Review immediately to avoid supplier disputes.</span>
          </div>
        </motion.div>
      )}

      {/* Summary cards */}
      {data && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {BUCKETS.map(b => (
            <div key={b.key} className={`rounded-xl border border-border ${b.bg} p-4`}>
              <div className={`text-base font-bold ${b.color}`}>
                {formatCurrency(data.totals[b.key])}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{b.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Sort toggle */}
      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Sort by:</span>
        {[{ k: "total", l: "Total outstanding" }, { k: "over90", l: "Most overdue (90d+)" }].map(s => (
          <button
            key={s.k}
            type="button"
            onClick={() => setSort(s.k as typeof sort)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              sort === s.k
                ? "fv-brand-accent-bg"
                : "border border-border bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            {s.l}
          </button>
        ))}
      </div>

      {/* Vendor table */}
      {isLoading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading vendor aging…</div>
      ) : isError ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 py-16 text-center">
          <Building2 className="mx-auto mb-3 h-10 w-10 text-destructive/40" />
          <div className="font-semibold text-foreground">Vendor aging could not be loaded</div>
          <div className="mt-1 text-sm text-muted-foreground">Refresh after invoices are available for this workspace.</div>
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-xl border border-border py-16 text-center">
          <Building2 className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
          <div className="font-semibold text-foreground">No unpaid invoices</div>
          <div className="mt-1 text-sm text-muted-foreground">All vendor invoices are paid or have no due dates.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((vendor, i) => {
            const isOpen = expanded === vendor.vendor;
            return (
              <motion.div
                key={vendor.vendor}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.02 * i }}
                className="overflow-hidden rounded-xl border border-border bg-card"
              >
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : vendor.vendor)}
                  className="flex w-full items-center gap-4 p-4 text-left"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground truncate">{vendor.vendor || "Unknown vendor"}</span>
                      <span className="text-xs text-muted-foreground">{vendor.invoiceCount} invoice{vendor.invoiceCount > 1 ? "s" : ""}</span>
                      {vendor.over90 > 0 && (
                        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-bold text-destructive">
                          {formatCurrency(vendor.over90)} overdue 90d+
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-5 gap-2 text-right text-xs min-w-[320px] hidden md:grid">
                    {BUCKETS.map(b => (
                      <div key={b.key} className={vendor[b.key] > 0 ? b.color : "text-muted-foreground/40"}>
                        {vendor[b.key] > 0 ? formatCurrency(vendor[b.key]) : "—"}
                      </div>
                    ))}
                  </div>
                  <div className="shrink-0 font-bold text-foreground text-sm ml-4">
                    {formatCurrency(vendor.total)}
                  </div>
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                </button>

                {isOpen && (
                  <div className="border-t border-border px-4 py-3 bg-muted/20">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground">
                          <th className="pb-2 text-left font-medium">Invoice</th>
                          <th className="pb-2 text-left font-medium">Date</th>
                          <th className="pb-2 text-left font-medium">Due</th>
                          <th className="pb-2 text-right font-medium">Amount</th>
                          <th className="pb-2 text-right font-medium">Overdue</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vendor.invoices.map(inv => (
                          <tr key={inv.invoice_number} className="border-t border-border/50">
                            <td className="py-1.5 font-mono text-foreground">{inv.invoice_number}</td>
                            <td className="py-1.5 text-muted-foreground">{inv.invoice_date?.slice(0, 10) ?? "—"}</td>
                            <td className="py-1.5 text-muted-foreground">{inv.due_date?.slice(0, 10) ?? "—"}</td>
                            <td className="py-1.5 text-right font-semibold text-foreground">
                              {formatCurrency(parseFloat(inv.amount || "0"))}
                            </td>
                            <td className={`py-1.5 text-right ${bucketColor(inv.aging_bucket)}`}>
                              {inv.days_overdue > 0 ? `${inv.days_overdue}d` : "Current"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </motion.div>
            );
          })}

          {/* Column headers reminder */}
          <div className="hidden md:grid grid-cols-5 gap-2 px-4 py-1 text-right text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            {BUCKETS.map(b => <div key={b.key}>{b.label}</div>)}
          </div>
        </div>
      )}
    </PageTransition>
  );
}
