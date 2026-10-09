import { and, desc, eq, isNull } from "drizzle-orm";
import {
  aiExtractionsTable,
  auditLogsTable,
  bankTransactionsTable,
  caReviewItemsTable,
  db,
  documentsTable,
  exceptionsTable,
  gatewaySettlementsTable,
  gstRecordsTable,
  invoicesTable,
  ledgerEntriesTable,
  payrollEntriesTable,
  reconciliationMatchesTable,
  uploadBatchesTable,
} from "@workspace/db";

export type WorkflowRecipeId =
  | "BANK_TALLY_RECONCILIATION"
  | "BANK_INVOICE_RECONCILIATION"
  | "BANK_GATEWAY_RECONCILIATION"
  | "BANK_PAYROLL_RECONCILIATION"
  | "GST_TDS_REVIEW"
  | "EXPENSE_REVIEW"
  | "FULL_MONTH_CLOSE";

export type WorkflowActionId =
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

export type NormalizedSourceType =
  | "bank_statement"
  | "invoices"
  | "tally_export"
  | "zoho_export"
  | "gst_tds"
  | "payroll"
  | "gateway_settlement"
  | "expenses";

const SOURCE_LABELS: Record<NormalizedSourceType, string> = {
  bank_statement: "Bank Statement",
  invoices: "Invoices",
  tally_export: "Tally Export",
  zoho_export: "Zoho Export",
  gst_tds: "GST/TDS",
  payroll: "Payroll",
  gateway_settlement: "Gateway Settlement",
  expenses: "Expenses",
};

const RAW_SOURCE_MAP: Record<string, NormalizedSourceType> = {
  bank: "bank_statement",
  bank_statement: "bank_statement",
  bankstatement: "bank_statement",
  invoice: "invoices",
  invoices: "invoices",
  tally: "tally_export",
  tally_export: "tally_export",
  tallyexport: "tally_export",
  ledger: "tally_export",
  zoho: "zoho_export",
  zoho_export: "zoho_export",
  zohoexport: "zoho_export",
  gst: "gst_tds",
  tds: "gst_tds",
  gst_tds: "gst_tds",
  gsttds: "gst_tds",
  payroll: "payroll",
  gateway: "gateway_settlement",
  gateway_settlement: "gateway_settlement",
  gatewaysettlement: "gateway_settlement",
  expenses: "expenses",
  expense: "expenses",
};

const RECIPE_REQUIRED: Record<WorkflowRecipeId, NormalizedSourceType[]> = {
  BANK_TALLY_RECONCILIATION: ["bank_statement", "tally_export"],
  BANK_INVOICE_RECONCILIATION: ["bank_statement", "invoices"],
  BANK_GATEWAY_RECONCILIATION: ["bank_statement", "gateway_settlement"],
  BANK_PAYROLL_RECONCILIATION: ["bank_statement", "payroll"],
  GST_TDS_REVIEW: ["gst_tds"],
  EXPENSE_REVIEW: ["expenses"],
  FULL_MONTH_CLOSE: ["bank_statement"],
};

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel() {
  return new Date().toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

export function normalizeSourceType(sourceType: string): NormalizedSourceType | null {
  const key = sourceType.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return RAW_SOURCE_MAP[key] ?? null;
}

export function sourceLabel(sourceType: NormalizedSourceType) {
  return SOURCE_LABELS[sourceType];
}

function parsedRows(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return [];
  const rows = (metadata as Record<string, unknown>).parsedRows;
  return Array.isArray(rows) ? rows : [];
}

function metadataNumber(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== "object") return 0;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "number" ? value : 0;
}

