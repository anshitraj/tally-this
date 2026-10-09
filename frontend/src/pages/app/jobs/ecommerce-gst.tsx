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
import { cn } from "@/lib/utils";

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
const TABS = ["B2B", "B2C", "HSN", "TCS", "Table 14"] as const;

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
  const [reviewOpen, setReviewOpen] = useState(false);
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
  const [newDocumentPlatform, setNewDocumentPlatform] = useState("");
  const portalInput = useRef<HTMLInputElement>(null);

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
    setReviewOpen(response.data.mismatches > 0);
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
        <div className="space-y-4">
          <ResultCard
            eyebrow={`${titleCase(pack.platform)} · ${files.length} ${files.length === 1 ? "report" : "reports"}`}
            actions={
              <>
                {attention > 0
                  ? <button type="button" className="fv-button-primary h-11 px-6" onClick={() => setReviewOpen(true)}>Review {attention} {attention === 1 ? "item" : "items"}</button>
                  : needsPortalTcs
                    ? <button type="button" className="fv-button-primary h-11 px-6" onClick={() => portalInput.current?.click()}>Compare portal TCS</button>
                    : <button type="button" className="fv-button-primary h-11 px-6" onClick={generate}>{downloaded ? "Download draft again" : "Download GST draft"}</button>}
                <button type="button" className="fv-button-secondary h-11" onClick={needsPortalTcs && attention > 0 ? () => portalInput.current?.click() : exportExcel} disabled={tcsBusy || exportingExcel}>{needsPortalTcs && attention > 0 ? "Compare portal TCS" : exportingExcel ? "Creating Excel…" : "Download Excel"}</button>
                <input ref={portalInput} type="file" accept=".csv,.xlsx,.xls" className="hidden" aria-label="GST portal TCS summary" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void compareTcsFile(file); event.currentTarget.value = ""; }} />
              </>
            }
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

          {pack.privacy && !downloaded && <Notice tone="success">Incognito: this file and result aren’t saved to your workspace. Download your reports before leaving.</Notice>}
          {needsPortalTcs && <Notice tone="info">TCS comes from marketplace reports only. Upload a GST portal TCS summary to compare before CA review.</Notice>}
          {tcsComparison && <Notice tone={tcsComparison.mismatches ? "warn" : "success"}>{tcsComparison.message} {tcsComparison.mismatches ? "Potential risk — needs CA review." : "Check the uploaded portal file and return period before filing."}</Notice>}
          {error && <Notice tone="error" onClose={() => setError("")}>{error}</Notice>}
          {Boolean(summary.excludedSalesRows) && <Notice tone="warn">Sales totals exclude {summary.excludedSalesRows} cancelled, return or adjustment {summary.excludedSalesRows === 1 ? "row" : "rows"}. Check their treatment before filing. Potential risk — needs CA review.</Notice>}
          {exportNote && <Notice tone="info" onClose={() => setExportNote("")}>{exportNote}</Notice>}
          {downloaded && (
            <Notice tone="success">GSTR-1 draft (JSON) and sales summary (CSV) downloaded. Potential risk — needs CA review before filing.</Notice>
          )}

          {reviewOpen && (
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
              <button type="button" className="fv-button-secondary mt-4" onClick={generate}>{downloaded ? "Download working draft again" : "Download working draft with issues"}</button>
            </ResultCard>
          )}

          <MoreOptions label="Show details">
            <button type="button" className="text-sm font-medium text-[var(--fv-accent-dark)] hover:underline" onClick={reset}>Upload other reports</button>
            <button type="button" className="fv-button-secondary" onClick={exportExcel} disabled={exportingExcel}>{exportingExcel ? "Creating Excel…" : "Download Excel working copy"}</button>
            <div className="flex flex-wrap gap-2">
              {TABS.map(item => (
                <button key={item} type="button" onClick={() => setTab(item)} className={cn("rounded-full px-3 py-1 text-xs font-semibold", tab === item ? "bg-foreground text-background" : "bg-card text-foreground border border-border")}>{item}</button>
              ))}
            </div>
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
                    {rows.slice(0, 200).map(sale => (
                      <tr key={`${sale.sourceFile}-${sale.sourceRow}`} className="border-t border-border">
                        <td className="px-3 py-2">{sale.invoiceNumber ?? sale.orderId}</td>
                        <td>{fmtDate(sale.invoiceDate)}</td>
                        <td>{sale.gstin ?? "—"}</td>
                        <td>{sale.placeOfSupply ?? "—"}</td>
                        <td>{inr(sale.taxableValue)}</td>
                        <td>{inr(sale.cgst + sale.sgst + sale.igst)}</td>
                        <td>{inr(sale.grossAmount)}</td>
                        <td><button type="button" className="font-semibold text-[var(--fv-accent-dark)] underline" onClick={() => { setReviewOpen(true); setReviewSale({ ...sale }); }}>Edit</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="rounded-xl border border-border p-4">
              <div className="text-sm font-semibold">Documents issued</div>
              <p className="mt-1 text-xs text-muted-foreground">Starting counts come from distinct invoice numbers in uploaded reports. Add or correct a count after checking the source document register.</p>
              {documentEdits.map((document, index) => <div key={index} className="mt-3 grid gap-2 sm:grid-cols-[1fr_90px_90px]">
                <label className="text-xs">Marketplace<input className="fv-input mt-1 w-full" value={document.platform} onChange={event => setDocumentEdits(rows => rows.map((row, i) => i === index ? { ...row, platform: event.target.value, source: "accountant correction" } : row))} /></label>
                <label className="text-xs">Issued<input className="fv-input mt-1 w-full" type="number" min="0" step="1" value={document.issued} onChange={event => setDocumentEdits(rows => rows.map((row, i) => i === index ? { ...row, issued: Number(event.target.value), source: "accountant correction" } : row))} /></label>
                <label className="text-xs">Cancelled<input className="fv-input mt-1 w-full" type="number" min="0" step="1" value={document.cancelled} onChange={event => setDocumentEdits(rows => rows.map((row, i) => i === index ? { ...row, cancelled: Number(event.target.value), source: "accountant correction" } : row))} /></label>
              </div>)}
              <div className="mt-3 flex flex-wrap gap-2"><input className="fv-input" aria-label="Additional marketplace for document summary" placeholder="Additional marketplace" value={newDocumentPlatform} onChange={event => setNewDocumentPlatform(event.target.value)} /><button type="button" className="fv-button-secondary" onClick={() => { if (newDocumentPlatform.trim()) { setDocumentEdits(rows => [...rows, { platform: newDocumentPlatform.trim(), issued: 0, cancelled: 0, source: "accountant correction" }]); setNewDocumentPlatform(""); } }}>Add document line</button></div>
              <button type="button" className="fv-button-secondary mt-3" disabled={savingReview} onClick={() => void saveReview(pack.sales, annualTurnoverAbove5Cr, documentEdits)}>{savingReview ? "Checking…" : "Save document summary"}</button>
            </div>
            <div>
              <div className="mb-2 text-sm font-semibold">Marketplace</div>
              <Choice size="sm" value={platform} options={PLATFORMS} onChange={value => { setPlatform(value); void run(files, value); }} />
            </div>
            <div>
              <div className="text-sm font-semibold">Tally Sales voucher working copy</div>
              <p className="mt-1 text-xs text-muted-foreground">Uses existing Sales, Marketplace Customers and Output GST ledgers in your test Tally company. For B2B, name each buyer’s existing ledger. Cancelled documents are left out. Returns, adjustments and unresolved sales stop this export.</p>
              {b2bGstins.map(gstin => <label key={gstin} className="mt-2 block text-xs">Buyer {gstin}<input className="fv-input mt-1 w-full" value={partyLedgers[gstin] ?? ""} onChange={event => setPartyLedgers(current => ({ ...current, [gstin]: event.target.value }))} placeholder="Existing Tally party ledger" /></label>)}
              <button type="button" className="fv-button-secondary mt-3" onClick={tallyXml}>Download Sales XML for test import</button>
              <p className="mt-2 text-xs text-muted-foreground">Sales and CGST/SGST/IGST/Cess lines are balanced. Import into a test Tally company and check Sales Register and GST reports. Settlement and fee vouchers are not included. Potential risk — needs CA review.</p>
            </div>
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
