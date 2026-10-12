import { useEffect, useMemo, useRef, useState } from "react";
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
  downloadBlob,
  fmtDate,
  inr,
  postFiles,
  postJson,
  postDownload,
  takePendingFiles,
} from "@/components/jobs/jobUi";
import { getActiveClient } from "@/lib/activeClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Sale {
  platform: string;
  orderId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  gstin: string | null;
  buyerState: string | null;
  placeOfSupply: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  grossAmount: number;
  refundAmount: number;
  marketplaceFees: number;
  tcsAmount: number;
  hsn: string | null;
  gstRate: number | null;
  transactionType: string;
  sourceRow: number;
  sourceFile: string;
  issues: string[];
}

interface Pack {
  ok: boolean;
  message: string;
  runId?: string | null;
  /** True when privacy mode was on: nothing about this run was saved. */
  privacy?: boolean;
  platform: string;
  files?: string[];
  sales: Sale[];
  summary: { documents: number; taxableValue: number; gst: number; cess?: number; gross: number; refunds: number; tcs: number; b2b: number; b2c: number; errors: number; excludedSalesRows?: number };
  tabs: { b2b: Sale[]; b2c: Sale[]; hsn: Array<{ hsn: string; gstRate: number | null; taxableValue: number; count: number; supply: "B2B" | "B2C" }>; tcs: Sale[]; table14: Sale[]; errors: Sale[] };
  documents?: Array<{ platform: string; issued: number; cancelled: number; source: "uploaded reports" | "accountant correction" }>;
}

interface TcsComparison { rows: Array<{ state: string; code: string; uploaded: number; portal: number; difference: number }>; mismatches: number; source: string; message: string }

type Stage = "idle" | "working" | "done" | "error";
type Platform = "auto" | "amazon" | "flipkart" | "meesho" | "myntra" | "jiomart" | "glowroad" | "shop101" | "paytm" | "snapdeal" | "ajio" | "citymall" | "limeroad" | "generic";

const STEPS = ["Reading marketplace reports", "Detecting the marketplace", "Splitting B2B, B2C and HSN", "Checking GST details"];
const PLATFORMS: Array<{ value: Platform; label: string }> = [
  { value: "auto", label: "Detect automatically" },
  { value: "amazon", label: "Amazon" },
  { value: "flipkart", label: "Flipkart" },
  { value: "meesho", label: "Meesho" },
  { value: "myntra", label: "Myntra" },
  { value: "jiomart", label: "JioMart" },
  { value: "glowroad", label: "GlowRoad" },
  { value: "shop101", label: "Shop101" },
  { value: "paytm", label: "Paytm" },
  { value: "snapdeal", label: "Snapdeal" },
  { value: "ajio", label: "AJIO" },
  { value: "citymall", label: "CityMall" },
  { value: "limeroad", label: "LimeRoad" },
  { value: "generic", label: "Other" },
];
const TABS = ["B2B", "B2C", "HSN", "TCS", "Documents", "Table 14"] as const;

function titleCase(text: string) {
  return text.split(" + ").map(part => part === "generic" ? "Marketplace" : part.charAt(0).toUpperCase() + part.slice(1)).join(" + ");
}

