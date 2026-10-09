import { useState } from "react";
import { motion } from "framer-motion";
import { Loader2, Pencil, ReceiptText, Save, Table2, X } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const EXTRACTION_STAGES = [
  "Reading parsed text",
  "Sending schema to provider",
  "Extracting invoice fields",
  "Validating JSON",
  "Saving pending review",
];

interface InvoiceExtractionData {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  vendorName: string | null;
  customerName: string | null;
  vendorGstin: string | null;
  customerGstin: string | null;
  subtotalAmount: number | null;
  gstAmount: number | null;
  totalAmount: number | null;
  currency: string | null;
  confidence: number;
  missingFields: string[];
  warnings: string[];
  sourceQuotes: string[];
}

export interface AIExtractionResult {
  id?: number;
  provider: string;
  model?: string | null;
  confidence: number;
  status: string;
  source?: string;
  usedFallback?: boolean;
  reviewLabel?: string;
  data?: InvoiceExtractionData | null;
  error?: string | null;
}

export interface UploadImportSummary {
  table: string | null;
  inserted: number;
  skipped: number;
  notes: string[];
}

export interface ReconciliationSummary {
  matchesFound: number;
  newVerified: number;
  newPotential: number;
  newUnverified: number;
}

export interface MappingPreview {
  uploadId?: number;
  sourceType: string;
  fileName: string;
  rowCount: number;
  detectedColumns: string[];
  mode: string;
  parser?: string;
  processingStatus: string;
  processingTone: "success" | "warning" | "error" | "neutral";
  sheetNames?: string[];
  pageCount?: number | null;
  textPreview?: string | null;
  textLength?: number | null;
  tablesDetected?: number | null;
  notes?: string[];
  aiExtraction?: AIExtractionResult | null;
  imported?: UploadImportSummary | null;
  reconciliation?: ReconciliationSummary | null;
}

interface Props {
  preview: MappingPreview;
  aiExtraction: AIExtractionResult | null;
  aiLoading: boolean;
  aiError: string;
  aiProgress: number;
  aiStageIndex: number;
  pendingAction: "accept" | "reject" | null;
  onRunAi: () => void;
  onAcceptAi: () => void;
  onRejectAi: () => void;
  onAiExtractionUpdate?: (next: AIExtractionResult) => void;
  sourceLabel: (source: string) => string;
  uploadFolderName: (source: string) => string;
  supportsInvoiceExtraction: (source: string) => boolean;
}

type FieldKey = "invoiceNumber" | "invoiceDate" | "vendorName" | "customerName" | "vendorGstin" | "customerGstin" | "subtotalAmount" | "gstAmount" | "totalAmount" | "currency";

interface EditFormState {
  invoiceNumber: string;
  invoiceDate: string;
  vendorName: string;
  customerName: string;
  vendorGstin: string;
  customerGstin: string;
  subtotalAmount: string;
  gstAmount: string;
  totalAmount: string;
  currency: string;
}

function toFormState(data: InvoiceExtractionData | null | undefined): EditFormState {
  return {
    invoiceNumber: data?.invoiceNumber ?? "",
    invoiceDate: data?.invoiceDate ?? "",
    vendorName: data?.vendorName ?? "",
    customerName: data?.customerName ?? "",
    vendorGstin: data?.vendorGstin ?? "",
    customerGstin: data?.customerGstin ?? "",
    subtotalAmount: data?.subtotalAmount != null ? String(data.subtotalAmount) : "",
    gstAmount: data?.gstAmount != null ? String(data.gstAmount) : "",
    totalAmount: data?.totalAmount != null ? String(data.totalAmount) : "",
    currency: data?.currency ?? "",
  };
}

function fromFormState(state: EditFormState) {
  const numeric = (v: string) => v.trim() === "" ? null : Number(v);
  return {
    invoiceNumber: state.invoiceNumber || null,
    invoiceDate: state.invoiceDate || null,
    vendorName: state.vendorName || null,
    customerName: state.customerName || null,
    vendorGstin: state.vendorGstin || null,
    customerGstin: state.customerGstin || null,
    subtotalAmount: numeric(state.subtotalAmount),
    gstAmount: numeric(state.gstAmount),
    totalAmount: numeric(state.totalAmount),
    currency: state.currency || null,
  };
}

function processingClasses(tone: MappingPreview["processingTone"]) {
  if (tone === "success") return "text-success";
  if (tone === "warning") return "text-warning";
  if (tone === "error") return "text-destructive";
  return "text-muted-foreground";
}

