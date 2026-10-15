import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  ChevronDown,
  CreditCard,
  Download,
  FileSpreadsheet,
  FileText,
  History as HistoryIcon,
  Users,
} from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import EmptyPanel from "@/components/app/EmptyPanel";
import { Notice, downloadBlob } from "@/components/jobs/jobUi";
import { getActiveClient } from "@/lib/activeClient";
import { formatCurrencyFull } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { readJson } from "@/lib/api";

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

interface MonthOverview {
  ok: boolean;
  month: string;
  monthLabel: string;
  jobs: number;
  openItems: number;
  runs: Array<{ id: string; job: string; title: string; headline: string; total: number | null; attention: number | null; createdAt: string }>;
}

/** Calendar months, newest first, so a CA can go back to last month's work. */
function lastMonths(count = 6) {
  const now = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    return { value, label: date.toLocaleDateString("en-IN", { month: "short", year: "numeric" }) };
  });
}

/** Where to fix each reason the older month-close pack is blocked. */
function blockerAction(text: string): { label: string; href: string } {
  if (/reconciliation/i.test(text)) return { label: "Open Reconciliation", href: "/app/reconciliation" };
  if (/risk/i.test(text)) return { label: "Open GST and TDS risks", href: "/app/gst-tds-risks" };
  return { label: "Open CA review", href: "/app/ca-review" };
}

