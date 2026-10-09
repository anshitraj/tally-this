import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

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

function when(value: string) {
  return new Date(value).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function ActivityPage() {
  const [query, setQuery] = useState("");
  const { data = [], isLoading } = useQuery<ActionItem[]>({
    queryKey: ["action-history", "activity"],
    queryFn: () =>
      fetch(`${BASE}/api/action-history?limit=100`).then((response) =>
        response.json(),
      ),
  });

  const items = useMemo(() => {
    const rows = (Array.isArray(data) ? data : []).map((item) => ({
      ...item,
      title: (item.action && LABELS[item.action]) || item.label,
      detail: readable(item.description ?? ""),
    }));
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((item) =>
      `${item.title} ${item.detail} ${item.actorEmail}`
        .toLowerCase()
        .includes(needle),
    );
  }, [data, query]);

  return (
    <div className="fv-standard-page">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
        Activity
      </h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Every upload, decision and download, with who did it.
      </p>
      <input
        aria-label="Search activity"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search activity"
        className="fv-input mt-5 h-11 w-full"
      />
      <div className="mt-4 divide-y divide-border rounded-2xl border border-border bg-card">
        {isLoading && (
          <p className="p-4 text-sm text-muted-foreground">Loading activity…</p>
        )}
        {!isLoading && items.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            Nothing yet. Your work will show up here.
          </p>
        )}
        {items.map((item) => (
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
            <time className="shrink-0 text-xs text-muted-foreground">
              {when(item.createdAt)}
            </time>
          </article>
        ))}
      </div>
    </div>
  );
}
