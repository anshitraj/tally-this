import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Activity as ActivityIcon, RotateCcw, Search, SearchX } from "lucide-react";
import EmptyPanel from "@/components/app/EmptyPanel";
import { readJson } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ActionItem {
  id: number;
  action?: string;
  label: string;
  description: string;
  actorEmail: string;
  createdAt: string;
}

/** Plain-language names for job events. Anything else keeps the server's label. */
const LABELS: Record<string, string> = {
  "job.bank_statement_parsed": "Bank statement read",
  "job.tally_xml_generated": "Tally file created",
  "job.bank_tally_compared": "Bank compared with Tally",
  "job.ecommerce_normalized": "Marketplace reports prepared",
  "job.invoice_bank_compared": "Invoices matched with bank",
  "job.match_decision": "Review decision saved",
  "job.tally_push": "Entries sent to Tally",
  "job.gstr2b_compared": "GSTR-2B compared with books",
  "job.gstr2b_linked": "GSTR-2B documents linked",
  "job.bills_read": "Purchase bills read",
  "job.bills_xml_generated": "Purchase vouchers file created",
  "job.bills_tally_push": "Purchase vouchers sent to Tally",
  "job.gst_sales_read": "Sales register sorted into GSTR-1 tables",
  "job.gst_sales_excel": "GSTR-1 and 3B working downloaded",
  "job.payroll_read": "Salary sheet read",
  "job.payroll_journal_generated": "Salary entry for Tally created",
  "job.payroll_tally_push": "Salary entry sent to Tally",
  "job.draft_report": "Draft report downloaded",
  "job.final_report": "Final report downloaded",
  "practice.client_linked": "Client added",
  "practice.client_unlinked": "Client removed",
  "auth.login": "Signed in",
  "auth.demo_loaded": "Sample workspace opened",
};

/** Internal entity names such as "workflow_run" are not shown to people. */
function readable(description: string) {
  return /^[a-z_]+$/.test(description.trim()) ? "" : description;
}

function time(value: string) {
  return new Date(value).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

/** "Today", "Yesterday", then the date, so a long list can be scanned. */
function dayLabel(value: string) {
  const date = new Date(value);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

export default function ActivityPage() {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const { data, isLoading, isError, refetch, isFetching } = useQuery<ActionItem[]>({
    queryKey: ["action-history", "activity"],
    queryFn: () => fetch(`${BASE}/api/action-history?limit=100`).then(readJson),
  });

  const groups = useMemo(() => {
    const rows = (Array.isArray(data) ? data : []).map(item => ({
      ...item,
      title: (item.action && LABELS[item.action]) || item.label,
      detail: readable(item.description ?? ""),
    }));
    const needle = query.trim().toLowerCase();
    const shown = needle
      ? rows.filter(item => `${item.title} ${item.detail} ${item.actorEmail}`.toLowerCase().includes(needle))
      : rows;
    const byDay = new Map<string, typeof shown>();
    for (const item of shown) {
      const key = dayLabel(item.createdAt);
      byDay.set(key, [...(byDay.get(key) ?? []), item]);
    }
    return { total: rows.length, shown: shown.length, days: [...byDay.entries()] };
  }, [data, query]);

  return (
    <div className="fv-standard-page">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Activity</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">Every upload, decision and download, with who did it.</p>

      {groups.total > 0 && (
        <label className="relative mt-5 block">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Search activity"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search by job, file or person"
            className="fv-input h-11 w-full pl-10"
          />
        </label>
      )}

      <div className="mt-5 space-y-6">
        {isLoading && (
          <div className="space-y-2" aria-label="Loading activity">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="fv-skeleton h-14" />
            ))}
          </div>
        )}

        {isError && !isLoading && (
          <EmptyPanel
            icon={RotateCcw}
            title="Activity could not be loaded."
            actions={
              <button type="button" className="fv-button-primary" onClick={() => void refetch()} disabled={isFetching}>
                {isFetching ? "Trying…" : "Try again"}
              </button>
            }
          >
            Your work is safe. Check your connection and try once more.
          </EmptyPanel>
        )}

        {!isLoading && !isError && groups.total === 0 && (
          <EmptyPanel
            icon={ActivityIcon}
            title="Nothing here yet."
            actions={
              <>
                <button type="button" className="fv-button-primary" onClick={() => navigate("/app/overview")}>
                  Start a job
                </button>
                <button type="button" className="fv-button-secondary" onClick={() => navigate("/app/history")}>
                  Open saved jobs
                </button>
              </>
            }
          >
            Every upload, decision and download will be listed here, with who did it and when.
          </EmptyPanel>
        )}

        {!isLoading && groups.total > 0 && groups.shown === 0 && (
          <EmptyPanel
            icon={SearchX}
            title="No activity matches that."
            actions={
              <button type="button" className="fv-button-secondary" onClick={() => setQuery("")}>
                Clear search
              </button>
            }
          />
        )}

        {groups.days.map(([day, items]) => (
          <section key={day} aria-label={day}>
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{day}</h2>
            <div className="divide-y divide-border rounded-2xl border border-border bg-card">
              {items.map(item => (
                <article
                  key={item.id}
                  className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{item.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[item.detail, item.actorEmail].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <time className="shrink-0 text-xs text-muted-foreground" dateTime={item.createdAt}>
                    {time(item.createdAt)}
                  </time>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
