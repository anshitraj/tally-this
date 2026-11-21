import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "wouter";
import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, FileSpreadsheet, UploadCloud, Wallet } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import EmptyPanel from "@/components/app/EmptyPanel";
import { BrandLogo } from "@/components/app/BrandLogo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Notice } from "@/components/jobs/jobUi";
import { useToast } from "@/hooks/use-toast";
import { refreshAfterChange } from "@/lib/refresh";
import { ExceptionsPanel } from "@/components/ecommerce/ExceptionsPanel";
import { GstPanel } from "@/components/ecommerce/GstPanel";
import { ImportProgress, UploadDialog } from "@/components/ecommerce/ImportFlow";
import { ReportsPanel } from "@/components/ecommerce/ReportsPanel";
import { Tone, TransactionsPanel } from "@/components/ecommerce/TransactionsPanel";
import { REPORT_STATUS, api, financialYearOf, maskGstin, periodLabel, rupeesFromPaise, rupeesFromText, type ImportJob, type Workspace } from "@/lib/ecommerce";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "transactions", label: "Transactions" },
  { id: "sales-returns", label: "Sales & Returns" },
  { id: "gst", label: "GST & HSN" },
  { id: "reconciliation", label: "Reconciliation" },
  { id: "reports", label: "Reports" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const SALES_COLOR = "#0d9488";
const RETURNS_COLOR = "#f97f06";

/** A marketplace workspace: everything imported for one marketplace, a month at a time. */
export default function EcommerceWorkspacePage() {
  const params = useParams<{ marketplace: string }>();
  const marketplace = (params.marketplace ?? "").toLowerCase();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const search = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const [period, setPeriod] = useState<string | null>(search.get("period"));
  const [tab, setTab] = useState<TabId>((TABS.find(t => t.id === search.get("tab"))?.id) ?? "overview");
  const [txStatus, setTxStatus] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [activeJob, setActiveJob] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery<Workspace>({
    queryKey: ["ecommerce", marketplace, "workspace", period],
    queryFn: () => api(`/ecommerce/${marketplace}/workspace${period ? `?period=${period}` : ""}`),
    retry: (count, err) => !(err instanceof Error && /not supported/.test(err.message)) && count < 2,
  });

  // Keep the address in step with the month and tab, so a refresh or a shared link opens the same view.
  useEffect(() => {
    const next = new URLSearchParams();
    const shown = period ?? data?.period;
    if (shown) next.set("period", shown);
    if (tab !== "overview") next.set("tab", tab);
    const query = next.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [period, tab, data?.period]);

  // A job still running from before this page opened is followed too.
  useEffect(() => {
    if (!activeJob && data?.jobs) {
      const running = data.jobs.find(j => j.status === "queued" || j.status === "running" || j.status === "needs_mapping");
      if (running) setActiveJob(running.id);
    }
  }, [data?.jobs, activeJob]);

  const finished = useCallback(async (job: ImportJob) => {
    const counted = job.counted ?? 0;
    toast({ title: "Import finished", description: `${counted} ${counted === 1 ? "transaction" : "transactions"} imported${job.duplicates ? `, ${job.duplicates} ${job.duplicates === 1 ? "repeat" : "repeats"} not counted again` : ""}.` });
    if (job.periods.length > 0) setPeriod(job.period && job.periods.includes(job.period) ? job.period : job.periods[job.periods.length - 1]);
    await refreshAfterChange(qc, [["ecommerce"]]);
  }, [qc, toast]);

  if (isError) {
    const notFound = error instanceof Error && /not supported/.test(error.message);
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-10">
        <EmptyPanel title={notFound ? "That marketplace is not supported" : "This workspace could not be loaded"} actions={<>
          <button type="button" className="fv-button-primary" onClick={() => navigate("/app/ecommerce")}>All marketplaces</button>
          {!notFound && <button type="button" className="fv-button-secondary" onClick={() => void refetch()}>Try again</button>}
        </>}>{notFound ? "Choose a marketplace from the E-commerce page." : "Check your connection and try again."}</EmptyPanel>
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6 sm:py-10" aria-label="Loading workspace">
        <div className="h-14 w-72 animate-pulse rounded-xl bg-muted/60" />
        <div className="h-10 animate-pulse rounded-xl bg-muted/40" />
        <div className="grid gap-3 sm:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-muted/40" />)}</div>
      </div>
    );
  }

  const info = data.marketplace;
  if (info.status !== "available") {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <BackLink />
        <h1 className="mt-3 text-2xl font-semibold">{info.name}</h1>
        <EmptyPanel className="mt-6" title={`${info.name} is coming soon`} actions={<button type="button" className="fv-button-primary" onClick={() => navigate("/app/ecommerce")}>All marketplaces</button>}>
          {info.name} reports cannot be imported yet. Until then, the quick GST file job reads most marketplace reports.
        </EmptyPanel>
      </div>
    );
  }

  const shownPeriod = data.period;
  const gstin = data.sellerGstins.length === 1 ? data.sellerGstins[0] : data.sellerGstins.length > 1 ? null : data.company.gstin;
  const state = data.data?.report;
  const status = state ? REPORT_STATUS[state.status] : null;
  const empty = data.periods.length === 0;
  const openUpload = () => setUploadOpen(true);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <BackLink />
      <header className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-white">
            <BrandLogo name={info.name} size="lg" withName={false} className="[&_img]:!h-10 [&_img]:!w-10" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{info.name}</h1>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"><FileSpreadsheet className="h-3 w-3" aria-hidden="true" />Report import</span>
              {status && <Tone tone={status.tone}>{status.label}</Tone>}
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {data.company.name}{data.company.name ? " · " : ""}GSTIN {gstin ? maskGstin(gstin) : data.sellerGstins.length > 1 ? `${data.sellerGstins.length} GSTINs` : "not given"}
              {shownPeriod ? ` · FY ${financialYearOf(shownPeriod)}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {data.periods.length > 0 && (
            <select aria-label="Month" value={shownPeriod ?? ""} onChange={event => setPeriod(event.target.value)} className="h-10 rounded-xl border border-border bg-card px-3 text-sm font-medium">
              {data.periods.map(p => <option key={p.period} value={p.period}>{periodLabel(p.period)}</option>)}
            </select>
          )}
          {data.can.import && <button type="button" className="fv-button-primary h-10" onClick={openUpload}><UploadCloud className="h-4 w-4" aria-hidden="true" />Upload reports</button>}
        </div>
      </header>

      {activeJob && (
        <div className="mt-5">
          <ImportProgress key={activeJob} marketplace={marketplace} jobId={activeJob} stages={data.stages} onFinished={finished} onDismiss={() => { setActiveJob(null); void refreshAfterChange(qc, [["ecommerce"]]); }} />
        </div>
      )}

      {empty ? (
        !activeJob && <Onboarding name={info.name} sourceFiles={info.sourceFiles} canImport={data.can.import} onUpload={openUpload} />
      ) : shownPeriod && data.data ? (
        <Tabs value={tab} onValueChange={value => setTab(value as TabId)} className="mt-6">
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <TabsList className="h-auto w-max gap-1 rounded-xl bg-muted/60 p-1">
              {TABS.map(t => (
                <TabsTrigger key={t.id} value={t.id} className="rounded-lg px-3 py-1.5 text-sm data-[state=active]:shadow-sm">
                  {t.label}
                  {t.id === "reconciliation" && data.data!.exceptions.openBlocking > 0 && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 text-xs tabular-nums text-amber-900">{data.data!.exceptions.openBlocking}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="overview" className="mt-5">
            <OverviewTab data={data} period={shownPeriod} onReview={() => setTab("reconciliation")} onShowStatus={value => { setTxStatus(value); setTab("transactions"); }} />
          </TabsContent>
          <TabsContent value="transactions" className="mt-5">
            <TransactionsPanel marketplace={marketplace} period={shownPeriod} initialStatus={txStatus} canReview={data.can.review} />
          </TabsContent>
          <TabsContent value="sales-returns" className="mt-5">
            <SalesReturnsTab data={data} marketplace={marketplace} period={shownPeriod} canReview={data.can.review} />
          </TabsContent>
          <TabsContent value="gst" className="mt-5">
            <GstPanel marketplace={marketplace} period={shownPeriod} />
          </TabsContent>
          <TabsContent value="reconciliation" className="mt-5">
            <ExceptionsPanel marketplace={marketplace} period={shownPeriod} canReview={data.can.review} />
          </TabsContent>
          <TabsContent value="reports" className="mt-5">
            <ReportsPanel marketplace={marketplace} period={shownPeriod} jobs={data.jobs} canApprove={data.can.approve} onReviewItems={() => setTab("reconciliation")} />
          </TabsContent>
        </Tabs>
      ) : null}

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        marketplace={marketplace}
        marketplaceName={info.name}
        sourceFiles={info.sourceFiles}
        defaultGstin={gstin}
        defaultPeriod={null}
        onStarted={jobId => { setActiveJob(jobId); void refreshAfterChange(qc, [["ecommerce", marketplace, "workspace"]]); }}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/app/ecommerce" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />E-commerce
    </Link>
  );
}

/** The first visit: what to download, where from, and one button. It is a report import, not a live connection. */
function Onboarding({ name, sourceFiles, canImport, onUpload }: { name: string; sourceFiles: string[]; canImport: boolean; onUpload: () => void }) {
  const reduce = useReducedMotion();
  const steps = [
    { title: `Download your ${name} reports`, body: `In the ${name} Supplier Panel, open GST Reports and download the month's sales and returns files.`, files: sourceFiles },
    { title: "Upload them here", body: "Excel, CSV or a ZIP. Several months at once is fine; each row keeps its own month and nothing is counted twice." },
    { title: "Review and download", body: "Look at only what needs attention, approve the month and download the working papers for your CA." },
  ];
  return (
    <section className="mt-8 rounded-2xl border border-border bg-card p-6 sm:p-8" aria-labelledby="onboarding-title">
      <h2 id="onboarding-title" className="text-lg font-semibold">Connect your {name} reports</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">TallyThis reads the reports you download from {name}. It does not sign in to your {name} account, and nothing updates until you upload new files.</p>
      <ol className="mt-6 grid gap-4 sm:grid-cols-3">
        {steps.map((step, i) => (
          <motion.li key={step.title} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: reduce ? 0 : 0.05 * i }} className="rounded-xl border border-border bg-background p-4">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-50 text-sm font-semibold text-orange-900">{i + 1}</span>
            <h3 className="mt-3 text-sm font-semibold">{step.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
            {step.files && <ul className="mt-2 space-y-0.5 font-mono text-xs text-muted-foreground">{step.files.map(f => <li key={f}>{f}</li>)}</ul>}
          </motion.li>
        ))}
      </ol>
      {canImport ? (
        <button type="button" className="fv-button-primary mt-6 h-11" onClick={onUpload}><UploadCloud className="h-4 w-4" aria-hidden="true" />Upload {name} reports</button>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">Ask an admin of this workspace to upload the reports.</p>
      )}
    </section>
  );
}

