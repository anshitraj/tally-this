import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileSearch,
  GitCompareArrows,
  Loader2,
  Play,
  Sparkles,
  Table2,
  X,
} from "lucide-react";
import ProcessingSteps from "@/components/workflow/ProcessingSteps";
import AgentProgressPanel from "@/components/workflow/AgentProgressPanel";
import { APP_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type RecipeId =
  | "BANK_TALLY_RECONCILIATION"
  | "BANK_INVOICE_RECONCILIATION"
  | "BANK_GATEWAY_RECONCILIATION"
  | "BANK_PAYROLL_RECONCILIATION"
  | "GST_TDS_REVIEW"
  | "EXPENSE_REVIEW"
  | "FULL_MONTH_CLOSE";

type WorkflowActionId =
  | "upload_files"
  | "import_bank_tally"
  | "compare_bank_tally"
  | "open_ledger_match"
  | "import_bank_invoices"
  | "run_ai_extraction"
  | "review_invoice_extractions"
  | "reconcile_bank_invoices"
  | "import_bank_gateway"
  | "match_gateway_settlements"
  | "import_bank_payroll"
  | "match_payroll_payments"
  | "import_gst_tds"
  | "generate_gst_tds_review"
  | "import_expenses"
  | "review_expenses"
  | "import_all_available"
  | "run_month_close_workflow";

type SourceType =
  | "bank_statement"
  | "invoices"
  | "tally_export"
  | "zoho_export"
  | "gst_tds"
  | "payroll"
  | "gateway_settlement"
  | "expenses";

interface WorkflowAction {
  id: WorkflowActionId;
  label: string;
  description?: string;
  enabled?: boolean;
}

interface WorkflowRecipe {
  id: RecipeId;
  title: string;
  description: string;
  status: "ready_to_import" | "ready_to_run" | "blocked" | "completed";
  primaryAction: WorkflowAction;
  requiredSources: SourceType[];
  optionalSources: SourceType[];
  blockers: string[];
}

interface SourceSummary {
  sourceType: SourceType;
  label: string;
  status: "uploaded" | "parsed" | "imported" | "needs_review";
  compactText: string;
  details: {
    files: number;
    rows: number;
    structuredRows: number;
    importedRows: number;
    columns?: string[];
    fileNames?: string[];
    pdfPages?: number;
    extractedTextLength?: number;
    lastAction?: string;
  };
}

interface ActionHistoryItem {
  id: number;
  label: string;
  description: string;
  actorEmail: string;
  createdAt: string;
}

interface WorkflowResponse {
  month: string;
  monthLabel?: string;
  uploadedSources: SourceType[];
  parsedSources: SourceType[];
  importedSources: SourceType[];
  availableRecipes: WorkflowRecipe[];
  recommendedRecipeId: RecipeId | null;
  recommendedAction: WorkflowAction;
  sourceSummary: SourceSummary[];
  actionHistory: ActionHistoryItem[];
  blockers: string[];
  createdRecordCounts: Record<string, number>;
  subtitle?: string;
  secondaryActions?: Array<{ id: string; label: string; href?: string }>;
}

interface PreflightResponse {
  canRun: boolean;
  blockers: string[];
  warnings: string[];
  availableSources: SourceType[] | Record<string, number>;
  matchingOptions: Array<string | { id: string; label: string; enabled?: boolean; defaultChecked?: boolean }>;
  estimatedOutputPage: string;
  counts?: Record<string, number>;
}

const SOURCE_LABELS: Record<SourceType, string> = {
  bank_statement: "Bank Statement",
  invoices: "Invoices",
  tally_export: "Tally Export",
  zoho_export: "Zoho Export",
  gst_tds: "GST/TDS",
  payroll: "Payroll",
  gateway_settlement: "Gateway Settlement",
  expenses: "Expenses",
};

const RECIPE_IMPORT_SOURCES: Record<RecipeId, SourceType[]> = {
  BANK_TALLY_RECONCILIATION: ["bank_statement", "tally_export"],
  BANK_INVOICE_RECONCILIATION: ["bank_statement", "invoices"],
  BANK_GATEWAY_RECONCILIATION: ["bank_statement", "gateway_settlement"],
  BANK_PAYROLL_RECONCILIATION: ["bank_statement", "payroll"],
  GST_TDS_REVIEW: ["gst_tds"],
  EXPENSE_REVIEW: ["expenses"],
  FULL_MONTH_CLOSE: ["bank_statement", "invoices", "tally_export", "zoho_export", "gst_tds", "payroll", "gateway_settlement", "expenses"],
};

const RECIPE_TITLES: Record<RecipeId, string> = {
  BANK_TALLY_RECONCILIATION: "Ready to compare Bank and Tally",
  BANK_INVOICE_RECONCILIATION: "Ready to reconcile payments with invoices",
  BANK_GATEWAY_RECONCILIATION: "Ready to match gateway settlements",
  BANK_PAYROLL_RECONCILIATION: "Ready to match payroll payments",
  GST_TDS_REVIEW: "GST/TDS review available",
  EXPENSE_REVIEW: "Expense review available",
  FULL_MONTH_CLOSE: "Month close workflow available",
};

const SUCCESS_LINKS: Partial<Record<RecipeId, { label: string; href: string; message: string }>> = {
  BANK_TALLY_RECONCILIATION: { label: "Open Ledger Match", href: APP_ROUTES.ledgerMatch, message: "Ledger reconciliation report saved." },
  BANK_INVOICE_RECONCILIATION: { label: "Open Reconciliation", href: APP_ROUTES.reconciliation, message: "Reconciliation saved under the Reconciliation page." },
  BANK_GATEWAY_RECONCILIATION: { label: "Open Gateway Settlements", href: APP_ROUTES.gatewaySettlements, message: "Gateway settlement matching completed." },
  BANK_PAYROLL_RECONCILIATION: { label: "Open Payroll", href: APP_ROUTES.payroll, message: "Payroll matching completed." },
  GST_TDS_REVIEW: { label: "Open GST/TDS Risks", href: APP_ROUTES.gstTdsRisks, message: "GST/TDS review pack generated." },
  FULL_MONTH_CLOSE: { label: "Open Reconciliation", href: APP_ROUTES.reconciliation, message: "Month close workflow saved." },
};

function sourceLabel(source: SourceType) {
  return SOURCE_LABELS[source] ?? source;
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || `Request failed: ${response.status}`);
  }
  return payload as T;
}

