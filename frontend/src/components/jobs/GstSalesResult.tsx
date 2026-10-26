import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, FileCheck2, ShoppingBag } from "lucide-react";
import { BigStat, Choice, MoreOptions, Notice, ResultCard, downloadBlob, inr, postDownload, postJson } from "@/components/jobs/jobUi";
import { NextSteps } from "@/components/jobs/NextSteps";
import { getActiveClient } from "@/lib/activeClient";

export interface Heads {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

interface ItcHeads {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface Gstr1Data {
  period: string | null;
  periods: string[];
  sellerGstin: string | null;
  b2clLimitRupees: number;
  b2b: unknown[];
  b2cl: unknown[];
  b2cs: unknown[];
  cdnr: unknown[];
  cdnur: unknown[];
  exports: unknown[];
  nil: Array<{ documents: number }>;
  review: unknown[];
  hsnMissing: number;
  totals: Record<"b2b" | "b2cl" | "b2cs" | "cdnr" | "cdnur" | "exp" | "nil" | "review" | "all", Heads>;
  register: Heads;
  difference: Heads;
  flagged: Array<{ id: string; number: string; customer: string; date: string | null; section: string; flags: string[] }>;
  notes: string[];
  counts: { documents: number; invoices: number; notes: number; cancelled: number };
  documents: Array<{ kind: string; prefix: string; from: string; to: string; total: number; cancelled: number; net: number; missing: string[] }>;
}

export interface ThreeBData {
  period: string | null;
  basis: "matched" | "portal";
  outward: Heads;
  zeroRated: Heads;
  nilExempt: number;
  rcm: ItcHeads & { taxable: number };
  interStateUnregistered: Array<{ pos: string; taxable: number; igst: number }>;
  itc: { source: { runId: string | null; period: string | null } | null; available: ItcHeads; reversal: ItcHeads; additional: ItcHeads; net: ItcHeads; notEligible: ItcHeads; atRisk: ItcHeads };
  payment: { liability: ItcHeads; credit: ItcHeads; cash: ItcHeads; carryForward: ItcHeads; setOff: Record<string, number> };
  rcmCash: ItcHeads;
  warnings: string[];
}

export interface ItcRun {
  runId: string;
  title: string;
  createdAt: string;
  period: string | null;
}

const money = (paise: number) => inr(paise / 100);
const taxOf = (heads: Heads) => heads.igst + heads.cgst + heads.sgst + heads.cess;

const TABLES: Array<{ key: keyof Gstr1Data["totals"]; label: string; note: string; count: (data: Gstr1Data) => number }> = [
  { key: "b2b", label: "Sales to registered buyers (B2B)", note: "Table 4", count: data => data.b2b.length },
  { key: "b2cl", label: "Large inter-state sales to consumers (B2C Large)", note: "Table 5", count: data => data.b2cl.length },
  { key: "b2cs", label: "Other sales to consumers (B2C Small)", note: "Table 7, by state and rate", count: data => data.b2cs.length },
  { key: "cdnr", label: "Credit and debit notes, registered buyers", note: "Table 9B", count: data => data.cdnr.length },
  { key: "cdnur", label: "Credit and debit notes, consumers", note: "Table 9B", count: data => data.cdnur.length },
  { key: "exp", label: "Exports and SEZ", note: "Needs shipping bill details", count: data => data.exports.length },
  { key: "nil", label: "Nil-rated, exempt or non-GST", note: "Table 8", count: data => data.nil.reduce((sum, row) => sum + row.documents, 0) },
  { key: "review", label: "Could not be placed", note: "Fix in the register", count: data => data.review.length },
];

const HEADS = ["igst", "cgst", "sgst", "cess"] as const;

interface Adjust {
  reversal: Record<(typeof HEADS)[number], string>;
  additional: Record<(typeof HEADS)[number], string>;
  rcm: Record<(typeof HEADS)[number] | "taxable", string>;
}

const BLANK: Adjust = {
  reversal: { igst: "", cgst: "", sgst: "", cess: "" },
  additional: { igst: "", cgst: "", sgst: "", cess: "" },
  rcm: { taxable: "", igst: "", cgst: "", sgst: "", cess: "" },
};

function toNumbers<T extends Record<string, string>>(values: T) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value.replace(/,/g, "")) || 0])) as Record<keyof T, number>;
}