function Kpi({ label, value, hint, tone = "neutral", index }: { label: string; value: string; hint?: string; tone?: "neutral" | "attention" | "good"; index: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: reduce ? 0 : index * 0.04 }} className="min-w-0 rounded-xl border border-border bg-card p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("mt-1 truncate text-xl font-semibold tabular-nums", tone === "attention" && "text-amber-700", tone === "good" && "text-emerald-700")}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div>}
    </motion.div>
  );
}

function OverviewTab({ data, period, onReview, onShowStatus }: { data: Workspace; period: string; onReview: () => void; onShowStatus: (status: string) => void }) {
  const d = data.data!;
  const o = d.overview;
  const open = d.exceptions.openBlocking;
  const chart = useMemo(() => data.byMonth.slice(-12).map(m => ({ month: periodLabel(m.period), period: m.period, Sales: Number(m.sales), Returns: Number(m.returns) })), [data.byMonth]);
  const statusCount = (s: string) => d.statuses.find(x => x.status === s)?.n ?? 0;
  return (
    <div className="space-y-6">
      {open > 0 ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
            <div>
              <div className="font-semibold text-amber-950">{open} {open === 1 ? "item needs" : "items need"} attention</div>
              <p className="text-sm text-amber-900/80">Missing details, tax differences or returns without their sale. The month cannot be approved until each is resolved or accepted.</p>
            </div>
          </div>
          <button type="button" className="fv-button-primary shrink-0" onClick={onReview}>Review {open} {open === 1 ? "item" : "items"}</button>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" aria-hidden="true" />
          <div>
            <div className="font-semibold text-emerald-950">{d.report.status === "approved" ? `${periodLabel(period)} is approved` : "Nothing needs review"}</div>
            <p className="text-sm text-emerald-900/80">{d.report.status === "approved" ? "Download the working papers from Reports." : "Every transaction has its details. Approve the month from Reports."}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi index={0} label="Sales (taxable)" value={rupeesFromPaise(o.sales.taxable, { whole: true })} hint={`${o.sales.count.toLocaleString("en-IN")} lines · ${o.sales.quantity.toLocaleString("en-IN")} units`} />
        <Kpi index={1} label="Returns & credit notes" value={rupeesFromPaise(o.returns.taxable + o.creditNotes.taxable, { whole: true })} hint={`${(o.returns.count + o.creditNotes.count).toLocaleString("en-IN")} lines`} />
        <Kpi index={2} label="Net taxable value" value={rupeesFromPaise(o.net.taxable, { whole: true })} hint={`Net GST ${rupeesFromPaise(o.net.tax, { whole: true })}`} />
        <Kpi index={3} label="Need attention" value={open.toLocaleString("en-IN")} hint={d.duplicates ? `${d.duplicates} duplicate rows not counted` : "No duplicates found"} tone={open > 0 ? "attention" : "good"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-2xl border border-border bg-card p-4 lg:col-span-2" aria-labelledby="by-month">
          <h2 id="by-month" className="text-sm font-semibold">Sales and returns by month</h2>
          <p className="text-xs text-muted-foreground">Taxable value, in the month each was reported.</p>
          <div className="mt-3 h-56" role="img" aria-label="Bar chart of sales and returns by month; the same figures are in the table below.">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} barGap={2} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke="var(--fv-border, #e7e5e4)" />
                <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={11} stroke="#78716c" />
                <YAxis tickLine={false} axisLine={false} fontSize={11} stroke="#78716c" width={56} tickFormatter={v => (Math.abs(v) >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : Math.abs(v) >= 1000 ? `₹${(v / 1000).toFixed(0)}k` : `₹${v}`)} />
                <Tooltip cursor={{ fill: "rgba(120,113,108,0.08)" }} formatter={(value: number) => rupeesFromPaise(Math.round(value * 100))} contentStyle={{ borderRadius: 10, border: "1px solid #e7e5e4", fontSize: 12 }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Sales" fill={SALES_COLOR} radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="Returns" fill={RETURNS_COLOR} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">Show as a table</summary>
            <table className="mt-2 w-full">
              <thead className="text-left text-muted-foreground"><tr><th className="py-1 font-medium">Month</th><th className="py-1 text-right font-medium">Sales</th><th className="py-1 text-right font-medium">Returns</th></tr></thead>
              <tbody>{data.byMonth.map(m => <tr key={m.period} className="border-t border-border"><td className="py-1">{periodLabel(m.period)}</td><td className="py-1 text-right tabular-nums">{rupeesFromText(m.sales)}</td><td className="py-1 text-right tabular-nums">{rupeesFromText(m.returns)}</td></tr>)}</tbody>
            </table>
          </details>
        </section>

        <section className="space-y-3" aria-label="Status">
          <div className="rounded-2xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Transactions this month</h2>
            <ul className="mt-2 space-y-1.5 text-sm">
              {([
                ["Ready", statusCount("ok") + statusCount("reviewed"), "ok"],
                ["Returns matched to their sale", statusCount("matched") + statusCount("cross_period"), "matched"],
                ["Returns without their sale", statusCount("unmatched"), "unmatched"],
                ["Missing details", statusCount("missing_info"), "missing_info"],
                ["Tax differences", statusCount("tax_mismatch"), "tax_mismatch"],
              ] as Array<[string, number, string]>).map(([label, n, s]) => (
                <li key={label}>
                  <button type="button" onClick={() => onShowStatus(s)} className="flex w-full justify-between gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted/50">
                    <span className="text-muted-foreground">{label}</span><span className="font-medium tabular-nums">{n.toLocaleString("en-IN")}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-dashed border-border bg-card/60 p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />Settlements</h2>
            <p className="mt-1 text-xs text-muted-foreground">Not available yet. Payment and settlement files are not read, so money received, fees and payouts are not part of this view. The figures here are GST values, not cash.</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Clock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />Last import</h2>
            <p className="mt-1 text-xs text-muted-foreground">{data.jobs[0] ? `${new Date(data.jobs[0].createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} · ${data.jobs[0].uploads.map(u => u.name).join(", ")}` : "None yet."}</p>
          </div>
        </section>
      </div>

      {o.byRate.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4" aria-labelledby="by-rate">
          <h2 id="by-rate" className="text-sm font-semibold">By GST rate</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1.5 font-medium">Rate</th><th className="py-1.5 text-right font-medium">Sales</th><th className="py-1.5 text-right font-medium">Returns</th><th className="py-1.5 text-right font-medium">Net taxable</th><th className="py-1.5 text-right font-medium">Net GST</th></tr></thead>
              <tbody>
                {o.byRate.map(r => (
                  <tr key={r.rate} className="border-t border-border">
                    <td className="py-1.5">{r.rate === "unknown" ? <span className="text-red-700">Not recognised</span> : `${r.rate}%`}</td>
                    <td className="py-1.5 text-right tabular-nums">{rupeesFromPaise(r.sales)}</td>
                    <td className="py-1.5 text-right tabular-nums text-red-700">{r.reductions ? `−${rupeesFromPaise(r.reductions)}` : "—"}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums">{rupeesFromPaise(r.net)}</td>
                    <td className="py-1.5 text-right tabular-nums">{rupeesFromPaise(r.tax)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {o.net.unassignedTax !== 0 && <p className="mt-2 text-xs text-amber-800">{rupeesFromPaise(o.net.unassignedTax)} of tax could not be split into IGST or CGST/SGST because the customer State is not recognised. It is in the totals and listed under Reconciliation.</p>}
        </section>
      )}
    </div>
  );
}

function SalesReturnsTab({ data, marketplace, period, canReview }: { data: Workspace; marketplace: string; period: string; canReview: boolean }) {
  const o = data.data!.overview;
  const statusCount = (s: string) => data.data!.statuses.find(x => x.status === s)?.n ?? 0;
  const rows: Array<[string, typeof o.sales, boolean]> = [["Sales", o.sales, false], ["Returns and cancellations", o.returns, true], ["Credit notes", o.creditNotes, true], ["Net for the month", o.net, false]];
  return (
    <div className="space-y-6">
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
            <tr><th className="px-3 py-2 font-medium" /><th className="px-3 py-2 text-right font-medium">Lines</th><th className="px-3 py-2 text-right font-medium">Units</th><th className="px-3 py-2 text-right font-medium">Taxable</th><th className="px-3 py-2 text-right font-medium">GST</th><th className="px-3 py-2 text-right font-medium">Invoice value</th></tr>
          </thead>
          <tbody>
            {rows.map(([label, t, negative]) => (
              <tr key={label} className={cn("border-b border-border last:border-0", label.startsWith("Net") && "font-semibold")}>
                <td className="px-3 py-2">{label}</td>
                <td className="px-3 py-2 text-right tabular-nums">{t.count.toLocaleString("en-IN")}</td>
                <td className="px-3 py-2 text-right tabular-nums">{t.quantity.toLocaleString("en-IN")}</td>
                <td className={cn("px-3 py-2 text-right tabular-nums", negative && t.taxable && "text-red-700")}>{negative && t.taxable ? "−" : ""}{rupeesFromPaise(t.taxable)}</td>
                <td className={cn("px-3 py-2 text-right tabular-nums", negative && t.tax && "text-red-700")}>{negative && t.tax ? "−" : ""}{rupeesFromPaise(t.tax)}</td>
                <td className={cn("px-3 py-2 text-right tabular-nums", negative && t.invoiceValue && "text-red-700")}>{negative && t.invoiceValue ? "−" : ""}{rupeesFromPaise(t.invoiceValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4"><div className="text-xs text-muted-foreground">Matched to a sale this month</div><div className="mt-1 text-xl font-semibold tabular-nums">{statusCount("matched")}</div></div>
        <div className="rounded-xl border border-border bg-card p-4"><div className="text-xs text-muted-foreground">Returns of an earlier month's sale</div><div className="mt-1 text-xl font-semibold tabular-nums">{statusCount("cross_period")}</div></div>
        <div className="rounded-xl border border-border bg-card p-4"><div className="text-xs text-muted-foreground">Without their sale (import that month to match)</div><div className={cn("mt-1 text-xl font-semibold tabular-nums", statusCount("unmatched") > 0 && "text-amber-700")}>{statusCount("unmatched")}</div></div>
      </div>
      <p className="text-xs text-muted-foreground">A return reduces the month it was reported in, even when the sale was earlier. Returns are never counted twice and never turned into negative sales.</p>
      <TransactionsPanel marketplace={marketplace} period={period} fixedType="reduction" canReview={canReview} />
      {data.data!.exceptions.openInfo > 0 && <Notice tone="info">{data.data!.exceptions.openInfo} note(s) for information only, such as returns of earlier months. They do not block approval.</Notice>}
    </div>
  );
}
