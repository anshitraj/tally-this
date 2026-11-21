import { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Search } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Notice } from "@/components/jobs/jobUi";
import { useToast } from "@/hooks/use-toast";
import { refreshAfterChange } from "@/lib/refresh";
import {
  KIND_TEXT,
  STATUS_TEXT,
  TYPE_TEXT,
  api,
  dateLabel,
  download,
  rupeesFromText,
  send,
  type ExceptionRow,
  type TransactionRow,
} from "@/lib/ecommerce";
import { cn } from "@/lib/utils";

export function Tone({ tone, children }: { tone: "good" | "warn" | "risk" | "neutral" | "info"; children: React.ReactNode }) {
  return (
    <span className={cn(
      "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold",
      tone === "good" && "border-emerald-200 bg-emerald-50 text-emerald-800",
      tone === "warn" && "border-amber-200 bg-amber-50 text-amber-900",
      tone === "risk" && "border-red-200 bg-red-50 text-red-800",
      tone === "info" && "border-sky-200 bg-sky-50 text-sky-800",
      tone === "neutral" && "border-border bg-muted text-muted-foreground",
    )}>{children}</span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const info = STATUS_TEXT[status] ?? { label: status, tone: "neutral" as const };
  return <Tone tone={info.tone}>{info.label}</Tone>;
}

const STATUS_FILTERS = [
  { value: "", label: "All counted" },
  { value: "attention", label: "Needs attention" },
  { value: "missing_info", label: "Missing details" },
  { value: "tax_mismatch", label: "Tax differences" },
  { value: "unmatched", label: "Unmatched returns" },
  { value: "return_mismatch", label: "Return mismatches" },
  { value: "cross_period", label: "Earlier-month returns" },
  { value: "matched", label: "Matched returns" },
  { value: "reviewed", label: "Reviewed" },
  { value: "ok", label: "Ready" },
  { value: "conflict", label: "Different figures (held back)" },
  { value: "duplicate", label: "Duplicates (not counted)" },
];

const TYPE_FILTERS = [
  { value: "", label: "All types" },
  { value: "sale", label: "Sales" },
  { value: "reduction", label: "Returns and credit notes" },
  { value: "return", label: "Returns" },
  { value: "cancellation", label: "Cancellations" },
  { value: "credit_note", label: "Credit notes" },
];

type SortKey = "date" | "taxable" | "hsn" | "state" | "status";

/**
 * Every transaction of the period, filtered on the server (search, status, type, sort, pages), so a month with a
 * hundred thousand rows loads as fast as one with ten. A row opens its detail on the side.
 */
export function TransactionsPanel({ marketplace, period, fixedType, initialStatus = "", canReview }: { marketplace: string; period: string; fixedType?: string; initialStatus?: string; canReview: boolean }) {
  const [status, setStatus] = useState(initialStatus);
  const [type, setType] = useState(fixedType ?? "");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("date");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const { toast } = useToast();

  useEffect(() => setStatus(initialStatus), [initialStatus]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const params = new URLSearchParams({ period, page: String(page), pageSize: "50", sort, dir });
  if (status) params.set("status", status);
  if (type) params.set("type", type);
  if (query) params.set("search", query);
  const { data, isLoading, isError, isFetching } = useQuery<{ total: number; page: number; pageSize: number; rows: TransactionRow[] }>({
    queryKey: ["ecommerce", marketplace, "transactions", params.toString()],
    queryFn: () => api(`/ecommerce/${marketplace}/transactions?${params}`),
    placeholderData: keepPreviousData,
  });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));

  const sortBy = (key: SortKey) => {
    if (sort === key) setDir(dir === "asc" ? "desc" : "asc");
    else { setSort(key); setDir(key === "hsn" || key === "state" ? "asc" : "desc"); }
    setPage(1);
  };
  const SortHead = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => (
    <th scope="col" className={cn("px-3 py-2 font-medium", right && "text-right")} aria-sort={sort === k ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => sortBy(k)} className={cn("inline-flex items-center gap-1 hover:text-foreground", right && "flex-row-reverse")}>
        {children}{sort === k && (dir === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden="true" /> : <ArrowDown className="h-3 w-3" aria-hidden="true" />)}
      </button>
    </th>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <label className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Order, sub-order, invoice or HSN" aria-label="Search transactions" className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm" />
        </label>
        <select aria-label="Status" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }} className="h-9 rounded-lg border border-border bg-background px-2 text-sm">
          {STATUS_FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        {!fixedType && (
          <select aria-label="Type" value={type} onChange={event => { setType(event.target.value); setPage(1); }} className="h-9 rounded-lg border border-border bg-background px-2 text-sm">
            {TYPE_FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        )}
        <button
          type="button"
          className="fv-button-ghost h-9 sm:ml-auto"
          disabled={downloading}
          onClick={async () => {
            setDownloading(true);
            const result = await download(marketplace, period, "transactions_csv");
            setDownloading(false);
            if (!result.ok) toast({ title: "Download failed", description: result.message, variant: "destructive" });
          }}
        ><Download className="h-4 w-4" aria-hidden="true" />CSV</button>
      </div>

      {isError ? <Notice tone="error">Transactions could not be loaded. Try again in a moment.</Notice> : (
        <div className={cn("overflow-x-auto rounded-xl border border-border bg-card transition-opacity", isFetching && !isLoading && "opacity-70")}>
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <SortHead k="date">Date</SortHead>
                <th scope="col" className="px-3 py-2 font-medium">Type</th>
                <th scope="col" className="px-3 py-2 font-medium">Sub-order</th>
                <SortHead k="hsn">HSN</SortHead>
                <SortHead k="state">State</SortHead>
                <th scope="col" className="px-3 py-2 text-right font-medium">Rate</th>
                <SortHead k="taxable" right>Taxable</SortHead>
                <th scope="col" className="px-3 py-2 text-right font-medium">GST</th>
                <SortHead k="status">Status</SortHead>
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 6 }, (_, i) => (
                <tr key={i} className="border-b border-border last:border-0"><td colSpan={9} className="px-3 py-3"><div className="h-4 animate-pulse rounded bg-muted" /></td></tr>
              ))}
              {!isLoading && rows.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-10 text-center text-sm text-muted-foreground">No transactions match these filters.</td></tr>
              )}
              {rows.map(row => {
                const reduction = row.eventType !== "sale";
                const gst = sumText([row.igst, row.cgst, row.sgst, row.cess]);
                return (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    onClick={() => setOpen(row.id)}
                    onKeyDown={event => { if (event.key === "Enter") setOpen(row.id); }}
                    className={cn("cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/40 focus:bg-muted/50 focus:outline-none", row.duplicateOf && "text-muted-foreground")}
                    aria-label={`Open transaction ${row.subOrderId ?? row.id}`}
                  >
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{dateLabel(row.returnDate ?? row.orderDate)}</td>
                    <td className="px-3 py-2">{TYPE_TEXT[row.eventType] ?? row.eventType}{row.eventType !== row.sourceType && <span className="ml-1 text-xs text-muted-foreground">(reclassified)</span>}</td>
                    <td className="max-w-[14rem] truncate px-3 py-2 font-mono text-xs">{row.subOrderId ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums">{row.hsn ?? <span className="text-red-700">missing</span>}</td>
                    <td className="max-w-[10rem] truncate px-3 py-2">{row.posName ?? row.placeOfSupply ?? <span className="text-red-700">unknown</span>}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.rate != null ? `${Number(row.rate)}%` : "—"}</td>
                    <td className={cn("whitespace-nowrap px-3 py-2 text-right tabular-nums", reduction && "text-red-700")}>{reduction ? "−" : ""}{rupeesFromText(row.taxable)}</td>
                    <td className={cn("whitespace-nowrap px-3 py-2 text-right tabular-nums", reduction && "text-red-700")}>{reduction ? "−" : ""}{rupeesFromText(gst)}</td>
                    <td className="px-3 py-2"><StatusPill status={row.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span aria-live="polite">{total.toLocaleString("en-IN")} {total === 1 ? "transaction" : "transactions"}</span>
        <div className="flex items-center gap-1">
          <button type="button" className="fv-button-ghost h-8 px-2" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
          <span className="px-2 tabular-nums">Page {page} of {pages}</span>
          <button type="button" className="fv-button-ghost h-8 px-2" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      <TransactionDetail marketplace={marketplace} id={open} onClose={() => setOpen(null)} canReview={canReview} />
    </div>
  );
}

/** Adds decimal strings exactly (as paise) and returns a decimal string. */
function sumText(values: Array<string | null>): string {
  let paise = 0n;
  for (const value of values) {
    if (!value) continue;
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?/.exec(value);
    if (!m) continue;
    const p = BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0"));
    paise += m[1] === "-" ? -p : p;
  }
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  return `${negative ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

interface Detail {
  event: TransactionRow & { raw: Record<string, string>; notes: string[]; reportPeriod: string; ecoGstin: string | null; sellerGstin: string | null; shippingTaxable: string | null; sourceStatus: string | null; reconStatus: string; corrected: { hsn?: string | null; placeOfSupply?: string | null } };
  options: { states: Array<{ code: string; name: string }>; hsns: string[] };
  file: { fileName: string; containerName: string | null; sheetName: string | null; reportType: string } | null;
  exceptions: ExceptionRow[];
  reviews: Array<{ id: number; action: string; note: string | null; data: Record<string, unknown>; actor: string | null; at: string }>;
  linked: Array<{ id: number; eventType: string; reportPeriod: string; taxable: string; quantity: string | null; orderDate: string | null; returnDate: string | null; duplicateOf: number | null; relatedEventId: number | null }>;
}

const ACTION_TEXT: Record<string, string> = {
  confirm: "Confirmed",
  classify: "Classification changed",
  accept_difference: "Difference accepted",
  note: "Note",
  reopen: "Reopened",
  exception_resolve: "Item resolved",
  exception_accept: "Item accepted",
  exception_reopen: "Item reopened",
  use_instead: "These figures counted instead",
  correct: "Details corrected",
  keep_earlier: "Earlier figures kept",
};

/**
 * The editor for what a file had missing or wrong: the HSN (pick one already used this month, or type it) and the
 * customer's State (pick from the list). Opens by itself when the row needs it; otherwise it sits behind "Edit details".
 */
function FixDetails({ hsn, pos, options, needsHsn, needsState, busy, onSave }: {
  hsn: string | null;
  pos: string | null;
  options: { states: Array<{ code: string; name: string }>; hsns: string[] };
  needsHsn: boolean;
  needsState: boolean;
  busy: boolean;
  onSave: (hsn: string, pos: string) => void;
}) {
  const needed = needsHsn || needsState;
  const [open, setOpen] = useState(needed);
  const [hsnValue, setHsnValue] = useState(hsn ?? "");
  const [posValue, setPosValue] = useState(pos ?? "");
  const hsnOk = !hsnValue || /^(\d{4}|\d{6}|\d{8})$/.test(hsnValue);
  const changed = (hsnValue && hsnValue !== (hsn ?? "")) || (posValue && posValue !== (pos ?? ""));
  if (!open) {
    return <button type="button" className="text-sm font-medium text-[var(--fv-secondary)] underline-offset-2 hover:underline" onClick={() => setOpen(true)}>Edit details</button>;
  }
  return (
    <section className={cn("space-y-3 rounded-xl border p-4", needed ? "border-amber-200 bg-amber-50/50" : "border-border")} aria-label="Fix details">
      <div>
        <h3 className="text-sm font-semibold">{needed ? "Fill in what the file is missing" : "Edit details"}</h3>
        <p className="text-xs text-muted-foreground">Saved as your correction; the imported row stays as it was.</p>
      </div>
      <div className="space-y-1.5">
        <label className="block text-xs font-medium" htmlFor="fix-hsn">HSN code{needsHsn && <span className="text-red-700"> · needed</span>}</label>
        {options.hsns.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="HSN codes used this month">
            {options.hsns.map(code => (
              <button key={code} type="button" aria-pressed={hsnValue === code} onClick={() => setHsnValue(code)} className={cn("rounded-full border px-2.5 py-0.5 font-mono text-xs transition-colors", hsnValue === code ? "border-[var(--fv-accent)] bg-orange-50 text-orange-900" : "border-border bg-card hover:border-foreground/30")}>{code}</button>
            ))}
          </div>
        )}
        <input id="fix-hsn" inputMode="numeric" maxLength={8} value={hsnValue} onChange={event => setHsnValue(event.target.value.replace(/\D/g, ""))} placeholder="Or type 4, 6 or 8 digits" className={cn("h-9 w-full rounded-lg border bg-background px-3 font-mono text-sm", hsnOk ? "border-border" : "border-red-300")} aria-invalid={!hsnOk} />
      </div>
      <div className="space-y-1.5">
        <label className="block text-xs font-medium" htmlFor="fix-state">Customer's State{needsState && <span className="text-red-700"> · needed</span>}</label>
        <select id="fix-state" value={posValue} onChange={event => setPosValue(event.target.value)} className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm">
          <option value="">{pos ? "Keep as it is" : "Choose the State…"}</option>
          {options.states.map(s => <option key={s.code} value={s.code}>{s.code} · {s.name}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="fv-button-primary h-9" disabled={busy || !changed || !hsnOk} onClick={() => onSave(hsnValue !== (hsn ?? "") ? hsnValue : "", posValue !== (pos ?? "") ? posValue : "")}>Save correction</button>
        {!needed && <button type="button" className="fv-button-ghost h-9" onClick={() => setOpen(false)}>Cancel</button>}
      </div>
    </section>
  );
}

/** The side panel for one transaction: its figures, the source row exactly as the file had it, issues and decisions. */
export function TransactionDetail({ marketplace, id, onClose, canReview }: { marketplace: string; id: number | null; onClose: () => void; canReview: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [classifyTo, setClassifyTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading } = useQuery<Detail>({
    queryKey: ["ecommerce", marketplace, "transaction", id],
    queryFn: () => api(`/ecommerce/${marketplace}/transactions/${id}`),
    enabled: id != null,
  });
  useEffect(() => { setNote(""); setClassifyTo(""); setError(null); }, [id]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (id == null) return;
    setBusy(true);
    setError(null);
    const result = await send("POST", `/ecommerce/${marketplace}/transactions/${id}/review`, { action, note: note || undefined, ...extra });
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? "That could not be saved.");
      return;
    }
    setNote("");
    setClassifyTo("");
    toast({ title: action === "note" ? "Note added" : action === "reopen" ? "Reopened for review" : action === "correct" ? "Correction saved" : "Decision saved" });
    await refreshAfterChange(qc, [["ecommerce", marketplace]]);
  };

  const e = data?.event;
  const open = data?.exceptions.filter(x => x.status === "open") ?? [];
  const closedByPerson = data?.exceptions.some(x => x.status !== "open" && x.note) ?? false;
  const hasDifference = open.some(x => ["tax_mismatch", "invoice_value_mismatch", "rate_check", "b2cl_candidate"].includes(x.kind));
  const isDuplicate = e?.duplicateOf != null;
  const conflict = open.find(x => x.kind === "conflicting_rows");

  return (
    <Sheet open={id != null} onOpenChange={value => { if (!value) onClose(); }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{e ? `${TYPE_TEXT[e.eventType] ?? e.eventType} · ${e.subOrderId ?? `#${e.id}`}` : "Transaction"}</SheetTitle>
          <SheetDescription>{e ? <>From {data?.file?.fileName ?? "an imported file"}{data?.file?.sheetName ? ` (${data.file.sheetName})` : ""}, row {e.sourceRow}</> : "Loading"}</SheetDescription>
        </SheetHeader>
        {isLoading || !e ? <div className="mt-6 space-y-3">{Array.from({ length: 5 }, (_, i) => <div key={i} className="h-5 animate-pulse rounded bg-muted" />)}</div> : (
          <div className="mt-5 space-y-6 text-sm">
            <div className="flex flex-wrap items-center gap-2"><StatusPill status={e.reconStatus} />{e.eventType !== e.sourceType && <Tone tone="info">Read as {TYPE_TEXT[e.sourceType] ?? e.sourceType}</Tone>}</div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              {([
                ["Order", e.orderId],
                ["Period", e.reportPeriod],
                ["Order date", dateLabel(e.orderDate)],
                ["Return date", e.returnDate ? dateLabel(e.returnDate) : null],
                ["Invoice / credit note", e.documentNumber],
                ["HSN", e.hsn],
                ["Quantity", e.quantity == null ? null : String(Number(e.quantity))],
                ["GST rate", e.rate != null ? `${Number(e.rate)}%` : null],
                ["Taxable value", rupeesFromText(e.taxable)],
                ["IGST", rupeesFromText(e.igst)],
                ["CGST", rupeesFromText(e.cgst)],
                ["SGST/UTGST", rupeesFromText(e.sgst)],
                ["Tax in report", e.sourceTax != null ? rupeesFromText(e.sourceTax) : null],
                ["Tax recalculated", e.computedTax != null ? rupeesFromText(e.computedTax) : null],
                ["Invoice value", rupeesFromText(e.invoiceValue)],
                ["Place of supply", e.posName ? `${e.placeOfSupply} · ${e.posName}` : e.placeOfSupply],
                ["Supply", e.supplyType === "intra" ? "Within the State" : e.supplyType === "inter" ? "Inter-State" : "Unknown"],
                ["Marketplace GSTIN", e.ecoGstin],
              ] as Array<[string, string | null]>).filter(([, v]) => v != null && v !== "").map(([k, v]) => (
                <div key={k} className="min-w-0"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="truncate tabular-nums">{v}</dd></div>
              ))}
            </dl>

            {(e.corrected?.hsn !== undefined || e.corrected?.placeOfSupply !== undefined) && (
              <p className="text-xs text-muted-foreground" data-testid="corrected-note">
                Corrected by a reviewer.{e.corrected.hsn !== undefined ? ` The file's HSN: ${e.corrected.hsn || "blank"}.` : ""}{e.corrected.placeOfSupply !== undefined ? ` The file's State: ${e.corrected.placeOfSupply || "not recognised"}.` : ""}
              </p>
            )}
            {e.notes.length > 0 && <ul className="space-y-1 text-xs text-muted-foreground">{e.notes.map(n => <li key={n}>• {n}</li>)}</ul>}

            {canReview && !isDuplicate && (
              <FixDetails
                key={`${e.id}-${e.hsn}-${e.placeOfSupply}`}
                hsn={e.hsn}
                pos={e.placeOfSupply}
                options={data.options}
                needsHsn={open.some(x => x.kind === "missing_hsn" || x.kind === "invalid_hsn")}
                needsState={open.some(x => x.kind === "unknown_state")}
                busy={busy}
                onSave={(hsn, pos) => void act("correct", { hsn: hsn || undefined, placeOfSupply: pos || undefined })}
              />
            )}

            {data.exceptions.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Needs a look</h3>
                <ul className="space-y-2">
                  {data.exceptions.map(x => (
                    <li key={x.id} className={cn("rounded-lg border p-3", x.status === "open" ? (x.severity === "error" ? "border-red-200 bg-red-50/60" : x.severity === "warning" ? "border-amber-200 bg-amber-50/60" : "border-border") : "border-border opacity-70")}>
                      <div className="flex items-center justify-between gap-2"><span className="font-medium">{KIND_TEXT[x.kind] ?? x.kind}</span><Tone tone={x.status === "open" ? (x.severity === "info" ? "info" : "warn") : "good"}>{x.status === "open" ? "Open" : x.status === "accepted" ? "Accepted" : "Resolved"}</Tone></div>
                      <p className="mt-1 text-xs text-muted-foreground">{x.message}</p>
                      {x.note && x.status !== "open" && <p className="mt-1 text-xs">Note: {x.note}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.linked.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Linked transactions</h3>
                <ul className="space-y-1">
                  {data.linked.map(l => (
                    <li key={l.id} className="flex justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs">
                      <span>{l.duplicateOf === e.id ? "Duplicate of this" : e.duplicateOf === l.id ? "Original row" : TYPE_TEXT[l.eventType] ?? l.eventType} · {l.reportPeriod}</span>
                      <span className="tabular-nums">{rupeesFromText(l.taxable)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {canReview && !isDuplicate && (
              <section className="space-y-3 rounded-xl border border-border p-4">
                <h3 className="text-sm font-semibold">Review</h3>
                <textarea value={note} onChange={event => setNote(event.target.value)} rows={2} maxLength={2000} placeholder="Note (needed to accept a difference or change the type)" aria-label="Review note" className="w-full rounded-lg border border-border bg-background p-2 text-sm" />
                <div className="flex flex-wrap gap-2">
                  {open.length > 0 && <button type="button" className="fv-button-primary h-9" disabled={busy} onClick={() => void act("confirm")}>Confirm as correct</button>}
                  {hasDifference && <button type="button" className="fv-button-secondary h-9" disabled={busy || !note.trim()} onClick={() => void act("accept_difference")}>Accept difference</button>}
                  {closedByPerson && <button type="button" className="fv-button-ghost h-9" disabled={busy} onClick={() => void act("reopen")}>Reopen</button>}
                  <button type="button" className="fv-button-ghost h-9" disabled={busy || !note.trim()} onClick={() => void act("note")}>Add note</button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select aria-label="Change type to" value={classifyTo} onChange={event => setClassifyTo(event.target.value)} className="h-9 rounded-lg border border-border bg-background px-2 text-sm">
                    <option value="">Change type to…</option>
                    {Object.entries(TYPE_TEXT).filter(([k]) => k !== e.eventType).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <button type="button" className="fv-button-ghost h-9" disabled={busy || !classifyTo || !note.trim()} onClick={() => void act("classify", { eventType: classifyTo })}>Apply</button>
                </div>
                <p className="text-xs text-muted-foreground">Decisions are recorded with your name. The imported row itself never changes.</p>
                {error && <Notice tone="error">{error}</Notice>}
              </section>
            )}
            {isDuplicate && conflict && canReview && (
              <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/50 p-4" aria-label="Choose which figures count">
                <h3 className="text-sm font-semibold">Which figures are right?</h3>
                <p className="text-xs text-muted-foreground">{conflict.message}</p>
                <textarea value={note} onChange={event => setNote(event.target.value)} rows={2} maxLength={2000} placeholder="Why (required)" aria-label="Review note" className="w-full rounded-lg border border-border bg-background p-2 text-sm" />
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="fv-button-primary h-9" disabled={busy || !note.trim()} onClick={() => void act("keep_earlier")}>Keep the earlier row</button>
                  <button type="button" className="fv-button-secondary h-9" disabled={busy || !note.trim()} onClick={() => void act("use_instead")}>Count this row instead</button>
                </div>
                {error && <Notice tone="error">{error}</Notice>}
              </section>
            )}
            {isDuplicate && !conflict && <Notice tone="info">This row repeats an earlier import and is not counted. Review the original row instead.</Notice>}

            {data.reviews.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h3>
                <ol className="space-y-2 text-xs">
                  {data.reviews.map(r => (
                    <li key={r.id} className="border-l-2 border-border pl-3">
                      <div className="font-medium">{ACTION_TEXT[r.action] ?? r.action}{r.action === "classify" && typeof r.data.eventType === "string" ? ` to ${TYPE_TEXT[r.data.eventType] ?? r.data.eventType}` : ""}</div>
                      <div className="text-muted-foreground">{r.actor ?? "Someone"} · {new Date(r.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
                      {r.note && <div className="mt-0.5">{r.note}</div>}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <details className="rounded-xl border border-border">
              <summary className="cursor-pointer px-4 py-2 text-sm font-medium">Source row as imported</summary>
              <dl className="grid gap-x-4 gap-y-1 border-t border-border px-4 py-3 text-xs sm:grid-cols-2">
                {Object.entries(e.raw).map(([k, v]) => (
                  <div key={k} className="min-w-0"><dt className="truncate text-muted-foreground">{k}</dt><dd className="break-words font-mono">{v === "" ? "—" : v}</dd></div>
                ))}
              </dl>
            </details>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
