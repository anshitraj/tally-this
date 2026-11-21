import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Notice } from "@/components/jobs/jobUi";
import { api, rupeesFromPaise, type Summary } from "@/lib/ecommerce";
import { cn } from "@/lib/utils";

function Money({ paise, className }: { paise: number; className?: string }) {
  return <span className={cn("tabular-nums", paise < 0 && "text-red-700", className)}>{rupeesFromPaise(paise)}</span>;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Table({ head, children, minWidth = 640 }: { head: Array<{ label: string; right?: boolean }>; children: React.ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>{head.map(h => <th key={h.label} scope="col" className={cn("px-3 py-2 font-medium", h.right && "text-right")}>{h.label}</th>)}</tr>
        </thead>
        <tbody className="[&_tr]:border-b [&_tr]:border-border [&_tr:last-child]:border-0 [&_td]:px-3 [&_td]:py-2">{children}</tbody>
      </table>
    </div>
  );
}

/** GST and HSN: the HSN summary, State-wise figures and the GSTR-1 working, all from the same counted transactions. */
export function GstPanel({ marketplace, period }: { marketplace: string; period: string }) {
  const [rounding, setRounding] = useState<"line" | "aggregate">("line");
  const { data, isLoading, isError } = useQuery<Summary>({
    queryKey: ["ecommerce", marketplace, "summary", period, rounding],
    queryFn: () => api(`/ecommerce/${marketplace}/summary?period=${period}&rounding=${rounding}`),
  });
  if (isError) return <Notice tone="error">The GST working could not be loaded.</Notice>;
  if (isLoading || !data) return <div className="space-y-3">{Array.from({ length: 4 }, (_, i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-muted/50" />)}</div>;
  const g = data.gstr1;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-start gap-2 text-xs text-muted-foreground"><Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />A draft working for CA review, not a filing-ready return. Potential risk — needs CA review.</p>
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium">
          Tax rounding
          <select value={rounding} onChange={event => setRounding(event.target.value as "line" | "aggregate")} className="h-8 rounded-lg border border-border bg-background px-2 text-xs" aria-label="Tax rounding">
            <option value="line">Each line as reported</option>
            <option value="aggregate">Once per group</option>
          </select>
        </label>
      </div>

      <Section title="HSN-wise summary" hint="Sales, returns and the net for each HSN and rate (the shape of GSTR-1 Table 12).">
        <Table head={[{ label: "HSN" }, { label: "Rate" }, { label: "Net qty", right: true }, { label: "Sales", right: true }, { label: "Returns", right: true }, { label: "Net taxable", right: true }, { label: "IGST", right: true }, { label: "CGST", right: true }, { label: "SGST", right: true }]} minWidth={760}>
          {data.hsn.map(r => (
            <tr key={`${r.hsn}-${r.rate}`}>
              <td className={cn("tabular-nums", r.hsn === "(no HSN)" && "text-red-700")}>{r.hsn}</td>
              <td className="tabular-nums">{r.rate === "unknown" ? "?" : `${r.rate}%`}</td>
              <td className="text-right tabular-nums">{r.net.quantity.toLocaleString("en-IN")}</td>
              <td className="text-right"><Money paise={r.sales.taxable} /></td>
              <td className="text-right"><Money paise={-r.returns.taxable} /></td>
              <td className="text-right font-medium"><Money paise={r.net.taxable} /></td>
              <td className="text-right"><Money paise={r.net.igst} /></td>
              <td className="text-right"><Money paise={r.net.cgst} /></td>
              <td className="text-right"><Money paise={r.net.sgst} /></td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="State-wise GST" hint="Net of returns, by place of supply and rate.">
        <Table head={[{ label: "Place of supply" }, { label: "Rate" }, { label: "Supply" }, { label: "Net taxable", right: true }, { label: "IGST", right: true }, { label: "CGST", right: true }, { label: "SGST", right: true }]}>
          {data.states.map(r => (
            <tr key={`${r.pos}-${r.rate}-${r.supplyType}-${r.ecoGstin}`}>
              <td className={cn(r.pos === "??" && "text-red-700")}>{r.pos === "??" ? "Unknown" : `${r.pos} · ${r.posName}`}</td>
              <td className="tabular-nums">{r.rate === "unknown" ? "?" : `${r.rate}%`}</td>
              <td>{r.supplyType === "intra" ? "Within State" : r.supplyType === "inter" ? "Inter-State" : "Unknown"}</td>
              <td className="text-right font-medium"><Money paise={r.net.taxable} /></td>
              <td className="text-right"><Money paise={r.net.igst} /></td>
              <td className="text-right"><Money paise={r.net.cgst} /></td>
              <td className="text-right"><Money paise={r.net.sgst} /></td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="GSTR-1 working" hint="Table 7 (B2C others) through the e-commerce operator, with Table 14(a), Table 13 and TCS alongside.">
        <Table head={[{ label: "Type" }, { label: "Place of supply" }, { label: "Rate" }, { label: "Operator GSTIN" }, { label: "Taxable", right: true }, { label: "IGST", right: true }, { label: "CGST", right: true }, { label: "SGST", right: true }]} minWidth={760}>
          {g.b2cs.map(r => (
            <tr key={`${r.type}-${r.pos}-${r.rate}-${r.ecoGstin}`}>
              <td>{r.type === "E" ? "E-commerce" : "Other"}</td>
              <td>{r.pos} · {r.posName}</td>
              <td className="tabular-nums">{r.rate}%</td>
              <td className="font-mono text-xs">{r.ecoGstin ?? "—"}</td>
              <td className="text-right"><Money paise={r.taxable} /></td>
              <td className="text-right"><Money paise={r.igst} /></td>
              <td className="text-right"><Money paise={r.cgst} /></td>
              <td className="text-right"><Money paise={r.sgst} /></td>
            </tr>
          ))}
        </Table>
        {g.b2cs.some(r => r.negative) && <Notice tone="warn">Some place-of-supply rows are negative: returns in this month exceed sales there. Potential risk — needs CA review.</Notice>}
        {g.unassigned.count > 0 && <Notice tone="warn">{g.unassigned.count} transaction(s) worth {rupeesFromPaise(g.unassigned.taxable)} have no recognisable customer State, so they are not in Table 7 until reviewed.</Notice>}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Table 14(a) · already in Table 7</h4>
            {g.table14a.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No operator GSTIN in these reports.</p> : g.table14a.map(r => (
              <div key={r.ecoGstin} className="mt-2 flex justify-between gap-2 text-sm"><span className="font-mono text-xs">{r.ecoGstin}</span><Money paise={r.taxable} /></div>
            ))}
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">TCS under Section 52 · not output tax</h4>
            <div className="mt-2 flex justify-between text-sm"><span>Net value through operator</span><Money paise={g.tcs.netTaxable} /></div>
            <div className="mt-1 flex justify-between text-sm"><span>Expected at {g.tcs.rate}%</span><Money paise={g.tcs.expected} className="font-medium" /></div>
            <p className="mt-2 text-xs text-muted-foreground">{g.tcs.note}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Table 13 · documents issued</h4>
            {!g.table13.available ? <p className="mt-2 text-sm text-muted-foreground">{g.table13.reason}</p> : (
              <ul className="mt-2 space-y-1 text-sm">
                {g.table13.invoices.map(s => <li key={`i-${s.prefix}`}>Invoices {s.from} – {s.to} <span className="text-muted-foreground">({s.count})</span></li>)}
                {g.table13.creditNotes.map(s => <li key={`c-${s.prefix}`}>Credit notes {s.from} – {s.to} <span className="text-muted-foreground">({s.count})</span></li>)}
                {g.table13.reason && <li className="text-xs text-muted-foreground">{g.table13.reason}</li>}
              </ul>
            )}
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">B2C (Large) candidates</h4>
            {g.b2clCandidates.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">None above the threshold.</p> : (
              <ul className="mt-2 space-y-1 text-sm">{g.b2clCandidates.slice(0, 8).map(r => <li key={r.reference} className="flex justify-between gap-2"><span className="truncate font-mono text-xs">{r.reference}</span><Money paise={r.invoiceValue} /></li>)}</ul>
            )}
          </div>
        </div>
        <ul className="space-y-1 text-xs text-muted-foreground">{g.notes.map(n => <li key={n}>• {n}</li>)}</ul>
      </Section>

      {data.ca && (
        <Section title="Compared with the CA's HSN summary" hint={`From ${data.ca.fileName}. Differences are shown as they are; nothing is adjusted to make them agree.`}>
          <Table head={[{ label: "HSN" }, { label: "CA taxable", right: true }, { label: "TallyThis taxable", right: true }, { label: "Difference", right: true }, { label: "CGST diff.", right: true }, { label: "SGST diff.", right: true }]}>
            {data.ca.rows.map(r => (
              <tr key={r.hsn}>
                <td className="tabular-nums">{r.hsn}</td>
                <td className="text-right"><Money paise={r.ca.taxable} /></td>
                <td className="text-right">{r.ours ? <Money paise={r.ours.taxable} /> : <span className="text-muted-foreground">not in these reports</span>}</td>
                <td className="text-right">{r.difference ? <Money paise={r.difference.taxable} className={r.difference.taxable !== 0 ? "font-medium" : "text-emerald-700"} /> : "—"}</td>
                <td className="text-right">{r.difference ? <Money paise={r.difference.cgst} /> : "—"}</td>
                <td className="text-right">{r.difference ? <Money paise={r.difference.sgst} /> : "—"}</td>
              </tr>
            ))}
          </Table>
          <p className="text-xs text-muted-foreground">A CA pivot usually adds each line's unrounded tax, so CGST and SGST can differ by a few rupees from the tax the reports show line by line. Switch tax rounding to compare.</p>
        </Section>
      )}
    </div>
  );
}
