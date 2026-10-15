import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { CheckCircle2, Copy, FileSpreadsheet, Link2, Mail, MessageSquareText } from "lucide-react";
import {
  BigStat,
  Choice,
  DropZone,
  JobShell,
  MoreOptions,
  Notice,
  ResultCard,
  Working,
  downloadBlob,
  fmtDate,
  inr,
  postDownload,
  postFiles,
  postJson,
} from "@/components/jobs/jobUi";
import { getActiveClient } from "@/lib/activeClient";
import { cn } from "@/lib/utils";

interface Side {
  docNumber: string;
  docDate: string | null;
  row: number;
  voucherNo?: string | null;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  tax: number;
  total: number;
}

type Bucket = "matched" | "value_mismatch" | "probable" | "missing_in_2b" | "missing_in_books" | "not_eligible" | "duplicate";
type Decision = "approved" | "rejected" | "needs_info";

interface Item {
  key: string;
  bucket: Bucket;
  status: "suggested" | Decision;
  confidence: "exact" | "tolerance" | "review";
  supplierGstin: string;
  supplierName: string;
  docNumber: string;
  docDate: string | null;
  kind: "invoice" | "note";
  books?: Side;
  portal?: Side;
  diff?: { taxable: number; igst: number; cgst: number; sgst: number; cess: number; tax: number };
  why: string[];
  itcAtRisk: number;
  itcUnclaimed: number;
}

interface Supplier {
  gstin: string;
  name: string;
  missing: Array<{ docNumber: string; docDate: string | null; tax: number; total: number }>;
  mismatched: number;
  itcAtRisk: number;
}

interface Heads {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  total: number;
}

interface Totals {
  portalTax: number;
  booksTax: number;
  matchedTax: number;
  itcAtRisk: number;
  itcUnclaimed: number;
  notEligibleTax: number;
}

interface ByHead {
  portal: Heads;
  books: Heads;
  matched: Heads;
  atRisk: Heads;
  unclaimed: Heads;
  notEligible: Heads;
}

interface Summary {
  counts: Record<Bucket, number> & { portal: number; books: number };
  totals: Totals;
  byHead: ByHead;
  suppliers: Supplier[];
}

interface CompareResponse extends Summary {
  runId: string | null;
  privacy?: boolean;
  period: string | null;
  periods: string[];
  recipientGstin: string | null;
  files: { portal: string; books: string };
  portalCount: number;
  booksCount: number;
  vendors: unknown[];
  notes: string[];
  items: Item[];
}

type Stage = "idle" | "working" | "done" | "error";

const STEPS = ["Reading GSTR-2B", "Reading your purchase register", "Matching suppliers and invoices", "Listing differences"];

type Choices = "match" | "note" | "book";

const GROUPS: Array<{ bucket: Bucket; title: string; hint: string; choices: Choices }> = [
  { bucket: "missing_in_2b", title: "In your books, not in GSTR-2B", hint: "ITC is at risk until the supplier reports the invoice.", choices: "note" },
  { bucket: "value_mismatch", title: "Amounts differ", hint: "The supplier reported different values from your books.", choices: "match" },
  { bucket: "probable", title: "Probable match — please confirm", hint: "Found by a looser rule. Nothing is confirmed until you say so.", choices: "match" },
  { bucket: "duplicate", title: "Entered twice in your books", hint: "Only one entry can match GSTR-2B.", choices: "note" },
  { bucket: "not_eligible", title: "ITC not available in GSTR-2B", hint: "GSTR-2B itself marks ITC as not available.", choices: "note" },
  { bucket: "missing_in_books", title: "In GSTR-2B, not in your books", hint: "Possibly unrecorded purchases or booked under another supplier.", choices: "book" },
];

const ATTENTION: Bucket[] = GROUPS.map(group => group.bucket);

