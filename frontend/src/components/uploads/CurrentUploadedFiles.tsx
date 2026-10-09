import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, BadgeIndianRupee, BookOpen, CreditCard, Eye, FileText, FolderOpen, Landmark, Loader2, ReceiptText, Sparkles, Trash2, Users, WalletCards, X } from "lucide-react";
import { formatDate, formatDateTime } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import StatusBadge from "@/components/app/StatusBadge";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface UploadBatch {
  id: number;
  sourceType: string;
  fileName: string;
  status: string;
  uploadedAt: string;
  recordCount?: number | null;
}

const SOURCE_META: Record<string, { label: string; icon: typeof Landmark; folder: string }> = {
  bank: { label: "Bank Statement", icon: Landmark, folder: "Bank Statements folder" },
  invoices: { label: "Invoices", icon: ReceiptText, folder: "Invoices folder" },
  invoice: { label: "Invoices", icon: ReceiptText, folder: "Invoices folder" },
  tally: { label: "Tally Export", icon: BookOpen, folder: "Tally Export folder" },
  zoho: { label: "Zoho Export", icon: FileText, folder: "Zoho Export folder" },
  gst: { label: "GST / TDS", icon: BadgeIndianRupee, folder: "GST/TDS folder" },
  tds: { label: "GST / TDS", icon: BadgeIndianRupee, folder: "GST/TDS folder" },
  payroll: { label: "Payroll", icon: Users, folder: "Payroll folder" },
  gateway: { label: "Gateway Settlement", icon: CreditCard, folder: "Gateway folder" },
  expenses: { label: "Expenses", icon: WalletCards, folder: "Expenses folder" },
};

function metaFor(source: string) {
  const key = source.toLowerCase();
  return SOURCE_META[key] ?? { label: source, icon: FileText, folder: `${source} folder` };
}

interface FileRowProps {
  file: UploadBatch;
  onRemove: (file: UploadBatch) => void;
  onViewDetails: (file: UploadBatch) => void;
  onReprocess: (file: UploadBatch) => void;
  onToggleSelect: (id: number, checked: boolean) => void;
  selected: boolean;
  removing: boolean;
  reprocessing: boolean;
}

