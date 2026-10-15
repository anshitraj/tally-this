import { useState } from "react";
import { useLocation } from "wouter";
import { FileSpreadsheet } from "lucide-react";
import { BigStat, MoreOptions, Notice, ResultCard, downloadBlob, fmtDate, inr, postDownload } from "@/components/jobs/jobUi";
import { getActiveClient } from "@/lib/activeClient";

interface SavedItem {
  bucket: string;
  status: string;
  supplierGstin: string;
  supplierName: string;
  docNumber: string;
  docDate: string | null;
  why: string[];
  itcAtRisk: number;
  itcUnclaimed: number;
  books?: { total: number; tax: number };
  portal?: { total: number; tax: number };
}

interface SavedData {
  period?: string | null;
  periods?: string[];
  recipientGstin?: string | null;
  comparison?: { items?: SavedItem[]; counts?: Record<string, number> };
  totals?: { itcAtRisk?: number; itcUnclaimed?: number; notEligibleTax?: number };
  notes?: string[];
  truncated?: boolean;
  files?: { portal?: string; books?: string };
}

const TITLES: Record<string, string> = {
  missing_in_2b: "In books, not in GSTR-2B",
  value_mismatch: "Amounts differ",
  probable: "Probable match, not confirmed",
  duplicate: "Entered twice in books",
  not_eligible: "ITC not available in GSTR-2B",
  missing_in_books: "In GSTR-2B, not in books",
};

const ORDER = Object.keys(TITLES);

function monthName(period: string | null | undefined) {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return null;
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** A saved GSTR-2B ↔ Books result, reopened from History. */
export function Gstr2bSavedView({ runId, data }: { runId: string; data: SavedData | undefined }) {
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!data?.comparison?.items) return <Notice tone="warn">The saved result for this item is not available.</Notice>;

  const counts = data.comparison.counts ?? {};
  const items = data.comparison.items;
  const attention = items.filter(item => item.bucket !== "matched");
  const label = (data.periods?.length ? data.periods : data.period ? [data.period] : []).map(monthName).filter(Boolean).join(", ");

  const download = async () => {
    setBusy(true);
    setError("");
    const response = await postDownload("/api/jobs/gstr-2b/excel", { runId, clientName: getActiveClient()?.name || "Client" });
    setBusy(false);
    if (!response.ok || !response.blob) {
      setError(response.message || "The Excel file could not be created.");
      return;
    }
    downloadBlob("TallyThis_GSTR2B_Reconciliation.xlsx", response.blob);
  };

  return (
    <div className="space-y-4">
      <ResultCard
        eyebrow={`${label ? `${label} · ` : ""}${counts.portal ?? 0} in GSTR-2B · ${counts.books ?? 0} in your books`}
        actions={
          <>
            <button type="button" className="fv-button-primary h-11 px-6" disabled={busy} onClick={() => void download()}>
              <FileSpreadsheet className="h-4 w-4" />
              {busy ? "Preparing…" : "Download Excel"}
            </button>
            <button type="button" className="fv-button-secondary h-11" onClick={() => navigate("/app/jobs/gstr-2b")}>
              Run again with new files
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-6">
          <BigStat value={counts.matched ?? 0} label="matched" tone="good" />
          <BigStat value={attention.length} label="need attention" tone={attention.length > 0 ? "attention" : "good"} />
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            <span className="text-xs text-muted-foreground">ITC not supported by GSTR-2B </span>
            <span className="font-medium tabular-nums">{inr(data.totals?.itcAtRisk ?? 0)}</span>
          </span>
          <span>
            <span className="text-xs text-muted-foreground">In GSTR-2B, not in books </span>
            <span className="font-medium tabular-nums">{inr(data.totals?.itcUnclaimed ?? 0)}</span>
          </span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Potential risk — needs CA review. This compares two uploaded files; it does not decide whether ITC can be claimed.</p>
      </ResultCard>

      {error && <Notice tone="error" onClose={() => setError("")}>{error}</Notice>}
      {data.truncated && <Notice tone="info">This was a very large run, so only the items needing attention were saved. The Excel file has them.</Notice>}
      {(data.notes ?? []).length > 0 && (
        <Notice tone="info">
          {(data.notes ?? []).map(note => (
            <p key={note}>{note}</p>
          ))}
        </Notice>
      )}

      {ORDER.map(bucket => {
        const rows = attention.filter(item => item.bucket === bucket);
        if (rows.length === 0) return null;
        return (
          <ResultCard key={bucket} eyebrow={`${TITLES[bucket]} (${rows.length})`}>
            <div className="divide-y divide-border rounded-xl border border-border">
              {rows.slice(0, 25).map((item, index) => (
                <div key={`${item.supplierGstin}-${item.docNumber}-${index}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{item.supplierName || item.supplierGstin}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {item.supplierGstin} · {item.docNumber}
                      {item.docDate ? ` · ${fmtDate(item.docDate)}` : ""}
                    </div>
                    {item.why[0] && <div className="mt-1 text-xs text-muted-foreground">{item.why[0]}</div>}
                  </div>
                  <div className="text-sm tabular-nums">
                    {item.itcAtRisk > 0 ? <span className="font-medium text-amber-700">{inr(item.itcAtRisk)} at risk</span> : item.itcUnclaimed > 0 ? <span className="text-muted-foreground">{inr(item.itcUnclaimed)} not in books</span> : null}
                  </div>
                </div>
              ))}
            </div>
            {rows.length > 25 && <p className="mt-2 text-xs text-muted-foreground">{rows.length - 25} more are in the Excel file.</p>}
          </ResultCard>
        );
      })}

      <MoreOptions label="Show details">
        <div className="space-y-1 text-sm text-muted-foreground">
          {data.files?.portal && <p>GSTR-2B: {data.files.portal}</p>}
          {data.files?.books && <p>Purchase register: {data.files.books}</p>}
          {data.recipientGstin && <p>GSTIN in GSTR-2B: {data.recipientGstin}</p>}
        </div>
      </MoreOptions>
    </div>
  );
}
