/**
 * AgentProgressPanel — polls /api/workflow/runs/:id/progress every 1.5s.
 * Shows staged 0-100% bar + per-step status chips.
 * Stops polling on completed | failed | cancelled.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, AlertCircle, Circle } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface RunStep {
  label: string;
  status: "pending" | "running" | "done" | "failed";
  percent: number;
}

interface RunProgress {
  runId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progressPercent: number;
  currentStep: string;
  steps: RunStep[];
}

interface Props {
  runId: string | null;
  onComplete?: (status: "completed" | "failed") => void;
  title?: string;
}

export default function AgentProgressPanel({ runId, onComplete, title }: Props) {
  const [completed, setCompleted] = useState(false);

  const { data, isLoading } = useQuery<RunProgress>({
    queryKey: ["workflow-run-progress", runId],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/workflow/runs/${runId}/progress`);
      if (!r.ok) throw new Error(`progress ${r.status}`);
      return r.json();
    },
    enabled: Boolean(runId) && !completed,
    refetchInterval: completed ? false : 1500,
    retry: 1,
  });

  useEffect(() => {
    if (!data) return;
    if (data.status === "completed" || data.status === "failed" || data.status === "cancelled") {
      if (!completed) {
        setCompleted(true);
        onComplete?.(data.status === "completed" ? "completed" : "failed");
      }
    }
  }, [data, completed, onComplete]);

  if (!runId) return null;

  const percent = data?.progressPercent ?? 0;
  const status = data?.status ?? "queued";
  const tone =
    status === "completed" ? "border-success/30 bg-success/5" :
    status === "failed" ? "border-destructive/30 bg-destructive/5" :
    "border-primary/30 bg-primary/5";

  return (
    <div className={`fv-card-flat overflow-hidden border ${tone}`}>
      <div className="px-5 py-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-sm font-semibold text-foreground">
              {title ?? "Workflow run"}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {isLoading ? "Connecting..." : data?.currentStep || status}
            </div>
          </div>
          <div className="text-right text-xs">
            <div className="font-bold text-foreground">{percent}%</div>
            <div className="mt-0.5 capitalize text-muted-foreground">{status.replace(/_/g, " ")}</div>
          </div>
        </div>

        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full transition-all duration-500 rounded-full ${
              status === "failed" ? "bg-destructive" :
              status === "completed" ? "bg-success" :
              "bg-primary"
            }`}
            style={{ width: `${Math.max(percent, 4)}%` }}
          />
        </div>

        {data?.steps && data.steps.length > 0 && (
          <div className="mt-4 grid gap-1.5 text-[11px]">
            {data.steps.map((step, i) => {
              const reached = percent >= step.percent;
              const isCurrent = step.label === data.currentStep && status === "running";
              const Icon =
                status === "failed" && i === data.steps.length - 1 ? AlertCircle :
                reached || step.status === "done" ? CheckCircle2 :
                isCurrent ? Loader2 :
                Circle;
              return (
                <div key={i} className={`flex items-center gap-2 ${reached ? "text-foreground" : "text-muted-foreground/70"}`}>
                  <Icon className={`h-3 w-3 shrink-0 ${isCurrent ? "animate-spin text-primary" : reached ? "text-success" : ""}`} />
                  <span className={isCurrent ? "font-semibold text-primary" : ""}>{step.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
