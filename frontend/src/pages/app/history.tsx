import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, ChevronRight, FileSpreadsheet, GitCompare, History as HistoryIcon, Layers, LifeBuoy, Receipt, Search, ShoppingBag, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import {
  BigStat,
  Choice,
  MoreOptions,
  Notice,
  ResultCard,
  StatementProof,
  downloadBlob,
  downloadText,
  fmtDate,
  inr,
  postDownload,
  postJson,
  toCsv,
  useClients,
  type StatementCheck,
} from "@/components/jobs/jobUi";
import { StatementViewer, type DownloadItem } from "@/components/jobs/BankStatementTable";
import { getActiveClient } from "@/lib/activeClient";
import { getUser } from "@/lib/auth";
import { upgradeMailto, usePrivacy } from "@/lib/privacy";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Shared types and labels ─────────────────────────────────────────────────

interface RunInfo {
  bankName?: string | null;
  periodLabel?: string | null;
  rows?: number;
  verified?: boolean | null;
  counts?: Record<string, number> | null;
  entries?: number;
  matched?: number;
  summary?: { documents?: number; gst?: number; gross?: number; errors?: number } | null;
  platform?: string | null;
}

interface HistoryRow {
  id: string;
  run_type: string;
  title: string;
  status: string;
  month?: string | null;
  created_at: string;
  user_name?: string | null;
  user_email?: string | null;
  info: RunInfo | null;
}

const KINDS: Record<string, { label: string; icon: LucideIcon }> = {
  bank_to_tally: { label: "Bank → Tally", icon: FileSpreadsheet },
  bank_tally_reconciliation: { label: "Bank ↔ Tally", icon: GitCompare },
  ecommerce_gst: { label: "E-commerce GST", icon: ShoppingBag },
  bank_invoice_reconciliation: { label: "Invoice ↔ Bank", icon: Receipt },
  import_records: { label: "Data import", icon: Layers },
  full_month_close: { label: "Month-end check", icon: Layers },
};

const FILTERS = [
  { value: "", label: "All" },
  { value: "bank_to_tally", label: "Bank → Tally" },
  { value: "bank_tally_reconciliation", label: "Bank ↔ Tally" },
  { value: "ecommerce_gst", label: "E-commerce GST" },
  { value: "bank_invoice_reconciliation", label: "Invoice ↔ Bank" },
  { value: "other", label: "Other" },
] as const;

function kindOf(type: string) {
  return KINDS[type] ?? { label: "Other", icon: Layers };
}

/** "Bank Statement → Tally — hdfc-may.pdf" becomes "hdfc-may.pdf". */
function displayTitle(row: Pick<HistoryRow, "title" | "run_type">) {
  const title = row.title ?? "";
  const cut = title.indexOf(" — ");
  const name = cut >= 0 ? title.slice(cut + 3).trim() : "";
  return name || (KINDS[row.run_type]?.label ?? title) || "Untitled";
}

function titleCase(text: string) {
  return text.split(" + ").map(part => (part === "generic" ? "Marketplace" : part.charAt(0).toUpperCase() + part.slice(1))).join(" + ");
}

function attentionOf(counts?: Record<string, number> | null) {
  if (!counts) return null;
  return (counts.suggested ?? 0) + (counts.bankOnly ?? 0) + (counts.tallyOnly ?? 0) + (counts.amountDifferences ?? 0) + (counts.duplicates ?? 0);
}

function summaryLine(row: HistoryRow) {
  const info = row.info;
  if (!info) return row.month ? `For ${row.month}` : "";
  switch (row.run_type) {
    case "bank_to_tally":
      return [info.bankName ?? "Bank statement", info.rows != null ? `${info.rows} transactions` : null, info.periodLabel].filter(Boolean).join(" · ");
    case "bank_tally_reconciliation": {
      const attention = attentionOf(info.counts);
      return attention == null ? "" : `${info.counts?.confirmed ?? 0} matched · ${attention} need attention`;
    }
    case "bank_invoice_reconciliation": {
      const entries = info.entries ?? 0;
      return `${info.matched ?? 0} matched · ${Math.max(entries - (info.matched ?? 0), 0)} need attention`;
    }
    case "ecommerce_gst":
      return [info.platform ? titleCase(info.platform) : "Marketplace", info.summary?.documents != null ? `${info.summary.documents} invoices` : null, info.summary?.errors ? `${info.summary.errors} need review` : null].filter(Boolean).join(" · ");
    default:
      return "";
  }
}

