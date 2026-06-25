import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, ArrowUpRight, FileText, Loader2, Package, ShieldCheck, Upload, WalletCards, Zap, type LucideIcon } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import HealthWidget from "@/components/app/HealthWidget";
import StatusBadge from "@/components/app/StatusBadge";
import { EmptyState, PageTransition, ScoreCard, StatCard } from "@/components/app/finverify-ui";
import { getUser } from "@/lib/auth";
import { formatCurrency, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

interface OverviewStats {
  verificationScore: number;
  totalTransactions: number;
  verifiedTransactions: number;
  unverifiedTransactions: number;
  missingInvoices: number;
  riskFlags: number;
  totalUploads: number;
  caReadyStatus: string;
  verifiedAmount: number;
  unverifiedAmount: number;
  recentUploads?: Array<{ id: number; fileName: string; sourceType: string; status: string; uploadedAt: string; recordCount?: number | null }>;
  monthlyProgress?: Array<{ month?: string; verified?: number; unverified?: number }>;
  riskByCategory?: Array<{ category?: string; count?: number; severity?: string }>;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const CHART_COLORS = ["#065F46", "#0D9488", "#F97F06", "#DC2626", "#78716C"];

function GenerateCaPackButton({ navigate }: { navigate: (to: string) => void }) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const handle = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/api/reconciliation/finalize`, { method: "POST" });
      const d = await res.json() as { ok: boolean; pending: number; approved: number; message: string };
      if (d.pending > 0) {
        toast({ title: `${d.pending} items still pending`, description: d.message, variant: "destructive" });
        navigate("/app/action-items");
      } else {
        toast({ title: "✓ CA pack ready", description: `${d.approved} matches approved. Check Action Items for reports.` });
        navigate("/app/action-items");
      }
    } catch {
      toast({ title: "Could not generate pack", description: "Check API connection.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={handle} disabled={busy} className="fv-button-primary">
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Package className="h-4 w-4" />}
      Generate CA pack
    </button>
  );
}

interface TaxAuditMini {
  source: "tally" | "demo";
  stats: { flagged: number; total: number; highSeverity: number };
}

export default function OverviewPage() {
  const [, navigate] = useLocation();
  const user = getUser();
  const { data, isLoading, isError } = useQuery<OverviewStats>({
    queryKey: ["overview"],
    queryFn: async () => {
      const response = await fetch(`${BASE}/api/overview`);
      if (!response.ok) throw new Error(`Overview request failed: ${response.status}`);
      return response.json();
    },
  });

  const { data: taxAudit } = useQuery<TaxAuditMini>({
    queryKey: ["tax-audit"],
    queryFn: () => fetch(`${BASE}/api/tax-audit`).then(r => r.json()),
  });

  if (isLoading) {
    return (
      <PageTransition className="mx-auto max-w-7xl">
        <div className="grid gap-4 md:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="h-40 animate-pulse rounded-2xl border border-border bg-muted" />)}
        </div>
      </PageTransition>
    );
  }

  if (isError || !data) {
    return (
      <PageTransition className="mx-auto max-w-7xl">
        <PageHeader title="Finance Control Room" subtitle="Could not load workspace data from the database." />
        <div className="fv-card p-6">
          <EmptyState title="Database data unavailable" description="Check that you are signed in and the API can reach the configured database." />
        </div>
      </PageTransition>
    );
  }

  const score = data.verificationScore;
  const caStatus = score >= 85 ? "Ready for CA" : score >= 60 ? "Needs review" : "Not ready";
  const scoreDescription = score >= 85
    ? "Verified records are ready for CA handoff. Keep monitoring new uploads."
    : score >= 60
      ? "Resolve missing invoices, mismatches, and CA review items to improve readiness."
      : "Multiple finance records need review before month-end close.";

  const readiness = Math.round((data.verifiedTransactions / Math.max(data.totalTransactions, 1)) * 100);
  const recentExceptions = [
    { label: "Missing invoices", value: data.missingInvoices, tone: "warning" as const, href: "/app/transactions" },
    { label: "Potential risks", value: data.riskFlags, tone: "risk" as const, href: "/app/gst-tds-risks" },
    { label: "Unverified entries", value: data.unverifiedTransactions, tone: "info" as const, href: "/app/reconciliation" },
  ];
  const quickActions: Array<{ label: string; href: string; icon: LucideIcon }> = [
    { label: "Upload files", href: "/app/uploads", icon: Upload },
    { label: "Tax Audit scrutiny", href: "/app/tax-audit", icon: ShieldCheck },
    { label: "Verify finances", href: "/app/verify", icon: Zap },
    { label: "Review risks", href: "/app/gst-tds-risks", icon: AlertTriangle },
    { label: "Action Items", href: "/app/action-items", icon: ArrowUpRight },
    { label: "Statutory calendar", href: "/app/statutory-calendar", icon: WalletCards },
    { label: "Vendor aging", href: "/app/vendor-aging", icon: FileText },
  ];

  return (
    <PageTransition className="mx-auto max-w-7xl">
      <PageHeader
        title="Finance Control Room"
        subtitle={`${user?.company ?? "Current workspace"} / upload-based finance verification from your database.`}
        actions={
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => navigate("/app/uploads")} className="fv-button-secondary">
              <Upload className="h-4 w-4" />
              Upload files
            </button>
            <GenerateCaPackButton navigate={navigate} />
          </div>
        }
      />

      <div className="mb-5"><HealthWidget /></div>

      <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
        <ScoreCard score={score} status={caStatus} description={scoreDescription} />
        <div className="fv-card p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-muted-foreground">Month-end readiness</div>
              <div className="mt-1 text-3xl font-bold tracking-tight">{readiness}% verified</div>
            </div>
            <StatusBadge status={score >= 85 ? "ca_ready" : "needs_ca_review"} />
          </div>
          <div className="mb-5 h-3 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-success" style={{ width: `${readiness}%` }} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {recentExceptions.map(item => (
              <button key={item.label} type="button" onClick={() => navigate(item.href)} className="rounded-2xl border border-border bg-background p-4 text-left transition hover:border-primary/40 hover:bg-muted/30">
                <div className="text-2xl font-bold">{item.value}</div>
                <div className="mt-1 text-xs text-muted-foreground">{item.label}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {taxAudit?.stats && (
        <button
          type="button"
          onClick={() => navigate("/app/tax-audit")}
          className="mt-5 flex w-full items-center justify-between gap-4 rounded-2xl border border-primary/30 bg-primary/5 p-5 text-left transition hover:border-primary/50 hover:bg-primary/10"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary"><ShieldCheck className="h-5 w-5" /></div>
            <div>
              <div className="text-sm font-bold">Tax Audit & Ledger Scrutiny</div>
              <div className="text-xs text-muted-foreground">
                {taxAudit.stats.flagged} of {taxAudit.stats.total} checks flagged
                {taxAudit.stats.highSeverity > 0 && <span className="font-semibold text-red-600"> · {taxAudit.stats.highSeverity} high-severity</span>}
                {taxAudit.source === "demo" && <span className="text-amber-600"> · demo data</span>}
              </div>
            </div>
          </div>
          <span className="flex items-center gap-1 text-sm font-semibold text-primary">Open cockpit <ArrowUpRight className="h-4 w-4" /></span>
        </button>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total transactions" value={data.totalTransactions} detail={`${data.verifiedTransactions} verified`} icon={WalletCards} tone="info" />
        <StatCard label="Verified amount" value={formatCurrency(data.verifiedAmount)} detail="Matched against evidence" icon={Zap} tone="success" />
        <StatCard label="Unverified amount" value={formatCurrency(data.unverifiedAmount)} detail="Needs finance review" icon={AlertTriangle} tone="warning" />
        <StatCard label="Documents uploaded" value={data.totalUploads} detail="Bank, GST, payroll, invoices" icon={FileText} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <div className="fv-card-flat p-5 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Verified vs unverified</div>
              <div className="text-xs text-muted-foreground">Monthly progress from stored finance records</div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data.monthlyProgress || []} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E7E5E4" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #E7E5E4", fontSize: 12 }} />
              <Area type="monotone" dataKey="verified" stackId="1" stroke="#065F46" fill="#065F4622" strokeWidth={2} />
              <Area type="monotone" dataKey="unverified" stackId="1" stroke="#F97F06" fill="#F97F0622" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="fv-card-flat p-5">
          <div className="mb-4 text-sm font-semibold">Risk by category</div>
          {data.riskByCategory?.length ? (
            <>
              <ResponsiveContainer width="100%" height={150}>
                <PieChart>
                  <Pie data={data.riskByCategory} dataKey="count" nameKey="category" innerRadius={42} outerRadius={68} paddingAngle={3}>
                    {data.riskByCategory.map((_, index) => <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-2">
                {data.riskByCategory.map((risk, index) => (
                  <div key={risk.category} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }} />
                      {risk.category}
                    </span>
                    <span className="font-semibold">{risk.count}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EmptyState title="No risks flagged" description="Uploaded records have no open potential risks." />
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="fv-card-flat p-5">
          <div className="mb-4 text-sm font-semibold">Quick actions</div>
          <div className="space-y-2">
            {quickActions.map(action => {
              const ActionIcon = action.icon;
              return (
                <button key={action.label} type="button" onClick={() => navigate(action.href)} className="flex w-full items-center justify-between rounded-xl border border-border px-3 py-3 text-left text-sm font-medium transition hover:border-primary/40 hover:bg-muted/30">
                  <span className="flex items-center gap-2.5">
                    <ActionIcon className="h-4 w-4 text-primary" />
                    {action.label}
                  </span>
                  <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              );
            })}
          </div>
        </div>

        <div className="fv-card-flat overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <div className="text-sm font-semibold">Recent uploads</div>
              <div className="text-xs text-muted-foreground">Latest files entering verification</div>
            </div>
            <button type="button" onClick={() => navigate("/app/uploads")} className="text-xs font-semibold text-primary hover:underline">View all</button>
          </div>
          {data.recentUploads?.length ? (
            <div className="divide-y divide-border">
              {data.recentUploads.map(upload => (
                <div key={upload.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{upload.fileName}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{upload.sourceType.replace("_", " ")} / {formatDate(upload.uploadedAt)}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    {upload.recordCount !== null && upload.recordCount !== undefined && <span className="text-xs text-muted-foreground">{upload.recordCount} records</span>}
                    <StatusBadge status={upload.status} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-5">
              <EmptyState title="No uploads yet" description="Upload CSV, Excel, PDF, or images to start verification." />
            </div>
          )}
        </div>
      </div>
    </PageTransition>
  );
}
