import { useEffect, useMemo, useState } from "react";
import {
  BigStat,
  Choice,
  DropZone,
  JobShell,
  MoreOptions,
  Notice,
  ResultCard,
  Working,
  downloadText,
  fmtDate,
  inr,
  postFiles,
  postJson,
  takePendingFiles,
} from "@/components/jobs/jobUi";
import { getActiveClient } from "@/lib/activeClient";
import { cn } from "@/lib/utils";

interface Sale {
  platform: string;
  orderId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  gstin: string | null;
  placeOfSupply: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  grossAmount: number;
  tcsAmount: number;
  hsn: string | null;
  gstRate: number | null;
  sourceRow: number;
  sourceFile: string;
  issues: string[];
}

interface Pack {
  ok: boolean;
  message: string;
  runId?: string;
  platform: string;
  files?: string[];
  sales: Sale[];
  summary: { documents: number; taxableValue: number; gst: number; gross: number; refunds: number; tcs: number; b2b: number; b2c: number; errors: number };
  tabs: { b2b: Sale[]; b2c: Sale[]; hsn: Array<{ hsn: string; gstRate: number | null; taxableValue: number; count: number }>; tcs: Sale[]; table14: Sale[]; errors: Sale[] };
}

type Stage = "idle" | "working" | "done" | "error";
type Platform = "auto" | "amazon" | "flipkart" | "meesho" | "myntra" | "jiomart" | "generic";

const STEPS = ["Reading marketplace reports", "Detecting the marketplace", "Splitting B2B, B2C and HSN", "Checking GST details"];
const PLATFORMS: Array<{ value: Platform; label: string }> = [
  { value: "auto", label: "Detect automatically" },
  { value: "amazon", label: "Amazon" },
  { value: "flipkart", label: "Flipkart" },
  { value: "meesho", label: "Meesho" },
  { value: "myntra", label: "Myntra" },
  { value: "jiomart", label: "JioMart" },
  { value: "generic", label: "Other" },
];
const TABS = ["B2B", "B2C", "HSN", "TCS", "Table 14"] as const;

function titleCase(text: string) {
  return text.split(" + ").map(part => part === "generic" ? "Marketplace" : part.charAt(0).toUpperCase() + part.slice(1)).join(" + ");
}

