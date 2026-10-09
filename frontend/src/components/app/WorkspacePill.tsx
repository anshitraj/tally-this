/**
 * WorkspacePill — shows currently-active workflow run (workspace folder).
 * Persists selection in localStorage so user stays in the same workspace
 * across navigation. Click → dropdown to switch runs.
 */
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, ChevronDown, Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useLocation } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const LS_KEY = "finverify.activeWorkspace";

interface WorkflowRun {
  id: string;
  title: string;
  run_type: string;
  status: string;
  created_at: string;
}

export function getActiveWorkspaceId(): string | null {
  try { return localStorage.getItem(LS_KEY); } catch { return null; }
}

export function setActiveWorkspaceId(id: string | null) {
  try {
    if (id) localStorage.setItem(LS_KEY, id);
    else localStorage.removeItem(LS_KEY);
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("workspace-changed", { detail: id }));
}

export default function WorkspacePill() {
  const [activeId, setActiveId] = useState<string | null>(getActiveWorkspaceId());
  const [, navigate] = useLocation();

  useEffect(() => {
    const onChange = (e: Event) => setActiveId((e as CustomEvent).detail);
    window.addEventListener("workspace-changed", onChange);
    return () => window.removeEventListener("workspace-changed", onChange);
  }, []);

  const { data: runs = [] } = useQuery<WorkflowRun[]>({
    queryKey: ["workflow-runs-all"],
    queryFn: () => fetch(`${BASE}/api/workflow/runs`).then(r => r.json()),
    refetchInterval: 30_000,
  });

  const active = runs.find(r => r.id === activeId);
  const label = active ? active.title : "No workspace";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="hidden items-center gap-1.5 rounded-xl border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/10 md:inline-flex"
          aria-label="Active workspace"
          title="Click to switch workspace"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="max-w-32 truncate">{label}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[20rem] rounded-2xl border-border bg-card p-2 shadow-[0_20px_60px_rgba(6,95,70,0.14)]">
        <div className="border-b border-border px-2 py-2">
          <div className="text-sm font-semibold text-foreground">Workspace folders</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Each generated report is a workspace. Data stays organised per folder.
          </div>
        </div>
        <div className="max-h-[20rem] overflow-y-auto py-1">
          <button
            type="button"
            onClick={() => setActiveWorkspaceId(null)}
            className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-muted ${!activeId ? "bg-primary/10 text-primary" : "text-foreground"}`}
          >
            <span>All workspaces (no filter)</span>
            {!activeId && <span className="text-[10px] font-bold uppercase text-primary">Active</span>}
          </button>
          {runs.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              No workspaces yet. Generate a reconciliation report to create one.
            </div>
          )}
          {runs.map(r => (
            <button
              key={r.id}
              type="button"
              onClick={() => setActiveWorkspaceId(r.id)}
              className={`flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-muted ${r.id === activeId ? "bg-primary/10 text-primary" : "text-foreground"}`}
            >
              <div className="min-w-0">
                <div className="truncate font-semibold">{r.title}</div>
                <div className="text-[10px] text-muted-foreground">{(r.run_type ?? "").replace(/_/g, " ")} · {r.status ?? ""}</div>
              </div>
              {r.id === activeId && <span className="text-[10px] font-bold uppercase text-primary">Active</span>}
            </button>
          ))}
        </div>
        <div className="border-t border-border px-2 pt-2">
          <button
            type="button"
            onClick={() => navigate("/app/uploads")}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-primary hover:bg-primary/10"
          >
            <Plus className="h-3.5 w-3.5" />
            Generate new report to create workspace
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