function extractionProviderLabel(provider?: string) {
  if (!provider) return "-";
  if (provider === "gemini") return "Gemini";
  if (provider === "nvidia") return "NVIDIA";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "rule_based") return "Rule-based";
  return provider;
}

function displayValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "Needs review";
  return String(value);
}

export default function AdvancedUploadView({
  preview,
  aiExtraction,
  aiLoading,
  aiError,
  aiProgress,
  aiStageIndex,
  pendingAction,
  onRunAi,
  onAcceptAi,
  onRejectAi,
  onAiExtractionUpdate,
  sourceLabel,
  uploadFolderName,
  supportsInvoiceExtraction,
}: Props) {
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState<EditFormState>(toFormState(aiExtraction?.data));
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string>("");

  const startEdit = () => {
    setEditForm(toFormState(aiExtraction?.data));
    setEditError("");
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
    setEditError("");
  };

  const saveEdit = async () => {
    if (!aiExtraction?.id) return;
    setEditing(true);
    setEditError("");
    try {
      const res = await fetch(`${BASE}/api/ai/extractions/${aiExtraction.id}/edit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: fromFormState(editForm) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Edit failed");
      const next: AIExtractionResult = {
        ...aiExtraction,
        status: body.status ?? "edited_by_user",
        reviewLabel: body.label ?? "AI extracted — pending review",
        confidence: body.confidence ?? aiExtraction.confidence,
        data: body.data ?? aiExtraction.data,
      };
      onAiExtractionUpdate?.(next);
      setEditMode(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Edit failed");
    } finally {
      setEditing(false);
    }
  };

  const updateField = (key: FieldKey, value: string) => setEditForm(prev => ({ ...prev, [key]: value }));

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="fv-card-flat mb-6 p-5"
    >
      <div className="mb-1 inline-flex items-center gap-2 rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Advanced upload view
      </div>
      <div className="mb-3 mt-2 flex items-center gap-2 text-sm font-semibold">
        <Table2 className="w-4 h-4 text-primary" />
        Mapping Preview
      </div>
      <p className="mb-4 text-xs text-muted-foreground">Parsed rows, extracted text, AI raw output, and reprocess options. Hidden from the normal upload page by default.</p>

      <div className="grid md:grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">File</div>
          <div className="font-medium">{preview.fileName}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Folder</div>
          <div className="font-medium">{uploadFolderName(preview.sourceType)}</div>
        </div>
        {preview.parser === "pdf" ? (
          <>
            <div>
              <div className="text-xs text-muted-foreground">PDF pages</div>
              <div className="font-medium">{preview.pageCount ?? "Needs review"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Extracted text</div>
              <div className="font-medium">{preview.textLength ?? preview.textPreview?.length ?? 0} characters</div>
            </div>
          </>
        ) : (
          <>
            <div>
              <div className="text-xs text-muted-foreground">Parsed rows</div>
              <div className="font-medium">{preview.rowCount}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Detected columns</div>
              <div className="font-medium">{preview.detectedColumns.length}</div>
            </div>
          </>
        )}
        <div>
          <div className="text-xs text-muted-foreground">Processing status</div>
          <div className={`font-medium ${processingClasses(preview.processingTone)}`}>{preview.processingStatus}</div>
        </div>
        {preview.parser === "pdf" && (
          <>
            <div>
              <div className="text-xs text-muted-foreground">Tables detected</div>
              <div className="font-medium">{preview.tablesDetected ?? 0}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">AI extraction status</div>
              <div className="font-medium">{aiExtraction ? (aiExtraction.reviewLabel ?? "AI extracted — pending review") : "Not run"}</div>
            </div>
          </>
        )}
      </div>

      <p className="text-xs text-muted-foreground mt-3">{preview.mode}</p>
      {preview.sheetNames && preview.sheetNames.length > 0 && (
        <p className="text-xs text-muted-foreground mt-2">Sheets: {preview.sheetNames.join(", ")}</p>
      )}
      {preview.detectedColumns.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {preview.detectedColumns.map(column => (
            <span key={column} className="px-2 py-1 rounded-md bg-muted text-xs text-muted-foreground border border-border">
              {column}
            </span>
          ))}
        </div>
      )}
      {preview.textPreview && (
        <div className="mt-3 p-3 rounded-lg bg-muted/40 border border-border">
          <div className="text-xs font-medium mb-1">Text preview</div>
          <p className="text-xs text-muted-foreground line-clamp-6">{preview.textPreview}</p>
        </div>
      )}
      {preview.notes && preview.notes.length > 0 && (
        <div className="mt-3 space-y-1">
          {preview.notes.map(note => <p key={note} className="text-xs text-muted-foreground">{note}</p>)}
        </div>
      )}
      {preview.imported && (
        <div className="mt-4 rounded-xl border border-border bg-muted/30 p-4">
          <div className="text-sm font-semibold">Import result</div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-border bg-background px-2.5 py-1">
              Rows imported: {preview.imported.inserted}
            </span>
            {preview.imported.table && (
              <span className="rounded-full border border-border bg-background px-2.5 py-1">
                Destination: {preview.imported.table.replace(/_/g, " ")}
              </span>
            )}
            {preview.reconciliation && (
              <span className="rounded-full border border-border bg-background px-2.5 py-1">
                New matches: {preview.reconciliation.matchesFound}
              </span>
            )}
          </div>
          {preview.imported.notes.map(note => <p key={note} className="mt-2 text-xs text-muted-foreground">{note}</p>)}
        </div>
      )}

      {supportsInvoiceExtraction(preview.sourceType) ? (
        <div className="mt-5 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">AI Extraction</div>
              <p className="mt-1 text-xs text-muted-foreground">
                {aiExtraction
                  ? "AI extracted — pending review. Mark Accept / Reject after CA verification."
                  : "Extract invoice fields from parsed text. Results stay pending review until accepted."}
              </p>
            </div>
            {!aiExtraction && (
              <button type="button" onClick={onRunAi} disabled={aiLoading || !preview.uploadId || !preview.textPreview} className="fv-button-primary">
                {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ReceiptText className="h-4 w-4" />}
                {aiLoading ? `Running ${aiProgress}%` : "Run AI Extraction"}
              </button>
            )}
          </div>
          {aiLoading && (
            <div className="mt-4 overflow-hidden rounded-xl border border-primary/20 bg-background p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">Running extraction</div>
                  <div className="mt-1 text-xs text-muted-foreground">{EXTRACTION_STAGES[aiStageIndex]}</div>
                </div>
                <div className="relative flex h-14 w-14 items-center justify-center rounded-full border border-primary/20 bg-primary/10">
                  <motion.div
                    className="absolute inset-1 rounded-full border-2 border-primary border-t-transparent"
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }}
                  />
                  <span className="text-xs font-bold text-primary">{aiProgress}%</span>
                </div>
              </div>
              <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-muted">
                <motion.div
                  className="h-full rounded-full bg-primary"
                  animate={{ width: `${aiProgress}%` }}
                  transition={{ type: "spring", stiffness: 90, damping: 18 }}
                />
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-5">
                {EXTRACTION_STAGES.map((stage, index) => (
                  <div
                    key={stage}
                    className={`rounded-lg border px-2 py-2 text-[11px] font-medium ${
                      index <= aiStageIndex
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : "border-border bg-muted/30 text-muted-foreground"
                    }`}
                  >
                    {stage}
                  </div>
                ))}
              </div>
            </div>
          )}
          {aiError && (
            <div className="mt-4 rounded-lg border border-warning/20 bg-warning/10 p-3 text-sm text-warning">
              {aiError === "No extracted text available. OCR required." ? aiError : "AI extraction failed. Rule-based extraction is available."}
              <button type="button" onClick={onRunAi} className="ml-3 font-semibold underline">Use rule-based extraction</button>
            </div>
          )}
          {aiExtraction && (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-2 text-xs font-semibold">
                <span className="fv-status-review">AI extracted — pending review</span>
                {aiExtraction.confidence < 0.75 && <span className="fv-status-missing">Needs review</span>}
                <span className="rounded-full border border-border px-2.5 py-1">Provider: {extractionProviderLabel(aiExtraction.provider)}</span>
                {aiExtraction.usedFallback && <span className="rounded-full border border-border px-2.5 py-1">Fallback used: {extractionProviderLabel(aiExtraction.provider)}</span>}
                {aiExtraction.model && <span className="rounded-full border border-border px-2.5 py-1">Model: {aiExtraction.model}</span>}
                <span className="rounded-full border border-border px-2.5 py-1">Confidence: {Math.round(aiExtraction.confidence * 100)}%</span>
              </div>
              {aiExtraction.confidence < 0.75 && (
                <div className="rounded-lg border border-warning/20 bg-warning/10 p-3 text-xs text-warning">
                  Low confidence extraction — please review before accepting.
                </div>
              )}
              {editMode ? (
                <div className="grid gap-3 text-sm md:grid-cols-2 lg:grid-cols-3">
                  {([
                    ["Invoice No", "invoiceNumber", "text"],
                    ["Date", "invoiceDate", "text"],
                    ["Vendor", "vendorName", "text"],
                    ["Customer", "customerName", "text"],
                    ["Vendor GSTIN", "vendorGstin", "text"],
                    ["Customer GSTIN", "customerGstin", "text"],
                    ["Subtotal", "subtotalAmount", "number"],
                    ["GST", "gstAmount", "number"],
                    ["Total", "totalAmount", "number"],
                    ["Currency", "currency", "text"],
                  ] as Array<[string, FieldKey, string]>).map(([label, key, type]) => (
                    <label key={key} className="rounded-lg border border-border bg-background p-3 block">
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <input
                        type={type}
                        value={editForm[key]}
                        onChange={e => updateField(key, e.target.value)}
                        className="mt-1 w-full rounded border border-border bg-card px-2 py-1 text-sm font-medium focus:border-primary focus:outline-none"
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <div className="grid gap-3 text-sm md:grid-cols-2 lg:grid-cols-3">
                  {[
                    ["Invoice No", aiExtraction.data?.invoiceNumber],
                    ["Date", aiExtraction.data?.invoiceDate],
                    ["Vendor", aiExtraction.data?.vendorName],
                    ["Customer", aiExtraction.data?.customerName],
                    ["Vendor GSTIN", aiExtraction.data?.vendorGstin],
                    ["Customer GSTIN", aiExtraction.data?.customerGstin],
                    ["Subtotal", aiExtraction.data?.subtotalAmount],
                    ["GST", aiExtraction.data?.gstAmount],
                    ["Total", aiExtraction.data?.totalAmount],
                    ["Currency", aiExtraction.data?.currency],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-lg border border-border bg-background p-3">
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="mt-1 font-medium">{displayValue(value as string | number | null | undefined)}</div>
                    </div>
                  ))}
                </div>
              )}
              {editError && <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-2 text-xs text-destructive">{editError}</div>}
              {aiExtraction.data?.missingFields && aiExtraction.data.missingFields.length > 0 && (
                <p className="text-xs text-muted-foreground">Missing fields: {aiExtraction.data.missingFields.join(", ")}</p>
              )}
              {aiExtraction.data?.warnings && aiExtraction.data.warnings.length > 0 && (
                <div className="space-y-1">
                  {aiExtraction.data.warnings.map(warning => <p key={warning} className="text-xs text-warning">{warning}</p>)}
                </div>
              )}
              {aiExtraction.data?.sourceQuotes && aiExtraction.data.sourceQuotes.length > 0 && (
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <div className="mb-2 text-xs font-semibold">Source quotes</div>
                  <div className="space-y-1">
                    {aiExtraction.data.sourceQuotes.slice(0, 4).map(quote => <p key={quote} className="text-xs text-muted-foreground">{quote}</p>)}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {editMode ? (
                  <>
                    <button type="button" onClick={saveEdit} disabled={editing} className="fv-button-primary">
                      {editing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      Save edits
                    </button>
                    <button type="button" onClick={cancelEdit} disabled={editing} className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:border-primary/40">
                      <X className="inline h-4 w-4" /> Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={onAcceptAi} disabled={pendingAction !== null || aiExtraction.status === "accepted"} className="fv-button-primary">
                      {pendingAction === "accept" && <Loader2 className="h-4 w-4 animate-spin" />}
                      {aiExtraction.status === "accepted" ? "Accepted for reconciliation" : "Accept extraction"}
                    </button>
                    <button type="button" onClick={startEdit} className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:border-primary/40">
                      <Pencil className="inline h-4 w-4" /> Edit fields
                    </button>
                    <button type="button" onClick={onRejectAi} disabled={pendingAction !== null || aiExtraction.status === "rejected"} className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:border-primary/40">
                      {pendingAction === "reject" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                      {aiExtraction.status === "rejected" ? "Rejected" : "Reject"}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-border bg-card p-4">
          <div className="text-sm font-semibold">Document workflow</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {sourceLabel(preview.sourceType)} uploads are parsed into their matching records for rule-based reconciliation. Invoice field extraction is only available for invoice uploads.
          </p>
        </div>
      )}
    </motion.div>
  );
}