export function GstSalesResult({
  gstr1,
  threeB: initialThreeB,
  runId,
  privacy = false,
  itcRuns = [],
  itcRunId: initialItcRun = null,
  onReset,
  clientName,
}: {
  gstr1: Gstr1Data;
  threeB: ThreeBData | null;
  runId: string | null;
  privacy?: boolean;
  itcRuns?: ItcRun[];
  itcRunId?: string | null;
  onReset?: () => void;
  clientName?: string;
}) {
  const [tab, setTab] = useState<"gstr1" | "gstr3b">("gstr1");
  const [threeB, setThreeB] = useState<ThreeBData | null>(initialThreeB);
  const [basis, setBasis] = useState<"matched" | "portal">(initialThreeB?.basis ?? "matched");
  const [itcRunId, setItcRunId] = useState<string>(initialItcRun ?? "none");
  const [adjust, setAdjust] = useState<Adjust>(BLANK);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // A saved result arrives without its GSTR-3B working, so the first update is the working itself.
  const first = useRef(initialThreeB !== null);
  const name = clientName || getActiveClient()?.name || "Client";

  const request = () => ({
    runId: runId ?? undefined,
    // A private run has nothing saved on the server, so the page sends the result back.
    gstr1: runId ? undefined : gstr1,
    basis,
    itcRunId,
    clientName: name,
    adjustments: { reversal: toNumbers(adjust.reversal), additional: toNumbers(adjust.additional), rcm: toNumbers(adjust.rcm) },
  });

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void postJson<{ threeB: ThreeBData }>("/api/jobs/gst-sales/3b", request()).then(response => {
        if (cancelled) return;
        if (response.ok && response.data.threeB) setThreeB(response.data.threeB);
        else setNotice(response.data.message || "The GSTR-3B working could not be updated.");
      });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // request() reads current state; the listed values are the inputs that change the working.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basis, itcRunId, adjust]);

  const download = async () => {
    setBusy(true);
    setNotice("");
    const response = await postDownload("/api/jobs/gst-sales/excel", request());
    setBusy(false);
    if (!response.ok || !response.blob) {
      setNotice(response.message || "The Excel file could not be created.");
      return;
    }
    downloadBlob("TallyThis_GSTR1_3B_Working.xlsx", response.blob);
  };

  const balanced = Object.values(gstr1.difference).every(value => value === 0);
  const flagged = gstr1.flagged.length;

  return (
    <div className="space-y-4">
      <ResultCard
        eyebrow={`${gstr1.period ?? "Period not found"} · ${gstr1.counts.documents} ${gstr1.counts.documents === 1 ? "document" : "documents"}`}
        actions={
          <>
            <button type="button" className="fv-button-primary h-11 px-6" onClick={() => void download()} disabled={busy || !balanced}>
              {busy ? "Preparing…" : "Download GSTR-1 & 3B working"}
            </button>
            {flagged > 0 && (
              <button type="button" className="fv-button-secondary h-11" onClick={() => { setTab("gstr1"); setReviewOpen(true); }}>
                Review {flagged} {flagged === 1 ? "item" : "items"}
              </button>
            )}
            {onReset && <button type="button" className="text-sm font-medium text-muted-foreground hover:text-foreground sm:ml-auto" onClick={onReset}>Upload another register</button>}
          </>
        }
      >
        <div className="grid grid-cols-3 gap-6">
          <BigStat value={gstr1.counts.documents - gstr1.review.length} label="sorted into tables" tone="good" />
          <BigStat value={flagged} label={flagged === 1 ? "needs a look" : "need a look"} tone={flagged > 0 ? "attention" : "good"} />
          <BigStat value={gstr1.counts.cancelled} label="cancelled" />
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Taxable value {money(gstr1.totals.all.taxable)} · GST {money(taxOf(gstr1.totals.all))}
          {gstr1.sellerGstin ? ` · ${gstr1.sellerGstin}` : ""}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">A working copy for your CA. Potential risk — needs CA review. It is not filed on the GST portal.</p>
      </ResultCard>

      {!balanced && (
        <Notice tone="error">
          The tables do not add up to the register (difference {money(gstr1.difference.taxable)} taxable, {money(taxOf(gstr1.difference))} tax). The Excel file is held back. Please report this with the register.
        </Notice>
      )}
      {notice && <Notice tone="error" onClose={() => setNotice("")}>{notice}</Notice>}
      {gstr1.periods.length > 1 && <Notice tone="warn">This register covers {gstr1.periods.length} months ({gstr1.periods.join(", ")}). A return is for one month: split the register by month for filing.</Notice>}

      <Choice<"gstr1" | "gstr3b">
        size="sm"
        value={tab}
        onChange={setTab}
        options={[
          { value: "gstr1", label: "GSTR-1 tables" },
          { value: "gstr3b", label: "GSTR-3B working" },
        ]}
      />

      {tab === "gstr1" && (
        <div className="space-y-4">
          <section className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[620px] border-collapse text-sm">
              <thead className="bg-muted/50 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--fv-accent-dark)]">
                <tr>
                  <th className="px-4 py-3">Table</th>
                  <th className="px-4 py-3 text-right">Documents</th>
                  <th className="px-4 py-3 text-right">Taxable value</th>
                  <th className="px-4 py-3 text-right">GST</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {TABLES.map(table => {
                  const count = table.count(gstr1);
                  const totals = gstr1.totals[table.key];
                  if (count === 0 && totals.taxable === 0) return null;
                  return (
                    <tr key={table.key}>
                      <td className="px-4 py-3">
                        <div className="font-medium">{table.label}</div>
                        <div className="text-xs text-muted-foreground">{table.note}</div>
                      </td>
                      <td className="px-4 py-3 text-right">{count}</td>
                      <td className="px-4 py-3 text-right">{money(totals.taxable)}</td>
                      <td className="px-4 py-3 text-right">{money(taxOf(totals))}</td>
                    </tr>
                  );
                })}
                <tr className="bg-muted/30 font-semibold">
                  <td className="px-4 py-3">All tables, net of credit notes</td>
                  <td className="px-4 py-3 text-right">{gstr1.counts.documents}</td>
                  <td className="px-4 py-3 text-right">{money(gstr1.totals.all.taxable)}</td>
                  <td className="px-4 py-3 text-right">{money(taxOf(gstr1.totals.all))}</td>
                </tr>
              </tbody>
            </table>
          </section>

          {flagged > 0 && (
            <section className="rounded-2xl border border-border bg-card">
              <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold" onClick={() => setReviewOpen(open => !open)} aria-expanded={reviewOpen}>
                <span className="inline-flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-700" />{flagged} {flagged === 1 ? "document has" : "documents have"} something to check</span>
                {reviewOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              {reviewOpen && (
                <div className="divide-y divide-border border-t border-border">
                  {gstr1.flagged.slice(0, 40).map(item => (
                    <div key={item.id} className="px-4 py-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{item.number}{item.customer ? ` · ${item.customer}` : ""}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold uppercase">{item.section}</span>
                      </div>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                        {item.flags.map(flag => <li key={flag}>{flag}</li>)}
                      </ul>
                    </div>
                  ))}
                  {flagged > 40 && <div className="px-4 py-3 text-xs text-muted-foreground">The Excel file lists all {flagged}.</div>}
                </div>
              )}
            </section>
          )}

          <MoreOptions label="Show details">
            <div className="space-y-3 text-sm">
              <div className="flex items-start gap-2">
                {balanced ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />}
                <span>
                  {balanced
                    ? `The tables add up to the register exactly: taxable value ${money(gstr1.register.taxable)}, GST ${money(taxOf(gstr1.register))}.`
                    : "The tables do not add up to the register."}
                </span>
              </div>
              {gstr1.notes.map(note => <p key={note} className="text-xs text-muted-foreground">{note}</p>)}
              {gstr1.documents.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground">Documents issued</div>
                  <ul className="mt-1 space-y-1 text-xs">
                    {gstr1.documents.map(series => (
                      <li key={`${series.kind}-${series.prefix}`}>
                        {series.kind}: {series.from} to {series.to} · {series.net} issued{series.cancelled > 0 ? `, ${series.cancelled} cancelled` : ""}
                        {series.missing.length > 0 ? ` · numbers not in the register: ${series.missing.slice(0, 8).join(", ")}${series.missing.length > 8 ? "…" : ""}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </MoreOptions>
        </div>
      )}

      {tab === "gstr3b" && !threeB && <p className="text-sm text-muted-foreground">Preparing the GSTR-3B working…</p>}
      {tab === "gstr3b" && threeB && (
        <div className="space-y-4">
          {threeB.warnings.map(text => <Notice key={text} tone="warn">{text}</Notice>)}

          <section className="rounded-2xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Where the input tax credit comes from</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-semibold text-muted-foreground">
                GSTR-2B ↔ Books result
                <select className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground" value={itcRunId} onChange={event => setItcRunId(event.target.value)} disabled={privacy}>
                  <option value="none">Do not use credit</option>
                  {itcRuns.map(run => <option key={run.runId} value={run.runId}>{run.period ?? "Period not found"} · {run.title.replace(/^.*? — /, "")}</option>)}
                </select>
              </label>
              <div>
                <div className="text-xs font-semibold text-muted-foreground">Credit to use</div>
                <div className="mt-1">
                  <Choice<"matched" | "portal">
                    size="sm"
                    value={basis}
                    onChange={setBasis}
                    options={[{ value: "matched", label: "Matched with books" }, { value: "portal", label: "As per GSTR-2B" }]}
                  />
                </div>
              </div>
            </div>
            {itcRuns.length === 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                {privacy ? "In Incognito, saved GSTR-2B results are not read." : "No GSTR-2B ↔ Books result was found for this client. Run it first to bring in the credit."}
              </p>
            )}
          </section>

          <HeadsTable
            title="3.1  Outward supplies"
            columns={["Taxable value", "IGST", "CGST", "SGST", "Cess"]}
            rows={[
              { label: "(a) Taxable supplies (other than zero-rated, nil-rated and exempt)", values: [threeB.outward.taxable, threeB.outward.igst, threeB.outward.cgst, threeB.outward.sgst, threeB.outward.cess] },
              { label: "(b) Zero-rated (exports and SEZ, check them)", values: [threeB.zeroRated.taxable, threeB.zeroRated.igst, threeB.zeroRated.cgst, threeB.zeroRated.sgst, threeB.zeroRated.cess] },
              { label: "(c) Nil-rated and exempt", values: [threeB.nilExempt, 0, 0, 0, 0] },
            ]}
          />
          <HeadsTable
            title="4  Input tax credit"
            columns={["IGST", "CGST", "SGST", "Cess"]}
            rows={[
              { label: "(A) Available", values: HEADS.map(head => threeB.itc.available[head]) },
              { label: "(B) Reversed (you enter)", values: HEADS.map(head => threeB.itc.reversal[head]) },
              { label: "(C) Net credit", values: HEADS.map(head => threeB.itc.net[head]), strong: true },
              { label: "(D) Not available per GSTR-2B", values: HEADS.map(head => threeB.itc.notEligible[head]) },
              { label: "In your books, not in GSTR-2B (not used)", values: HEADS.map(head => threeB.itc.atRisk[head]) },
            ]}
          />
          <HeadsTable
            title="6.1  Payment of tax"
            columns={["IGST", "CGST", "SGST", "Cess"]}
            rows={[
              { label: "Tax payable", values: HEADS.map(head => threeB.payment.liability[head]) },
              { label: "Paid through credit", values: HEADS.map(head => threeB.payment.liability[head] - threeB.payment.cash[head]) },
              { label: "Payable in cash", values: HEADS.map(head => threeB.payment.cash[head]), strong: true },
              { label: "Credit carried forward", values: HEADS.map(head => threeB.payment.carryForward[head]) },
            ]}
          />
          {threeB.interStateUnregistered.length > 0 && (
            <p className="text-xs text-muted-foreground">
              3.2 Inter-state sales to consumers: {threeB.interStateUnregistered.map(row => `${row.pos || "state not known"} ${money(row.taxable)} (IGST ${money(row.igst)})`).join(" · ")}
            </p>
          )}

          <MoreOptions label="Reversals and reverse charge">
            <div className="space-y-4 text-sm">
              <p className="text-xs text-muted-foreground">Enter figures your CA has worked out. They change the working above and the Excel file; nothing is claimed or filed.</p>
              {([
                ["reversal", "ITC to reverse (Rule 42, 43, section 17(5))"],
                ["additional", "Additional credit not in GSTR-2B"],
                ["rcm", "Tax payable on reverse charge (cash)"],
              ] as const).map(([group, label]) => (
                <div key={group}>
                  <div className="text-xs font-semibold text-muted-foreground">{label}</div>
                  <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {HEADS.map(head => (
                      <label key={head} className="block text-[11px] font-semibold uppercase text-muted-foreground">
                        {head}
                        <input
                          inputMode="decimal"
                          className="fv-input mt-1 h-9 w-full text-sm font-normal normal-case text-foreground"
                          value={adjust[group][head]}
                          onChange={event => setAdjust(current => ({ ...current, [group]: { ...current[group], [head]: event.target.value } }))}
                          placeholder="0"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </MoreOptions>
        </div>
      )}

      <NextSteps
        steps={[
          { label: "Check input credit with GSTR-2B", hint: "GSTR-2B ↔ Books: match your purchases with what suppliers filed", href: "/app/jobs/gstr-2b", icon: FileCheck2 },
          { label: "Add marketplace sales", hint: "E-commerce GST: Amazon, Flipkart and Meesho reports", href: "/app/jobs/ecommerce-gst", icon: ShoppingBag },
        ]}
      />
    </div>
  );
}

function HeadsTable({ title, columns, rows }: { title: string; columns: string[]; rows: Array<{ label: string; values: number[]; strong?: boolean }> }) {
  return (
    <section className="overflow-x-auto rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3 text-sm font-semibold">{title}</div>
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead className="text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-2" />
            {columns.map(column => <th key={column} className="px-4 py-2 text-right">{column}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(row => (
            <tr key={row.label} className={row.strong ? "bg-muted/30 font-semibold" : ""}>
              <td className="px-4 py-2.5">{row.label}</td>
              {row.values.map((value, index) => <td key={index} className="px-4 py-2.5 text-right">{money(value)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