export default function ReportsPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const months = useMemo(() => lastMonths(), []);
  const [month, setMonth] = useState(months[0].value);
  const [packing, setPacking] = useState(false);
  const [exportingType, setExportingType] = useState<string | null>(null);
  const [exportingPack, setExportingPack] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [blockers, setBlockers] = useState<string[]>([]);
  const client = getActiveClient();

  const overview = useQuery<MonthOverview>({
    queryKey: ["jobs-overview", month, client?.id ?? null],
    queryFn: () => fetch(`${BASE}/api/reports/jobs-overview?month=${month}`).then(readJson),
  });

  const { data, isLoading } = useQuery<ReportSummary>({
    queryKey: ["reportSummary"],
    queryFn: () => fetch(`${BASE}/api/reports/summary`).then(readJson),
  });

  const downloadMonthPack = async () => {
    setPacking(true);
    try {
      const response = await fetch(`${BASE}/api/reports/jobs-pack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, clientName: client?.name ?? "Client" }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        toast({ title: "Month pack not created", description: body.message || "Please try again.", variant: "destructive" });
        return;
      }
      downloadBlob(`TallyThis_Month_Pack_${month}.xlsx`, await response.blob());
      toast({ title: "Month pack downloaded", description: "Potential risk — needs CA review." });
    } catch {
      toast({ title: "Download failed", description: "Check your connection and try again.", variant: "destructive" });
    } finally {
      setPacking(false);
    }
  };

  const downloadExcelPack = async () => {
    setExportingExcel(true);
    try {
      const response = await fetch(`${BASE}/api/reports/excel-export`, {
        method: "POST",
        headers: { Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
      if (!response.ok) throw new Error("Excel export failed");
      const name = /filename="?([^";]+)"?/i.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "TallyThis_CA_Pack.xlsx";
      downloadBlob(name, await response.blob());
      toast({ title: "Excel workbook downloaded", description: "Newest saved records across all dates. Potential risk — needs CA review." });
    } catch {
      toast({ title: "Excel download failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setExportingExcel(false);
    }
  };

  const downloadPdfPack = async () => {
    setExportingPack(true);
    setBlockers([]);
    try {
      const response = await fetch(`${BASE}/api/reports/export-ca-pack`, { method: "POST", headers: { Accept: "application/pdf" } });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { blockers?: string[] };
        const found = body.blockers ?? [];
        setBlockers(found.length > 0 ? found : ["Resolve the open items before exporting."]);
        return;
      }
      const slug = data?.month?.toLowerCase().replace(/\s+/g, "-") ?? "ca-pack";
      downloadBlob(`tallythis-ca-pack-${slug}.pdf`, await response.blob());
      toast({ title: "CA pack PDF downloaded", description: "Potential risk — needs CA review." });
    } catch {
      toast({ title: "Download failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setExportingPack(false);
    }
  };

  const handleExport = async (type: string, store = false) => {
    setExportingType(type);
    try {
      const res = await fetch(`${BASE}/api/reports/export-csv?type=${type}${store ? "&store=true" : ""}`);
      if (!res.ok) {
        toast({ title: "Export failed", description: `The server answered ${res.status}. Please try again.`, variant: "destructive" });
        return;
      }
      const result = (await res.json()) as { data?: Record<string, unknown>[]; rowCount?: number };
      if (!result.data || result.data.length === 0) {
        toast({
          title: "Nothing to export yet",
          description: `No ${type.replace(/_/g, " ")} records. Import files in the Upload center first.`,
          variant: "destructive",
        });
        return;
      }
      const headers = Object.keys(result.data[0]);
      const quote = (value: unknown) => {
        const text = value === null || value === undefined ? "" : String(value);
        const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
        return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      };
      const csv = [headers.join(","), ...result.data.map(row => headers.map(header => quote(row[header])).join(","))].join("\n");
      downloadBlob(`${type}_report.csv`, new Blob([csv], { type: "text/csv" }));
      toast({ title: "Exported", description: `${result.rowCount} ${type.replace(/_/g, " ")} records downloaded.` });
    } catch {
      toast({ title: "Export failed", description: "Could not generate the export. Check your connection.", variant: "destructive" });
    } finally {
      setExportingType(null);
    }
  };

  const score = data?.verificationScore ?? 0;
  const scoreColor = score >= 85 ? "text-success" : score >= 60 ? "text-warning" : "text-destructive";

  const exports = [
    { type: "ca_ready", label: "CA-ready report", icon: BarChart3, desc: "Verified transactions ready for CA handoff" },
    { type: "transactions", label: "Transactions", icon: FileText, desc: "All transactions with status and confidence" },
    { type: "invoices", label: "Invoices", icon: FileText, desc: "Purchase and sales invoices with GST details" },
    { type: "missing_invoices", label: "Missing documents", icon: AlertTriangle, desc: "Transactions that need an invoice or document" },
    { type: "risks", label: "Risk flags", icon: AlertTriangle, desc: "Potential GST/TDS risks with suggested actions" },
    { type: "reconciliation", label: "Ledger corrections", icon: CreditCard, desc: "Suggested matches and review decisions" },
    { type: "payroll", label: "Payroll register", icon: Users, desc: "Employee-wise salary and payment details" },
  ];

  const jobs = overview.data?.jobs ?? 0;
  const open = overview.data?.openItems ?? 0;

  return (
    <div className="fv-reports-page fv-standard-page">
      <PageHeader title="Reports" subtitle="One file for the month, and every saved result in one place." />

      <section className="fv-ca-handoff fv-reveal" aria-label="Month pack">
        <div className="flex items-start gap-3">
          <BarChart3 className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <span className="fv-micro">THE NEXT STEP, IN ONE FILE</span>
            <h2>Hand over {client?.name ? `${client.name}’s` : "the"} month.</h2>

            <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Month">
              {months.map(item => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={month === item.value}
                  onClick={() => setMonth(item.value)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    month === item.value ? "border-[var(--fv-leaf)] bg-[var(--fv-soft)] text-[var(--fv-forest)]" : "border-border bg-card hover:border-foreground/30"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {overview.isLoading && <div className="fv-skeleton h-12 max-w-md" aria-label="Loading" />}

            {!overview.isLoading && jobs > 0 && (
              <>
                <p className="mb-3 text-sm">
                  <strong>{jobs}</strong> {jobs === 1 ? "job" : "jobs"} saved in {overview.data?.monthLabel}
                  {open > 0 ? (
                    <>
                      {" "}
                      · <strong className="text-amber-700">{open}</strong> {open === 1 ? "item still needs" : "items still need"} a decision
                    </>
                  ) : (
                    <> · nothing is waiting for review</>
                  )}
                  .
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={packing} onClick={() => void downloadMonthPack()} className="fv-button-primary">
                    <FileSpreadsheet className="h-4 w-4" />
                    {packing ? "Preparing your pack…" : "Download month pack"}
                  </button>
                  <button type="button" onClick={() => navigate("/app/history")} className="fv-button-secondary">
                    <HistoryIcon className="h-4 w-4" />
                    Open saved jobs
                  </button>
                </div>
              </>
            )}

            {!overview.isLoading && jobs === 0 && (
              <EmptyPanel
                className="!border-solid !p-6"
                title={`No jobs saved for ${overview.data?.monthLabel ?? "this month"}.`}
                actions={
                  <>
                    <button type="button" className="fv-button-primary" onClick={() => navigate("/app/overview")}>
                      Start a job
                    </button>
                    {month !== months[1]?.value && months[1] && (
                      <button type="button" className="fv-button-secondary" onClick={() => setMonth(months[1].value)}>
                        Look at {months[1].label}
                      </button>
                    )}
                  </>
                }
              >
                Run a job and its result is saved here automatically. Incognito jobs are never saved.
              </EmptyPanel>
            )}
            {overview.isError && !overview.isLoading && (
              <Notice tone="warn">The month summary could not be loaded. Check your connection and try again.</Notice>
            )}
          </div>
        </div>
      </section>

      <button type="button" className="fv-saved-outputs" onClick={() => navigate("/app/history")}>
        <FileText size={18} />
        <span>
          Looking for a Tally file, GST draft or job report?
          <strong>Open your saved job outputs</strong>
        </span>
        <ArrowRight size={18} />
      </button>

      <details className="fv-report-advanced">
        <summary>
          More options <span>Month-close pack and individual reports</span>
          <ChevronDown size={16} />
        </summary>
        <div className="fv-report-advanced-content">
          <div className="mb-6 rounded-xl border border-border bg-card p-5">
            <div className="text-sm font-semibold">Month-close CA pack (PDF)</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Built from the Upload center’s month-close records: reconciliation runs, risk flags and CA review items. It is not built from the
              four jobs above, so it stays blocked until those records exist.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={exportingPack} onClick={() => void downloadPdfPack()} className="fv-button-secondary">
                <FileText className="h-4 w-4" />
                {exportingPack ? "Checking…" : "Download CA review pack"}
              </button>
              <button type="button" disabled={exportingExcel} onClick={() => void downloadExcelPack()} className="fv-button-secondary">
                <FileSpreadsheet className="h-4 w-4" />
                {exportingExcel ? "Preparing Excel…" : "Download Excel workbook"}
              </button>
            </div>
            {blockers.length > 0 && (
              <div className="mt-4 space-y-2" role="alert">
                <div className="text-sm font-semibold text-amber-900">The CA pack is not ready yet</div>
                {blockers.map(blocker => {
                  const action = blockerAction(blocker);
                  return (
                    <div key={blocker} className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                      <span className="min-w-0 flex-1">{blocker}</span>
                      <button type="button" className="fv-button-secondary" onClick={() => navigate(action.href)}>
                        {action.label}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {isLoading ? (
            <div className="fv-skeleton mb-6 h-32" aria-label="Loading" />
          ) : (
            data && (
              <div className="mb-6 rounded-xl border border-border bg-card p-6">
                <div className="mb-6 flex items-start justify-between">
                  <div>
                    <div className="text-lg font-bold">{data.companyName}</div>
                    <div className="text-sm text-muted-foreground">
                      {data.month} · Generated {new Date(data.generatedAt).toLocaleString("en-IN")}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-3xl font-bold ${scoreColor}`}>{data.verificationScore}</div>
                    <div className="text-xs text-muted-foreground">Verification score</div>
                    <div className={`mt-0.5 text-xs font-semibold ${scoreColor}`}>{data.caReadyStatus}</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  {[
                    { label: "Verified entries", val: `${data.verifiedTransactions} / ${data.totalTransactions}` },
                    { label: "Missing invoices", val: String(data.missingInvoices) },
                    { label: "High-risk flags", val: String(data.highRisks) },
                    { label: "Total payroll", val: formatCurrencyFull(data.totalPayroll) },
                  ].map(stat => (
                    <div key={stat.label} className="rounded-lg bg-muted/30 p-3 text-center">
                      <div className="text-xl font-bold">{stat.val}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{stat.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )
          )}

          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
              <Download className="h-4 w-4 text-primary" />
              Export reports
            </div>
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                className="fv-button-secondary"
                onClick={() => {
                  void Promise.all(["ca_ready", "missing_invoices", "risks", "reconciliation"].map(type => handleExport(type, true)));
                }}
              >
                <Download className="h-4 w-4" />
                Export all and keep a copy
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {exports.map(item => {
                const Icon = item.icon;
                return (
                  <div key={item.type} className="flex items-center justify-between rounded-xl border border-border p-4 transition-colors hover:bg-muted/20">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="text-sm font-medium">{item.label}</div>
                        <div className="text-xs text-muted-foreground">{item.desc}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleExport(item.type)}
                      disabled={exportingType === item.type}
                      className="fv-button-secondary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={`Download ${item.label} as CSV`}
                    >
                      <Download className="h-3.5 w-3.5" />
                      CSV
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