export default function EcommerceGstPage() {
  const [stage, setStage] = useState<Stage>("idle");
  const [files, setFiles] = useState<File[]>([]);
  const [platform, setPlatform] = useState<Platform>("auto");
  const [error, setError] = useState("");
  const [exportNote, setExportNote] = useState("");
  const [pack, setPack] = useState<Pack | null>(null);
  const [resultView, setResultView] = useState<"report" | "review" | "export">("report");
  const [exportFormat, setExportFormat] = useState<"excel" | "gst" | "tally">("excel");
  const [exporting, setExporting] = useState(false);
  const [rowLimit, setRowLimit] = useState(200);
  const [tab, setTab] = useState<(typeof TABS)[number]>("B2B");
  const [downloaded, setDownloaded] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [savingReview, setSavingReview] = useState(false);
  const [reviewSale, setReviewSale] = useState<Sale | null>(null);
  const [bulkHsn, setBulkHsn] = useState({ from: "", to: "", rate: "" });
  const [annualTurnoverAbove5Cr, setAnnualTurnoverAbove5Cr] = useState(false);
  const [tcsComparison, setTcsComparison] = useState<TcsComparison | null>(null);
  const [tcsBusy, setTcsBusy] = useState(false);
  const [partyLedgers, setPartyLedgers] = useState<Record<string, string>>({});
  const [documentEdits, setDocumentEdits] = useState<NonNullable<Pack["documents"]>>([]);
  const portalInput = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (stage === "done") resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [stage, resultView]);

  const run = async (picked: File[], chosen: Platform = platform) => {
    setFiles(picked);
    setStage("working");
    setError("");
    setExportNote("");
    setDownloaded(false);
    setTcsComparison(null);
    setReviewSale(null);
    const response = await postFiles<Pack>("/api/jobs/ecommerce/normalize", { files: picked, platform: chosen });
    if (!response.ok) {
      setError(response.data.message || "These reports could not be read.");
      setStage("error");
      return;
    }
    setPack(response.data);
    setDocumentEdits(response.data.documents ?? []);
    setResultView("report");
    setTab(response.data.tabs.b2c.length ? "B2C" : "B2B");
    setRowLimit(200);
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

  const saveReview = async (sales: Sale[], above5Cr = annualTurnoverAbove5Cr, documents = pack?.documents ?? []) => {
    if (!pack) return;
    setSavingReview(true);
    const response = await postJson<Pack>("/api/jobs/ecommerce/review", {
      clientId: getActiveClient()?.id ?? undefined,
      runId: pack.runId,
      platform: pack.platform,
      annualTurnoverAbove5Cr: above5Cr,
      sales,
      documents,
    });
    setSavingReview(false);
    if (!response.ok) { setError(response.data.errors?.slice(0, 3).join(" ") || response.data.message || "Review changes could not be saved."); return; }
    setPack(response.data);
    setDocumentEdits(response.data.documents ?? []);
    setAnnualTurnoverAbove5Cr(above5Cr);
    if (!response.data.summary.errors) setResultView("report");
    setTcsComparison(null);
    setDownloaded(false);
    setReviewSale(null);
    setExportNote("");
    setError("");
  };

  const compareTcsFile = async (file: File) => {
    if (!pack) return;
    setTcsBusy(true);
    const response = await postFiles<TcsComparison>("/api/jobs/ecommerce/tcs-compare", {
      portalFile: file,
      sales: JSON.stringify(pack.sales),
      runId: pack.runId ?? undefined,
    });
    setTcsBusy(false);
    if (!response.ok) { setError(response.data.message || "The TCS summary could not be compared."); return; }
    setTcsComparison(response.data);
    setResultView(response.data.mismatches > 0 ? "review" : "report");
    setError("");
  };

  const generate = async () => {
    if (!pack) return;
    const name = pack.platform.replace(/\s\+\s/g, "-");
    const json = await postJson<{ json: unknown }>("/api/jobs/ecommerce/gst-json", { pack, annualTurnoverAbove5Cr });
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
    const response = await postJson<{ xml?: string; fileName?: string }>("/api/jobs/ecommerce/sales-xml", {
      clientId: getActiveClient()?.id ?? undefined,
      clientName: getActiveClient()?.name || "Client",
      partyLedgers,
      sales: pack.sales,
    });
    if (!response.ok || !response.data.xml) {
      setError(response.data.errors?.slice(0, 3).join(" ") || response.data.message || "Sales vouchers were not created.");
      return;
    }
    setError("");
    setExportNote(response.data.message || "Sales XML working copy downloaded. Check it in a test Tally company.");
    downloadText(response.data.fileName || "TallyThis_Marketplace_Sales_Review.xml", response.data.xml, "application/xml");
  };

  const exportExcel = async () => {
    if (!pack) return;
    setExportingExcel(true);
    const response = await postDownload("/api/jobs/ecommerce/excel", {
      clientName: getActiveClient()?.name || "Client",
      sales: pack.sales,
      documents: pack.documents,
      tcsComparison: tcsComparison ?? undefined,
    });
    setExportingExcel(false);
    if (!response.ok || !response.blob) { setError(response.message || "The Excel summary could not be created."); return; }
    setError("");
    downloadBlob("TallyThis_Ecommerce_Summary.xlsx", response.blob);
  };

  const reset = () => {
    setStage("idle");
    setFiles([]);
    setPack(null);
    setDocumentEdits([]);
    setError("");
    setReviewSale(null);
    setTcsComparison(null);
  };

  const exportSelected = async () => {
    setExporting(true);
    try {
      if (exportFormat === "excel") await exportExcel();
      else if (exportFormat === "gst") await generate();
      else await tallyXml();
    } finally { setExporting(false); }
  };

  const summary = pack?.summary;
  const needsPortalTcs = Boolean(pack?.sales.some(sale => sale.tcsAmount !== 0) && !tcsComparison);
  const attention = (summary?.errors ?? 0) + (tcsComparison?.mismatches ?? 0);
  const b2bGstins = pack ? [...new Set(pack.tabs.b2b.map(sale => sale.gstin).filter((value): value is string => Boolean(value)))] : [];
  const rows: Sale[] = pack ? (tab === "B2B" ? pack.tabs.b2b : tab === "B2C" ? pack.tabs.b2c : tab === "TCS" ? pack.tabs.tcs : tab === "Table 14" ? pack.tabs.table14 : []) : [];

  return (
    <JobShell title="E-commerce GST" outcome="Upload marketplace reports and prepare a GST review draft." modeLocked={stage !== "idle" && stage !== "error"}>
      {(stage === "idle" || stage === "error") && (
        <div className="space-y-4">
          {stage === "error" && <Notice tone="error">{error}</Notice>}
          <DropZone
            multiple
            label="Upload Marketplace Reports"
            hint="Marketplace sales reports · Excel or CSV · add several at once"
            accept=".csv,.xlsx,.xls"
            files={files}
            onFiles={picked => run(picked)}
          />
          <p className="text-center text-xs text-muted-foreground">The marketplace is detected from the file. Draft data for your GST return — not filed on the GST portal.</p>
        </div>
      )}

      {stage === "working" && <Working steps={STEPS} />}

      {stage === "done" && pack && summary && (
        <Tabs ref={resultRef} className="scroll-mt-4" value={resultView} onValueChange={value => setResultView(value as typeof resultView)}>
          <TabsList className="grid h-11 w-full grid-cols-3" aria-label="Marketplace results">
            <TabsTrigger value="report">GST report</TabsTrigger>
            <TabsTrigger value="review">Review{attention ? ` (${attention})` : ""}</TabsTrigger>
            <TabsTrigger value="export">Export</TabsTrigger>
          </TabsList>
          <TabsContent value={resultView} className="space-y-4 pt-2">
          <ResultCard
            eyebrow={`${titleCase(pack.platform)} · ${files.length} ${files.length === 1 ? "report" : "reports"}`}
            actions={resultView === "report" ?
              <>
                {attention > 0
                  ? <button type="button" className="fv-button-primary h-11 px-6" onClick={() => setResultView("review")}>Review {attention} {attention === 1 ? "item" : "items"}</button>
                  : needsPortalTcs
                    ? <button type="button" className="fv-button-primary h-11 px-6" disabled={tcsBusy} onClick={() => portalInput.current?.click()}>{tcsBusy ? "Comparing…" : "Compare portal TCS"}</button>
                    : <button type="button" className="fv-button-primary h-11 px-6" onClick={() => setResultView("export")}>Open exports</button>}
                {needsPortalTcs && attention > 0 && <button type="button" className="fv-button-secondary h-11" onClick={() => portalInput.current?.click()} disabled={tcsBusy}>{tcsBusy ? "Comparing…" : "Compare portal TCS"}</button>}
              </>
              : undefined}
          >
            <div className="grid grid-cols-2 gap-6">
              <BigStat value={summary.documents} label="sales rows read" tone="good" />
              <BigStat value={summary.errors} label={summary.errors === 1 ? "needs review" : "need review"} tone={summary.errors > 0 ? "attention" : "good"} />
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Mini label="Taxable value" value={inr(summary.taxableValue)} />
              <Mini label={summary.cess ? "GST + cess" : "GST"} value={inr(summary.gst + (summary.cess ?? 0))} />
              <Mini label="TCS" value={inr(summary.tcs)} />
              <Mini label="B2B · B2C" value={`${summary.b2b} · ${summary.b2c}`} />
            </div>
          </ResultCard>
          <input ref={portalInput} type="file" accept=".csv,.xlsx,.xls" className="hidden" aria-label="GST portal TCS summary" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void compareTcsFile(file); event.currentTarget.value = ""; }} />

          {pack.privacy && !downloaded && <Notice tone="success">Incognito: this file and result aren’t saved to your workspace. Download your reports before leaving.</Notice>}
          {needsPortalTcs && <Notice tone="info">TCS comes from marketplace reports only. Upload a GST portal TCS summary to compare before CA review.</Notice>}
          {tcsComparison && <Notice tone={tcsComparison.mismatches ? "warn" : "success"}>{tcsComparison.message} {tcsComparison.mismatches ? "Potential risk — needs CA review." : "Check the uploaded portal file and return period before filing."}</Notice>}
          {error && <Notice tone="error" onClose={() => setError("")}>{error}</Notice>}
          {Boolean(summary.excludedSalesRows) && <Notice tone="warn">Sales totals exclude {summary.excludedSalesRows} cancelled, return or adjustment {summary.excludedSalesRows === 1 ? "row" : "rows"}. Check their treatment before filing. Potential risk — needs CA review.</Notice>}
          {exportNote && <Notice tone="info" onClose={() => setExportNote("")}>{exportNote}</Notice>}
          {downloaded && (
            <Notice tone="success">GSTR-1 draft (JSON) and sales summary (CSV) downloaded. Potential risk — needs CA review before filing.</Notice>
          )}

          {resultView === "review" && (
            <ResultCard eyebrow="Review">
              <p className="mb-4 text-sm text-muted-foreground">Correct flagged rows here. TallyThis recalculates every section and total before exporting. Potential risk — needs CA review.</p>
              {tcsComparison && tcsComparison.mismatches > 0 && (
                <div className="mb-4 overflow-auto rounded-xl border border-border">
                  <table className="w-full min-w-[460px] text-left text-xs"><thead className="bg-muted"><tr><th className="p-3">State</th><th>Marketplace TCS</th><th>Portal TCS</th><th>Difference</th></tr></thead><tbody>
                    {tcsComparison.rows.filter(row => row.difference !== 0).map(row => <tr key={row.code} className="border-t border-border"><td className="p-3">{row.state}</td><td>{inr(row.uploaded)}</td><td>{inr(row.portal)}</td><td className="font-semibold text-amber-700">{inr(row.difference)}</td></tr>)}
                  </tbody></table>
                </div>
              )}
              <div className="space-y-4">
                {issueGroups.map(([issue, sales]) => (
                  <details key={issue} className="rounded-xl border border-border" open={issueGroups.length <= 2}>
                    <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold">{issue} <span className="text-muted-foreground">({sales.length})</span></summary>
                    <div className="divide-y divide-border border-t border-border">
                      {sales.slice(0, 50).map(sale => (
                        <div key={`${sale.sourceFile}-${sale.sourceRow}`} className="flex flex-wrap justify-between gap-2 px-4 py-2 text-xs">
                          <span className="font-medium">{sale.invoiceNumber || sale.orderId || `Row ${sale.sourceRow}`}</span>
                          <span className="text-muted-foreground">{fmtDate(sale.invoiceDate)} · {inr(sale.grossAmount)}</span>
                          <button type="button" className="font-semibold text-[var(--fv-accent-dark)] underline" onClick={() => setReviewSale({ ...sale })}>Correct row</button>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
              {reviewSale && (
                <div className="mt-5 rounded-xl border border-border bg-muted/30 p-4">
                  <h3 className="font-semibold">Correct {reviewSale.invoiceNumber || reviewSale.orderId || `row ${reviewSale.sourceRow}`}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">From {reviewSale.sourceFile}, row {reviewSale.sourceRow}. Check every change against the marketplace report.</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {([ ["invoiceNumber", "Invoice number"], ["invoiceDate", "Invoice date (YYYY-MM-DD)"], ["gstin", "Buyer GSTIN"], ["placeOfSupply", "Place of supply"], ["hsn", "HSN"], ["transactionType", "Document type"] ] as const).map(([key, label]) => <label key={key} className="text-xs font-medium">{label}<input className="fv-input mt-1 w-full" value={reviewSale[key] ?? ""} onChange={event => setReviewSale(current => current ? { ...current, [key]: key === "transactionType" ? event.target.value || "sale" : event.target.value || null } : current)} /></label>)}
                    {([ ["gstRate", "GST rate %"], ["taxableValue", "Taxable value"], ["cgst", "CGST"], ["sgst", "SGST"], ["igst", "IGST"], ["cess", "Cess"], ["grossAmount", "Invoice total"], ["tcsAmount", "TCS"], ["refundAmount", "Refund amount"] ] as const).map(([key, label]) => <label key={key} className="text-xs font-medium">{label}<input className="fv-input mt-1 w-full" type="number" min={key === "tcsAmount" ? undefined : "0"} step="0.01" value={reviewSale[key] ?? ""} onChange={event => setReviewSale(current => current ? { ...current, [key]: key === "gstRate" && !event.target.value ? null : Number(event.target.value) } : current)} /></label>)}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2"><button type="button" className="fv-button-primary" disabled={savingReview} onClick={() => void saveReview(pack.sales.map(sale => sale.sourceFile === reviewSale.sourceFile && sale.sourceRow === reviewSale.sourceRow ? reviewSale : sale))}>{savingReview ? "Checking…" : "Save correction"}</button><button type="button" className="fv-button-secondary" onClick={() => setReviewSale(null)}>Cancel</button></div>
                </div>
              )}
              <details className="mt-5 rounded-xl border border-border p-4">
                <summary className="cursor-pointer text-sm font-semibold">Fix multiple HSN codes</summary>
                <p className="mt-2 text-xs text-muted-foreground">Replace one code across this upload. Use “(missing)” for rows without HSN. Check the GST rate if it changes.</p>
                <div className="mt-3 flex flex-wrap gap-2"><input className="fv-input w-32" aria-label="Existing HSN" placeholder="Existing HSN" value={bulkHsn.from} onChange={event => setBulkHsn(value => ({ ...value, from: event.target.value }))} /><input className="fv-input w-32" aria-label="Correct HSN" placeholder="Correct HSN" value={bulkHsn.to} onChange={event => setBulkHsn(value => ({ ...value, to: event.target.value }))} /><input className="fv-input w-28" aria-label="Correct GST rate" type="number" min="0" max="100" step="0.01" placeholder="Rate %" value={bulkHsn.rate} onChange={event => setBulkHsn(value => ({ ...value, rate: event.target.value }))} /><button type="button" className="fv-button-secondary" disabled={savingReview} onClick={() => {
                  if (!/^\d{4,8}$/.test(bulkHsn.to) || (!bulkHsn.from && bulkHsn.from !== "(missing)")) { setError("Enter the old HSN and a 4–8 digit corrected HSN."); return; }
                  const changed = pack.sales.map(sale => (sale.hsn || "(missing)") === bulkHsn.from ? { ...sale, hsn: bulkHsn.to, gstRate: bulkHsn.rate ? Number(bulkHsn.rate) : sale.gstRate } : sale);
                  if (changed.every((sale, index) => sale === pack.sales[index])) { setError("No rows use that HSN."); return; }
                  void saveReview(changed);
                }}>Apply to matching rows</button></div>
                <label className="mt-4 flex items-center gap-2 text-xs"><input type="checkbox" checked={annualTurnoverAbove5Cr} onChange={event => void saveReview(pack.sales, event.target.checked)} />Previous year turnover exceeded ₹5 crore; check for at least six HSN digits.</label>
              </details>
              {!attention && !reviewSale && <p className="mt-3 text-sm">No flagged items remain. Check the GST report, then open Export.</p>}
              <button type="button" className="fv-button-secondary mt-4" onClick={() => setResultView("report")}>Back to GST report</button>
            </ResultCard>
          )}

          {resultView === "report" && (
            <ResultCard eyebrow="GST report">
              <p className="mb-4 text-sm text-muted-foreground">Your uploaded reports, grouped into readable GST sections. Review the figures here before choosing an export.</p>
              <Tabs value={tab} onValueChange={value => { setTab(value as typeof tab); setRowLimit(200); }}>
                <TabsList className="grid h-auto w-full grid-cols-3 gap-1 sm:grid-cols-6" aria-label="GST sections">
                  {TABS.map(section => <TabsTrigger key={section} value={section}>{section}</TabsTrigger>)}
                </TabsList>
                <TabsContent value={tab} className="pt-3">
                  {tab === "Documents"
                    ? <DocumentSummaryEditor value={documentEdits} onChange={setDocumentEdits} onSave={() => void saveReview(pack.sales, annualTurnoverAbove5Cr, documentEdits)} busy={savingReview} />
                    : <GstSectionSummary pack={pack} section={tab} comparison={tcsComparison} />}
                </TabsContent>
              </Tabs>
            </ResultCard>
          )}

          {resultView === "export" && (
            <ResultCard eyebrow="Export">
              <p className="mb-4 text-sm text-muted-foreground">Download the report you need. Uploading or opening a tab never starts a download.</p>
              {(attention > 0 || needsPortalTcs) && <Notice tone="warn">This is a working copy. {attention > 0 ? `${attention} items still need review.` : "Portal TCS has not been compared."} Potential risk — needs CA review.</Notice>}
              <label className="mt-4 block text-sm font-medium">Export format
                <select className="fv-input mt-2 w-full" value={exportFormat} onChange={event => setExportFormat(event.target.value as typeof exportFormat)}>
                  <option value="excel">Excel working copy</option>
                  <option value="gst">GST JSON draft + sales CSV</option>
                  <option value="tally">Tally Sales XML for test import</option>
                </select>
              </label>
              {exportFormat === "gst" && <p className="mt-3 text-xs text-muted-foreground">This GST JSON is a review draft. GST portal acceptance has not been verified.</p>}
              {exportFormat === "tally" && <div className="mt-4 space-y-3">
                <p className="text-xs text-muted-foreground">Uses existing Sales, Marketplace Customers and Output GST ledgers. Cancelled documents are left out; returns, adjustments and unresolved sales stop this export.</p>
                {b2bGstins.map(gstin => <label key={gstin} className="block text-xs">Buyer {gstin}<input className="fv-input mt-1 w-full" value={partyLedgers[gstin] ?? ""} onChange={event => setPartyLedgers(current => ({ ...current, [gstin]: event.target.value }))} placeholder="Existing Tally party ledger" /></label>)}
                <p className="text-xs text-muted-foreground">Check the Sales Register and GST reports in a test Tally company. Settlement and fee vouchers are not included. Potential risk — needs CA review.</p>
              </div>}
              <button type="button" className="fv-button-primary mt-5 h-11 px-6" disabled={exporting || exportingExcel} onClick={() => void exportSelected()}>
                {exporting ? "Preparing download…" : exportFormat === "excel" ? "Download Excel" : exportFormat === "gst" ? "Download GST draft" : "Download Sales XML"}
              </button>
            </ResultCard>
          )}

          {resultView === "report" && tab !== "Documents" && <MoreOptions label="Show source rows">
            <button type="button" className="text-sm font-medium text-[var(--fv-accent-dark)] hover:underline" onClick={reset}>Upload other reports</button>
            <p className="text-xs text-muted-foreground">{tab} source entries. Edits are checked again before the report changes.</p>
            <div className="max-h-96 overflow-auto rounded-xl border border-border bg-card">
              {tab === "HSN" ? (
                <table className="w-full min-w-[420px] text-left text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground"><tr><th className="px-3 py-2">Supply</th><th>HSN</th><th>Rate</th><th>Invoices</th><th>Taxable value</th></tr></thead>
                  <tbody>{pack.tabs.hsn.map(row => <tr key={`${row.supply}-${row.hsn}-${row.gstRate}`} className="border-t border-border"><td className="px-3 py-2">{row.supply}</td><td>{row.hsn}</td><td>{row.gstRate ?? "—"}%</td><td>{row.count}</td><td>{inr(row.taxableValue)}</td></tr>)}</tbody>
                </table>
              ) : rows.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">Nothing in {tab}.</p>
              ) : (
                <table className="w-full min-w-[620px] text-left text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground"><tr><th className="px-3 py-2">Invoice</th><th>Date</th><th>GSTIN</th><th>Place</th><th>Taxable</th><th>GST</th><th>Total</th><th>Review</th></tr></thead>
                  <tbody>
                    {rows.slice(0, rowLimit).map(sale => (
                      <tr key={`${sale.sourceFile}-${sale.sourceRow}`} className="border-t border-border">
                        <td className="px-3 py-2">{sale.invoiceNumber ?? sale.orderId}</td>
                        <td>{fmtDate(sale.invoiceDate)}</td>
                        <td>{sale.gstin ?? "—"}</td>
                        <td>{sale.placeOfSupply ?? "—"}</td>
                        <td>{inr(sale.taxableValue)}</td>
                        <td>{inr(sale.cgst + sale.sgst + sale.igst)}</td>
                        <td>{inr(sale.grossAmount)}</td>
                        <td><button type="button" className="font-semibold text-[var(--fv-accent-dark)] underline" onClick={() => { setResultView("review"); setReviewSale({ ...sale }); }}>Edit</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {rows.length > rowLimit && <button type="button" className="fv-button-secondary" onClick={() => setRowLimit(limit => limit + 200)}>Show next {Math.min(200, rows.length - rowLimit)} rows ({rowLimit} of {rows.length} shown)</button>}
            <div>
              <div className="mb-2 text-sm font-semibold">Marketplace</div>
              <Choice size="sm" value={platform} options={PLATFORMS} onChange={value => { setPlatform(value); void run(files, value); }} />
            </div>
          </MoreOptions>}
          </TabsContent>
        </Tabs>
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

function GstSectionSummary({ pack, section, comparison }: { pack: Pack; section: Exclude<(typeof TABS)[number], "Documents">; comparison: TcsComparison | null }) {
  if (section === "HSN") return <ReportTable columns={["Supply", "HSN", "GST rate", "Sales rows", "Taxable value"]} rows={pack.tabs.hsn.map(row => [row.supply, row.hsn, row.gstRate == null ? "Needs review" : `${row.gstRate}%`, row.count, inr(row.taxableValue)])} empty="No HSN summary is available." />;
  if (section === "TCS") {
    if (comparison) return <ReportTable columns={["State", "Marketplace TCS", "Uploaded portal TCS", "Difference"]} rows={comparison.rows.map(row => [row.state, inr(row.uploaded), inr(row.portal), inr(row.difference)])} empty="No TCS amounts were found." />;
    const byState = new Map<string, number>();
    pack.tabs.tcs.forEach(sale => { const state = sale.placeOfSupply || "Not provided"; byState.set(state, (byState.get(state) ?? 0) + sale.tcsAmount); });
    return <div className="space-y-3"><p className="text-xs text-muted-foreground">Amounts from uploaded reports. Compare a portal summary to check differences.</p><ReportTable columns={["Place of supply", "TCS from reports"]} rows={[...byState].map(([state, amount]) => [state, inr(amount)])} empty="No TCS amounts were found in these reports." /></div>;
  }
  const sales = section === "B2B" ? pack.tabs.b2b : section === "B2C" ? pack.tabs.b2c : pack.tabs.table14;
  const groups = new Map<string, { buyer: string; state: string; rate: number | null; count: number; taxable: number; tax: number; gross: number }>();
  sales.forEach(sale => {
    const state = sale.placeOfSupply || "Not provided";
    const buyer = section === "B2B" ? sale.gstin || "Not provided" : "";
    const key = `${buyer}:${state}:${sale.gstRate}`;
    const row = groups.get(key) ?? { buyer, state, rate: sale.gstRate, count: 0, taxable: 0, tax: 0, gross: 0 };
    row.count++; row.taxable += sale.taxableValue; row.tax += sale.cgst + sale.sgst + sale.igst + sale.cess; row.gross += sale.grossAmount;
    groups.set(key, row);
  });
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">{section === "Table 14" ? "Draft operator-related entries. Operator GSTIN and supply classification still need CA review." : `${sales.length} sales rows grouped by ${section === "B2B" ? "buyer GSTIN, " : ""}place of supply and GST rate. This is a review summary.`}</p>
    <ReportTable columns={[...(section === "B2B" ? ["Buyer GSTIN"] : []), "Place of supply", "GST rate", "Sales rows", "Taxable value", "GST + cess", "Invoice total"]} rows={[...groups.values()].map(row => [...(section === "B2B" ? [row.buyer] : []), row.state, row.rate == null ? "Needs review" : `${row.rate}%`, row.count, inr(row.taxable), inr(row.tax), inr(row.gross)])} empty={`No ${section} sales are included in these reports.`} />
  </div>;
}

function ReportTable({ columns, rows, empty }: { columns: string[]; rows: Array<Array<string | number>>; empty: string }) {
  if (!rows.length) return <p className="rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground">{empty}</p>;
  return <div className="max-h-96 overflow-auto rounded-xl border border-border">
    <table className="w-full text-left text-xs">
      <thead className="sticky top-0 bg-muted text-muted-foreground"><tr>{columns.map(column => <th key={column} className="whitespace-nowrap px-3 py-3">{column}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index} className="border-t border-border">{row.map((cell, col) => <td key={col} className="whitespace-nowrap px-3 py-3">{cell}</td>)}</tr>)}</tbody>
    </table>
  </div>;
}

type DocumentSummaryRows = NonNullable<Pack["documents"]>;
function DocumentSummaryEditor({ value, onChange, onSave, busy }: { value: DocumentSummaryRows; onChange: (rows: DocumentSummaryRows) => void; onSave: () => void; busy: boolean }) {
  const [newPlatform, setNewPlatform] = useState("");
  const change = (index: number, patch: Partial<DocumentSummaryRows[number]>) => onChange(value.map((row, i) => i === index ? { ...row, ...patch, source: "accountant correction" } : row));
  return <div>
    <h3 className="text-sm font-semibold">Documents issued</h3>
    <p className="mt-1 text-xs text-muted-foreground">Counts come from distinct invoice numbers. Correct them after checking the source document register.</p>
    {value.map((document, index) => <div key={index} className="mt-3 grid gap-2 sm:grid-cols-[1fr_90px_90px]">
      <label className="text-xs">Marketplace<input className="fv-input mt-1 w-full" value={document.platform} onChange={event => change(index, { platform: event.target.value })} /></label>
      <label className="text-xs">Issued<input className="fv-input mt-1 w-full" type="number" min="0" step="1" value={document.issued} onChange={event => change(index, { issued: Number(event.target.value) })} /></label>
      <label className="text-xs">Cancelled<input className="fv-input mt-1 w-full" type="number" min="0" step="1" value={document.cancelled} onChange={event => change(index, { cancelled: Number(event.target.value) })} /></label>
    </div>)}
    <MoreOptions label="Add document line">
      <label className="text-xs">Additional marketplace<input className="fv-input mt-1 w-full" value={newPlatform} onChange={event => setNewPlatform(event.target.value)} /></label>
      <button type="button" className="fv-button-secondary" disabled={!newPlatform.trim()} onClick={() => { onChange([...value, { platform: newPlatform.trim(), issued: 0, cancelled: 0, source: "accountant correction" }]); setNewPlatform(""); }}>Add document line</button>
    </MoreOptions>
    <button type="button" className="fv-button-primary mt-4" disabled={busy} onClick={onSave}>{busy ? "Checking…" : "Save document summary"}</button>
  </div>;
}
