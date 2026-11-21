import { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, ChevronRight, Download, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Notice } from "@/components/jobs/jobUi";
import { useToast } from "@/hooks/use-toast";
import { refreshAfterChange } from "@/lib/refresh";
import { KIND_TEXT, api, download, rupeesFromText, send, type ExceptionRow } from "@/lib/ecommerce";
import { cn } from "@/lib/utils";
import { Tone, TransactionDetail } from "./TransactionsPanel";

/**
 * Exceptions first: only what needs a person, grouped by kind, newest decisions recorded with a note. A transaction
 * opens in the side panel; an item without one (a file that could not be read) is resolved here.
 */
export function ExceptionsPanel({ marketplace, period, canReview }: { marketplace: string; period: string; canReview: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = useState("open");
  const [severity, setSeverity] = useState("blocking");
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [eventId, setEventId] = useState<number | null>(null);
  const [acting, setActing] = useState<{ item: ExceptionRow; action: "resolve" | "accept" | "reopen" } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const params = new URLSearchParams({ period, status, page: String(page), pageSize: "50" });
  if (severity) params.set("severity", severity);
  if (kind) params.set("kind", kind);
  if (query) params.set("search", query);
  const { data, isLoading, isError } = useQuery<{ total: number; rows: ExceptionRow[]; kinds: Array<{ kind: string; severity: string; open: number; total: number }> }>({
    queryKey: ["ecommerce", marketplace, "exceptions", params.toString()],
    queryFn: () => api(`/ecommerce/${marketplace}/exceptions?${params}`),
    placeholderData: keepPreviousData,
  });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  const kinds = (data?.kinds ?? []).filter(k => severity !== "blocking" || k.severity !== "info");
  const [bulk, setBulk] = useState<{ kind: string; count: number } | null>(null);
  const chosenKind = kinds.find(k => k.kind === kind && k.severity !== "info");

  return (
    <div className="space-y-4">
      {kinds.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Kinds of item">
          <button type="button" aria-pressed={kind === ""} onClick={() => { setKind(""); setPage(1); }} className={cn("rounded-full border px-3 py-1 text-xs font-semibold transition-colors", kind === "" ? "border-[var(--fv-accent)] bg-orange-50 text-orange-900" : "border-border bg-card hover:border-foreground/30")}>All</button>
          {kinds.map(k => (
            <button key={`${k.kind}-${k.severity}`} type="button" aria-pressed={kind === k.kind} onClick={() => { setKind(k.kind); setPage(1); }} className={cn("rounded-full border px-3 py-1 text-xs font-semibold transition-colors", kind === k.kind ? "border-[var(--fv-accent)] bg-orange-50 text-orange-900" : "border-border bg-card hover:border-foreground/30")}>
              {KIND_TEXT[k.kind] ?? k.kind} <span className="tabular-nums text-muted-foreground">{status === "open" ? k.open : k.total}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <label className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search items or sub-orders" aria-label="Search review items" className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm" />
        </label>
        <select aria-label="Item status" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }} className="h-9 rounded-lg border border-border bg-background px-2 text-sm">
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="accepted">Accepted</option>
          <option value="all">All</option>
        </select>
        <select aria-label="Severity" value={severity} onChange={event => { setSeverity(event.target.value); setPage(1); }} className="h-9 rounded-lg border border-border bg-background px-2 text-sm">
          <option value="blocking">Needs review</option>
          <option value="error">Errors only</option>
          <option value="warning">Warnings only</option>
          <option value="info">For information</option>
          <option value="">Everything</option>
        </select>
        <button type="button" className="fv-button-ghost h-9 sm:ml-auto" onClick={async () => {
          const result = await download(marketplace, period, "exceptions_csv");
          if (!result.ok) toast({ title: "Download failed", description: result.message, variant: "destructive" });
        }}><Download className="h-4 w-4" aria-hidden="true" />CSV</button>
      </div>

      {canReview && status === "open" && chosenKind && chosenKind.open > 1 && kind !== "conflicting_rows" && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="text-muted-foreground">{chosenKind.open} open “{KIND_TEXT[kind] ?? kind}” items. If one reason covers them all, decide them together.</span>
          <button type="button" className="fv-button-secondary h-9 shrink-0" onClick={() => setBulk({ kind, count: chosenKind.open })}>Accept all {chosenKind.open}</button>
        </div>
      )}

      {isError ? <Notice tone="error">Review items could not be loaded.</Notice> : isLoading ? (
        <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-muted/50" />)}</div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl border border-border bg-card px-6 py-12 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-600" aria-hidden="true" />
          <p className="mt-3 font-semibold">{status === "open" && severity === "blocking" ? "Nothing needs review" : "No items match"}</p>
          <p className="mt-1 text-sm text-muted-foreground">{status === "open" && severity === "blocking" ? "Every transaction in this month has its details and agrees with its rate." : "Try another filter."}</p>
        </div>
      ) : (
        <ul className="space-y-2" aria-label="Review items">
          {rows.map(item => (
            <li key={item.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{KIND_TEXT[item.kind] ?? item.kind}</span>
                    <Tone tone={item.severity === "error" ? "risk" : item.severity === "warning" ? "warn" : "info"}>{item.severity === "error" ? "Error" : item.severity === "warning" ? "Check" : "Info"}</Tone>
                    {item.status !== "open" && <Tone tone="good">{item.status === "accepted" ? "Accepted" : "Resolved"}</Tone>}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{item.message}</p>
                  {item.subOrderId && <p className="mt-1 font-mono text-xs text-muted-foreground">{item.subOrderId}{item.taxable ? ` · ${rupeesFromText(item.taxable)}` : ""}</p>}
                  {item.note && item.status !== "open" && <p className="mt-1 text-xs">Note: {item.note}</p>}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {item.eventId && (canReview && item.status === "open" && ["missing_hsn", "invalid_hsn", "unknown_state"].includes(item.kind)
                    ? <button type="button" className="fv-button-primary h-8 px-3 text-xs" onClick={() => setEventId(item.eventId)}>Fix</button>
                    : <button type="button" className="fv-button-ghost h-8 px-3 text-xs" onClick={() => setEventId(item.eventId)}>Open</button>)}
                  {canReview && item.status === "open" && item.severity !== "info" && <button type="button" className="fv-button-secondary h-8 px-3 text-xs" onClick={() => setActing({ item, action: "accept" })}>Accept</button>}
                  {canReview && item.status === "open" && <button type="button" className="fv-button-ghost h-8 px-3 text-xs" onClick={() => setActing({ item, action: "resolve" })}>Resolve</button>}
                  {canReview && item.status !== "open" && <button type="button" className="fv-button-ghost h-8 px-3 text-xs" onClick={() => setActing({ item, action: "reopen" })}>Reopen</button>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {total > 50 && (
        <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
          <button type="button" className="fv-button-ghost h-8 px-2" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
          <span className="px-2 tabular-nums">Page {page} of {pages}</span>
          <button type="button" className="fv-button-ghost h-8 px-2" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
        </div>
      )}

      <TransactionDetail marketplace={marketplace} id={eventId} onClose={() => setEventId(null)} canReview={canReview} />
      <BulkDialog
        target={bulk}
        onClose={() => setBulk(null)}
        onSubmit={async note => {
          if (!bulk) return "Nothing chosen.";
          const result = await send<{ count: number }>("POST", `/ecommerce/${marketplace}/exceptions/bulk`, { period, kind: bulk.kind, action: "accept", note });
          if (!result.ok) return result.message ?? "That could not be saved.";
          toast({ title: `${result.count} items accepted` });
          setBulk(null);
          setKind("");
          await refreshAfterChange(qc, [["ecommerce", marketplace]]);
          return null;
        }}
      />
      <DecisionDialog
        target={acting}
        onClose={() => setActing(null)}
        onSubmit={async note => {
          if (!acting) return "Nothing chosen.";
          const result = await send("POST", `/ecommerce/${marketplace}/exceptions/${acting.item.id}`, { action: acting.action, note: note || undefined });
          if (!result.ok) return result.message ?? "That could not be saved.";
          toast({ title: acting.action === "reopen" ? "Item reopened" : "Decision saved" });
          setActing(null);
          await refreshAfterChange(qc, [["ecommerce", marketplace]]);
          return null;
        }}
      />
    </div>
  );
}

function BulkDialog({ target, onClose, onSubmit }: { target: { kind: string; count: number } | null; onClose: () => void; onSubmit: (note: string) => Promise<string | null> }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setNote(""); setError(null); }, [target]);
  return (
    <Dialog open={target != null} onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Accept all {target?.count} items</DialogTitle>
          <DialogDescription>Every open “{target ? KIND_TEXT[target.kind] ?? target.kind : ""}” item in this month is accepted with this note. Each keeps its own record, and any can be reopened later.</DialogDescription>
        </DialogHeader>
        <textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={2000} aria-label="Note for all" placeholder="Why these are acceptable (required)" className="w-full rounded-lg border border-border bg-background p-2 text-sm" />
        {error && <Notice tone="error">{error}</Notice>}
        <DialogFooter className="gap-2 sm:gap-0">
          <button type="button" className="fv-button-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="fv-button-primary" disabled={busy || !note.trim()} onClick={async () => {
            setBusy(true);
            setError(await onSubmit(note.trim()));
            setBusy(false);
          }}>{busy ? "Saving…" : `Accept all ${target?.count ?? ""}`}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DecisionDialog({ target, onClose, onSubmit }: { target: { item: ExceptionRow; action: "resolve" | "accept" | "reopen" } | null; onClose: () => void; onSubmit: (note: string) => Promise<string | null> }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setNote(""); setError(null); }, [target]);
  const needsNote = target?.action === "accept";
  const title = target?.action === "accept" ? "Accept this item" : target?.action === "reopen" ? "Reopen this item" : "Mark as resolved";
  return (
    <Dialog open={target != null} onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{target ? `${KIND_TEXT[target.item.kind] ?? target.item.kind}: ${target.item.message}` : ""}</DialogDescription>
        </DialogHeader>
        <textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={2000} aria-label="Note" placeholder={needsNote ? "Why is this acceptable? (required)" : "Note (optional)"} className="w-full rounded-lg border border-border bg-background p-2 text-sm" />
        {error && <Notice tone="error">{error}</Notice>}
        <DialogFooter className="gap-2 sm:gap-0">
          <button type="button" className="fv-button-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="fv-button-primary" disabled={busy || (needsNote && !note.trim())} onClick={async () => {
            setBusy(true);
            setError(await onSubmit(note.trim()));
            setBusy(false);
          }}>{busy ? "Saving…" : title}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
