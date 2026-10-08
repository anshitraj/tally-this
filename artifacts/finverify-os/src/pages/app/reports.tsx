import React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Download,
  FileText,
  BarChart3,
  AlertTriangle,
  Users,
  CreditCard,
  ArrowUpRight,
  ChevronDown,
} from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { formatCurrencyFull } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ReportSummary {
  companyName: string;
  month: string;
  verificationScore: number;
  caReadyStatus: string;
  generatedAt: string;
  totalTransactions: number;
  verifiedTransactions: number;
  totalInvoices: number;
  missingInvoices: number;
  totalRisks: number;
  highRisks: number;
  totalPayroll: number;
  totalGatewaySettlements: number;
}

export default function ReportsPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data, isLoading } = useQuery<ReportSummary>({
    queryKey: ["reportSummary"],
    queryFn: () => fetch(`${BASE}/api/reports/summary`).then((r) => r.json()),
  });

  const [exportingType, setExportingType] = React.useState<string | null>(null);
  const [exportingPack, setExportingPack] = React.useState(false);

  const handleExport = async (type: string, store = false) => {
    setExportingType(type);
    try {
      const res = await fetch(
        `${BASE}/api/reports/export-csv?type=${type}${store ? "&store=true" : ""}`,
      );
      if (!res.ok) {
        toast({
          title: "Export failed",
          description: `Server returned ${res.status}. Please try again.`,
          variant: "destructive",
        });
        return;
      }
      const result = (await res.json()) as {
        data?: Record<string, unknown>[];
        rowCount?: number;
        storedExport?: unknown;
      };
      if (!result.data || result.data.length === 0) {
        toast({
          title: "No data to export",
          description: `No ${type.replace(/_/g, " ")} records yet. Upload and import files first.`,
          variant: "destructive",
        });
        return;
      }
      const headers = Object.keys(result.data[0]);
      const rows = result.data.map((row: Record<string, unknown>) =>
        headers
          .map((h) => {
            const v = row[h];
            if (v === null || v === undefined) return "";
            const str = String(v);
            return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
          })
          .join(","),
      );
      const csv = [headers.join(","), ...rows].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${type}_report.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast({
        title: "Exported",
        description:
          store && result.storedExport
            ? `${result.rowCount} ${type.replace(/_/g, " ")} records downloaded and stored.`
            : `${result.rowCount} ${type.replace(/_/g, " ")} records downloaded.`,
      });
    } catch {
      toast({
        title: "Export failed",
        description: "Could not generate export. Check your connection.",
        variant: "destructive",
      });
    } finally {
      setExportingType(null);
    }
  };

  const score = data?.verificationScore ?? 0;
  const scoreColor =
    score >= 85
      ? "text-success"
      : score >= 60
        ? "text-warning"
        : "text-destructive";

  const exports = [
    {
      type: "ca_ready",
      label: "CA-ready Report",
      icon: BarChart3,
      desc: "Verified transactions ready for CA handoff",
    },
    {
      type: "transactions",
      label: "Verified / Unverified Transactions",
      icon: FileText,
      desc: "All transactions with status and confidence scores",
    },
    {
      type: "invoices",
      label: "Invoices",
      icon: FileText,
      desc: "Purchase and sales invoices with GST details",
    },
    {
      type: "missing_invoices",
      label: "Missing Documents Report",
      icon: AlertTriangle,
      desc: "Transactions that need invoice or document collection",
    },
    {
      type: "risks",
      label: "Risk Flags Report",
      icon: AlertTriangle,
      desc: "Potential GST/TDS and workflow risks with suggested actions",
    },
    {
      type: "reconciliation",
      label: "Ledger Correction Suggestions",
      icon: CreditCard,
      desc: "Suggested matches and review decisions",
    },
    {
      type: "payroll",
      label: "Payroll Register",
      icon: Users,
      desc: "Employee-wise salary and payment details",
    },
  ];

  return (
    <div className="fv-reports-page fv-standard-page">
      <PageHeader
        title="Reports"
        subtitle="Download your saved job outputs or prepare a pack for CA review."
      />

      {/* CA Handoff section */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="fv-ca-handoff"
      >
        <div className="flex items-start gap-3">
          <BarChart3 className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <span className="fv-micro">THE NEXT STEP, IN ONE FILE</span>
            <h2>Prepare your CA review pack.</h2>
            <p className="text-xs text-muted-foreground mb-3">
              Bring your verified entries and review findings together in a PDF.
              TallyThis checks for open blockers before creating the pack.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={exportingPack}
                onClick={async () => {
                  setExportingPack(true);
                  try {
                    const response = await fetch(
                      `${BASE}/api/reports/export-ca-pack`,
                      {
                        method: "POST",
                        headers: { Accept: "application/pdf" },
                      },
                    );
                    if (!response.ok) {
                      const err = (await response.json().catch(() => ({}))) as {
                        blockers?: string[];
                      };
                      toast({
                        title: "CA Pack blocked",
                        description:
                          (err.blockers ?? []).join(" ") ||
                          "Resolve open items before exporting.",
                        variant: "destructive",
                      });
                      return;
                    }
                    const blob = await response.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    const month =
                      data?.month?.toLowerCase().replace(/\s+/g, "-") ??
                      "ca-pack";
                    a.download = `finverify-ca-pack-${month}.pdf`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    toast({
                      title: "CA Pack PDF downloaded",
                      description: "Potential risk — needs CA review.",
                    });
                  } catch {
                    toast({
                      title: "Download failed",
                      description: "Please try again.",
                      variant: "destructive",
                    });
                  } finally {
                    setExportingPack(false);
                  }
                }}
                className="fv-button-primary"
              >
                <FileText className="w-4 h-4" />
                {exportingPack
                  ? "Preparing your pack…"
                  : "Download CA review pack"}
              </button>
            </div>
          </div>
        </div>
      </motion.div>

      <button
        type="button"
        className="fv-saved-outputs"
        onClick={() => navigate("/app/history")}
      >
        <FileText size={18} />
        <span>
          Looking for a Tally file, GST draft or job report?
          <strong>Open your saved job outputs</strong>
        </span>
        <ArrowUpRight size={18} />
      </button>
      <details className="fv-report-advanced">
        <summary>
          More options <span>Individual reports and summaries</span>
          <ChevronDown size={16} />
        </summary>
        <div className="fv-report-advanced-content">
          {/* Existing summaries and specialist exports remain available on demand. */}
          {isLoading ? (
            <div className="py-8 text-center text-muted-foreground text-sm">
              Loading…
            </div>
          ) : (
            data && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-card border border-border rounded-xl p-6 mb-6"
              >
                <div className="flex items-start justify-between mb-6">
                  <div>
                    <div className="text-lg font-bold">{data.companyName}</div>
                    <div className="text-sm text-muted-foreground">
                      {data.month} · Generated{" "}
                      {new Date(data.generatedAt).toLocaleString("en-IN")}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-3xl font-bold ${scoreColor}`}>
                      {data.verificationScore}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Verification Score
                    </div>
                    <div
                      className={`text-xs font-semibold mt-0.5 ${scoreColor}`}
                    >
                      {data.caReadyStatus}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    {
                      label: "Verified Txns",
                      val: `${data.verifiedTransactions} / ${data.totalTransactions}`,
                      color: "text-success",
                    },
                    {
                      label: "Missing Invoices",
                      val: String(data.missingInvoices),
                      color: "fv-text-brand-accent",
                    },
                    {
                      label: "High-Risk Flags",
                      val: String(data.highRisks),
                      color: "text-destructive",
                    },
                    {
                      label: "Total Payroll",
                      val: formatCurrencyFull(data.totalPayroll),
                      color: "text-foreground",
                    },
                  ].map((s) => (
                    <div
                      key={s.label}
                      className="text-center p-3 rounded-lg bg-muted/30"
                    >
                      <div className={`text-xl font-bold ${s.color}`}>
                        {s.val}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {s.label}
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )
          )}

          {/* Export section */}
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="text-sm font-semibold mb-4 flex items-center gap-2">
              <Download className="w-4 h-4 text-primary" />
              Export Reports
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              {exports.map((ex, i) => {
                const Icon = ex.icon;
                return (
                  <motion.div
                    key={ex.type}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05 * i }}
                    className="flex items-center justify-between p-4 border border-border rounded-xl hover:bg-muted/20 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                        <Icon className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="text-sm font-medium">{ex.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {ex.desc}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleExport(ex.type)}
                      disabled={exportingType === ex.type}
                      className="fv-button-secondary shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label={`Download ${ex.label} as CSV`}
                    >
                      <Download className="w-3.5 h-3.5" />
                      CSV
                    </button>
                  </motion.div>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            className="fv-button-secondary mt-4"
            onClick={() => {
              void Promise.all(
                ["ca_ready", "missing_invoices", "risks", "reconciliation"].map(
                  (type) => handleExport(type, true),
                ),
              );
            }}
          >
            <Download size={15} />
            Export all CSVs
          </button>
        </div>
      </details>
    </div>
  );
}
