import { useEffect, useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Upload, FileText, CheckCircle, AlertCircle, Loader2, Plus, Settings2, ChevronUp } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import StatusBadge from "@/components/app/StatusBadge";
import { PageTransition } from "@/components/app/finverify-ui";
import { formatDateTime } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import SmartNextStepPanel from "@/components/uploads/SmartNextStepPanel";
import ActionHistory from "@/components/workflow/ActionHistory";
import ProcessingSteps from "@/components/workflow/ProcessingSteps";
import AdvancedUploadView from "@/components/uploads/AdvancedUploadView";
import CurrentUploadedFiles from "@/components/uploads/CurrentUploadedFiles";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface UploadBatch {
  id: number;
  sourceType: string;
  fileName: string;
  status: string;
  uploadedAt: string;
  recordCount?: number | null;
}

interface MappingPreview {
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

interface UploadResult extends UploadBatch {
  parsing?: {
    documentId: number;
    parser: string;
    status?: string;
    rowCount?: number | null;
    detectedColumns?: string[];
    sheetNames?: string[];
    pageCount?: number | null;
    textPreview?: string | null;
    textLength?: number | null;
    tablesDetected?: number | null;
    notes?: string[];
  };
  aiExtraction?: MappingPreview["aiExtraction"];
  imported?: UploadImportSummary | null;
  reconciliation?: ReconciliationSummary | null;
}

interface UploadImportSummary {
  table: string | null;
  inserted: number;
  skipped: number;
  notes: string[];
}

interface ReconciliationSummary {
  matchesFound: number;
  newVerified: number;
  newPotential: number;
  newUnverified: number;
}

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

interface AIExtractionResult {
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

interface SelectedFilePreview {
  name: string;
  url: string;
  kind: "pdf" | "image" | "file";
}

type ExtractionAction = "accept" | "reject" | null;

const SOURCE_TYPES = [
  { value: "bank", label: "Bank Statement" },
  { value: "invoices", label: "Invoices" },
  { value: "tally", label: "Tally Export" },
  { value: "zoho", label: "Zoho Export" },
  { value: "gst", label: "GST 2B / 3B" },
  { value: "payroll", label: "Payroll Sheet" },
  { value: "gateway", label: "Gateway Settlement" },
  { value: "expenses", label: "Expense Sheet" },
];

function autoDetectSourceType(fileName: string): string {
  const n = fileName.toLowerCase();
  if (/bank|statement|hdfc|icici|sbi|kotak|axis|txn|transaction/.test(n)) return "bank";
  if (/invoice|inv[-_]|bill|receipt/.test(n)) return "invoices";
  if (/tally|ledger|voucher|daybook/.test(n)) return "tally";
  if (/zoho|crm/.test(n)) return "zoho";
  if (/gst|tds|2b|3b|gstr/.test(n)) return "gst";
  if (/payroll|salary|salary.reg|ctc/.test(n)) return "payroll";
  if (/gateway|razorpay|cashfree|stripe|settlement/.test(n)) return "gateway";
  if (/expense|reimburse/.test(n)) return "expenses";
  return "bank";
}

const EXTRACTION_STAGES = [
  "Reading parsed text",
  "Sending schema to provider",
  "Extracting invoice fields",
  "Validating JSON",
  "Saving pending review",
];

async function readUploadBatches(response: Response): Promise<UploadBatch[]> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || `Uploads request failed: ${response.status}`);
  }
  if (!Array.isArray(data)) {
    throw new Error("Uploads response was not a list.");
  }
  return data;
}