export default function EcommerceGstPage() {
  const [stage, setStage] = useState<Stage>("idle");
  const [files, setFiles] = useState<File[]>([]);
  const [platform, setPlatform] = useState<Platform>("auto");
  const [error, setError] = useState("");
  const [pack, setPack] = useState<Pack | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [tab, setTab] = useState<(typeof TABS)[number]>("B2B");
  const [downloaded, setDownloaded] = useState(false);

  const run = async (picked: File[], chosen: Platform = platform) => {
    setFiles(picked);
    setStage("working");
    setError("");
    setDownloaded(false);
    const response = await postFiles<Pack>("/api/jobs/ecommerce/normalize", { files: picked, platform: chosen });
    if (!response.ok) {
      setError(response.data.message || "These reports could not be read.");
      setStage("error");
      return;
    }
    setPack(response.data);
    setReviewOpen(false);
    setStage("done");
  };

  useEffect(() => {
    const pending = takePendingFiles("ecommerce-gst");
    if (pending?.length) void run(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const issueGroups = useMemo(() => {
    const map = new Map<string, Sale[]>();
    (pack?.tabs.errors ?? []).forEach(sale => sale.issues.forEach(issue => {
      const label = issue.replace(" Potential risk — needs CA review.", "");
      map.set(label, [...(map.get(label) ?? []), sale]);
    }));
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [pack]);

  const generate = async () => {
    if (!pack) return;
    const name = pack.platform.replace(/\s\+\s/g, "-");
    const json = await postJson<{ json: unknown }>("/api/jobs/ecommerce/gst-json", { pack });
    if (!json.ok) {
      setError(json.data.errors?.slice(0, 3).join(" ") || json.data.message || "GST draft not created.");
      return;
    }
    downloadText(`${name}-gstr1-draft.json`, JSON.stringify(json.data.json, null, 2), "application/json");
    const csv = await postJson<{ csv: string }>("/api/jobs/ecommerce/csv", { sales: pack.sales });
    if (csv.data.csv) downloadText(`${name}-sales-summary.csv`, csv.data.csv, "text/csv");
    setError("");
    setDownloaded(true);
  };

  const tallyXml = async () => {
    if (!pack) return;
    const client = getActiveClient();
    const transactions = pack.sales.filter(sale => sale.invoiceDate && sale.grossAmount > 0).map(sale => ({
      date: sale.invoiceDate,
      valueDate: null,
      description: sale.invoiceNumber ?? "Marketplace sale",
      narration: `${titleCase(sale.platform)} sale ${sale.invoiceNumber ?? sale.orderId ?? ""}`.trim(),
      reference: sale.invoiceNumber,
      debit: null,
      credit: sale.grossAmount,
      balance: null,
      counterparty: titleCase(sale.platform),
      accountName: null,
      accountNumberMasked: null,
      bankName: null,
      rowNumber: sale.sourceRow,
      confidence: 0.9,
      sourceFile: sale.sourceFile,
      sourcePage: null,
      sourceQuote: sale.invoiceNumber ?? "",
    }));
    const response = await postJson<{ xml?: string; fileName?: string }>("/api/jobs/bank-to-tally/xml", {
      clientName: client?.name || "Client",
      bankLedger: "Marketplace Control",
      bankGroup: "Current Assets",
      transactions,
      mappings: [...new Set(pack.sales.map(sale => titleCase(sale.platform)))].map(name => ({ counterparty: name, ledgerName: "Sales" })),
    });
    if (!response.ok || !response.data.xml) {
      setError(response.data.errors?.slice(0, 3).join(" ") || response.data.message || "Tally XML not created.");
      return;
    }
    downloadText(response.data.fileName || "marketplace-tally.xml", response.data.xml, "application/xml");
  };

  const reset = () => {
    setStage("idle");
    setFiles([]);
    setPack(null);
    setError("");
  };

  const summary = pack?.summary;
  const rows: Sale[] = pack ? (tab === "B2B" ? pack.tabs.b2b : tab === "B2C" ? pack.tabs.b2c : tab === "TCS" ? pack.tabs.tcs : tab === "Table 14" ? pack.tabs.table14 : []) : [];

  return (
    <JobShell title="E-commerce GST" outcome="Upload marketplace reports and prepare GST-ready data.">
      {(stage === "idle" || stage === "error") && (
        <div className="space-y-4">
          {stage === "error" && <Notice tone="error">{error}</Notice>}
          <DropZone
            multiple
            label="Upload Marketplace Reports"
            hint="Amazon, Flipkart, Meesho, Myntra, JioMart · Excel or CSV · add several at once"
            accept=".csv,.xlsx,.xls"
            files={files}
            onFiles={picked => run(picked)}
          />
          <p className="text-center text-xs text-muted-foreground">The marketplace is detected from the file. Draft data for your GST return — not filed on the GST portal.</p>
        </div>
      )}

      {stage === "working" && <Working steps={STEPS} />}

      {stage === "done" && pack && summary && (
        <div className="space-y-4">
          <ResultCard
            eyebrow={`${titleCase(pack.platform)} · ${files.length} ${files.length === 1 ? "report" : "reports"}`}
            actions={
              <>
                <button type="button" className="fv-button-primary h-11 px-6" onClick={generate}>{downloaded ? "Download again" : "Generate GST Reports"}</button>
                {summary.errors > 0 && <button type="button" className="fv-button-secondary h-11" onClick={() => setReviewOpen(true)}>Review {summary.errors} {summary.errors === 1 ? "item" : "items"}</button>}
                <button type="button" className="text-sm font-medium text-muted-foreground hover:text-foreground sm:ml-auto" onClick={reset}>Upload other reports</button>
              </>
            }
          >
            <div className="grid grid-cols-2 gap-6">
              <BigStat value={summary.documents} label="invoices ready" tone="good" />
              <BigStat value={summary.errors} label={summary.errors === 1 ? "needs review" : "need review"} tone={summary.errors > 0 ? "attention" : "good"} />
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Mini label="Taxable value" value={inr(summary.taxableValue)} />
              <Mini label="GST" value={inr(summary.gst)} />
              <Mini label="TCS" value={inr(summary.tcs)} />
              <Mini label="B2B · B2C" value={`${summary.b2b} · ${summary.b2c}`} />
            </div>
          </ResultCard>

          {error && <Notice tone="error" onClose={() => setError("")}>{error}</Notice>}
          {downloaded && (
            <Notice tone="success">GSTR-1 draft (JSON) and sales summary (CSV) downloaded. Potential risk — needs CA review before filing.</Notice>
          )}

          {reviewOpen && (
            <ResultCard eyebrow="Review">
              <p className="mb-4 text-sm text-muted-foreground">Fix these in the marketplace report or note them for your CA. Potential risk — needs CA review.</p>
              <div className="space-y-4">
                {issueGroups.map(([issue, sales]) => (
                  <details key={issue} className="rounded-xl border border-border" open={issueGroups.length <= 2}>
                    <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold">{issue} <span className="text-muted-foreground">({sales.length})</span></summary>
                    <div className="divide-y divide-border border-t border-border">
                      {sales.slice(0, 50).map(sale => (
                        <div key={`${sale.sourceFile}-${sale.sourceRow}`} className="flex flex-wrap justify-between gap-2 px-4 py-2 text-xs">
                          <span className="font-medium">{sale.invoiceNumber || sale.orderId || `Row ${sale.sourceRow}`}</span>
                          <span className="text-muted-foreground">{fmtDate(sale.invoiceDate)} · {inr(sale.grossAmount)}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </ResultCard>
          )}

          <MoreOptions label="Show details">
            <div className="flex flex-wrap gap-2">
              {TABS.map(item => (
                <button key={item} type="button" onClick={() => setTab(item)} className={cn("rounded-full px-3 py-1 text-xs font-semibold", tab === item ? "bg-foreground text-background" : "bg-card text-foreground border border-border")}>{item}</button>
              ))}
            </div>
            <div className="max-h-96 overflow-auto rounded-xl border border-border bg-card">
              {tab === "HSN" ? (
                <table className="w-full min-w-[420px] text-left text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground"><tr><th className="px-3 py-2">HSN</th><th>Rate</th><th>Invoices</th><th>Taxable value</th></tr></thead>
                  <tbody>{pack.tabs.hsn.map(row => <tr key={row.hsn} className="border-t border-border"><td className="px-3 py-2">{row.hsn}</td><td>{row.gstRate ?? "—"}%</td><td>{row.count}</td><td>{inr(row.taxableValue)}</td></tr>)}</tbody>
                </table>
              ) : rows.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">Nothing in {tab}.</p>
              ) : (
                <table className="w-full min-w-[620px] text-left text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground"><tr><th className="px-3 py-2">Invoice</th><th>Date</th><th>GSTIN</th><th>Place</th><th>Taxable</th><th>GST</th><th>Total</th></tr></thead>
                  <tbody>
                    {rows.slice(0, 200).map(sale => (
                      <tr key={`${sale.sourceFile}-${sale.sourceRow}`} className="border-t border-border">
                        <td className="px-3 py-2">{sale.invoiceNumber ?? sale.orderId}</td>
                        <td>{fmtDate(sale.invoiceDate)}</td>
                        <td>{sale.gstin ?? "—"}</td>
                        <td>{sale.placeOfSupply ?? "—"}</td>
                        <td>{inr(sale.taxableValue)}</td>
                        <td>{inr(sale.cgst + sale.sgst + sale.igst)}</td>
                        <td>{inr(sale.grossAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div>
              <div className="mb-2 text-sm font-semibold">Marketplace</div>
              <Choice size="sm" value={platform} options={PLATFORMS} onChange={value => { setPlatform(value); void run(files, value); }} />
            </div>
            <button type="button" className="fv-button-secondary" onClick={tallyXml}>Download Tally sales vouchers (XML)</button>
          </MoreOptions>
        </div>
      )}
    </JobShell>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/50 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