function when(value: string, withTime = false) {
  const date = new Date(value);
  return date.toLocaleString("en-IN", withTime
    ? { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }
    : { hour: "numeric", minute: "2-digit" });
}

/** A ready-to-send email about one saved item. It carries the item's name and date, never its contents. */
function ticketMailto(email: string, row: Pick<HistoryRow, "id" | "title" | "run_type" | "created_at">) {
  const name = displayTitle(row);
  const body = [`Hello,`, ``, `I have a question about this item in TallyThis history:`, `File: ${name}`, `Job: ${kindOf(row.run_type).label}`, `Date: ${when(row.created_at, true)}`, `Reference: ${row.id}`, ``, `My question:`, ``].join("\n");
  return `mailto:${email}?subject=${encodeURIComponent(`TallyThis history: ${name}`)}&body=${encodeURIComponent(body)}`;
}

function who(row: Pick<HistoryRow, "user_name" | "user_email">) {
  return row.user_name || row.user_email || "";
}

// ── List ────────────────────────────────────────────────────────────────────

export default function HistoryPage() {
  const [, navigate] = useLocation();
  const { active } = useClients();
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Only the first page of a load knows how many older items are waiting.
  const [older, setOlder] = useState({ count: 0, months: 3, email: "" });
  const privacy = usePrivacy();
  const request = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (offset: number) => {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: "30", offset: String(offset) });
      if (type) params.set("type", type);
      if (query) params.set("q", query);
      const response = await fetch(`${BASE}/api/jobs/history?${params}`);
      const data = await response.json().catch(() => null);
      if (id !== request.current) return;
      if (!response.ok || !data?.ok) throw new Error(data?.message || "History could not be loaded. Please try again in a moment.");
      setRows(current => (offset === 0 ? data.runs : [...current, ...data.runs]));
      setHasMore(Boolean(data.hasMore));
      if (offset === 0) setOlder({ count: Number(data.olderCount) || 0, months: Number(data.windowMonths) || 3, email: String(data.supportEmail || "") });
    } catch (err) {
      if (id === request.current) setError(err instanceof Error ? err.message : "History could not be loaded. Please try again in a moment.");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [type, query]);

  useEffect(() => { void load(0); }, [load, active?.id]);

  return (
    <div className="fv-standard-page fv-history-wide">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">History</h1>
      <p className="mt-1.5 text-sm text-muted-foreground sm:text-base">
        Your last {older.months} months of work{active ? <> for <span className="font-medium text-foreground">{active.name}</span></> : ""}. Open any item to see the result and download it again.
      </p>

      <div className="relative mt-5">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input aria-label="Search by file name" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by file name" className="fv-input h-11 w-full pl-9" />
      </div>
      <div className="mt-3 overflow-x-auto pb-1">
        <Choice size="sm" value={type} onChange={setType} options={FILTERS.map(filter => ({ value: filter.value, label: filter.label }))} />
      </div>

      {error && <div className="mt-4"><Notice tone="error">{error}</Notice></div>}

      <div className="mt-5 space-y-6">
        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[760px] border-collapse text-sm" aria-label="History">
              <thead className="bg-muted/50 text-left">
                <tr>
                  {["Date & time", "File name", "Details", "Status"].map(label => <th key={label} className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--fv-accent-dark)]">{label}</th>)}
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--fv-accent-dark)]">View</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--fv-accent-dark)]">Raise a ticket</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(row => {
                  const kind = kindOf(row.run_type);
                  const failed = row.status === "failed";
                  const done = row.status === "completed" || row.status === "complete" || row.status === "success";
                  return (
                    <tr key={row.id} className="align-top hover:bg-muted/30">
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        <div>{when(row.created_at, true)}</div>
                        {who(row) && <div className="text-xs">{who(row)}</div>}
                      </td>
                      <td className="min-w-[200px] max-w-[320px] px-4 py-3">
                        <span className="block font-medium [overflow-wrap:anywhere]">{displayTitle(row)}</span>
                        <span className="block text-xs text-muted-foreground">{kind.label}</span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{summaryLine(row) || "—"}</td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className={cn("font-medium", failed ? "text-red-700" : done ? "text-emerald-700" : "text-muted-foreground")}>{failed ? "Failed" : done ? "Success" : titleCase(row.status.replace(/_/g, " "))}</span>
                        {row.info?.verified && <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800"><ShieldCheck className="h-3 w-3" />Checked</span>}
                      </td>
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => navigate(`/app/history/${row.id}`)} className="font-semibold text-[var(--fv-accent-dark)] hover:underline" aria-label={`View ${displayTitle(row)}`}>View</button>
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={ticketMailto(older.email || privacy.supportEmail, row)}
                          aria-label={`Raise a ticket about ${displayTitle(row)}`}
                          title="Email us about this item"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <LifeBuoy className="h-4 w-4" />
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!loading && rows.length === 0 && !error && (
          <div className="rounded-2xl border border-dashed border-border bg-card p-8 text-center">
            <HistoryIcon className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">{query || type ? "Nothing matches. Try another filter." : "Nothing yet. Your finished jobs will show up here."}</p>
          </div>
        )}
        {loading && <p className="text-center text-sm text-muted-foreground">Loading…</p>}
        {!loading && hasMore && (
          <button type="button" className="fv-button-secondary w-full" onClick={() => void load(rows.length)}>Show more</button>
        )}
        {!loading && !error && older.count > 0 && !hasMore && (
          <p className="rounded-xl border border-dashed border-border px-4 py-3 text-center text-sm text-muted-foreground">
            Showing the last {older.months} months. {older.count} older {older.count === 1 ? "item is" : "items are"} kept safely.{" "}
            <a className="font-semibold text-[var(--fv-accent-dark)] hover:underline" href={upgradeMailto("Older history")}>Email {older.email || privacy.supportEmail}</a> and we will send {older.count === 1 ? "it" : "them"} to you.
          </p>
        )}
        {!loading && !error && (
          <p className="text-center text-xs text-muted-foreground">Incognito jobs aren’t saved to your workspace, so they do not appear here.</p>
        )}
      </div>
    </div>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

interface Artifact { id: number; artifact_type: string; title: string; json_data: any; created_at: string }
interface Detail {
  run: HistoryRow & { completed_at?: string | null; failed_reason?: string | null };
  artifacts: Artifact[];
}

const BUCKETS: Record<string, string> = {
  confirmed: "Matched",
  matched: "Matched",
  suggested: "Probable match",
  bank_only: "In bank, missing in Tally",
  tally_only: "In Tally, missing in bank",
  amount_difference: "Amounts differ",
  amount_mismatch: "Amount differs",
  duplicate: "Possible duplicate",
  payment_without_invoice: "Bank entry without an invoice",
  invoice_without_payment: "Invoice not paid yet",
  no_invoice_expected: "No invoice expected",
};

export function HistoryDetailPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/app/history/:id");
  const id = params?.id ?? "";
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [tooOld, setTooOld] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setTooOld(false);
    fetch(`${BASE}/api/jobs/history/${encodeURIComponent(id)}`)
      .then(response => response.json().catch(() => ({})).then(data => ({ ok: response.ok && data.ok, data })))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok) {
          setError(data.message || "This item could not be opened.");
          setTooOld(data.code === "outside_window");
        } else setDetail(data);
      })
      .catch(() => { if (!cancelled) setError("Could not reach TallyThis."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const latest = (type: string) => [...(detail?.artifacts ?? [])].reverse().find(artifact => artifact.artifact_type === type);

  return (
    <div className="fv-standard-page">
      <button type="button" onClick={() => navigate("/app/history")} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />History
      </button>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <Notice tone={tooOld ? "info" : "error"}>
          {error}
          {tooOld && <div className="mt-3"><a className="fv-button-secondary inline-flex h-9" href={upgradeMailto("Older history item")}>Email us about this item</a></div>}
        </Notice>
      )}
      {detail && (
        <>
          <div className="mb-5">
            <div className="text-xs font-medium text-muted-foreground">{kindOf(detail.run.run_type).label}</div>
            <h1 className="mt-1 break-words text-2xl font-bold tracking-tight sm:text-3xl">{displayTitle(detail.run)}</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">{[who(detail.run), when(detail.run.created_at, true)].filter(Boolean).join(" · ")}</p>
          </div>
          {detail.run.status === "failed" && <div className="mb-4"><Notice tone="error">This job did not finish{detail.run.failed_reason ? `: ${detail.run.failed_reason}` : "."}</Notice></div>}
          {detail.run.run_type === "bank_to_tally" && <BankStatementView artifact={latest("bank_statement")} xml={latest("tally_xml")} />}
          {(detail.run.run_type === "bank_tally_reconciliation" || detail.run.run_type === "bank_invoice_reconciliation") && (
            <ComparisonView artifact={latest(detail.run.run_type === "bank_tally_reconciliation" ? "bank_tally_comparison" : "invoice_bank_comparison")} fileName={displayTitle(detail.run)} />
          )}
          {detail.run.run_type === "ecommerce_gst" && <EcommerceView artifact={latest("ecommerce_gst")} />}
          {!KINDS_WITH_VIEW.has(detail.run.run_type) && <GenericView detail={detail} />}
        </>
      )}
    </div>
  );
}