function isImportAction(actionId: WorkflowActionId) {
  return actionId.startsWith("import_");
}

function isRunAction(actionId: WorkflowActionId) {
  return [
    "compare_bank_tally",
    "reconcile_bank_invoices",
    "match_gateway_settlements",
    "match_payroll_payments",
    "generate_gst_tds_review",
    "review_expenses",
    "run_month_close_workflow",
  ].includes(actionId);
}

function statusClass(status: SourceSummary["status"]) {
  if (status === "imported") return "fv-status-verified";
  if (status === "parsed") return "fv-status-review";
  if (status === "needs_review") return "fv-status-missing";
  return "rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground";
}

function matchingOptionLabel(option: PreflightResponse["matchingOptions"][number]) {
  return typeof option === "string" ? option : option.label;
}

function matchingOptionKey(option: PreflightResponse["matchingOptions"][number]) {
  return typeof option === "string" ? option : option.id;
}

function matchingOptionEnabled(option: PreflightResponse["matchingOptions"][number]) {
  return typeof option === "string" ? true : option.enabled !== false;
}

function importedCount(imported: number | Record<string, number> | undefined) {
  if (typeof imported === "number") return imported;
  if (!imported) return 0;
  return Object.values(imported).reduce((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
}

function defaultWorkflow(): WorkflowResponse {
  return {
    month: "",
    uploadedSources: [],
    parsedSources: [],
    importedSources: [],
    availableRecipes: [],
    recommendedRecipeId: null,
    recommendedAction: {
      id: "upload_files",
      label: "Upload Files",
      description: "Upload any finance files you have. You do not need every file to start.",
      enabled: true,
    },
    sourceSummary: [],
    actionHistory: [],
    blockers: [],
    createdRecordCounts: {},
    subtitle: "Upload any files you have. TallyThis will show matching options based on uploaded sources.",
  };
}

export default function SmartNextStepPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [expandedSource, setExpandedSource] = useState<SourceType | null>(null);
  const [modal, setModal] = useState<"import" | "run" | null>(null);
  const [activeRecipeId, setActiveRecipeId] = useState<RecipeId | null>(null);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [success, setSuccess] = useState<{ message: string; href?: string; label?: string } | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunTitle, setActiveRunTitle] = useState<string>("Workflow run");

  const { data: workflow = defaultWorkflow(), isLoading, isError, error, refetch } = useQuery<WorkflowResponse, Error>({
    queryKey: ["monthly-close-workflow"],
    queryFn: () => fetch(`${BASE}/api/monthly-close/current/workflow`).then(readJson<WorkflowResponse>),
  });

  const recommendedRecipe = workflow.availableRecipes.find(recipe => recipe.id === workflow.recommendedRecipeId) ?? workflow.availableRecipes[0] ?? null;
  const activeRecipe = workflow.availableRecipes.find(recipe => recipe.id === activeRecipeId) ?? recommendedRecipe;
  const title = recommendedRecipe ? RECIPE_TITLES[recommendedRecipe.id] : "Upload files to start";
  const action = workflow.recommendedAction;

  const importSources = useMemo(() => {
    if (!activeRecipe) return [] as SourceSummary[];
    const allowed = new Set(RECIPE_IMPORT_SOURCES[activeRecipe.id]);
    return workflow.sourceSummary.filter(source => allowed.has(source.sourceType) && source.details.importedRows === 0);
  }, [activeRecipe, workflow.sourceSummary]);

  const invalidateWorkflow = () => {
    qc.invalidateQueries({ queryKey: ["monthly-close-workflow"] });
    qc.invalidateQueries({ queryKey: ["action-history"] });
    qc.invalidateQueries({ queryKey: ["uploads"] });
    qc.invalidateQueries({ queryKey: ["reconciliation"] });
    qc.invalidateQueries({ queryKey: ["ledger"] });
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["payroll"] });
    qc.invalidateQueries({ queryKey: ["gateway"] });
  };

  const importMutation = useMutation({
    mutationFn: async (recipe: WorkflowRecipe) => {
      const sourceTypes = RECIPE_IMPORT_SOURCES[recipe.id].filter(source => workflow.parsedSources.includes(source));
      const endpoint = recipe.id === "FULL_MONTH_CLOSE" ? "/api/uploads/import-all-parsed" : "/api/uploads/import-selected-sources";
      return fetch(`${BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month: workflow.month, sourceTypes }),
      }).then(readJson<{
        ok: boolean;
        runId?: string;
        imported: number | Record<string, number>;
        skipped?: number;
        skippedAlreadyImported?: number;
        skippedNoStructuredRows?: number;
        skippedNoImportedRows?: number;
        pendingInvoiceExtractions?: number;
        errors?: string[];
        message?: string;
      }>);
    },
    onSuccess: result => {
      const totalImported = importedCount(result.imported);
      setModal(null);
      if (result.runId) {
        setActiveRunId(result.runId);
        setActiveRunTitle("Importing records");
      }
      if (totalImported === 0) {
        const msg = (result.skippedAlreadyImported ?? 0) > 0
          ? `${result.skippedAlreadyImported} selected upload${(result.skippedAlreadyImported ?? 0) === 1 ? " was" : "s were"} already imported, so TallyThis did not duplicate rows. Remove/re-upload or upload a new file set to create new imported records.`
          : "No structured rows could be imported. PDF/image uploads need CSV or Excel conversion (bank/tally/GST) or AI extraction (invoices). Re-upload as CSV/Excel, or open Advanced Upload View to inspect the parsed text.";
        setSuccess({ message: msg });
        toast({ title: "Nothing to import", description: msg, variant: "destructive" });
      } else {
        setSuccess({ message: result.message || `Imported ${totalImported} records.` });
        toast({ title: "Records imported", description: result.message || `${totalImported} records imported.` });
      }
      invalidateWorkflow();
    },
    onError: err => toast({ title: "Import failed", description: err instanceof Error ? err.message : "Could not import records.", variant: "destructive" }),
  });

  const preflightMutation = useMutation({
    mutationFn: async (recipeId: RecipeId) => fetch(`${BASE}/api/reconciliation/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipeId, month: workflow.month }),
    }).then(readJson<PreflightResponse>),
    onSuccess: result => setPreflight(result),
    onError: err => {
      setPreflight(null);
      toast({ title: "Preflight failed", description: err instanceof Error ? err.message : "Could not check available records.", variant: "destructive" });
    },
  });

  const [reportName, setReportName] = useState<string>("");
  const [suggestedName, setSuggestedName] = useState<string>("");

  const runMutation = useMutation({
    mutationFn: async (recipe: WorkflowRecipe) => {
      const name = reportName.trim() || suggestedName.trim() || undefined;
      if (recipe.id === "GST_TDS_REVIEW") {
        return fetch(`${BASE}/api/gst-tds-review/generate`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportName: name }),
        }).then(readJson<Record<string, unknown>>);
      }
      if (recipe.id === "BANK_PAYROLL_RECONCILIATION") {
        return fetch(`${BASE}/api/payroll/match`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportName: name }),
        }).then(readJson<Record<string, unknown>>);
      }
      if (recipe.id === "BANK_GATEWAY_RECONCILIATION") {
        return fetch(`${BASE}/api/gateway-settlements/match`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportName: name }),
        }).then(readJson<Record<string, unknown>>);
      }
      return fetch(`${BASE}/api/reconciliation/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipeId: recipe.id, month: workflow.month, reportName: name }),
      }).then(readJson<Record<string, unknown>>);
    },
    onSuccess: payload => {
      const recipe = activeRecipe;
      const link = recipe ? SUCCESS_LINKS[recipe.id] : null;
      const message = typeof payload.message === "string" ? payload.message : link?.message ?? "Workflow action completed.";
      setModal(null);
      const newRunId = typeof payload.runId === "string" ? payload.runId : null;
      if (newRunId) {
        setActiveRunId(newRunId);
        setActiveRunTitle(recipe ? RECIPE_TITLES[recipe.id] : "Workflow run");
      }
      setSuccess({ message: link?.message ?? message, href: link?.href, label: link?.label });
      toast({ title: link?.message ?? "Workflow action completed", description: message });
      invalidateWorkflow();
    },
    onError: err => toast({ title: "Action failed", description: err instanceof Error ? err.message : "Could not run workflow action.", variant: "destructive" }),
  });

  const aiMutation = useMutation({
    mutationFn: () => fetch(`${BASE}/api/invoices/extract-batch`, { method: "POST" }).then(readJson<{ processed: number; skipped: number; message: string }>),
    onSuccess: result => {
      setSuccess({ message: "Invoice extraction completed. Review results before using them.", href: APP_ROUTES.invoices, label: "Review Invoice Extractions" });
      toast({ title: "AI extracted — pending review", description: result.message });
      invalidateWorkflow();
    },
    onError: err => toast({ title: "Extraction failed", description: err instanceof Error ? err.message : "Could not run extraction.", variant: "destructive" }),
  });

  const isCsvAutoImport = (actionId: WorkflowActionId) =>
    actionId === "import_bank_tally" ||
    actionId === "import_bank_gateway" ||
    actionId === "import_bank_payroll" ||
    actionId === "import_gst_tds" ||
    actionId === "import_expenses" ||
    actionId === "import_all_available";

  const runTypeForRecipe = (id: RecipeId): string => ({
    BANK_TALLY_RECONCILIATION: "bank_tally_reconciliation",
    BANK_INVOICE_RECONCILIATION: "bank_invoice_reconciliation",
    BANK_GATEWAY_RECONCILIATION: "bank_gateway_reconciliation",
    BANK_PAYROLL_RECONCILIATION: "bank_payroll_reconciliation",
    GST_TDS_REVIEW: "gst_tds_review",
    EXPENSE_REVIEW: "report_export",
    FULL_MONTH_CLOSE: "full_month_close",
  })[id];

  const runImmediate = async (recipe: WorkflowRecipe) => {
    setPreflight(null);
    setReportName("");
    // Fetch suggested name from backend so user sees "{Recipe} #N"
    try {
      const suggestRes = await fetch(`${BASE}/api/workflow/runs/suggest-name?runType=${runTypeForRecipe(recipe.id)}`);
      const suggestData = await suggestRes.json() as { suggestedName: string };
      setSuggestedName(suggestData.suggestedName);
    } catch {
      setSuggestedName(RECIPE_TITLES[recipe.id]);
    }
    setModal("run");
    preflightMutation.mutate(recipe.id);
  };

  const openPrimaryAction = () => {
    if (!recommendedRecipe || !action.enabled) return;
    setActiveRecipeId(recommendedRecipe.id);
    setSuccess(null);
    if (isImportAction(action.id) && isCsvAutoImport(action.id)) {
      // CSV/Excel auto-imports on upload. Trigger backend catch-up silently, then go straight to compare/run.
      importMutation.mutateAsync(recommendedRecipe)
        .then(() => runImmediate(recommendedRecipe))
        .catch(() => runImmediate(recommendedRecipe));
      return;
    }
    if (isImportAction(action.id)) {
      setModal("import");
      return;
    }
    if (action.id === "run_ai_extraction") {
      aiMutation.mutate();
      return;
    }
    if (action.id === "review_invoice_extractions") {
      navigate(APP_ROUTES.invoices);
      return;
    }
    if (isRunAction(action.id)) {
      runImmediate(recommendedRecipe);
    }
  };

  const openRecipe = (recipe: WorkflowRecipe) => {
    setActiveRecipeId(recipe.id);
    setSuccess(null);
    if (recipe.status === "ready_to_import") {
      // Same auto-import-then-run shortcut for CSV recipes
      const importActionId = recipe.primaryAction?.id;
      if (importActionId && isCsvAutoImport(importActionId)) {
        importMutation.mutateAsync(recipe)
          .then(() => runImmediate(recipe))
          .catch(() => runImmediate(recipe));
        return;
      }
      setModal("import");
    } else {
      runImmediate(recipe);
    }
  };

  const confirmRun = () => {
    if (!activeRecipe) return;
    if (!preflight?.canRun) {
      toast({
        title: "Reconciliation blocked",
        description: preflight?.blockers.join(" ") || "Import the required records before generating a report.",
        variant: "destructive",
      });
      return;
    }
    runMutation.mutate(activeRecipe);
  };

  const confirmImport = () => {
    if (!activeRecipe) return;
    importMutation.mutate(activeRecipe);
  };

  if (isLoading) {
    return (
      <section className="fv-card-flat mb-6 p-5">
        <ProcessingSteps kind="upload" active title="Preparing next steps..." />
      </section>
    );
  }

  return (
    <section className="mb-6 space-y-5">
      <div className="fv-card-flat overflow-hidden">
        <div className="border-b border-border bg-card px-5 py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary">
                <Sparkles className="h-3.5 w-3.5" />
                Smart Next Step
              </div>
              <h2 className="text-lg font-bold text-foreground">{title}</h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                {workflow.subtitle ?? action.description ?? "TallyThis detects uploaded sources and shows only relevant actions."}
              </p>
            </div>
            <button type="button" onClick={openPrimaryAction} disabled={!action.enabled || aiMutation.isPending || importMutation.isPending} className="fv-button-primary self-start disabled:opacity-60">
              {aiMutation.isPending || importMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {aiMutation.isPending
                ? "Extracting..."
                : importMutation.isPending
                  ? "Auto-importing..."
                  : isCsvAutoImport(action.id) && recommendedRecipe
                    ? (RECIPE_TITLES[recommendedRecipe.id] ?? action.label).replace(/^Ready to /, "")
                    : action.label}
            </button>
          </div>
          {activeRunId && (
            <div className="mt-4">
              <AgentProgressPanel
                runId={activeRunId}
                title={activeRunTitle}
                onComplete={() => {
                  invalidateWorkflow();
                  setTimeout(() => setActiveRunId(null), 4000);
                }}
              />
            </div>
          )}
          {success && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-success/25 bg-success/5 px-4 py-3 text-sm text-success">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" />
                <span className="font-semibold">{success.message}</span>
              </div>
              {success.href && success.label && (
                <button type="button" onClick={() => navigate(success.href!)} className="rounded-lg border border-success/25 bg-background px-3 py-1.5 text-xs font-semibold text-success">
                  {success.label}
                </button>
              )}
            </div>
          )}
          {(workflow.blockers.length > 0 || isError) && (
            <div className="mt-4 rounded-xl border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  {isError ? (error?.message ?? "Workflow status is unavailable.") : workflow.blockers.join(" ")}
                  <button type="button" onClick={() => refetch()} className="ml-2 font-semibold underline">Retry</button>
                </div>
              </div>
            </div>
          )}
          {aiMutation.isPending && <ProcessingSteps kind="ai" active title="Running invoice extraction..." />}
        </div>

        <div className="grid gap-4 p-5 lg:grid-cols-[1fr_320px]">
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
              <GitCompareArrows className="h-4 w-4 text-primary" />
              Available workflows
            </div>
            <div className="grid gap-3">
              {workflow.availableRecipes.slice(0, 4).map(recipe => {
                const csvAuto = recipe.status === "ready_to_import" && isCsvAutoImport(recipe.primaryAction?.id ?? "upload_files");
                const displayStatus = csvAuto ? "ready_to_run" : recipe.status;
                return (
                  <button
                    key={recipe.id}
                    type="button"
                    onClick={() => openRecipe(recipe)}
                    disabled={recipe.status === "blocked"}
                    className={cn(
                      "rounded-xl border px-4 py-3 text-left transition",
                      recipe.id === workflow.recommendedRecipeId
                        ? "border-primary/30 bg-primary/5"
                        : "border-border bg-background hover:border-primary/30",
                      recipe.status === "blocked" && "opacity-60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-foreground">{recipe.title}</div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{recipe.description}</div>
                      </div>
                      <span className="shrink-0 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
                        {displayStatus.replace(/_/g, " ")}
                      </span>
                    </div>
                  </button>
                );
              })}
              {workflow.availableRecipes.length === 0 && (
                <div className="rounded-xl border border-border bg-background p-4 text-sm text-muted-foreground">
                  Upload any available finance file. The app will unlock matching options automatically.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-background p-4">
            <div className="mb-3 text-sm font-semibold text-foreground">What TallyThis detected</div>
            {Object.values(workflow.createdRecordCounts).some(v => v > 0) ? (
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["bankTransactions", "Bank Txns"],
                    ["invoices", "Invoices"],
                    ["ledgerEntries", "Ledger"],
                    ["gstRecords", "GST Records"],
                    ["payrollEntries", "Payroll"],
                    ["gatewaySettlements", "Settlements"],
                    ["reconciliationMatches", "Reconciled"],
                    ["openExceptions", "Exceptions"],
                    ["caReviewItems", "CA Review"],
                  ] as [string, string][]
                )
                  .filter(([key]) => (workflow.createdRecordCounts[key] ?? 0) > 0)
                  .map(([key, label]) => (
                    <div key={key} className="rounded-lg border border-border bg-card px-2.5 py-2">
                      <div className="text-[11px] text-muted-foreground">{label}</div>
                      <div className="text-sm font-bold text-foreground">{workflow.createdRecordCounts[key].toLocaleString()}</div>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">
                No records yet. Upload and import files — counts will appear here after import.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="fv-card-flat overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <div className="text-sm font-semibold">Uploaded Sources</div>
            <div className="mt-0.5 text-xs text-muted-foreground">Compact source summary. Details stay hidden until you open them.</div>
          </div>
          <Table2 className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">
          {workflow.sourceSummary.map(source => {
            const expanded = expandedSource === source.sourceType;
            return (
              <div key={source.sourceType} className="rounded-xl border border-border bg-background p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-foreground">{source.label}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{source.compactText}</div>
                  </div>
                  <span className={statusClass(source.status)}>{source.status.replace(/_/g, " ")}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setExpandedSource(expanded ? null : source.sourceType)}
                  className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary"
                >
                  {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {expanded ? "Show less" : "Show more"}
                </button>
                {expanded && (
                  <div className="mt-3 space-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
                    <div className="flex justify-between gap-3"><span>Files</span><span className="font-semibold text-foreground">{source.details.files}</span></div>
                    <div className="flex justify-between gap-3"><span>Parsed rows</span><span className="font-semibold text-foreground">{source.details.structuredRows || source.details.rows}</span></div>
                    <div className="flex justify-between gap-3"><span>Imported rows</span><span className="font-semibold text-foreground">{source.details.importedRows}</span></div>
                    <div className="flex justify-between gap-3"><span>Last action</span><span className="font-semibold text-foreground">{source.details.lastAction ?? source.status}</span></div>
                    {(source.details.pdfPages ?? 0) > 0 && <div className="flex justify-between gap-3"><span>PDF pages</span><span className="font-semibold text-foreground">{source.details.pdfPages}</span></div>}
                    {(source.details.extractedTextLength ?? 0) > 0 && <div className="flex justify-between gap-3"><span>Extracted text</span><span className="font-semibold text-foreground">{source.details.extractedTextLength} chars</span></div>}
                    {source.details.columns && source.details.columns.length > 0 && <div>Columns: {source.details.columns.join(", ")}</div>}
                    {source.details.fileNames && source.details.fileNames.length > 0 && (
                      <div>
                        <div className="mb-1 font-semibold text-foreground">Files</div>
                        <div className="space-y-1">{source.details.fileNames.map(file => <div key={file} className="truncate">{file}</div>)}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {workflow.sourceSummary.length === 0 && (
            <div className="rounded-xl border border-dashed border-border bg-background p-5 text-sm text-muted-foreground md:col-span-2 xl:col-span-3">
              No uploaded sources yet. Select a source type above and upload any file you have.
            </div>
          )}
        </div>
      </div>

      {modal && activeRecipe && (
        <div className="fv-content-modal-overlay">
          <div className="fv-modal-panel-lg overflow-y-auto p-5" style={{ maxHeight: "calc(100vh - 2rem)" }}>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <div className="text-base font-bold text-foreground">
                  {modal === "import" ? activeRecipe.primaryAction.label : activeRecipe.title}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {modal === "import"
                    ? "Confirm the parsed sources to import into financial tables for reconciliation."
                    : activeRecipe.id === "GST_TDS_REVIEW"
                      ? "This generates a GST/TDS review pack. It is not called reconciliation."
                      : "Choose the comparison and generate a rules-first reconciliation report."}
                </p>
              </div>
              <button type="button" onClick={() => setModal(null)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>

            {modal === "import" ? (
              <>
                <ProcessingSteps kind="import" active={importMutation.isPending} title="Importing records..." />
                <div className="mb-3 rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs text-foreground">
                  Are you sure? The following parsed sources will be imported into financial tables. Confirm the file list before proceeding.
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(importSources.length > 0 ? importSources : workflow.sourceSummary.filter(source => RECIPE_IMPORT_SOURCES[activeRecipe.id].includes(source.sourceType))).map(source => (
                    <div key={source.sourceType} className="rounded-xl border border-border bg-background p-4">
                      <div className="text-sm font-semibold text-foreground">{source.label}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{source.compactText}</div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        {source.details.files} file{source.details.files === 1 ? "" : "s"} · {source.details.structuredRows || source.details.rows} parsed rows
                      </div>
                      {source.details.fileNames && source.details.fileNames.length > 0 && (
                        <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
                          {source.details.fileNames.slice(0, 5).map(name => (
                            <li key={name} className="truncate" title={name}>· {name}</li>
                          ))}
                          {source.details.fileNames.length > 5 && (
                            <li>+{source.details.fileNames.length - 5} more</li>
                          )}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-5 flex justify-end gap-3">
                  <button type="button" onClick={() => setModal(null)} className="fv-button-secondary">Cancel</button>
                  <button type="button" onClick={confirmImport} disabled={importMutation.isPending} className="fv-button-primary">
                    {importMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                    Import Records
                  </button>
                </div>
              </>
            ) : (
              <>
                <ProcessingSteps kind="reconciliation" active={preflightMutation.isPending || runMutation.isPending} title={runMutation.isPending ? "Saving report..." : "Checking preflight..."} />
                {preflight && (
                  <div className="space-y-4">
                    {preflight.blockers.length > 0 && (
                      <div className="rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm text-destructive">
                        <div className="flex items-start gap-2">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          <div>
                            <div className="font-semibold text-foreground">This report cannot be generated yet</div>
                            <div className="mt-1 leading-5">{preflight.blockers.join(" ")}</div>
                          </div>
                        </div>
                      </div>
                    )}
                    {preflight.warnings.length > 0 && (
                      <div className="rounded-xl border border-border bg-background p-4 text-sm text-muted-foreground">
                        {preflight.warnings.join(" ")}
                      </div>
                    )}
                    <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                      <div className="mb-2 text-sm font-semibold text-foreground">
                        {activeRecipe.id === "GST_TDS_REVIEW"
                          ? "Generate GST/TDS Review Pack — TallyThis will use:"
                          : "Are you sure? TallyThis will use:"}
                      </div>
                      <ul className="space-y-1.5 text-xs text-foreground">
                        {workflow.sourceSummary
                          .filter(s => RECIPE_IMPORT_SOURCES[activeRecipe.id].includes(s.sourceType))
                          .map(s => {
                            const importedRows = s.details.importedRows ?? 0;
                            const noImportable = importedRows === 0;
                            return (
                              <li key={s.sourceType} className={cn(
                                "rounded-md bg-background px-3 py-2 border",
                                noImportable ? "border-warning/40" : "border-border",
                              )}>
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="font-semibold">{s.label}</div>
                                    <div className="text-muted-foreground">
                                      {s.details.files} file{s.details.files === 1 ? "" : "s"} -{" "}
                                      <span className={noImportable ? "text-warning font-semibold" : ""}>
                                        {importedRows} importable rows
                                      </span>
                                      {" "}- {s.status.replace(/_/g, " ")}
                                    </div>
                                    {s.details.fileNames && s.details.fileNames.length > 0 && (
                                      <div className="mt-1 text-[11px] text-muted-foreground truncate" title={s.details.fileNames.join(", ")}>
                                        {s.details.fileNames.slice(0, 3).join(", ")}{s.details.fileNames.length > 3 ? ` +${s.details.fileNames.length - 3} more` : ""}
                                      </div>
                                    )}
                                    {noImportable && (
                                      <div className="mt-1 text-[11px] text-warning">
                                        0 records in {s.label.toLowerCase()} table. Import parsed rows first; older uploads may need remove/re-upload.
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                      </ul>
                      <p className="mt-3 text-[11px] text-muted-foreground">
                        {activeRecipe.id === "GST_TDS_REVIEW"
                          ? "GST/TDS results are labelled Potential risk - needs CA review. TallyThis does not certify GST/TDS compliance."
                          : "TallyThis only suggests matches. CA reviews every suggested match (Correct / Wrong / Needs more info) before the final CA-ready report."}
                      </p>
                    </div>
                    <div className="rounded-xl border border-primary/30 bg-background p-4">
                      <label className="block">
                        <div className="mb-1.5 text-sm font-semibold text-foreground">Report name (workspace folder)</div>
                        <div className="mb-2 text-[11px] text-muted-foreground">
                          Saved as a named workspace under Reconciliation. Pick anything: "May Bank-Tally", "Webcoin Q1 Review", etc.
                        </div>
                        <input
                          type="text"
                          value={reportName}
                          onChange={e => setReportName(e.target.value)}
                          placeholder={suggestedName || "Report name..."}
                          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
                        />
                        <div className="mt-1.5 text-[11px] text-muted-foreground">
                          Leave blank to use <span className="font-mono text-foreground">{suggestedName || "auto-suggested name"}</span>
                        </div>
                      </label>
                    </div>
                    <div className="rounded-xl border border-border bg-background p-4">
                      <div className="mb-3 text-sm font-semibold text-foreground">Matching options</div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {preflight.matchingOptions.map(option => (
                          <label key={matchingOptionKey(option)} className={cn(
                            "flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium",
                            matchingOptionEnabled(option) ? "text-foreground" : "text-muted-foreground opacity-70",
                          )}>
                            <input type="checkbox" checked={matchingOptionEnabled(option)} readOnly className="accent-primary" />
                            {matchingOptionLabel(option)}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="flex justify-end gap-3">
                      <button type="button" onClick={() => setModal(null)} className="fv-button-secondary">Cancel</button>
                      <button
                        type="button"
                        onClick={confirmRun}
                        disabled={!preflight.canRun || runMutation.isPending}
                        title={!preflight.canRun ? "Import the required records before generating a report." : undefined}
                        className={cn(
                          preflight.canRun
                            ? "fv-button-primary"
                            : "inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-muted px-4 py-2 text-sm font-semibold text-muted-foreground",
                          "disabled:cursor-not-allowed disabled:opacity-100",
                        )}
                      >
                        {runMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSearch className="h-4 w-4" />}
                        {!preflight.canRun
                          ? "Resolve blockers first"
                          : activeRecipe.id === "GST_TDS_REVIEW"
                            ? "Generate Review Pack"
                            : "Generate Reconciliation Report"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
