import { useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2, AlertCircle } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface HealthPayload {
  ok: boolean;
  goApi?: string;
  typeScriptFallback?: string;
  pythonWorker?: string;
  database?: string;
  // Legacy TypeScript API shape
  db?: string;
  r2?: string;
  ai?: { gemini?: string | boolean; openrouter?: string | boolean };
  // Go gateway shape
  aiProviders?: { gemini?: string };
  latencyMs?: Record<string, number>;
}

function statusLabel(value: string | boolean | undefined | null): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "ok" : "unavailable";
  return value;
}

function tone(value: string | boolean | undefined | null): string {
  const s = statusLabel(value);
  if (s === "ok" || s === "configured" || s === "true") return "text-success";
  if (s === "not-configured" || s === "—") return "text-muted-foreground";
  if (s === "unreachable" || s === "unavailable" || s === "missing" || s === "false") return "text-destructive";
  if (s.startsWith("error")) return "text-destructive";
  return "text-warning";
}

function Tile({ label, value, ms }: { label: string; value: string | boolean | undefined | null; ms?: number }) {
  const s = statusLabel(value);
  return (
    <div className="rounded-md border border-border bg-background px-2 py-1.5">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={`font-semibold text-xs ${tone(value)}`}>
        {s}{ms !== undefined && ms > 0 ? <span className="ml-1 font-normal text-muted-foreground">{ms}ms</span> : null}
      </div>
    </div>
  );
}

export default function HealthWidget() {
  const { data, isLoading, isError } = useQuery<HealthPayload>({
    queryKey: ["health"],
    queryFn: () => fetch(`${BASE}/api/health`).then(r => r.json()),
    refetchInterval: 60_000,
    retry: 1,
  });

  // Normalise: support both Go gateway shape and legacy TS shape
  const db = data?.database ?? data?.db;
  const gemini = data?.aiProviders?.gemini ?? data?.ai?.gemini;
  const openrouter = data?.ai?.openrouter;
  const r2 = data?.r2;
  const ms = data?.latencyMs ?? {};

  return (
    <div className="fv-card-flat p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Activity className="h-4 w-4 text-primary" />
          System Health
        </div>
        {isLoading ? (
          <span className="text-xs text-muted-foreground">Checking...</span>
        ) : isError || !data ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-destructive/25 bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
            <AlertCircle className="h-3 w-3" /> Unreachable
          </span>
        ) : data.ok ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
            <CheckCircle2 className="h-3 w-3" /> Healthy
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
            <AlertCircle className="h-3 w-3" /> Degraded
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Checking services...</div>
      ) : isError || !data ? (
        <div className="text-xs text-destructive">Health endpoint unreachable. Check that all services are running.</div>
      ) : (
        <div className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-3">
          <Tile label="Database" value={db} ms={ms["database"]} />
          <Tile label="Go Gateway" value={data.goApi ?? "ok"} />
          <Tile label="TypeScript API" value={data.typeScriptFallback} ms={ms["typescript"]} />
          <Tile label="Python Worker" value={data.pythonWorker} ms={ms["python"]} />
          <Tile label="Gemini AI" value={gemini ?? "not-configured"} />
          {r2 !== undefined && <Tile label="Storage (R2)" value={r2} />}
          {openrouter !== undefined && <Tile label="OpenRouter" value={openrouter} />}
        </div>
      )}
    </div>
  );
}
