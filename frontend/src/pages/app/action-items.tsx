/**
 * Action Items — merged CA Review Queue + Reports into one page.
 * Two tabs: "CA Review" and "Reports". The primary CTA "Generate full CA pack"
 * lives in the header and is always visible regardless of which tab is active.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  ClipboardList, CheckCircle, XCircle, FileQuestion, MessageSquare,
  BarChart3, Download, Loader2, Package, AlertTriangle,
} from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import StatusBadge from "@/components/app/StatusBadge";
import { severityColor, formatDateTime } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Types ────────────────────────────────────────────────────────────────────
interface CaReviewItem {
  id: number;
  entityType: string;
  entityId?: number | null;
  title: string;
  description?: string | null;
  severity: string;
  status: string;
  founderNote?: string | null;
  caNote?: string | null;
  createdAt: string;
}

const ACTION_BUTTONS = [
  { action: "approve",  label: "Approve",      icon: CheckCircle,   color: "bg-success/10 text-success hover:bg-success/20" },
  { action: "reject",   label: "Reject",        icon: XCircle,       color: "bg-destructive/10 text-destructive hover:bg-destructive/20" },
  { action: "request",  label: "Request Doc",   icon: FileQuestion,  color: "fv-status-review hover:opacity-85" },
  { action: "resolve",  label: "Resolve",       icon: CheckCircle,   color: "bg-muted text-muted-foreground hover:bg-muted/80" },
];

// ─── Generate CA Pack button (shared across tabs) ─────────────────────────────
function GenerateCaPackButton() {
  const { toast } = useToast();
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`${BASE}/api/reconciliation/finalize`, { method: "POST" });
      const data = await res.json() as { ok: boolean; approved: number; pending: number; message: string };
      if (data.pending > 0) {
        toast({
          title: `${data.pending} items still pending`,
          description: data.message,
          variant: "destructive",
        });
      } else {
        toast({
          title: "✓ CA pack ready",
          description: `${data.approved} matches approved. Download from Reports tab.`,
        });
      }
    } catch {
      toast({ title: "Could not generate pack", description: "Check API connection.", variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleGenerate}
      disabled={generating}
      className="fv-button-primary"
    >
      {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Package className="h-4 w-4" />}
      Generate full CA pack
    </button>
  );
}

// ─── CA Review Tab ─────────────────────────────────────────────────────────────
function CaReviewTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState("pending");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [note, setNote] = useState("");

  const { data = [], isLoading } = useQuery<CaReviewItem[]>({
    queryKey: ["caReview"],
    queryFn: () => fetch(`${BASE}/api/ca-review`).then(r => r.json()),
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action, n }: { id: number; action: string; n?: string }) =>
      fetch(`${BASE}/api/ca-review/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: n }),
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["caReview"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      setNote("");
      setSelectedId(null);
      toast({ title: "Action applied", description: "Review item updated." });
    },
  });

  const filtered = statusFilter === "all" ? data : data.filter(i => i.status === statusFilter);
  const pending = data.filter(i => i.status === "pending").length;

  return (
    <div>
      {/* Status filter pills */}
      <div className="mb-5 flex flex-wrap gap-2">
        {["pending", "all", "approved", "rejected", "document_requested", "resolved"].map(f => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={`relative px-3 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize ${
              statusFilter === f
                ? "fv-brand-accent-bg"
                : "bg-card border border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.replace(/_/g, " ")}
            {f === "pending" && pending > 0 && (
              <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white">
                {pending}
              </span>
            )}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-muted-foreground text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-card border border-border rounded-xl py-16 text-center">
          <ClipboardList className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <div className="font-semibold text-foreground">No items in queue</div>
          <p className="text-sm text-muted-foreground mt-1">
            {statusFilter === "pending" ? "All caught up — no pending items." : "No items match this filter."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((item, i) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.03 * i }}
              className="bg-card border border-border rounded-xl overflow-hidden"
            >
              <div className="p-5">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <span className={`mt-0.5 shrink-0 px-2 py-0.5 rounded text-xs font-semibold border ${severityColor(item.severity)} uppercase`}>
                      {item.severity}
                    </span>
                    <div>
                      <div className="font-semibold text-sm mb-0.5">{item.title}</div>
                      <div className="text-xs text-muted-foreground capitalize">
                        {item.entityType.replace(/_/g, " ")} {item.entityId ? `#${item.entityId}` : ""} · {formatDateTime(item.createdAt)}
                      </div>
                    </div>
                  </div>
                  <StatusBadge status={item.status} />
                </div>

                {item.description && (
                  <p className="text-sm text-muted-foreground mb-3 border-l-2 border-border pl-3">{item.description}</p>
                )}

                <div className="flex flex-wrap gap-2 mt-0.5">
                  {item.founderNote && (
                    <div className="fv-status-missing flex items-start gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border max-w-full">
                      <MessageSquare className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span><strong>Founder:</strong> {item.founderNote}</span>
                    </div>
                  )}
                  {item.caNote && (
                    <div className="fv-status-review flex items-start gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border max-w-full">
                      <MessageSquare className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span><strong>CA:</strong> {item.caNote}</span>
                    </div>
                  )}
                </div>

                {item.status === "pending" && (
                  <div className="mt-4 pt-3 border-t border-border">
                    <AnimatePresence mode="wait">
                      {selectedId === item.id ? (
                        <motion.div
                          key="expanded"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="space-y-2"
                        >
                          <textarea
                            value={note}
                            onChange={e => setNote(e.target.value)}
                            placeholder="Add a CA note (optional)…"
                            rows={2}
                            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                          />
                          <div className="flex gap-2 flex-wrap">
                            {ACTION_BUTTONS.map(btn => {
                              const Icon = btn.icon;
                              return (
                                <button
                                  key={btn.action}
                                  onClick={() => actionMutation.mutate({ id: item.id, action: btn.action, n: note || undefined })}
                                  disabled={actionMutation.isPending}
                                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${btn.color}`}
                                >
                                  <Icon className="w-3.5 h-3.5" />
                                  {btn.label}
                                </button>
                              );
                            })}
                            <button onClick={() => setSelectedId(null)} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
                              Cancel
                            </button>
                          </div>
                        </motion.div>
                      ) : (
                        <motion.button
                          key="collapsed"
                          onClick={() => setSelectedId(item.id)}
                          className="text-xs text-primary font-medium hover:underline flex items-center gap-1"
                        >
                          <CheckCircle className="w-3.5 h-3.5" />
                          Take action
                        </motion.button>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Reports Tab (inline summary — links out to full report page) ──────────────
function ReportsTab() {
  const { toast } = useToast();

  const reportLinks = [
    { label: "Bank Reconciliation Report",   desc: "Matched / unmatched bank transactions vs invoices & ledger",  href: "/app/reconciliation" },
    { label: "Ledger Match Report",          desc: "Tally / Zoho export vs bank transactions",                    href: "/app/ledger-match" },
    { label: "GST / TDS Risk Report",        desc: "Flags, mismatches and exposure items",                        href: "/app/gst-tds-risks" },
    { label: "Payroll Reconciliation",       desc: "Salary disbursements vs bank debits",                          href: "/app/payroll" },
    { label: "Gateway Settlement Report",    desc: "Razorpay / Cashfree credits vs bank credits",                 href: "/app/gateway-settlements" },
    { label: "Trial Balance",                desc: "Aggregated debit / credit balances by ledger account",         href: "/app/trial-balance" },
  ];

  const handleExport = async (label: string) => {
    toast({ title: `Exporting ${label}…`, description: "Download will start shortly." });
    try {
      const res = await fetch(`${BASE}/api/reports/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportType: label }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${label.replace(/\s+/g, "_")}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        toast({ title: "Export not available yet", description: "Use the individual report page to export.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Export failed", description: "Try again or use the individual page.", variant: "destructive" });
    }
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {reportLinks.map((r, i) => (
        <motion.div
          key={r.href}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.04 * i }}
          className="fv-card-flat rounded-xl p-5 flex flex-col gap-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-foreground">{r.label}</div>
              <div className="mt-1 text-xs text-muted-foreground leading-5">{r.desc}</div>
            </div>
            <BarChart3 className="h-5 w-5 shrink-0 text-primary/50 mt-0.5" />
          </div>
          <div className="flex gap-2 mt-auto pt-1">
            <a
              href={r.href}
              className="flex-1 rounded-lg border border-primary/20 bg-primary/5 px-3 py-1.5 text-center text-xs font-semibold text-primary hover:bg-primary/10 transition-colors"
            >
              View report
            </a>
            <button
              type="button"
              onClick={() => handleExport(r.label)}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:border-primary/30 hover:text-foreground transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </button>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function ActionItemsPage() {
  const [tab, setTab] = useState<"review" | "reports">("review");

  const { data: caItems = [] } = useQuery<CaReviewItem[]>({
    queryKey: ["caReview"],
    queryFn: () => fetch(`${BASE}/api/ca-review`).then(r => r.json()),
  });

  const pendingCount = caItems.filter(i => i.status === "pending").length;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader
          title="Action Items"
          subtitle="CA review queue, pending decisions, and downloadable reports"
        />
        <div className="shrink-0">
          <GenerateCaPackButton />
        </div>
      </div>

      {/* Tab switcher */}
      <div className="mb-6 flex items-center gap-1 rounded-xl border border-border bg-muted/30 p-1">
        <button
          type="button"
          onClick={() => setTab("review")}
          className={`relative flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            tab === "review" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <ClipboardList className="h-4 w-4" />
          CA Review Queue
          {pendingCount > 0 && (
            <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-bold text-white">
              {pendingCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab("reports")}
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            tab === "reports" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <BarChart3 className="h-4 w-4" />
          Reports
        </button>
      </div>

      {/* Pending alert banner */}
      {tab === "review" && pendingCount > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-5 flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/8 px-4 py-3"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <div className="text-sm">
            <strong className="text-foreground">{pendingCount} item{pendingCount > 1 ? "s" : ""} need CA action</strong>
            <span className="text-muted-foreground"> — Review before generating the CA pack.</span>
          </div>
        </motion.div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, x: tab === "review" ? -12 : 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: tab === "review" ? 12 : -12 }}
          transition={{ duration: 0.18 }}
        >
          {tab === "review" ? <CaReviewTab /> : <ReportsTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