const KINDS_WITH_VIEW = new Set(["bank_to_tally", "bank_tally_reconciliation", "bank_invoice_reconciliation", "ecommerce_gst"]);

function Missing() {
  return <Notice tone="warn">The saved result for this item is not available.</Notice>;
}

interface StatementTxn {
  rowNumber: number;
  date: string;
  valueDate?: string | null;
  narration: string;
  reference: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  counterparty?: string | null;
  confidence: number;
}

/** A saved statement opens in the same full-screen viewer as a fresh upload, without editing. */
function BankStatementView({ artifact, xml }: { artifact?: Artifact; xml?: Artifact }) {
  const [viewerOpen, setViewerOpen] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");
  if (!artifact) return <Missing />;
  const data = artifact.json_data ?? {};
  const txns: StatementTxn[] = (Array.isArray(data.transactions) ? data.transactions : []).map((txn: StatementTxn, index: number) => ({ ...txn, rowNumber: txn.rowNumber ?? index + 1 }));
  const check: StatementCheck | null = data.check ?? null;
  const flagged = txns.filter(txn => txn.confidence < 0.9).length;
  const aiRead = data.source === "ai" || data.source === "ocr";
  const opening: number | null = check?.openingBalance ?? data.openingBalance ?? null;
  const closing: number | null = check?.printedClosing ?? check?.closingBalance ?? data.closingBalance ?? null;
  const bankName: string = data.bankName ?? "Bank statement";

  const csv = () => downloadText(
    "bank-transactions.csv",
    toCsv(["Date", "Value date", "Narration", "Reference", "Withdrawal", "Deposit", "Balance"], txns.map(txn => [txn.date, txn.valueDate ?? "", txn.narration, txn.reference ?? "", txn.debit ?? "", txn.credit ?? "", txn.balance ?? ""])),
    "text/csv",
  );

  // Same conversion-only workbook as a fresh upload: nothing is classified until the CA reviews it.
  const excel = async () => {
    setExporting(true);
    setNotice("");
    const client = getActiveClient();
    const response = await postDownload("/api/jobs/bank-to-tally/excel", {
      clientName: client?.name || getUser()?.company || "Client",
      bankName,
      accountNumberMasked: data.accountNumberMasked ?? null,
      periodLabel: data.periodLabel ?? null,
      openingBalance: opening,
      closingBalance: closing,
      balanceCheck: check?.verified ? "passed" : "needs_check",
      rows: txns.map(txn => ({
        rowNumber: txn.rowNumber,
        date: txn.date,
        valueDate: txn.valueDate ?? null,
        narration: txn.narration,
        reference: txn.reference,
        debit: txn.debit,
        credit: txn.credit,
        balance: txn.balance,
        counterparty: txn.counterparty ?? null,
        ledgerChoice: "Suspense",
        ledgerConfirmed: false,
        voucherType: txn.credit != null && txn.credit > 0 ? "Receipt" : "Payment",
        query: null,
        needsReview: txn.confidence < 0.9,
        reviewed: false,
        edited: false,
        excluded: false,
      })),
    });
    setExporting(false);
    if (!response.ok || !response.blob) { setNotice(response.message || "The Excel file could not be created."); return; }
    downloadBlob("TallyThis_Bank_Transactions.xlsx", response.blob);
  };

  const downloads: DownloadItem[] = [
    { key: "excel", label: "Excel", hint: "The statement as saved, ready for review", busy: exporting, onSelect: () => void excel() },
    { key: "csv", label: "CSV", hint: "Every transaction as plain rows", onSelect: csv },
    ...(xml?.json_data?.xml ? [{ key: "xml", label: "Tally XML", hint: "The Tally file created for this statement", onSelect: () => downloadText(xml.title || "tally-vouchers.xml", xml.json_data.xml, "application/xml") }] : []),
  ];

  return (
    <div className="space-y-4">
      <ResultCard
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <span>{bankName}{data.accountNumberMasked ? ` · ••${data.accountNumberMasked}` : ""}{data.periodLabel ? ` · ${data.periodLabel}` : ""}</span>
            {aiRead && <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 normal-case tracking-normal text-sky-800"><Sparkles className="h-3 w-3" />Read by AI</span>}
          </span>
        }
        actions={<button type="button" className="fv-button-primary h-11 px-6" onClick={() => setViewerOpen(true)}>Open statement</button>}
      >
        <div className="grid grid-cols-2 gap-6">
          <BigStat value={txns.length} label="transactions" />
          <BigStat value={flagged} label={flagged === 1 ? "was flagged for review" : "were flagged for review"} tone={flagged > 0 ? "attention" : "good"} />
        </div>
        <div className="mt-4 text-sm text-muted-foreground">Money in {inr(data.creditTotal)} · Money out {inr(data.debitTotal)}</div>
        <StatementProof check={check} />
        {xml?.json_data?.voucherCount != null && <p className="mt-3 text-xs text-muted-foreground">Tally file: {xml.json_data.voucherCount} vouchers.</p>}
      </ResultCard>

      {viewerOpen && (
        <StatementViewer
          title={`${bankName} statement`}
          rows={txns}
          openingBalance={opening}
          closingBalance={closing}
          onClose={() => setViewerOpen(false)}
          backLabel="Back to history"
          downloads={downloads}
          notice={notice ? <Notice tone="error" onClose={() => setNotice("")}>{notice}</Notice> : null}
        />
      )}
    </div>
  );
}

