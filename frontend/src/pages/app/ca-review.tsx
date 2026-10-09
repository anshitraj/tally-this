import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { motion } from "framer-motion";
import { ClipboardList, CheckCircle, XCircle, FileQuestion, MessageSquare } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import StatusBadge from "@/components/app/StatusBadge";
import { severityColor } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface CaReviewItem {
  id: number;
  entityType: string;
  entityId?: number | null;
  title: string;
  description?: string | null;
  severity: string;
  status: string;
  founderNote?: string | null;
  caNote?: string | null;
  createdAt: string;
}

const ACTION_BUTTONS = [
  { action: "approve", label: "Approve", icon: CheckCircle, color: "bg-success/10 text-success hover:bg-success/20" },
  { action: "reject", label: "Reject", icon: XCircle, color: "bg-destructive/10 text-destructive hover:bg-destructive/20" },
  { action: "request", label: "Request Doc", icon: FileQuestion, color: "fv-status-review hover:opacity-85" },
  { action: "resolve", label: "Resolve", icon: CheckCircle, color: "bg-muted text-muted-foreground hover:bg-muted/80" },
];

export default function CaReviewPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [note, setNote] = useState("");

  const { data = [], isLoading } = useQuery<CaReviewItem[]>({
    queryKey: ["caReview"],
    queryFn: () => fetch(`${BASE}/api/ca-review`).then(r => r.json()),
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action, n }: { id: number; action: string; n?: string }) =>
      fetch(`${BASE}/api/ca-review/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: n }),
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["caReview"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      setNote("");
      setSelectedId(null);
      toast({ title: "Action applied", description: "Review item updated." });
    },
  });

  const filtered = statusFilter === "all" ? data : data.filter(i => i.status === statusFilter);
  const pending = data.filter(i => i.status === "pending").length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="CA Review Queue"
        subtitle={`${data.length} items · ${pending} pending CA action`}
      />

      {/* Filter tabs */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {["all", "pending", "approved", "rejected", "document_requested", "resolved"].map(f => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize ${
              statusFilter === f
                ? "fv-brand-accent-bg"
                : "bg-card border border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.replace(/_/g, " ")}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-muted-foreground text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-card border border-border rounded-xl py-16 text-center">
          <ClipboardList className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <div className="font-medium">No items in queue</div>
          <p className="text-sm text-muted-foreground mt-1">All items have been reviewed.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((item, i) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.03 * i }}
              className="bg-card border border-border rounded-xl overflow-hidden"
            >
              <div className="p-5">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <span className={`mt-0.5 flex-shrink-0 px-2 py-0.5 rounded text-xs font-semibold border ${severityColor(item.severity)} uppercase`}>
                      {item.severity}
                    </span>
                    <div>
                      <div className="font-semibold text-sm mb-0.5">{item.title}</div>
                      <div className="text-xs text-muted-foreground capitalize">
                        {item.entityType.replace(/_/g, " ")} {item.entityId ? `#${item.entityId}` : ""}
                      </div>
                    </div>
                  </div>
                  <StatusBadge status={item.status} />
                </div>

                {item.description && (
                  <p className="text-sm text-muted-foreground mb-3">{item.description}</p>
                )}

                <div className="flex flex-wrap gap-2 mt-0.5">
                  {item.founderNote && (
                    <div className="fv-status-missing flex items-start gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border max-w-full">
                      <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <span><strong>Founder:</strong> {item.founderNote}</span>
                    </div>
                  )}
                  {item.caNote && (
                    <div className="fv-status-review flex items-start gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border max-w-full">
                      <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <span><strong>CA:</strong> {item.caNote}</span>
                    </div>
                  )}
                </div>

                {/* Action buttons - only show for pending */}
                {item.status === "pending" && (
                  <div className="mt-4 pt-3 border-t border-border">
                    {selectedId === item.id ? (
                      <div className="space-y-2">
                        <textarea
                          value={note}
                          onChange={e => setNote(e.target.value)}
                          placeholder="Add a CA note (optional)…"
                          rows={2}
                          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                        />
                        <div className="flex gap-2 flex-wrap">
                          {ACTION_BUTTONS.map(btn => {
                            const Icon = btn.icon;
                            return (
                              <button
                                key={btn.action}
                                onClick={() => actionMutation.mutate({ id: item.id, action: btn.action, n: note || undefined })}
                                disabled={actionMutation.isPending}
                                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${btn.color}`}
                              >
                                <Icon className="w-3.5 h-3.5" />
                                {btn.label}
                              </button>
                            );
                          })}
                          <button
                            onClick={() => setSelectedId(null)}
                            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setSelectedId(item.id)}
                        className="text-xs text-primary font-medium hover:underline flex items-center gap-1"
                      >
                        <CheckCircle className="w-3.5 h-3.5" />
                        Take action
                      </button>
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
