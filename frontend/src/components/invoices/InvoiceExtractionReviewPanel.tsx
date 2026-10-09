import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, ChevronDown, ChevronUp, CheckCircle, XCircle, Edit3 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrencyFull } from "@/lib/format";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ExtractionData {
  invoiceNumber?: string | null;
  vendorName?: string | null;
  invoiceDate?: string | null;
  totalAmount?: number | null;
  gstAmount?: number | null;
  vendorGstin?: string | null;
  confidence?: number;
}

interface Extraction {
  id: number;
  uploadId: number | null;
  fileName: string | null;
  provider: string;
  model: string | null;
  confidence: number;
  status: string;
  label: string;
  data: ExtractionData | null;
  createdAt: string;
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const cls =
    pct >= 85
      ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
      : pct >= 65
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300"
        : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{pct}% conf</span>;
}

function ExtractionRow({
  extraction,
  onDone,
}: {
  extraction: Extraction;
  onDone: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<ExtractionData>>(extraction.data ?? {});
  const [saving, setSaving] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const { toast } = useToast();

  const d = extraction.data;

  const setField = (key: string, value: unknown) =>
    setEditData(prev => ({ ...prev, [key]: value }));

  async function handleSaveEdit() {
    setSaving(true);
    try {
      const r = await fetch(`${BASE}/api/ai/extractions/${extraction.id}/edit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: editData }),
      });
      if (!r.ok) throw new Error();
      toast({ title: "Extraction updated" });
      setIsEditing(false);
      onDone();
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleAccept() {
    setAccepting(true);
    try {
      const r = await fetch(`${BASE}/api/ai/extractions/${extraction.id}/accept`, { method: "POST" });
      if (!r.ok) {
        const err = (await r.json().catch(() => ({}))) as { missingFields?: string[] };
        toast({
          title: "Cannot accept",
          description: err.missingFields
            ? `Required fields missing: ${err.missingFields.join(", ")}. Edit first.`
            : "Edit extraction to fill required fields.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Accepted", description: "Invoice created and queued for reconciliation." });
      onDone();
    } finally {
      setAccepting(false);
    }
  }

  async function handleReject() {
    setRejecting(true);
    try {
      await fetch(`${BASE}/api/ai/extractions/${extraction.id}/reject`, { method: "POST" });
      toast({ title: "Extraction rejected" });
      onDone();
    } finally {
      setRejecting(false);
    }
  }

  const editFields: { key: keyof ExtractionData; label: string; type: "text" | "number" }[] = [
    { key: "invoiceNumber", label: "Invoice #", type: "text" },
    { key: "vendorName", label: "Vendor", type: "text" },
    { key: "invoiceDate", label: "Date (YYYY-MM-DD)", type: "text" },
    { key: "totalAmount", label: "Amount (₹)", type: "number" },
    { key: "gstAmount", label: "GST Amount (₹)", type: "number" },
    { key: "vendorGstin", label: "GSTIN", type: "text" },
  ];

  return (
    <div className="px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-2 mb-2">
            <span className="text-xs font-mono text-muted-foreground truncate max-w-[18rem]">
              {extraction.fileName ?? `Extraction #${extraction.id}`}
            </span>
            <ConfidenceBadge confidence={extraction.confidence} />
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
              AI extracted — pending review
            </span>
          </div>

          {!isEditing && d && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-x-6 gap-y-1.5 text-xs">
              <div>
                <span className="text-muted-foreground">Invoice# </span>
                <span className="font-mono font-semibold">{d.invoiceNumber || "—"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Vendor </span>
                <span className="font-medium">{d.vendorName || "—"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Date </span>
                <span>{d.invoiceDate || "—"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Amount </span>
                <span className="font-semibold">
                  {d.totalAmount != null ? formatCurrencyFull(d.totalAmount) : "—"}
                </span>
              </div>
              {d.gstAmount != null && (
                <div>
                  <span className="text-muted-foreground">GST </span>
                  <span>{formatCurrencyFull(d.gstAmount)}</span>
                </div>
              )}
              {d.vendorGstin && (
                <div>
                  <span className="text-muted-foreground">GSTIN </span>
                  <span className="font-mono">{d.vendorGstin}</span>
                </div>
              )}
            </div>
          )}

          {isEditing && (
            <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-3">
              {editFields.map(field => (
                <div key={field.key} className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">{field.label}</label>
                  <input
                    type={field.type}
                    value={String((editData as Record<string, unknown>)[field.key] ?? "")}
                    onChange={e =>
                      setField(
                        field.key,
                        field.type === "number"
                          ? e.target.value === ""
                            ? null
                            : Number(e.target.value)
                          : e.target.value,
                      )
                    }
                    className="fv-input text-xs py-1.5"
                  />
                </div>
              ))}
              <div className="col-span-full flex gap-2 mt-1">
                <button
                  onClick={() => setIsEditing(false)}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-muted/40 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveEdit}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </div>
          )}
        </div>

        {!isEditing && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setIsEditing(true)}
              className="p-1.5 rounded-lg hover:bg-muted/40 text-muted-foreground hover:text-foreground transition-colors"
              title="Edit extraction"
            >
              <Edit3 className="w-4 h-4" />
            </button>
            <button
              onClick={handleAccept}
              disabled={accepting || rejecting}
              className="flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white text-xs font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              <CheckCircle className="w-3.5 h-3.5" />
              {accepting ? "…" : "Accept"}
            </button>
            <button
              onClick={handleReject}
              disabled={accepting || rejecting}
              className="flex items-center gap-1 px-3 py-1.5 bg-red-500 text-white text-xs font-medium rounded-lg hover:bg-red-600 disabled:opacity-50 transition-colors"
            >
              <XCircle className="w-3.5 h-3.5" />
              {rejecting ? "…" : "Reject"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function InvoiceExtractionReviewPanel() {
  const [expanded, setExpanded] = useState(true);
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<{ count: number; extractions: Extraction[] }>({
    queryKey: ["invoices/extractions/pending"],
    queryFn: () =>
      fetch(`${BASE}/api/invoices/extractions/pending`).then(r => r.json()),
    staleTime: 10_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["invoices/extractions/pending"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["monthly-close-workflow"] });
  };

  async function bulkAction(action: "accept" | "reject") {
    const ids = (data?.extractions ?? []).map(e => e.id);
    if (!ids.length) return;
    try {
      await fetch(`${BASE}/api/invoices/extractions/bulk-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids }),
      });
      toast({
        title:
          action === "accept"
            ? `Accepted ${ids.length} extraction${ids.length > 1 ? "s" : ""}`
            : `Rejected ${ids.length} extraction${ids.length > 1 ? "s" : ""}`,
        description:
          action === "accept"
            ? "Invoices created and queued for reconciliation."
            : "Extractions dismissed.",
      });
      invalidate();
    } catch {
      toast({ title: "Bulk action failed", variant: "destructive" });
    }
  }

  const extractions = data?.extractions ?? [];
  const count = data?.count ?? 0;

  if (!isLoading && count === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-5 bg-card border border-amber-200 dark:border-amber-800 rounded-xl overflow-hidden"
    >
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-muted/20 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
            <span className="text-sm font-semibold text-foreground">
              AI Extractions — Pending Review
            </span>
            {!isLoading && (
              <span className="px-2 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 rounded-full text-xs font-medium">
                {count}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 ml-6">
            AI extracted — pending review. Accept, edit, or reject each before reconciliation. AI suggests — you approve.
          </p>
        </div>
        <div className="flex-shrink-0 ml-3">
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="panel-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            {extractions.length > 1 && (
              <div className="flex items-center gap-2 px-5 py-2.5 border-t border-b border-border bg-muted/20">
                <span className="text-xs text-muted-foreground">Bulk action:</span>
                <button
                  onClick={() => bulkAction("accept")}
                  className="px-3 py-1 bg-green-600 text-white text-xs font-medium rounded-lg hover:bg-green-700 transition-colors"
                >
                  Accept All
                </button>
                <button
                  onClick={() => bulkAction("reject")}
                  className="px-3 py-1 bg-red-500 text-white text-xs font-medium rounded-lg hover:bg-red-600 transition-colors"
                >
                  Reject All
                </button>
              </div>
            )}

            <div className="divide-y divide-border">
              {isLoading ? (
                <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                  Loading extractions…
                </div>
              ) : (
                extractions.map(ex => (
                  <ExtractionRow key={ex.id} extraction={ex} onDone={invalidate} />
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