function FileRow({ file, onRemove, onViewDetails, onReprocess, onToggleSelect, selected, removing, reprocessing }: FileRowProps) {
  const needsReprocess = (file.recordCount ?? 0) === 0 || file.status === "needs_conversion" || file.status === "needs_ai_extraction";
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={e => onToggleSelect(file.id, e.target.checked)}
            className="accent-primary"
            aria-label={`Select ${file.fileName}`}
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground" title={file.fileName}>{file.fileName}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>Uploaded {formatDateTime(file.uploadedAt)}</span>
              {file.recordCount != null && <span>- {file.recordCount} rows</span>}
              <StatusBadge status={file.status} />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {needsReprocess && (
            <button
              type="button"
              onClick={() => onReprocess(file)}
              disabled={reprocessing}
              className="rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary hover:bg-primary/15 disabled:opacity-60"
              title="Re-run hybrid extractor with AI fallback"
            >
              {reprocessing ? <Loader2 className="inline h-3 w-3 animate-spin" /> : <Sparkles className="inline h-3 w-3" />}
              {" Re-extract"}
            </button>
          )}
          <button
            type="button"
            onClick={() => onViewDetails(file)}
            className="rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground hover:border-primary/30"
          >
            <Eye className="inline h-3 w-3" />{" View details"}
          </button>
          <button
            type="button"
            onClick={() => onRemove(file)}
            disabled={removing}
            className="rounded-md border border-destructive/20 bg-destructive/5 px-2 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60"
            title="Remove from active uploads"
          >
            {removing ? <Loader2 className="inline h-3 w-3 animate-spin" /> : <Trash2 className="inline h-3 w-3" />}
            {" Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface UploadDetails {
  id: number;
  fileName: string;
  sourceType: string;
  status: string;
  uploadedAt: string;
  recordCount: number | null;
  document: {
    id: number;
    mimeType: string | null;
    sizeBytes: number | null;
    rowCount: number | null;
    detectedColumns: string[] | unknown;
    parser?: string | null;
    extractionMethod?: string | null;
    extractionConfidence?: number | string | null;
    notes?: unknown[];
    extractedTextStatus: string;
    storageProvider: string;
  } | null;
  aiExtractions: Array<{
    id: number;
    provider: string;
    model: string | null;
    status: string;
    confidence: string;
    purpose: string;
    data: unknown;
    createdAt: string;
  }>;
}

function DetailsModal({ batchId, onClose }: { batchId: number; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<UploadDetails, Error>({
    queryKey: ["upload-details", batchId],
    queryFn: () => fetch(`${BASE}/api/uploads/${batchId}/details`).then(async r => {
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error || "Failed");
      return body;
    }),
  });

  const cols = Array.isArray(data?.document?.detectedColumns) ? (data!.document!.detectedColumns as string[]) : [];
  const notes = Array.isArray(data?.document?.notes) ? data!.document!.notes.map(note => String(note)) : [];
  const parserNote = notes.find(note => /python worker|typescript|server-side|fallback/i.test(note));
  const engine = parserNote?.toLowerCase().includes("python worker")
    ? "Python worker"
    : parserNote?.toLowerCase().includes("typescript") || parserNote?.toLowerCase().includes("fallback")
      ? "TypeScript fallback"
      : data?.document?.parser
        ? String(data.document.parser).toUpperCase()
        : "-";

  return (
    <div className="fv-content-modal-overlay">
      <div className="fv-modal-panel-lg p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-bold text-foreground">Upload details</div>
            {data && <div className="mt-0.5 truncate text-xs text-muted-foreground">{data.fileName}</div>}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        {isLoading && <div className="py-6 text-center text-sm text-muted-foreground">Loading details...</div>}
        {error && <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error.message}</div>}
        {data && (
          <div className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="text-[11px] text-muted-foreground">Source type</div>
                <div className="font-medium">{data.sourceType}</div>
              </div>
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="text-[11px] text-muted-foreground">Status</div>
                <div className="font-medium">{data.status}</div>
              </div>
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="text-[11px] text-muted-foreground">Uploaded</div>
                <div className="font-medium">{formatDateTime(data.uploadedAt)}</div>
              </div>
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="text-[11px] text-muted-foreground">Records imported</div>
                <div className="font-medium">{data.recordCount ?? 0}</div>
              </div>
            </div>
            {data.document && (
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Document</div>
                <div className="grid gap-2 text-xs sm:grid-cols-2">
                  <div><span className="text-muted-foreground">MIME:</span> {data.document.mimeType ?? "-"}</div>
                  <div><span className="text-muted-foreground">Size:</span> {data.document.sizeBytes ?? 0} bytes</div>
                  <div><span className="text-muted-foreground">Parsed rows:</span> {data.document.rowCount ?? 0}</div>
                  <div><span className="text-muted-foreground">Parser engine:</span> {engine}</div>
                  <div><span className="text-muted-foreground">Parser:</span> {data.document.parser ?? "-"}</div>
                  <div><span className="text-muted-foreground">Method:</span> {data.document.extractionMethod ?? "-"}</div>
                  <div><span className="text-muted-foreground">Text status:</span> {data.document.extractedTextStatus}</div>
                  <div><span className="text-muted-foreground">Storage:</span> {data.document.storageProvider}</div>
                </div>
                {cols.length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1 text-[11px] text-muted-foreground">Detected columns</div>
                    <div className="flex flex-wrap gap-1.5">
                      {cols.map(col => (
                        <span key={col} className="rounded-md border border-border bg-muted px-2 py-0.5 text-[11px]">{col}</span>
                      ))}
                    </div>
                  </div>
                )}
                {notes.length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1 text-[11px] text-muted-foreground">Parser notes</div>
                    <div className="space-y-1">
                      {notes.slice(0, 4).map((note, index) => (
                        <div key={`${note}-${index}`} className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground">{note}</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {data.aiExtractions.length > 0 && (
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">AI extractions</div>
                <div className="space-y-2">
                  {data.aiExtractions.map(ext => (
                    <div key={ext.id} className="rounded-md border border-border bg-card p-2 text-xs">
                      <div className="flex justify-between gap-3">
                        <span className="font-semibold">{ext.purpose}</span>
                        <span className="text-muted-foreground">{ext.provider} - {Math.round(Number(ext.confidence) * 100)}%</span>
                      </div>
                      <div className="text-muted-foreground">Status: {ext.status} - {formatDate(ext.createdAt)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CurrentUploadedFiles() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirmRemove, setConfirmRemove] = useState<UploadBatch | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkMode, setBulkMode] = useState<"selected" | "all" | null>(null);
  const [detailsId, setDetailsId] = useState<number | null>(null);

  const { data = [], isLoading } = useQuery<UploadBatch[]>({
    queryKey: ["uploads"],
    queryFn: () => fetch(`${BASE}/api/uploads`).then(r => r.json()),
  });

  const removeMutation = useMutation({
    mutationFn: ({ id, force }: { id: number; force?: boolean }) =>
      fetch(`${BASE}/api/uploads/${id}${force ? "?force=true" : ""}`, { method: "DELETE" }).then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          const err = new Error(body?.detail || body?.error || `Remove failed: ${r.status}`);
          (err as Error & { requiresForce?: boolean }).requiresForce = Boolean(body?.requiresForce);
          throw err;
        }
        return body;
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["uploads"] });
      qc.invalidateQueries({ queryKey: ["monthly-close-workflow"] });
      qc.invalidateQueries({ queryKey: ["action-history"] });
      toast({ title: "File removed from active", description: "File hidden from active uploads. Audit trail retained." });
      setConfirmRemove(null);
      setConfirmForce(false);
    },
    onError: err => {
      if ((err as Error & { requiresForce?: boolean }).requiresForce) {
        setConfirmForce(true);
        return;
      }
      toast({ title: "Could not remove", description: err instanceof Error ? err.message : "Remove failed", variant: "destructive" });
      setConfirmRemove(null);
      setConfirmForce(false);
    },
  });

  const [reprocessingId, setReprocessingId] = useState<number | null>(null);

  const reprocessMutation = useMutation({
    mutationFn: async (id: number) => {
      setReprocessingId(id);
      const r = await fetch(`${BASE}/api/uploads/${id}/reprocess`, { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error || body?.detail || "Reprocess failed");
      return body as { method: string; rowsExtracted: number; inserted: number; confidence: number };
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["uploads"] });
      qc.invalidateQueries({ queryKey: ["monthly-close-workflow"] });
      qc.invalidateQueries({ queryKey: ["action-history"] });
      toast({
        title: result.inserted > 0 ? `Imported ${result.inserted} rows via ${result.method}` : `Extracted ${result.rowsExtracted} rows (${Math.round(result.confidence * 100)}% confidence)`,
        description: result.inserted === 0 ? "Could not extract structured rows even with AI fallback. Try re-uploading as CSV/Excel." : `Method: ${result.method}, confidence ${Math.round(result.confidence * 100)}%`,
      });
      setReprocessingId(null);
    },
    onError: (err) => {
      toast({ title: "Reprocess failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
      setReprocessingId(null);
    },
  });

  const bulkMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const results = await Promise.allSettled(ids.map(id => fetch(`${BASE}/api/uploads/${id}?force=true`, { method: "DELETE" })));
      const failed = results.filter(r => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)).length;
      return { removed: ids.length - failed, failed };
    },
    onSuccess: ({ removed, failed }) => {
      qc.invalidateQueries({ queryKey: ["uploads"] });
      qc.invalidateQueries({ queryKey: ["monthly-close-workflow"] });
      qc.invalidateQueries({ queryKey: ["action-history"] });
      toast({ title: `${removed} removed`, description: failed ? `${failed} failed` : "All selected files removed from active." });
      setSelected(new Set());
      setBulkMode(null);
    },
  });

  const toggleSelect = (id: number, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const grouped = useMemo(() => {
    const map = new Map<string, UploadBatch[]>();
    for (const file of data) {
      const key = file.sourceType.toLowerCase();
      const arr = map.get(key) ?? [];
      arr.push(file);
      map.set(key, arr);
    }
    return Array.from(map.entries())
      .map(([source, files]) => ({ source, meta: metaFor(source), files }))
      .sort((a, b) => a.meta.label.localeCompare(b.meta.label));
  }, [data]);

  const bulkIds = bulkMode === "all" ? data.map(file => file.id) : Array.from(selected);
  const bulkCount = bulkIds.length;

  return (
    <section className="fv-card-flat mb-6 overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">Current Uploaded Files</div>
          <div className="mt-0.5 text-xs text-muted-foreground">Active files grouped by destination folder. Remove takes the file out of active workflow but keeps audit history.</div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {data.length > 0 && (
            <button
              type="button"
              onClick={() => setBulkMode("all")}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:border-destructive/30 hover:bg-destructive/5 hover:text-destructive"
            >
              <Trash2 className="inline h-3.5 w-3.5" /> Clear all active
            </button>
          )}
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => setBulkMode("selected")}
              className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="inline h-3.5 w-3.5" /> Remove {selected.size} selected
            </button>
          )}
          <div className="text-xs text-muted-foreground">{data.length} active</div>
        </div>
      </div>

      {isLoading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">Loading active files...</div>
      ) : data.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">No active files. Upload any finance file to begin.</div>
      ) : (
        <div className="grid gap-4 p-5 md:grid-cols-2">
          {grouped.map(group => {
            const Icon = group.meta.icon;
            return (
              <div key={group.source} className="rounded-xl border border-border bg-muted/20 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">{group.meta.label}</div>
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <FolderOpen className="h-3 w-3" />
                      {group.meta.folder} - {group.files.length} file{group.files.length === 1 ? "" : "s"}
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  {group.files.map(file => (
                    <FileRow
                      key={file.id}
                      file={file}
                      selected={selected.has(file.id)}
                      onToggleSelect={toggleSelect}
                      onViewDetails={f => setDetailsId(f.id)}
                      onRemove={f => { setConfirmForce(false); setConfirmRemove(f); }}
                      onReprocess={f => reprocessMutation.mutate(f.id)}
                      removing={removeMutation.isPending && confirmRemove?.id === file.id}
                      reprocessing={reprocessingId === file.id}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {confirmRemove && (
        <div className="fv-content-modal-overlay">
          <div className="fv-modal-panel-sm p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                <AlertCircle className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="text-base font-bold text-foreground">{confirmForce ? "Records already imported — cascade delete?" : "Remove from active uploads?"}</div>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  <span className="font-medium text-foreground">{confirmRemove.fileName}</span> will be hidden from active workflow and Smart Next Step recommendations.
                  {confirmForce
                    ? " ⚠ All imported rows in bank/invoice/ledger/payroll/gateway/GST tables tied to this upload WILL ALSO BE DELETED. Audit history of the upload itself is kept."
                    : " The file stays in audit history. If records were already imported, you will be asked to confirm cascade deletion."}
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={() => { setConfirmRemove(null); setConfirmForce(false); }} className="fv-button-secondary">Cancel</button>
              <button
                type="button"
                onClick={() => removeMutation.mutate({ id: confirmRemove.id, force: confirmForce })}
                disabled={removeMutation.isPending}
                style={{ backgroundColor: "hsl(0 72% 51%)", color: "white" }}
                className="rounded-lg border border-red-700 px-3 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-60"
              >
                {removeMutation.isPending ? <Loader2 className="inline h-4 w-4 animate-spin" /> : <Trash2 className="inline h-4 w-4" />}
                {confirmForce ? " Yes, delete upload + imported rows" : " Remove"}
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkMode && (
        <div className="fv-content-modal-overlay">
          <div className="fv-modal-panel-sm p-5">
            <div className="text-base font-bold text-foreground">{bulkMode === "all" ? "Clear all active uploads?" : `Remove ${bulkCount} files?`}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              {bulkMode === "all" ? "Every active upload" : "All selected uploads"} will be hidden from active workflow. Imported financial rows tied to each upload are cascade-deleted. Audit history is retained.
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={() => setBulkMode(null)} className="fv-button-secondary">Cancel</button>
              <button
                type="button"
                onClick={() => bulkMutation.mutate(bulkIds)}
                disabled={bulkMutation.isPending || bulkCount === 0}
                style={{ backgroundColor: "hsl(0 72% 51%)", color: "white" }}
                className="rounded-lg border border-red-700 px-3 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-60"
              >
                {bulkMutation.isPending ? <Loader2 className="inline h-4 w-4 animate-spin" /> : <Trash2 className="inline h-4 w-4" />}
                {bulkMode === "all" ? " Clear all active" : " Remove selected"}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailsId !== null && <DetailsModal batchId={detailsId} onClose={() => setDetailsId(null)} />}
    </section>
  );
}
