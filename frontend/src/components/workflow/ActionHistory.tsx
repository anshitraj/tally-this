import { useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2 } from "lucide-react";
import { formatDate } from "@/lib/format";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ActionHistoryItem {
  id: number;
  label: string;
  description: string;
  actorEmail: string;
  createdAt: string;
}

export default function ActionHistory({ items: providedItems }: { items?: ActionHistoryItem[] }) {
  const { data = [], isLoading } = useQuery<ActionHistoryItem[]>({
    queryKey: ["action-history"],
    queryFn: () => fetch(`${BASE}/api/action-history`).then(r => r.json()),
    enabled: !providedItems,
  });
  const items = providedItems ?? data;

  return (
    <section className="fv-card-flat mb-6 overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <div className="text-sm font-semibold">Action History</div>
          <div className="mt-0.5 text-xs text-muted-foreground">Workflow actions saved from uploads, imports, reconciliation, review, and export</div>
        </div>
        <Activity className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="divide-y divide-border">
        {isLoading && items.length === 0 && <div className="px-5 py-4 text-sm text-muted-foreground">Loading action history...</div>}
        {!isLoading && items.length === 0 && (
          <div className="px-5 py-6 text-sm text-muted-foreground">
            No workflow actions yet. Upload files or run an import to start the history.
          </div>
        )}
        {items.slice(0, 8).map(item => (
          <div key={item.id} className="flex gap-3 px-5 py-3">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-success/25 bg-success/5 text-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground">{item.label}</div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{item.description}</div>
            </div>
            <div className="shrink-0 text-right text-[11px] text-muted-foreground">
              <div>{formatDate(item.createdAt)}</div>
              <div className="mt-0.5 max-w-36 truncate">{item.actorEmail}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