function metadataArray(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== "object") return [];
  const value = (metadata as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function actionLabel(action: string) {
  const labels: Record<string, string> = {
    "upload.file_received": "Uploaded file",
    "upload.metadata_received": "Captured upload metadata",
    "upload.parsed": "Parsed upload",
    "upload.metadata_captured": "Captured upload metadata",
    "upload.rows_imported": "Imported parsed records",
    "upload.batch_import_completed": "Imported selected records",
    "reconciliation.run": "Ran reconciliation",
    "reconciliation.approved": "Approved reconciliation match",
    "reconciliation.rejected": "Rejected reconciliation match",
    "gst_tds_review.generate": "Generated GST/TDS review pack",
    "payroll.match": "Matched payroll payments",
    "gateway.match": "Matched gateway settlements",
    "report.ca_pack_export": "Exported CA-ready pack",
  };
  return labels[action] ?? action.replace(/[._]/g, " ").replace(/\b\w/g, char => char.toUpperCase());
}

export async function getActionHistory(companyId: number, limit = 20) {
  const logs = await db.select().from(auditLogsTable)
    .where(eq(auditLogsTable.companyId, companyId))
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(limit);

  return logs.map(log => {
    const metadata = (log.metadata ?? {}) as Record<string, unknown>;
    const fileName = typeof metadata.fileName === "string" ? metadata.fileName : null;
    const sourceType = typeof metadata.sourceType === "string" ? normalizeSourceType(metadata.sourceType) : null;
    const inserted = typeof metadata.inserted === "number" ? metadata.inserted : null;
    return {
      id: log.id,
      action: log.action,
      label: actionLabel(log.action),
      description: fileName
        ? `${fileName}${sourceType ? ` (${sourceLabel(sourceType)})` : ""}`
        : inserted !== null
          ? `${inserted} records affected`
          : log.entityType,
      actorEmail: log.actorEmail ?? "system",
      createdAt: log.createdAt.toISOString(),
      metadata,
    };
  });
}

function recipeText(id: WorkflowRecipeId) {
  const copy: Record<WorkflowRecipeId, { title: string; description: string; primary: string }> = {
    BANK_TALLY_RECONCILIATION: {
      title: "Compare Bank with Tally",
      description: "Compare imported bank transactions with Tally ledger entries.",
      primary: "Compare Bank with Tally",
    },
    BANK_INVOICE_RECONCILIATION: {
      title: "Reconcile Bank with Invoices",
      description: "Match bank payments against accepted invoice records.",
      primary: "Reconcile Bank with Invoices",
    },
    BANK_GATEWAY_RECONCILIATION: {
      title: "Match Gateway Settlements",
      description: "Match settlement credits and fees against bank records.",
      primary: "Match Gateway Settlements",
    },
    BANK_PAYROLL_RECONCILIATION: {
      title: "Match Payroll Payments",
      description: "Match salary payments against imported payroll records.",
      primary: "Match Payroll Payments",
    },
    GST_TDS_REVIEW: {
      title: "GST/TDS Review Pack",
      description: "Generate potential risk review items for GST/TDS records.",
      primary: "Generate GST/TDS Review Pack",
    },
    EXPENSE_REVIEW: {
      title: "Review Expenses",
      description: "Review expense uploads and flag missing receipts.",
      primary: "Review Expenses",
    },
    FULL_MONTH_CLOSE: {
      title: "Run Month Close Workflow",
      description: "Run the available imports, checks, exceptions, and CA-ready handoff.",
      primary: "Run Month Close Workflow",
    },
  };
  return copy[id];
}

function hasAll(set: Set<NormalizedSourceType>, required: NormalizedSourceType[]) {
  return required.every(source => set.has(source));
}

function importedForSource(source: NormalizedSourceType, counts: Record<string, number>) {
  if (source === "bank_statement") return counts.bankTransactions;
  if (source === "invoices") return counts.invoices;
  if (source === "tally_export" || source === "zoho_export") return counts.ledgerEntries;
  if (source === "gst_tds") return counts.gstRecords;
  if (source === "payroll") return counts.payrollEntries;
  if (source === "gateway_settlement") return counts.gatewaySettlements;
  return 0;
}

function actionForRecipe(input: {
  id: WorkflowRecipeId;
  parsedSet: Set<NormalizedSourceType>;
  importedSet: Set<NormalizedSourceType>;
  counts: Record<string, number>;
  pendingInvoiceExtractions: number;
  pendingInvoiceReviews: number;
}) {
  const { id, parsedSet, importedSet, counts, pendingInvoiceExtractions, pendingInvoiceReviews } = input;
  const required = RECIPE_REQUIRED[id];
  const uploadedEnough = hasAll(parsedSet, required);
  const importedEnough = hasAll(importedSet, required);
  const blockers: string[] = [];
  if (!uploadedEnough) {
    for (const source of required) {
      if (!parsedSet.has(source)) blockers.push(`${sourceLabel(source)} not uploaded or not parsed yet.`);
    }
  }

  if (id === "FULL_MONTH_CLOSE") {
    const hasComparisonSource = importedSet.has("invoices") || importedSet.has("tally_export") || importedSet.has("zoho_export");
    if (counts.bankTransactions > 0 && hasComparisonSource) {
      return { status: "ready_to_run" as const, action: { id: "run_month_close_workflow" as WorkflowActionId, label: "Run Month Close Workflow" }, blockers };
    }
    if (parsedSet.size > 0) {
      return { status: "ready_to_import" as const, action: { id: "import_all_available" as WorkflowActionId, label: "Import Available Records" }, blockers };
    }
    return { status: "blocked" as const, action: { id: "upload_files" as WorkflowActionId, label: "Upload Files" }, blockers };
  }

  if (!uploadedEnough) {
    return { status: "blocked" as const, action: { id: "upload_files" as WorkflowActionId, label: "Upload Missing Files" }, blockers };
  }

  if (!importedEnough && id === "BANK_INVOICE_RECONCILIATION" && pendingInvoiceExtractions > 0) {
    return { status: "ready_to_import" as const, action: { id: "run_ai_extraction" as WorkflowActionId, label: "Run AI Extraction for Invoices" }, blockers };
  }

  if (!importedEnough && id === "BANK_INVOICE_RECONCILIATION" && pendingInvoiceReviews > 0) {
    return { status: "ready_to_import" as const, action: { id: "review_invoice_extractions" as WorkflowActionId, label: "Review Invoice Extractions" }, blockers };
  }

  if (!importedEnough) {
    const importLabels: Record<WorkflowRecipeId, { id: WorkflowActionId; label: string }> = {
      BANK_TALLY_RECONCILIATION: { id: "import_bank_tally", label: "Import Bank + Tally Records" },
      BANK_INVOICE_RECONCILIATION: { id: "import_bank_invoices", label: "Import Bank + Invoice Records" },
      BANK_GATEWAY_RECONCILIATION: { id: "import_bank_gateway", label: "Import Bank + Gateway Records" },
      BANK_PAYROLL_RECONCILIATION: { id: "import_bank_payroll", label: "Import Bank + Payroll Records" },
      GST_TDS_REVIEW: { id: "import_gst_tds", label: "Import GST/TDS Data" },
      EXPENSE_REVIEW: { id: "import_expenses", label: "Import Expense Records" },
      FULL_MONTH_CLOSE: { id: "import_all_available", label: "Import Available Records" },
    };
    return { status: "ready_to_import" as const, action: importLabels[id], blockers };
  }

  const runLabels: Record<WorkflowRecipeId, { id: WorkflowActionId; label: string }> = {
    BANK_TALLY_RECONCILIATION: { id: "compare_bank_tally", label: "Compare Bank with Tally" },
    BANK_INVOICE_RECONCILIATION: { id: "reconcile_bank_invoices", label: "Run Bank to Invoice Reconciliation" },
    BANK_GATEWAY_RECONCILIATION: { id: "match_gateway_settlements", label: "Match Gateway Settlements" },
    BANK_PAYROLL_RECONCILIATION: { id: "match_payroll_payments", label: "Match Payroll Payments" },
    GST_TDS_REVIEW: { id: "generate_gst_tds_review", label: "Generate GST/TDS Review Pack" },
    EXPENSE_REVIEW: { id: "review_expenses", label: "Review Expenses" },
    FULL_MONTH_CLOSE: { id: "run_month_close_workflow", label: "Run Month Close Workflow" },
  };
  return { status: "ready_to_run" as const, action: runLabels[id], blockers };
}

export async function buildCurrentWorkflow(companyId: number) {
  const [uploads, docs, bankTxns, invoices, ledgerEntries, payrollEntries, gatewaySetts, gstRecs, aiExtractions, reconMatches, exceptions, caItems, actionHistory] =
    await Promise.all([
      db.select().from(uploadBatchesTable).where(eq(uploadBatchesTable.companyId, companyId)),
      db.select().from(documentsTable).where(and(eq(documentsTable.companyId, companyId), isNull(documentsTable.deletedAt))),
      db.select({ id: bankTransactionsTable.id }).from(bankTransactionsTable).where(eq(bankTransactionsTable.companyId, companyId)),
      db.select({ id: invoicesTable.id, status: invoicesTable.status }).from(invoicesTable).where(eq(invoicesTable.companyId, companyId)),
      db.select({ id: ledgerEntriesTable.id }).from(ledgerEntriesTable).where(eq(ledgerEntriesTable.companyId, companyId)),
      db.select({ id: payrollEntriesTable.id }).from(payrollEntriesTable).where(eq(payrollEntriesTable.companyId, companyId)),
      db.select({ id: gatewaySettlementsTable.id }).from(gatewaySettlementsTable).where(eq(gatewaySettlementsTable.companyId, companyId)),
      db.select({ id: gstRecordsTable.id }).from(gstRecordsTable).where(eq(gstRecordsTable.companyId, companyId)),
      db.select({ id: aiExtractionsTable.id, status: aiExtractionsTable.status, uploadId: aiExtractionsTable.uploadId }).from(aiExtractionsTable).where(eq(aiExtractionsTable.companyId, companyId)),
      db.select({ id: reconciliationMatchesTable.id }).from(reconciliationMatchesTable).where(eq(reconciliationMatchesTable.companyId, companyId)),
      db.select({ id: exceptionsTable.id, status: exceptionsTable.status, severity: exceptionsTable.severity }).from(exceptionsTable).where(eq(exceptionsTable.companyId, companyId)),
      db.select({ id: caReviewItemsTable.id, status: caReviewItemsTable.status }).from(caReviewItemsTable).where(eq(caReviewItemsTable.companyId, companyId)),
      getActionHistory(companyId, 8),
    ]);

  const activeUploads = uploads.filter(upload => upload.status !== "removed");
  const activeUploadIds = new Set(activeUploads.map(upload => upload.id));
  const activeDocs = docs.filter(doc => doc.status !== "removed" && (doc.uploadBatchId == null || activeUploadIds.has(doc.uploadBatchId)));
  const uploadedSet = new Set<NormalizedSourceType>();
  const parsedSet = new Set<NormalizedSourceType>();
  const sourceDetails = new Map<NormalizedSourceType, {
    files: number;
    rows: number;
    structuredRows: number;
    importedRows: number;
    status: "uploaded" | "parsed" | "imported" | "needs_review";
    columns: Set<string>;
    fileNames: string[];
    pdfPages: number;
    extractedTextLength: number;
    lastAction: string;
  }>();

  for (const upload of activeUploads) {
    const source = normalizeSourceType(upload.sourceType);
    if (!source) continue;
    uploadedSet.add(source);
    if (!sourceDetails.has(source)) {
      sourceDetails.set(source, {
        files: 0,
        rows: 0,
        structuredRows: 0,
        importedRows: 0,
        status: "uploaded",
        columns: new Set(),
        fileNames: [],
        pdfPages: 0,
        extractedTextLength: 0,
        lastAction: upload.status,
      });
    }
    const detail = sourceDetails.get(source)!;
    detail.files += 1;
    detail.rows += upload.recordCount ?? 0;
    detail.fileNames.push(upload.fileName);
    detail.lastAction = upload.status;
    if (upload.status === "processed" || upload.status === "batch_confirmed" || upload.status === "imported") {
      parsedSet.add(source);
      if (detail.status !== "imported") detail.status = "parsed";
    }
    if (upload.status === "batch_confirmed" || upload.status === "imported") detail.status = "imported";
  }

  const invoiceUploadIds = activeUploads.filter(u => {
    const source = normalizeSourceType(u.sourceType);
    return source === "invoices";
  }).map(u => u.id);
  const extractedUploadIds = new Set(aiExtractions.map(e => e.uploadId).filter(Boolean));
  let pendingInvoiceExtractions = 0;

  for (const doc of activeDocs) {
    const source = normalizeSourceType(doc.sourceType);
    if (!source) continue;
    parsedSet.add(source);
    const detail = sourceDetails.get(source);
    if (!detail) continue;
    const metadata = doc.detectedColumns ?? {};
    const rows = parsedRows(metadata);
    detail.structuredRows += rows.length;
    for (const column of metadataArray(metadata, "columns")) {
      if (typeof column === "string") detail.columns.add(column);
    }
    detail.pdfPages += metadataNumber(metadata, "pageCount");
    detail.extractedTextLength += metadataNumber(metadata, "textLength");
    if (doc.status === "parsed" && detail.status !== "imported") detail.status = "parsed";
    if (source === "invoices" && invoiceUploadIds.includes(doc.uploadBatchId ?? -1) && doc.extractedTextStatus === "text_extracted" && !extractedUploadIds.has(doc.uploadBatchId ?? -1)) {
      pendingInvoiceExtractions++;
      detail.status = "needs_review";
    }
  }

  const counts = {
    bankTransactions: bankTxns.length,
    invoices: invoices.length,
    ledgerEntries: ledgerEntries.length,
    gstRecords: gstRecs.length,
    payrollEntries: payrollEntries.length,
    gatewaySettlements: gatewaySetts.length,
    reconciliationMatches: reconMatches.length,
    openExceptions: exceptions.filter(e => e.status === "open").length,
    highOpenExceptions: exceptions.filter(e => e.status === "open" && e.severity === "high").length,
    caReviewItems: caItems.length,
    pendingCAItems: caItems.filter(i => i.status === "pending").length,
  };

  const importedSet = new Set<NormalizedSourceType>();
  if (counts.bankTransactions > 0) importedSet.add("bank_statement");
  if (counts.invoices > 0) importedSet.add("invoices");
  if (counts.ledgerEntries > 0) {
    if (uploadedSet.has("zoho_export") && !uploadedSet.has("tally_export")) importedSet.add("zoho_export");
    else importedSet.add("tally_export");
  }
  if (counts.gstRecords > 0) importedSet.add("gst_tds");
  if (counts.payrollEntries > 0) importedSet.add("payroll");
  if (counts.gatewaySettlements > 0) importedSet.add("gateway_settlement");

  for (const [source, detail] of sourceDetails) {
    detail.importedRows = importedForSource(source, counts);
    if (detail.importedRows > 0) detail.status = "imported";
  }

  const sourceSummary = Array.from(sourceDetails.entries()).map(([sourceType, detail]) => ({
    sourceType,
    label: sourceLabel(sourceType),
    status: detail.status,
    compactText: detail.importedRows > 0
      ? `${detail.importedRows} records imported`
      : detail.structuredRows > 0
        ? `${detail.structuredRows} rows parsed`
        : sourceType === "invoices" && pendingInvoiceExtractions > 0
          ? `${detail.files} files need extraction`
          : detail.rows > 0
            ? `${detail.rows} text lines parsed`
            : `${detail.files} file${detail.files === 1 ? "" : "s"} uploaded`,
    details: {
      files: detail.files,
      rows: detail.rows,
      structuredRows: detail.structuredRows,
      importedRows: detail.importedRows,
      columns: Array.from(detail.columns).slice(0, 12),
      fileNames: detail.fileNames.slice(0, 8),
      pdfPages: detail.pdfPages,
      extractedTextLength: detail.extractedTextLength,
      lastAction: detail.lastAction,
    },
  }));

  const pendingInvoiceReviews = aiExtractions.filter(e => e.status === "extracted_pending_review").length;
  const recipeIds: WorkflowRecipeId[] = [
    "BANK_TALLY_RECONCILIATION",
    "BANK_INVOICE_RECONCILIATION",
    "BANK_GATEWAY_RECONCILIATION",
    "BANK_PAYROLL_RECONCILIATION",
    "GST_TDS_REVIEW",
    "EXPENSE_REVIEW",
    "FULL_MONTH_CLOSE",
  ];
  const recipes = recipeIds.map(id => {
    const text = recipeText(id);
    const required = id === "FULL_MONTH_CLOSE"
      ? (uploadedSet.has("invoices") || uploadedSet.has("tally_export") || uploadedSet.has("zoho_export") ? ["bank_statement"] as NormalizedSourceType[] : ["bank_statement", "invoices"] as NormalizedSourceType[])
      : RECIPE_REQUIRED[id];
    const action = actionForRecipe({ id, parsedSet, importedSet, counts, pendingInvoiceExtractions, pendingInvoiceReviews });
    return {
      id,
      title: text.title,
      description: text.description,
      status: action.status,
      primaryAction: action.action,
      requiredSources: required,
      optionalSources: id === "FULL_MONTH_CLOSE" ? ["gst_tds", "payroll", "gateway_settlement", "expenses"] as NormalizedSourceType[] : [],
      blockers: action.blockers,
    };
  }).filter(recipe => recipe.status !== "blocked" || recipe.id === "FULL_MONTH_CLOSE" || recipe.requiredSources.some(source => uploadedSet.has(source)));

  const preferredOrder: WorkflowRecipeId[] = [
    "BANK_TALLY_RECONCILIATION",
    "BANK_INVOICE_RECONCILIATION",
    "BANK_GATEWAY_RECONCILIATION",
    "BANK_PAYROLL_RECONCILIATION",
    "GST_TDS_REVIEW",
    "EXPENSE_REVIEW",
    "FULL_MONTH_CLOSE",
  ];
  const recommendedRecipe = preferredOrder
    .map(id => recipes.find(recipe => recipe.id === id && recipe.status !== "blocked"))
    .find(Boolean) ?? recipes.find(recipe => recipe.status !== "blocked") ?? recipes[0];

  const recommendedAction = recommendedRecipe?.primaryAction ?? { id: "upload_files" as WorkflowActionId, label: "Upload Files" };
  const blockers = recommendedRecipe?.blockers ?? [];
  const pendingImportSources = sourceSummary.filter(source => source.details.structuredRows > 0 && source.details.importedRows === 0).length;

  let legacyStatus = "no_data";
  if (activeUploads.length === 0) legacyStatus = "no_data";
  else if (recommendedAction.id.startsWith("import")) legacyStatus = "files_uploaded";
  else if (recommendedAction.id === "run_ai_extraction") legacyStatus = "needs_invoice_extraction";
  else if (recommendedAction.id === "review_invoice_extractions") legacyStatus = "needs_invoice_review";
  else if (recommendedAction.id.includes("reconcile") || recommendedAction.id.includes("compare") || recommendedAction.id.includes("match")) legacyStatus = "ready_for_reconciliation";
  else if (counts.openExceptions > 0) legacyStatus = "needs_exception_review";
  else legacyStatus = "ca_ready";

  return {
    month: currentMonth(),
    monthLabel: monthLabel(),
    uploadedSources: Array.from(uploadedSet),
    parsedSources: Array.from(parsedSet),
    importedSources: Array.from(importedSet),
    availableRecipes: recipes,
    recommendedRecipeId: recommendedRecipe?.id ?? null,
    recommendedAction: {
      ...recommendedAction,
      description: recommendedRecipe?.description ?? "Upload files to start an upload-based monthly close workflow.",
      enabled: recommendedRecipe ? recommendedRecipe.status !== "blocked" : true,
    },
    sourceSummary,
    actionHistory,
    blockers,
    createdRecordCounts: counts,
    summary: {
      totalUploads: activeUploads.length,
      parsedUploads: activeUploads.filter(u => u.status === "processed" || u.status === "imported" || u.status === "batch_confirmed").length,
      importedUploads: activeUploads.filter(u => u.status === "imported" || u.status === "batch_confirmed").length,
      pendingImports: pendingImportSources,
      invoiceFiles: sourceDetails.get("invoices")?.files ?? 0,
      pendingInvoiceExtractions,
      pendingInvoiceReviews,
      ...counts,
    },
    status: legacyStatus,
    subtitle: recommendedRecipe
      ? recipeSpecificSubtitle(recommendedRecipe.id, parsedSet, importedSet)
      : "Upload any files you have. TallyThis will show matching options based on uploaded sources.",
    secondaryActions: secondaryActionsForRecommendation(recommendedRecipe?.id),
  };
}

function recipeSpecificSubtitle(recipeId: WorkflowRecipeId, parsedSet: Set<NormalizedSourceType>, importedSet: Set<NormalizedSourceType>) {
  if (recipeId === "BANK_TALLY_RECONCILIATION") {
    return importedSet.has("bank_statement") && importedSet.has("tally_export")
      ? "You imported bank and Tally records. You can now compare bank transactions with ledger entries."
      : "You uploaded a bank statement and Tally ledger export. Import both records, then compare bank transactions with ledger entries.";
  }
  if (recipeId === "BANK_INVOICE_RECONCILIATION") {
    return "You uploaded bank and invoice files. Extract/review invoice PDFs if needed, then reconcile payments.";
  }
  if (recipeId === "BANK_GATEWAY_RECONCILIATION") return "You uploaded gateway settlement and bank files. You can now match settlement credits.";
  if (recipeId === "BANK_PAYROLL_RECONCILIATION") return "You uploaded payroll and bank files. You can now match salary payments.";
  if (recipeId === "GST_TDS_REVIEW") return "GST/TDS review is available. Generate potential risk items for CA review.";
  if (recipeId === "EXPENSE_REVIEW") return "Expense review is available. Import expenses and request missing receipts when needed.";
  if (parsedSet.size > 0) return "You do not need every file. Run the available workflow for the sources uploaded.";
  return "Upload any files you have. TallyThis will show matching options based on uploaded sources.";
}

function secondaryActionsForRecommendation(recipeId?: WorkflowRecipeId | null) {
  if (recipeId === "BANK_TALLY_RECONCILIATION") {
    return [
      { id: "preview_records", label: "Preview records", href: "/app/uploads" },
      { id: "view_ledger_match", label: "View Ledger Match", href: "/app/ledger-match" },
    ];
  }
  if (recipeId === "BANK_INVOICE_RECONCILIATION") {
    return [
      { id: "review_invoices", label: "Review invoices", href: "/app/invoices" },
      { id: "view_reconciliation", label: "View Reconciliation", href: "/app/reconciliation" },
    ];
  }
  if (recipeId === "BANK_GATEWAY_RECONCILIATION") return [{ id: "view_gateway", label: "Open Gateway", href: "/app/gateway-settlements" }];
  if (recipeId === "BANK_PAYROLL_RECONCILIATION") return [{ id: "view_payroll", label: "Open Payroll", href: "/app/payroll" }];
  if (recipeId === "GST_TDS_REVIEW") return [{ id: "view_gst_tds", label: "Open GST/TDS Risks", href: "/app/gst-tds-risks" }];
  return [
    { id: "view_reconciliation", label: "View Reconciliation", href: "/app/reconciliation" },
    { id: "view_reports", label: "View Reports", href: "/app/reports" },
  ];
}