function monthName(period: string | null) {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return null;
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

function periodsLabel(periods: string[], period: string | null) {
  const list = periods.length > 0 ? periods : period ? [period] : [];
  const names = list.map(monthName).filter((name): name is string => Boolean(name));
  if (names.length === 0) return null;
  return names.length > 3 ? `${names[0]} to ${names[names.length - 1]}` : names.join(", ");
}

function followUpText(supplier: Supplier, label: string | null, sender: string) {
  const lines = supplier.missing
    .slice(0, 25)
    .map(doc => `• ${doc.docNumber}${doc.docDate ? ` dated ${fmtDate(doc.docDate)}` : ""} — GST ${inr(doc.tax)}`);
  return [
    `Dear ${supplier.name || "Sir/Madam"},`,
    "",
    `These invoices from you (GSTIN ${supplier.gstin}) are in our books but do not appear in our GSTR-2B${label ? ` for ${label}` : ""}:`,
    ...lines,
    supplier.missing.length > 25 ? `…and ${supplier.missing.length - 25} more.` : "",
    "",
    "Please check that they were reported in your GSTR-1 / IFF and filed, so that we can claim input tax credit on them.",
    "",
    "Regards,",
    sender,
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");
}

export default function Gstr2bJobPage() {
  const [, navigate] = useLocation();
  const [stage, setStage] = useState<Stage>("idle");
  const [portalFiles, setPortalFiles] = useState<File[]>([]);
  const [booksFile, setBooksFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [data, setData] = useState<CompareResponse | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [limit, setLimit] = useState<Record<string, number>>({});
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);

  const compare = async (portal: File[], books: File) => {
    setStage("working");
    setError("");
    const client = getActiveClient();
    const response = await postFiles<CompareResponse>("/api/jobs/gstr-2b/compare", {
      gstr2b: portal,
      books,
      clientName: client?.name,
    });
    if (!response.ok) {
      setError(response.data.message || "These files could not be compared.");
      setStage("error");
      return;
    }
    setData(response.data);
    setItems(response.data.items);
    setSummary({ counts: response.data.counts, totals: response.data.totals, byHead: response.data.byHead, suppliers: response.data.suppliers });
    setLimit({});
    setReviewOpen(false);
    setStage("done");
  };

  const choosePortal = (files: File[]) => {
    setPortalFiles(files);
    if (booksFile) void compare(files, booksFile);
  };

  const chooseBooks = (file: File) => {
    setBooksFile(file);
    if (portalFiles.length > 0) void compare(portalFiles, file);
  };

  const decide = async (key: string, status: Decision) => {
    setItems(current => current.map(item => (item.key === key ? { ...item, status } : item)));
    if (!data?.runId) return; // an Incognito run has nothing saved to update
    await postJson(`/api/jobs/gstr-2b/runs/${data.runId}/decision`, { key, status });
  };

  const link = async (booksKey: string, portalKey: string) => {
    if (!data || !summary) return;
    setLinking(booksKey);
    const response = await postJson<{ removed: string[]; merged: Item; summary: Summary }>(
      "/api/jobs/gstr-2b/link",
      data.runId
        ? { runId: data.runId, booksKey, portalKey, clientId: getActiveClient()?.id }
        : { booksKey, portalKey, items, counts: summary.counts, byHead: summary.byHead, clientId: getActiveClient()?.id },
    );
    setLinking(null);
    if (!response.ok || !response.data.merged) {
      setError(response.data.message || "These two documents could not be linked.");
      return;
    }
    const { removed, merged } = response.data;
    setItems(current => [...current.filter(item => !removed.includes(item.key)), merged]);
    setSummary(response.data.summary);
    setError("");
  };

  const reset = () => {
    setStage("idle");
    setPortalFiles([]);
    setBooksFile(null);
    setData(null);
    setItems([]);
    setSummary(null);
    setError("");
  };

  const attention = useMemo(() => items.filter(item => ATTENTION.includes(item.bucket)), [items]);
  const open = attention.filter(item => item.status === "suggested");
  const matched = items.filter(item => item.bucket === "matched");
  const label = data ? periodsLabel(data.periods, data.period) : null;
  const sender = getActiveClient()?.name || "Accounts team";

  const downloadExcel = async () => {
    if (!data || !summary) return;
    setExporting(true);
    const client = getActiveClient();
    const large = items.length > 6000 && data.runId;
    const response = await postDownload(
      "/api/jobs/gstr-2b/excel",
      large
        ? { runId: data.runId, clientName: client?.name || "Client" }
        : {
            clientName: client?.name || "Client",
            period: data.period,
            periods: data.periods,
            recipientGstin: data.recipientGstin,
            items,
            counts: summary.counts,
            totals: summary.totals,
            byHead: summary.byHead,
            suppliers: summary.suppliers,
            vendors: data.vendors,
            notes: data.notes,
          },
    );
    setExporting(false);
    if (!response.ok || !response.blob) {
      setError(response.message || "The Excel file could not be created.");
      return;
    }
    setError("");
    downloadBlob("TallyThis_GSTR2B_Reconciliation.xlsx", response.blob);
  };

  const copyMessage = async (supplier: Supplier) => {
    try {
      await navigator.clipboard.writeText(followUpText(supplier, label, sender));
      setCopied(supplier.gstin);
      window.setTimeout(() => setCopied(current => (current === supplier.gstin ? null : current)), 2200);
    } catch {
      setError("The message could not be copied. Open it in your email instead.");
    }
  };

  const mailto = (supplier: Supplier) =>
    `mailto:?subject=${encodeURIComponent(`Invoices not in GSTR-2B${label ? ` — ${label}` : ""}`)}&body=${encodeURIComponent(followUpText(supplier, label, sender))}`;

  const followUps = (summary?.suppliers ?? []).filter(supplier => supplier.missing.length > 0);
  const onlyInBooks = items.filter(item => item.books && !item.portal && item.bucket === "missing_in_2b");
  const onlyInPortal = items.filter(item => item.portal && !item.books && (item.bucket === "missing_in_books" || item.bucket === "not_eligible"));

  return (
    <JobShell
      title="GSTR-2B ↔ Books"
      outcome="Upload GSTR-2B and your purchase register to see what ITC is supported."
      modeLocked={stage !== "idle" && stage !== "error"}
    >
      {(stage === "idle" || stage === "error") && (
        <div className="space-y-4">
          {stage === "error" && <Notice tone="error">{error}</Notice>}
          <div className="grid gap-3 sm:grid-cols-2">
            <DropZone
              size="sm"
              multiple
              label="GSTR-2B"
              hint="JSON or Excel from the GST portal · add several months if you like"
              accept=".json,.xlsx,.xls,.csv"
              files={portalFiles}
              onFiles={choosePortal}
            />
            <DropZone
              size="sm"
              label="Purchase register"
              hint="Excel or CSV from Tally or your billing software"
              accept=".xlsx,.xls,.csv"
              files={booksFile ? [booksFile] : []}
              onFiles={files => chooseBooks(files[0])}
            />
          </div>
          <p className="text-center text-xs text-muted-foreground">
            We compare as soon as both are in. Portal: Returns → GSTR-2B → Download JSON. Tally: Purchase Register → Export → Excel.
          </p>
          <p className="text-center text-xs text-muted-foreground">
            Invoices already imported in the Upload center?{" "}
            <button type="button" className="font-medium underline hover:text-foreground" onClick={() => navigate("/app/gstr-2b-recon")}>
              Compare GSTR-2B with those instead
            </button>
          </p>
        </div>
      )}

      {stage === "working" && <Working steps={STEPS} />}

      {stage === "done" && data && summary && (
        <div className="space-y-4">
          <ResultCard
            eyebrow={`${label ? `${label} · ` : ""}${summary.counts.portal} in GSTR-2B · ${summary.counts.books} in your books`}
            actions={
              <>
                {open.length > 0 ? (
                  <button type="button" className="fv-button-primary h-11 px-6" onClick={() => setReviewOpen(true)}>
                    Review {open.length} {open.length === 1 ? "item" : "items"}
                  </button>
                ) : (
                  <button type="button" className="fv-button-primary h-11 px-6" disabled={exporting} onClick={() => void downloadExcel()}>
                    {exporting ? "Preparing…" : "Download Excel"}
                  </button>
                )}
                {open.length > 0 && (
                  <button type="button" className="fv-button-secondary h-11" disabled={exporting} onClick={() => void downloadExcel()}>
                    {exporting ? "Preparing…" : "Download Excel"}
                  </button>
                )}
                <button type="button" className="text-sm font-medium text-muted-foreground hover:text-foreground sm:ml-auto" onClick={reset}>
                  Compare other files
                </button>
              </>
            }
          >
            <div className="grid grid-cols-2 gap-6">
              <BigStat value={matched.length} label="matched" tone="good" />
              <BigStat value={attention.length} label="need attention" tone={attention.length > 0 ? "attention" : "good"} />
            </div>
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                <span className="text-xs text-muted-foreground">ITC not supported by GSTR-2B </span>
                <span className={cn("font-medium tabular-nums", summary.totals.itcAtRisk > 0 && "text-amber-700")}>{inr(summary.totals.itcAtRisk)}</span>
              </span>
              <span>
                <span className="text-xs text-muted-foreground">In GSTR-2B, not in books </span>
                <span className="font-medium tabular-nums">{inr(summary.totals.itcUnclaimed)}</span>
              </span>
            </div>
            {open.length < attention.length && (
              <p className="mt-3 text-sm text-muted-foreground">
                {attention.length - open.length} of {attention.length} reviewed.
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Potential risk — needs CA review. This compares your two files; it does not decide whether ITC can be claimed.
            </p>
          </ResultCard>

          {data.privacy && <Notice tone="success">Incognito: these files and this result aren’t saved to your workspace. Download the Excel before leaving.</Notice>}
          {data.notes.length > 0 && (
            <Notice tone="info">
              {data.notes.map(note => (
                <p key={note}>{note}</p>
              ))}
            </Notice>
          )}
          {error && (
            <Notice tone="error" onClose={() => setError("")}>
              {error}
            </Notice>
          )}

          {followUps.length > 0 && (
            <ResultCard eyebrow="Suppliers to follow up">
              <p className="mb-3 text-sm text-muted-foreground">These suppliers have not reported invoices that are in your books.</p>
              <div className="divide-y divide-border rounded-xl border border-border">
                {followUps.slice(0, 8).map(supplier => (
                  <div key={supplier.gstin} className="flex flex-wrap items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{supplier.name || supplier.gstin}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {supplier.gstin} · {supplier.missing.length} {supplier.missing.length === 1 ? "invoice" : "invoices"} · GST {inr(supplier.itcAtRisk)}
                      </div>
                    </div>
                    <button type="button" className="fv-button-secondary h-9" onClick={() => void copyMessage(supplier)}>
                      {copied === supplier.gstin ? <CheckCircle2 className="h-4 w-4 text-emerald-700" /> : <Copy className="h-4 w-4" />}
                      {copied === supplier.gstin ? "Copied" : "Copy message"}
                    </button>
                    <a className="fv-button-secondary inline-flex h-9 items-center gap-2" href={mailto(supplier)}>
                      <Mail className="h-4 w-4" />
                      Email
                    </a>
                  </div>
                ))}
              </div>
              {followUps.length > 8 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {followUps.length - 8} more suppliers are in the “Supplier follow-up” sheet of the Excel file.
                </p>
              )}
            </ResultCard>
          )}

          {reviewOpen && (
            <ResultCard eyebrow="Review">
              {open.length === 0 && (
                <div className="mb-4 flex items-center gap-2 text-sm text-emerald-800">
                  <CheckCircle2 className="h-4 w-4" />
                  Everything is reviewed. Download the Excel file.
                </div>
              )}
              <div className="space-y-7">
                {GROUPS.map(group => {
                  const rows = attention.filter(item => item.bucket === group.bucket);
                  if (rows.length === 0) return null;
                  const shown = limit[group.bucket] ?? 15;
                  return (
                    <section key={group.bucket}>
                      <h2 className="font-semibold">
                        {group.title} <span className="text-muted-foreground">({rows.length})</span>
                      </h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">{group.hint}</p>
                      <div className="mt-3 divide-y divide-border rounded-xl border border-border">
                        {rows.slice(0, shown).map(item => (
                          <div key={item.key} className="space-y-3 p-3">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold">{item.supplierName || item.supplierGstin}</div>
                                <div className="truncate text-xs text-muted-foreground">
                                  {item.supplierGstin} · {item.docNumber}
                                  {item.kind === "note" ? " (credit/debit note)" : ""}
                                  {item.docDate ? ` · ${fmtDate(item.docDate)}` : ""}
                                </div>
                              </div>
                              {item.itcAtRisk > 0 && <div className="text-sm font-medium tabular-nums text-amber-700">{inr(item.itcAtRisk)} at risk</div>}
                              {item.itcAtRisk === 0 && item.itcUnclaimed > 0 && (
                                <div className="text-sm font-medium tabular-nums text-muted-foreground">{inr(item.itcUnclaimed)} not in books</div>
                              )}
                            </div>
                            <div className="grid gap-2 text-sm sm:grid-cols-2">
                              <SideBox title="Your books" side={item.books} none="Not found" />
                              <SideBox title="GSTR-2B" side={item.portal} none="Not found" />
                            </div>
                            <ul className="space-y-0.5 text-xs text-muted-foreground">
                              {item.why.map(line => (
                                <li key={line}>{line}</li>
                              ))}
                            </ul>
                            <Choice<Decision>
                              size="sm"
                              value={item.status === "suggested" ? null : item.status}
                              onChange={status => void decide(item.key, status)}
                              options={
                                group.choices === "match"
                                  ? [
                                      { value: "approved", label: "Confirm match", tone: "good" },
                                      { value: "rejected", label: "Not a match", tone: "bad" },
                                      { value: "needs_info", label: "Ask supplier" },
                                    ]
                                  : group.choices === "book"
                                    ? [
                                        { value: "approved", label: "To be booked", tone: "good" },
                                        { value: "rejected", label: "Not our purchase", tone: "bad" },
                                        { value: "needs_info", label: "Ask supplier" },
                                      ]
                                    : [
                                        { value: "approved", label: "Noted", tone: "good" },
                                        { value: "needs_info", label: "Ask supplier" },
                                      ]
                              }
                            />
                            {(item.bucket === "missing_in_2b" || item.bucket === "missing_in_books" || item.bucket === "not_eligible") && !(item.books && item.portal) && (
                              <LinkPicker
                                item={item}
                                candidates={item.books ? onlyInPortal : onlyInBooks}
                                busy={linking === item.key}
                                onLink={other => void (item.books ? link(item.key, other.key) : link(other.key, item.key))}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                      {rows.length > shown && (
                        <button
                          type="button"
                          className="mt-3 text-sm font-semibold text-[var(--fv-accent-dark)] hover:underline"
                          onClick={() => setLimit(current => ({ ...current, [group.bucket]: shown + 15 }))}
                        >
                          Show more ({rows.length - shown} left)
                        </button>
                      )}
                    </section>
                  );
                })}
              </div>
              <p className="mt-5 text-xs text-muted-foreground">Suggested matches need review. Nothing is marked matched without a rule or your decision.</p>
            </ResultCard>
          )}

          <MoreOptions>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>
                GSTR-2B: {data.files.portal}. Purchase register: {data.files.books}.
              </p>
              {data.recipientGstin && <p>GSTIN in GSTR-2B: {data.recipientGstin}</p>}
            </div>
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full min-w-[460px] text-left text-xs tabular-nums">
                <thead className="bg-muted text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">ITC by tax head</th>
                    <th className="px-3 py-2">IGST</th>
                    <th className="px-3 py-2">CGST</th>
                    <th className="px-3 py-2">SGST</th>
                    <th className="px-3 py-2">Cess</th>
                    <th className="px-3 py-2">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["As per GSTR-2B, ITC available", summary.byHead.portal],
                      ["As per purchase register", summary.byHead.books],
                      ["Matched", summary.byHead.matched],
                      ["In books, not supported by GSTR-2B", summary.byHead.atRisk],
                      ["In GSTR-2B, not in books", summary.byHead.unclaimed],
                      ["GSTR-2B marks ITC not available", summary.byHead.notEligible],
                    ] as Array<[string, Heads]>
                  ).map(([name, heads]) => (
                    <tr key={name} className="border-t border-border">
                      <td className="px-3 py-2">{name}</td>
                      <td className="px-3 py-2">{inr(heads.igst)}</td>
                      <td className="px-3 py-2">{inr(heads.cgst)}</td>
                      <td className="px-3 py-2">{inr(heads.sgst)}</td>
                      <td className="px-3 py-2">{inr(heads.cess)}</td>
                      <td className="px-3 py-2 font-medium">{inr(heads.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="fv-button-secondary" disabled={exporting} onClick={() => void downloadExcel()}>
                <FileSpreadsheet className="h-4 w-4" />
                Excel working copy
              </button>
              {followUps.length > 0 && (
                <button type="button" className="fv-button-secondary" onClick={() => void copyMessage(followUps[0])}>
                  <MessageSquareText className="h-4 w-4" />
                  Copy message for the top supplier
                </button>
              )}
            </div>
          </MoreOptions>
        </div>
      )}
    </JobShell>
  );
}

/** A person says these two are the same invoice, when no rule could tell. */
function LinkPicker({ item, candidates, busy, onLink }: { item: Item; candidates: Item[]; busy: boolean; onLink: (other: Item) => void }) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(
    () =>
      [...candidates]
        .filter(candidate => candidate.kind === item.kind)
        .sort((a, b) => Number(b.supplierGstin === item.supplierGstin) - Number(a.supplierGstin === item.supplierGstin)),
    [candidates, item],
  );
  if (sorted.length === 0) return null;
  if (!open) {
    return (
      <button type="button" className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground" onClick={() => setOpen(true)}>
        <Link2 className="h-3.5 w-3.5" />
        {item.books ? "It is in GSTR-2B under another number…" : "It is in my books under another number…"}
      </button>
    );
  }
  return (
    <label className="block text-xs font-medium">
      Link {item.books ? "to the GSTR-2B document" : "to the document in your books"}
      <select
        className="fv-input mt-1 w-full"
        defaultValue=""
        disabled={busy}
        onChange={event => {
          const other = sorted.find(candidate => candidate.key === event.target.value);
          if (other) onLink(other);
        }}
      >
        <option value="" disabled>
          {busy ? "Linking…" : "Choose the same invoice"}
        </option>
        {sorted.map(candidate => {
          const side = candidate.portal ?? candidate.books;
          return (
            <option key={candidate.key} value={candidate.key}>
              {candidate.docNumber} · {candidate.supplierName || candidate.supplierGstin} · GST {inr(side?.tax ?? 0)}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function SideBox({ title, side, none }: { title: string; side?: Side; none: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      {side ? (
        <>
          <div className="font-medium tabular-nums">
            {inr(side.total)} <span className="font-normal text-muted-foreground">· GST {inr(side.tax)}</span>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {side.docNumber}
            {side.docDate ? ` · ${fmtDate(side.docDate)}` : ""} · taxable {inr(side.taxable)}
          </div>
        </>
      ) : (
        <div className="text-muted-foreground">{none}</div>
      )}
    </div>
  );
}