async function inspectFile(file: File, activeSourceType: string): Promise<MappingPreview> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "csv") {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    const detectedColumns = (lines[0] ?? "")
      .split(",")
      .map(col => col.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
      .slice(0, 12);
    return {
      sourceType: activeSourceType,
      fileName: file.name,
      rowCount: Math.max(lines.length - 1, 0),
      detectedColumns,
      mode: "CSV parsed locally. Rows are counted and columns are mapped for review.",
      parser: "csv",
      processingStatus: "Local preview",
      processingTone: "neutral",
    };
  }

  if (["xlsx", "xls"].includes(extension ?? "")) {
    return {
      sourceType: activeSourceType,
      fileName: file.name,
      rowCount: 0,
      detectedColumns: [],
      mode: "Excel will be parsed on the server for worksheet names, row count, and detected columns.",
      parser: "excel",
      processingStatus: "Local preview",
      processingTone: "neutral",
    };
  }

  return {
    sourceType: activeSourceType,
    fileName: file.name,
    rowCount: 0,
    detectedColumns: [],
    mode: extension === "pdf"
      ? "PDF text will be extracted on the server for preview and mapping."
      : "Image metadata will be stored. OCR is still future work unless an extractor is configured.",
    parser: extension === "pdf" ? "pdf" : "unsupported",
    processingStatus: "Local preview",
    processingTone: "neutral",
  };
}

function statusCopy(result: UploadResult) {
  const parserStatus = result.parsing?.status;
  if (result.status === "processed" && parserStatus === "parsed") {
    return {
      message: "File parsed and audit logged successfully.",
      processingStatus: "Parsed + audit logged",
      tone: "success" as const,
    };
  }
  if (result.status === "metadata_only") {
    return {
      message: "File captured and audit logged. Parsing needs CA review.",
      processingStatus: "Metadata captured + audit logged",
      tone: "warning" as const,
    };
  }
  return {
    message: "File captured and audit logged.",
    processingStatus: "Captured + audit logged",
    tone: "success" as const,
  };
}

function serverMode(result: UploadResult) {
  const parser = String(result.parsing?.parser ?? "file").toUpperCase();
  if (result.parsing?.status === "parsed") return `${parser} parsed server-side.`;
  if (result.parsing?.parser === "pdf") return "PDF metadata captured server-side. Text extraction needs review.";
  return "File metadata captured server-side. Parser extraction needs review.";
}

function messageClasses(tone: "success" | "warning" | "error") {
  if (tone === "success") return "bg-success/10 text-success border border-success/20";
  if (tone === "warning") return "bg-warning/10 text-warning border border-warning/20";
  return "bg-destructive/10 text-destructive border border-destructive/20";
}

function processingClasses(tone: MappingPreview["processingTone"]) {
  if (tone === "success") return "text-success";
  if (tone === "warning") return "text-warning";
  if (tone === "error") return "text-destructive";
  return "text-muted-foreground";
}

