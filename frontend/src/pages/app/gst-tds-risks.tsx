import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle, Shield } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import StatusBadge from "@/components/app/StatusBadge";
import { formatCurrencyFull, severityColor } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface RiskFlag {
  id: number;
  entityType: string;
  entityId?: number | null;
  category: string;
  severity: string;
  reason: string;
  suggestedAction: string;
  status: string;
  createdAt: string;
}

interface GstRecord {
  id: number;
  period: string;
  sourceType: string;
  gstin?: string | null;
  counterpartyName?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  taxableValue: number;
  gstAmount: number;
  matchStatus: string;
  riskStatus: string;
}

export default function GstTdsRisksPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [severity, setSeverity] = useState("all");
  const [category, setCategory] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");

  const { data = [], isLoading } = useQuery<RiskFlag[]>({
    queryKey: ["risks"],
    queryFn: () => fetch(`${BASE}/api/risks`).then(r => r.json()),
  });
  const { data: gstRecords = [], isLoading: gstLoading } = useQuery<GstRecord[]>({
    queryKey: ["gstRecords"],
    queryFn: () => fetch(`${BASE}/api/gst-records`).then(r => r.json()),
  });

  const resolveMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`${BASE}/api/risks/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["risks"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      toast({ title: "Risk resolved", description: "Flag marked as resolved." });
    },
  });

  const filtered = data.filter(r => {
    const matchSeverity = severity === "all" || r.severity === severity;
    const matchCategory = category === "all" || r.category === category;
    const matchStatus = statusFilter === "all" || r.status === statusFilter;
    return matchSeverity && matchCategory && matchStatus;
  });

  const high = data.filter(r => r.severity === "high" && r.status === "open").length;
  const medium = data.filter(r => r.severity === "medium" && r.status === "open").length;
  const low = data.filter(r => r.severity === "low" && r.status === "open").length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="GST / TDS Risk Flags"
        subtitle="Structured GST/TDS records and potential risks before CA review"
      />

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: "High Risk", count: high, color: "bg-red-50 border-red-200 text-red-700", dot: "bg-red-500" },
          { label: "Medium Risk", count: medium, color: "fv-status-missing", dot: "fv-brand-accent-bg" },
          { label: "Low Risk", count: low, color: "fv-status-review", dot: "fv-brand-secondary-bg" },
        ].map(s => (
          <div key={s.label} className={`${s.color} border rounded-xl p-4 flex items-center gap-3`}>
            <div className={`w-3 h-3 rounded-full ${s.dot} flex-shrink-0`} />
            <div>
              <div className="text-2xl font-bold">{s.count}</div>
              <div className="text-xs">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden mb-6">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Structured GST / TDS Data</div>
            <div className="text-xs text-muted-foreground">From uploaded GST 2B/3B/TDS files. Potential risk — needs CA review.</div>
          </div>
          <div className="text-xs text-muted-foreground">{gstRecords.length} records</div>
        </div>
        {gstLoading ? (
          <div className="p-6 text-sm text-muted-foreground text-center">Loading GST/TDS records...</div>
        ) : gstRecords.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground text-center">No structured GST/TDS records yet. Upload GST/TDS files to create records.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-3">Period</th>
                  <th className="text-left font-medium px-4 py-3">Source</th>
                  <th className="text-left font-medium px-4 py-3">Counterparty</th>
                  <th className="text-left font-medium px-4 py-3">Invoice</th>
                  <th className="text-right font-medium px-4 py-3">Taxable</th>
                  <th className="text-right font-medium px-4 py-3">GST/TDS</th>
                  <th className="text-left font-medium px-4 py-3">Match</th>
                  <th className="text-left font-medium px-4 py-3">Risk</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {gstRecords.map(record => (
                  <tr key={record.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3 whitespace-nowrap">{record.period}</td>
                    <td className="px-4 py-3 uppercase text-xs text-muted-foreground">{record.sourceType}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{record.counterpartyName ?? "Unknown"}</div>
                      <div className="text-xs text-muted-foreground font-mono">{record.gstin ?? "GSTIN missing"}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs">{record.invoiceNumber ?? "Missing"}</div>
                      <div className="text-xs text-muted-foreground">{record.invoiceDate ?? "-"}</div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{formatCurrencyFull(record.taxableValue)}</td>
                    <td className="px-4 py-3 text-right font-mono">{formatCurrencyFull(record.gstAmount)}</td>
                    <td className="px-4 py-3"><StatusBadge status={record.matchStatus} /></td>
                    <td className="px-4 py-3"><StatusBadge status={record.riskStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <select
          value={severity}
          onChange={e => setSeverity(e.target.value)}
          className="px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none"
        >
          <option value="all">All Severities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          className="px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none"
        >
          <option value="all">All Categories</option>
          <option value="gst">GST</option>
          <option value="tds">TDS</option>
          <option value="invoice">Invoice</option>
          <option value="bank">Bank</option>
        </select>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>

      {/* Risk list */}
      {isLoading ? (
        <div className="py-10 text-center text-muted-foreground text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-card border border-border rounded-xl py-16 text-center">
          <Shield className="w-10 h-10 text-success/40 mx-auto mb-3" />
          <div className="font-medium">No risks found</div>
          <p className="text-sm text-muted-foreground mt-1">All compliance flags resolved or no issues detected.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((r, i) => (
            <motion.div
              key={r.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.03 * i }}
              className="bg-card border border-border rounded-xl p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div className={`mt-0.5 flex-shrink-0 px-2 py-0.5 rounded text-xs font-semibold border ${severityColor(r.severity)} uppercase tracking-wide`}>
                    {r.severity}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-sm font-semibold">{r.reason}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wide">{r.category}</span>
                    </div>
                    <div className="flex items-start gap-2 text-sm text-muted-foreground">
                      <AlertTriangle className="fv-text-brand-accent w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <span>{r.suggestedAction}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <StatusBadge status={r.status} />
                  {r.status === "open" && (
                    <button
                      onClick={() => resolveMutation.mutate(r.id)}
                      disabled={resolveMutation.isPending}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-success/10 text-success font-medium rounded-lg hover:bg-success/20 transition-colors"
                    >
                      <CheckCircle className="w-3.5 h-3.5" />
                      Resolve
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