interface CompareItemData {
  bucket: string;
  status: string;
  confidence?: number;
  why?: string[];
  bank?: { date: string; narration?: string; debit: number | null; credit: number | null };
  tally?: { date: string; ledgerName?: string; debit: number | null; credit: number | null };
  invoice?: { invoiceNumber: string; vendorName: string; total: number; invoiceDate: string | null };
}

const isMatched = (bucket: string) => bucket === "confirmed" || bucket === "matched";

function ComparisonView({ artifact, fileName }: { artifact?: Artifact; fileName: string }) {
  const [limit, setLimit] = useState(15);
  if (!artifact) return <Missing />;
  const data = artifact.json_data ?? {};
  const items: CompareItemData[] = Array.isArray(data.comparison?.items) ? data.comparison.items : [];
  const matched = items.filter(item => isMatched(item.bucket));
  const skipped = items.filter(item => item.bucket === "no_invoice_expected");
  const attention = items.filter(item => !isMatched(item.bucket) && item.bucket !== "no_invoice_expected");
  const decision = (item: CompareItemData) => (item.status === "approved" ? "Confirmed" : item.status === "rejected" ? "Not a match" : "");

  const report = () => downloadText(
    `${fileName.replace(/\.[a-z0-9]+$/i, "") || "report"}-report.csv`,
    toCsv(
      ["Result", "Decision", "Bank date", "Bank narration", "Bank amount", "Other side", "Other side amount"],
      items.map(item => [
        BUCKETS[item.bucket] ?? item.bucket,
        isMatched(item.bucket) ? "Matched" : decision(item) || "Not reviewed",
        item.bank?.date ?? "",
        item.bank?.narration ?? "",
        item.bank ? item.bank.debit ?? item.bank.credit ?? "" : "",
        item.tally ? `${item.tally.ledgerName ?? ""} ${item.tally.date}`.trim() : item.invoice ? `${item.invoice.invoiceNumber} ${item.invoice.vendorName}`.trim() : "",
        item.tally ? item.tally.debit ?? item.tally.credit ?? "" : item.invoice?.total ?? "",
      ]),
    ),
    "text/csv",
  );

  return (
    <div className="space-y-4">
      <ResultCard
        eyebrow={data.bankName || data.periodLabel ? [data.bankName, data.periodLabel].filter(Boolean).join(" · ") : undefined}
        actions={<button type="button" className="fv-button-primary h-11 px-6" onClick={report}>Download Report</button>}
      >
        <div className="grid grid-cols-2 gap-6">
          <BigStat value={matched.length} label="matched" tone="good" />
          <BigStat value={attention.length} label="needed attention" tone={attention.length > 0 ? "attention" : "good"} />
        </div>
        {skipped.length > 0 && <p className="mt-3 text-xs text-muted-foreground">{skipped.length} salary, cash, tax or bank-charge entries were set aside — these usually have no invoice.</p>}
      </ResultCard>

      {attention.length > 0 && (
        <section className="rounded-2xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3 text-sm font-semibold">Items that needed attention</div>
          <div className="divide-y divide-border">
            {attention.slice(0, limit).map((item, index) => (
              <div key={index} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{BUCKETS[item.bucket] ?? item.bucket}</span>
                  {decision(item) && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">{decision(item)}</span>}
                </div>
                <div className="mt-1.5 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  <div>{item.bank ? <>Bank: {inr(item.bank.debit ?? item.bank.credit)} · {fmtDate(item.bank.date)} · {item.bank.narration}</> : "Bank: not found"}</div>
                  <div>
                    {item.tally ? <>Tally: {inr(item.tally.debit ?? item.tally.credit)} · {fmtDate(item.tally.date)} · {item.tally.ledgerName}</>
                      : item.invoice ? <>Invoice: {inr(item.invoice.total)} · {item.invoice.invoiceNumber} · {item.invoice.vendorName}</>
                      : "Other side: not found"}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {attention.length > limit && (
            <button type="button" className="w-full border-t border-border px-4 py-3 text-sm font-semibold text-[var(--fv-accent-dark)] hover:bg-muted/40" onClick={() => setLimit(value => value + 20)}>Show more</button>
          )}
        </section>
      )}
    </div>
  );
}

function EcommerceView({ artifact }: { artifact?: Artifact }) {
  const [error, setError] = useState("");
  if (!artifact) return <Missing />;
  const pack = artifact.json_data ?? {};
  const summary = pack.summary ?? {};
  const name = String(pack.platform ?? "marketplace").replace(/\s\+\s/g, "-");

  const download = async () => {
    setError("");
    const json = await postJson<{ json: unknown }>("/api/jobs/ecommerce/gst-json", { pack });
    if (!json.ok) {
      setError(json.data.errors?.slice(0, 3).join(" ") || json.data.message || "GST draft not created.");
      return;
    }
    downloadText(`${name}-gstr1-draft.json`, JSON.stringify(json.data.json, null, 2), "application/json");
    const csv = await postJson<{ csv: string }>("/api/jobs/ecommerce/csv", { sales: pack.sales ?? [] });
    if (csv.data.csv) downloadText(`${name}-sales-summary.csv`, csv.data.csv, "text/csv");
  };

  return (
    <div className="space-y-4">
      <ResultCard
        eyebrow={pack.platform ? titleCase(String(pack.platform)) : undefined}
        actions={<button type="button" className="fv-button-primary h-11 px-6" onClick={download}>Download GST Reports</button>}
      >
        <div className="grid grid-cols-2 gap-6">
          <BigStat value={summary.documents ?? 0} label="invoices" tone="good" />
          <BigStat value={summary.errors ?? 0} label={summary.errors === 1 ? "needed review" : "needed review"} tone={summary.errors ? "attention" : "good"} />
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {[["Taxable value", inr(summary.taxableValue)], ["GST", inr(summary.gst)], ["TCS", inr(summary.tcs)], ["B2B · B2C", `${summary.b2b ?? 0} · ${summary.b2c ?? 0}`]].map(([label, value]) => (
            <div key={label} className="rounded-xl bg-muted/50 px-3 py-2"><div className="text-xs text-muted-foreground">{label}</div><div className="font-semibold">{value}</div></div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Draft data for your GST return. Potential risk — needs CA review. Not filed on the GST portal.</p>
      </ResultCard>
      {error && <Notice tone="error" onClose={() => setError("")}>{error}</Notice>}
    </div>
  );
}

/** Older work (data imports, month-end checks): show the plain facts that were saved. */
function GenericView({ detail }: { detail: Detail }) {
  const facts = useMemo(() => {
    const out: Array<[string, string]> = [];
    for (const artifact of detail.artifacts) {
      const data = artifact.json_data;
      if (!data || typeof data !== "object") continue;
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (typeof value === "number" || (typeof value === "string" && value.length < 80) || typeof value === "boolean") {
          out.push([key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase()), String(value)]);
        }
      }
    }
    return out.slice(0, 24);
  }, [detail]);
  return (
    <div className="space-y-4">
      <ResultCard eyebrow={detail.run.month ? `For ${detail.run.month}` : undefined}>
        <p className="text-sm text-muted-foreground">
          This is earlier work from the older month-end flow. It finished with status <span className="font-semibold text-foreground">{detail.run.status}</span>.
        </p>
      </ResultCard>
      {facts.length > 0 && (
        <MoreOptions label="Show details">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {facts.map(([label, value], index) => (
              <div key={`${label}-${index}`} className="flex justify-between gap-3 border-b border-border pb-1.5"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{value}</dd></div>
            ))}
          </dl>
        </MoreOptions>
      )}
    </div>
  );
}