function previewKind(file: File): SelectedFilePreview["kind"] {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pdf" || file.type === "application/pdf") return "pdf";
  if (file.type.startsWith("image/") || ["png", "jpg", "jpeg"].includes(extension ?? "")) return "image";
  return "file";
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

function supportsInvoiceExtraction(source: string) {
  return ["invoice", "invoices"].includes(source);
}

function sourceLabel(source: string) {
  return SOURCE_TYPES.find(t => t.value === source)?.label || source;
}

function uploadFolderName(source: string) {
  return `${sourceLabel(source)} folder`;
}

export default function UploadsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [dragging, setDragging] = useState(false);
  const [sourceType, setSourceType] = useState("bank");
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "warning" | "error">("success");
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [selectedFilePreview, setSelectedFilePreview] = useState<SelectedFilePreview | null>(null);
  const [aiExtraction, setAiExtraction] = useState<AIExtractionResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiProgress, setAiProgress] = useState(0);
  const [aiStageIndex, setAiStageIndex] = useState(0);
  const [pendingAction, setPendingAction] = useState<ExtractionAction>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(() => new URLSearchParams(window.location.search).get("view") === "advanced");
  const fileRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const pendingSourceTypeRef = useRef(sourceType);
  // Session-scoped upload run ID — groups files uploaded in the same session.
  // Resets on new page load, or when the user explicitly starts a new session.
  const runIdRef = useRef<string>(crypto.randomUUID());
  const resetRunId = () => { runIdRef.current = crypto.randomUUID(); };

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  useEffect(() => {
    if (!aiLoading) return;
    setAiProgress(3);
    setAiStageIndex(0);
    const timer = window.setInterval(() => {
      setAiProgress(current => {
        const next = Math.min(current + Math.max(1, Math.round((96 - current) / 10)), 96);
        setAiStageIndex(Math.min(Math.floor(next / 20), EXTRACTION_STAGES.length - 1));
        return next;
      });
    }, 420);
    return () => window.clearInterval(timer);
  }, [aiLoading]);

  const { data = [], isLoading, isError, error, refetch } = useQuery<UploadBatch[], Error>({
    queryKey: ["uploads"],
    queryFn: () => fetch(`${BASE}/api/uploads`).then(readUploadBatches),
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, activeSourceType }: { file: File; activeSourceType: string }) => {
      const parsed = await inspectFile(file, activeSourceType);
      setPreview(parsed);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("sourceType", activeSourceType);
      fd.append("enableAiExtraction", "false");
      fd.append("runId", runIdRef.current);
      const res = await fetch(`${BASE}/api/uploads`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        let detail = "Please try again.";
        try {
          const payload = await res.json();
          detail = payload.detail || payload.error || detail;
        } catch {
          detail = res.statusText || detail;
        }
        throw new Error(detail);
      }
      const result = await res.json() as UploadResult;
      const copy = statusCopy(result);
      if (result.parsing) {
        setPreview({
          uploadId: result.id,
          sourceType: result.sourceType,
          fileName: result.fileName,
          rowCount: result.parsing.rowCount ?? 0,
          detectedColumns: result.parsing.detectedColumns ?? [],
          mode: serverMode(result),
          parser: result.parsing.parser,
          processingStatus: copy.processingStatus,
          processingTone: copy.tone,
          sheetNames: result.parsing.sheetNames,
          pageCount: result.parsing.pageCount,
          textPreview: result.parsing.textPreview,
          textLength: result.parsing.textLength,
          tablesDetected: result.parsing.tablesDetected,
          notes: result.parsing.notes,
          aiExtraction: result.aiExtraction,
          imported: result.imported ?? null,
          reconciliation: result.reconciliation ?? null,
        });
        setAiExtraction(result.aiExtraction ?? null);
      }
      return result;
    },
    onSuccess: result => {
      qc.invalidateQueries({ queryKey: ["uploads"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["ledger"] });
      qc.invalidateQueries({ queryKey: ["payroll"] });
      qc.invalidateQueries({ queryKey: ["gateway"] });
      qc.invalidateQueries({ queryKey: ["reconciliation"] });
      const copy = statusCopy(result);
      const importMessage = result.imported?.inserted
        ? ` Imported ${result.imported.inserted} rows into ${result.imported.table?.replace(/_/g, " ")}.`
        : "";
      const matchMessage = result.reconciliation?.matchesFound
        ? ` Found ${result.reconciliation.matchesFound} new rule-based matches.`
        : "";
      setMessage(`Uploaded successfully to ${uploadFolderName(result.sourceType)}. ${copy.message}${importMessage}${matchMessage}`);
      setMessageTone(copy.tone);
      setUploading(false);
      setTimeout(() => setMessage(""), copy.tone === "warning" ? 5000 : 3000);
    },
    onError: error => {
      setPreview(current => current ? {
        ...current,
        processingStatus: "Upload failed",
        processingTone: "error",
      } : current);
      const msg = error instanceof Error ? error.message : "Upload failed. Please try again.";
      setMessage(msg);
      setMessageTone("error");
      toast({
        title: "Upload rejected",
        description: msg,
        variant: "destructive",
      });
      setUploading(false);
    },
  });

  const PDF_BLOCKED_SOURCES = new Set(["bank", "tally", "zoho", "gst", "tds", "payroll", "gateway", "expenses"]);

  function preflightFile(file: File, activeSourceType: string): string | null {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if ((ext === "pdf" || file.type === "application/pdf") && PDF_BLOCKED_SOURCES.has(activeSourceType.toLowerCase())) {
      const label = SOURCE_TYPES.find(s => s.value === activeSourceType)?.label ?? activeSourceType;
      return `PDF not supported for ${label}. Export this file from your bank/portal as CSV or Excel and re-upload. Only invoice PDFs are accepted (via AI extraction).`;
    }
    return null;
  }

  const handleFile = (file: File, activeSourceType = sourceType) => {
    const reject = preflightFile(file, activeSourceType);
    if (reject) {
      setMessage(reject);
      setMessageTone("error");
      toast({ title: "Upload blocked — wrong format", description: reject, variant: "destructive" });
      return;
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setSelectedFilePreview({
      name: file.name,
      url,
      kind: previewKind(file),
    });
    setAiExtraction(null);
    setAiError("");
    setUploading(true);
    uploadMutation.mutate({ file, activeSourceType });
  };

  const handleFiles = (files: FileList | File[], activeSourceType = sourceType) => {
    const list = Array.from(files);
    list.forEach(file => handleFile(file, activeSourceType));
  };

  const selectSourceType = (nextSourceType: string) => {
    pendingSourceTypeRef.current = nextSourceType;
    setSourceType(nextSourceType);
    setPreview(null);
    setSelectedFilePreview(null);
    setAiExtraction(null);
    setAiError("");
  };

  const runAiExtraction = async () => {
    if (!preview?.uploadId) return;
    if (!supportsInvoiceExtraction(preview.sourceType)) {
      setAiError("Invoice extraction can only run on invoice uploads.");
      return;
    }
    setAiLoading(true);
    setAiProgress(0);
    setAiStageIndex(0);
    setAiError("");
    toast({ title: "AI extraction started", description: "Gemini is reading the parsed invoice text." });
    try {
      const res = await fetch(`${BASE}/api/ai/extract-invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: preview.uploadId }),
      });
      const result = await res.json() as AIExtractionResult & { error?: string };
      if (!res.ok) throw new Error(result.error || "AI extraction failed");
      setAiProgress(100);
      setAiExtraction(result);
      setPreview(current => current ? { ...current, aiExtraction: result } : current);
      toast({
        title: "AI extracted — pending review",
        description: `${extractionProviderLabel(result.provider)} returned ${Math.round(result.confidence * 100)}% confidence.`,
      });
    } catch (error) {
      setAiError(error instanceof Error ? error.message : "AI extraction failed");
      toast({ title: "AI extraction failed", description: "Rule-based extraction is available.", variant: "destructive" });
    } finally {
      window.setTimeout(() => setAiLoading(false), 450);
    }
  };

  const updateExtractionStatus = async (action: "accept" | "reject") => {
    if (!aiExtraction?.id) return;
    const previous = aiExtraction;
    const optimisticLabel = action === "accept" ? "Accepted for reconciliation" : "Rejected";
    setPendingAction(action);
    setAiError("");
    setAiExtraction(current => current ? {
      ...current,
      status: action === "accept" ? "accepted" : "rejected",
      reviewLabel: optimisticLabel,
    } : current);
    toast({
      title: optimisticLabel,
      description: action === "accept" ? "Saving reviewed invoice fields..." : "Rejecting pending extraction...",
    });
    try {
      const res = await fetch(`${BASE}/api/ai/extractions/${aiExtraction.id}/${action}`, {
        method: "POST",
      });
      const result = await res.json() as { error?: string; status?: string; label?: string };
      if (!res.ok) throw new Error(result.error || `Could not ${action} extraction`);
      setAiExtraction(current => current ? {
        ...current,
        status: result.status ?? action,
        reviewLabel: result.label ?? (action === "accept" ? "Accepted for reconciliation" : "Rejected"),
      } : current);
      setMessage(action === "accept" ? "Accepted for reconciliation." : "AI extraction rejected.");
      setMessageTone(action === "accept" ? "success" : "warning");
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["uploads"] });
    } catch (error) {
      setAiExtraction(previous);
      setAiError(error instanceof Error ? error.message : `Could not ${action} extraction`);
      toast({
        title: action === "accept" ? "Accept failed" : "Reject failed",
        description: error instanceof Error ? error.message : `Could not ${action} extraction`,
        variant: "destructive",
      });
    } finally {
      setPendingAction(null);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) {
      const files = Array.from(e.dataTransfer.files);
      files.forEach(f => handleFile(f, autoDetectSourceType(f.name)));
    }
  };

  const statusIcon = (status: string) => {
    if (status === "processed") return <CheckCircle className="w-4 h-4 text-success" />;
    if (status === "failed") return <AlertCircle className="w-4 h-4 text-destructive" />;
    if (status === "metadata_only") return <AlertCircle className="w-4 h-4 text-warning" />;
    return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
  };

  const visibleUploads = showAllHistory ? data : data.slice(0, 5);

  return (
    <PageTransition className="mx-auto max-w-6xl">
      <PageHeader title="Upload Center" subtitle="Upload any finance file — TallyThis detects the source type automatically" />

      {isError && (
        <div className="fv-card-flat mb-6 flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <div className="text-sm font-semibold text-foreground">Uploads could not be loaded</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {error.message || "Check that you are signed in and the API is reachable."}
              </div>
            </div>
          </div>
          <button type="button" onClick={() => refetch()} className="fv-button-secondary">
            Retry
          </button>
        </div>
      )}

      {/* ── PRIMARY UPLOAD ZONE ── */}
      <motion.div
        animate={{ scale: dragging ? 1.01 : 1 }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={`mb-6 cursor-pointer rounded-2xl border-2 border-dashed transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-muted/30"
        }`}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".csv,.xlsx,.xls,.pdf,.png,.jpg,.jpeg"
          className="hidden"
          onChange={e => {
            if (e.target.files?.length) {
              const files = Array.from(e.target.files);
              files.forEach(f => handleFile(f, autoDetectSourceType(f.name)));
            }
            e.currentTarget.value = "";
          }}
        />
        {selectedFilePreview ? (
          /* ── Post-upload state: show thumbnail left, "upload more" right ── */
          <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between">
            {/* Compact file thumbnail */}
            <div className="flex items-center gap-4">
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-border bg-background">
                {selectedFilePreview.kind === "pdf" ? (
                  <iframe
                    title={`Preview of ${selectedFilePreview.name}`}
                    src={`${selectedFilePreview.url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
                    className="h-full w-full border-0 bg-background"
                    style={{ pointerEvents: "none" }}
                  />
                ) : selectedFilePreview.kind === "image" ? (
                  <img
                    src={selectedFilePreview.url}
                    alt={`Preview of ${selectedFilePreview.name}`}
                    className="h-full w-full object-contain"
                    style={{ pointerEvents: "none" }}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-muted/40">
                    <FileText className="h-7 w-7 text-muted-foreground/60" />
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground" title={selectedFilePreview.name}>
                  {selectedFilePreview.name}
                </div>
                {uploading ? (
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    Detecting source type and parsing...
                  </div>
                ) : (
                  <div className="mt-1 text-xs text-success">Uploaded successfully</div>
                )}
              </div>
            </div>
            {/* Upload more */}
            <div className="flex shrink-0 flex-col items-center gap-3 text-center sm:items-end">
              <button
                type="button"
                className="fv-button-primary"
                onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}
              >
                <Plus className="h-4 w-4" />
                Upload Another File
              </button>
              <div className="text-xs text-muted-foreground">CSV · Excel · PDF · Image</div>
            </div>
          </div>
        ) : uploading ? (
          <div className="flex flex-col items-center gap-3 p-12">
            <Loader2 className="w-10 h-10 text-primary animate-spin" />
            <div className="text-sm text-muted-foreground">Detecting source type and parsing...</div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 px-8 py-12 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
              <Upload className="h-8 w-8 text-primary" />
            </div>
            <div>
              <div className="text-base font-semibold text-foreground">Drop any finance file here</div>
              <div className="mt-1.5 text-sm text-muted-foreground">
                TallyThis will automatically detect the source type — Bank Statement, Invoice, Tally Export, GST, Payroll, and more.
              </div>
              <div className="mt-1 text-xs text-muted-foreground">CSV · Excel · PDF · Image (JPG, PNG)</div>
            </div>
            <button type="button" className="fv-button-primary mt-1" onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}>
              <Plus className="w-4 h-4" />
              Upload File
            </button>
          </div>
        )}
      </motion.div>

      <ProcessingSteps kind="upload" active={uploading} title="Uploading and parsing..." />

      <CurrentUploadedFiles />

      <SmartNextStepPanel />

      {message && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className={`mb-4 px-4 py-3 rounded-lg text-sm font-medium ${messageClasses(messageTone)}`}
        >
          {message}
        </motion.div>
      )}

      {preview && !showAdvanced && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="fv-card-flat mb-6 p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">Just uploaded</div>
              <div className="mt-1 text-xs text-muted-foreground truncate" title={preview.fileName}>
                <span className="font-medium text-foreground">{preview.fileName}</span> · {sourceLabel(preview.sourceType)} · <span className={processingClasses(preview.processingTone)}>{preview.processingStatus}</span>
              </div>
            </div>
            <button type="button" onClick={() => setShowAdvanced(true)} className="fv-button-secondary">
              <Settings2 className="h-4 w-4" />
              Open Advanced Upload View
            </button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Parsed rows, extracted text, detected columns, AI extraction, and reprocess options are kept under Advanced. Use the Smart Next Step panel above to act on this file.
          </p>
        </motion.div>
      )}

      {preview && showAdvanced && (
        <div className="mb-2 flex items-center justify-end">
          <button type="button" onClick={() => setShowAdvanced(false)} className="fv-button-secondary">
            <ChevronUp className="h-4 w-4" />
            Hide Advanced Upload View
          </button>
        </div>
      )}

      {preview && showAdvanced && (
        <AdvancedUploadView
          preview={preview}
          aiExtraction={aiExtraction}
          aiLoading={aiLoading}
          aiError={aiError}
          aiProgress={aiProgress}
          aiStageIndex={aiStageIndex}
          pendingAction={pendingAction}
          onRunAi={runAiExtraction}
          onAcceptAi={() => updateExtractionStatus("accept")}
          onRejectAi={() => updateExtractionStatus("reject")}
          onAiExtractionUpdate={(next) => {
            setAiExtraction(next);
            setPreview(current => current ? { ...current, aiExtraction: next } : current);
            toast({ title: "Edits saved", description: "AI extraction updated — still pending review." });
          }}
          sourceLabel={sourceLabel}
          uploadFolderName={uploadFolderName}
          supportsInvoiceExtraction={supportsInvoiceExtraction}
        />
      )}


      <ActionHistory />

      <div className="fv-card-flat overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Upload History</div>
            <div className="text-xs text-muted-foreground mt-0.5">Immutable file audit trail. Workflow actions live above.</div>
          </div>
          <div className="text-xs text-muted-foreground">{data.length} files</div>
        </div>
        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Loading...</div>
        ) : data.length === 0 ? (
          <div className="p-8 text-center">
            <FileText className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
            <div className="text-sm text-muted-foreground">No files uploaded yet</div>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {visibleUploads.map(u => (
              <div key={u.id} className="px-5 py-3.5 flex items-center justify-between hover:bg-muted/20 transition-colors">
                <div className="flex items-center gap-3">
                  {statusIcon(u.status)}
                  <div>
                    <div className="text-sm font-medium">{u.fileName}</div>
                    <div className="text-xs text-muted-foreground">
                      {SOURCE_TYPES.find(t => t.value === u.sourceType)?.label || u.sourceType} - Uploaded {formatDateTime(u.uploadedAt)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {u.recordCount !== null && u.recordCount !== undefined && <span className="text-xs text-muted-foreground">{u.recordCount} rows</span>}
                  <StatusBadge status={u.status} />
                </div>
              </div>
            ))}
            {data.length > 5 && (
              <div className="px-5 py-4">
                <button type="button" onClick={() => setShowAllHistory(current => !current)} className="fv-button-secondary w-full justify-center">
                  {showAllHistory ? "Show latest 5 uploads" : "Show all upload history"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </PageTransition>
  );
}
