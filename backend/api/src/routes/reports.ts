import { Router, type IRouter } from "express";
import PDFDocument from "pdfkit";
import { db } from "@workspace/db";
import {
  bankTransactionsTable,
  invoicesTable,
  riskFlagsTable,
  payrollEntriesTable,
  gatewaySettlementsTable,
  caReviewItemsTable,
  companiesTable,
  documentsTable,
  reconciliationMatchesTable,
} from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import {
  GetReportSummaryResponse,
  ExportReportCsvResponse,
  GetCaReviewItemsResponse,
  ProcessCaReviewItemParams,
  ProcessCaReviewItemBody,
  ProcessCaReviewItemResponse,
} from "@workspace/api-zod";
import { auditAction, getCompanyId, requirePermission } from "../middleware/authz";
import { retentionUntil, storeUploadedFile } from "../services/storage";

const router: IRouter = Router();

type CaPackData = {
  month: string;
  companyId: number;
  generatedAt: string;
  blockers: string[];
  summary: {
    verificationScore: number;
    totalTransactions: number;
    verifiedTransactions: number;
    openRisks: number;
    highRisks: number;
    reconciliationMatches: number;
    totalCAItems: number;
    pendingCAItems: number;
  };
  missingDocuments: { id: number; date: string; narration: string; amount: number; type: string }[];
  reconciliationReport: { id: number; matchType: string; confidenceScore: number | null; reason: string | null; status: string }[];
  gstTdsRisks: { id: number; category: string; severity: string; reason: string; suggestedAction: string | null }[];
  caReviewQueue: { id: number; title: string; severity: string; status: string; founderNote: string | null }[];
  disclaimer: string;
};

function buildCaPackPDF(pack: CaPackData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: false });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width - 100;
    const H1 = 16, H2 = 13, BODY = 10, SMALL = 8.5;
    const C_PRIMARY = "#143e2c";
    const C_MUTED = "#6b7280";
    const C_DANGER = "#dc2626";
    const C_SUCCESS = "#16a34a";
    const C_WARN = "#d97706";

    function rule(y?: number) {
      if (y) doc.y = y;
      doc.moveTo(50, doc.y).lineTo(50 + pageW, doc.y).strokeColor("#e5e7eb").lineWidth(0.5).stroke();
      doc.moveDown(0.3);
    }

    function sectionTitle(text: string) {
      doc.moveDown(0.8);
      doc.fontSize(H2).font("Helvetica-Bold").fillColor(C_PRIMARY).text(text);
      doc.moveDown(0.3);
    }

    function row(label: string, value: string, color?: string) {
      const startY = doc.y;
      doc.fontSize(BODY).font("Helvetica").fillColor(C_MUTED).text(label, 50, startY, { width: 180, continued: false });
      doc.fontSize(BODY).font("Helvetica-Bold").fillColor(color ?? "#111827").text(value, 240, startY, { width: pageW - 190 });
      doc.moveDown(0.3);
    }

    // ── Header ──
    doc.fontSize(H1 + 4).font("Helvetica-Bold").fillColor(C_PRIMARY).text("TallyThis", { align: "center" });
    doc.fontSize(H1).font("Helvetica").fillColor("#111827").text("CA-Ready Pack", { align: "center" });
    doc.fontSize(BODY).font("Helvetica").fillColor(C_MUTED).text(`${pack.month}  ·  Generated ${new Date(pack.generatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`, { align: "center" });
    doc.moveDown(1);
    rule();

    // ── Blockers ──
    if (pack.blockers.length > 0) {
      sectionTitle("⚠ Export Blockers");
      for (const b of pack.blockers) {
        doc.fontSize(BODY).font("Helvetica").fillColor(C_DANGER).text(`• ${b}`, { width: pageW });
        doc.moveDown(0.2);
      }
      rule();
    }

    // ── Verification Summary ──
    sectionTitle("Verification Summary");
    const s = pack.summary;
    const scoreColor = s.verificationScore >= 85 ? C_SUCCESS : s.verificationScore >= 60 ? C_WARN : C_DANGER;
    row("Verification Score", `${s.verificationScore} / 100`, scoreColor);
    row("Bank Transactions", `${s.verifiedTransactions} verified / ${s.totalTransactions} total`);
    row("Open Risk Flags", String(s.openRisks), s.highRisks > 0 ? C_DANGER : C_MUTED);
    row("High-Severity Risks", String(s.highRisks), s.highRisks > 0 ? C_DANGER : C_SUCCESS);
    row("Reconciliation Matches", String(s.reconciliationMatches));
    row("CA Review Items", `${s.pendingCAItems} pending / ${s.totalCAItems} total`, s.pendingCAItems > 0 ? C_WARN : C_MUTED);
    rule();

    // ── Reconciliation ──
    if (pack.reconciliationReport.length > 0) {
      sectionTitle(`Reconciliation Matches (top ${Math.min(pack.reconciliationReport.length, 30)})`);
      const shown = pack.reconciliationReport.slice(0, 30);
      for (const m of shown) {
        const conf = m.confidenceScore != null ? `${m.confidenceScore}%` : "—";
        const text = `#${m.id}  ${m.matchType}  Conf: ${conf}  ${m.status}${m.reason ? `  —  ${m.reason.slice(0, 60)}` : ""}`;
        doc.fontSize(SMALL).font("Courier").fillColor("#374151").text(text, { width: pageW });
        doc.moveDown(0.15);
      }
      if (pack.reconciliationReport.length > 30) {
        doc.fontSize(SMALL).font("Helvetica").fillColor(C_MUTED).text(`… and ${pack.reconciliationReport.length - 30} more matches`);
      }
      rule();
    }

    // ── GST / TDS Risks ──
    if (pack.gstTdsRisks.length > 0) {
      sectionTitle("GST / TDS Risk Flags");
      for (const r of pack.gstTdsRisks) {
        const sevColor = r.severity === "high" ? C_DANGER : r.severity === "medium" ? C_WARN : C_MUTED;
        doc.fontSize(BODY).font("Helvetica-Bold").fillColor(sevColor).text(`[${r.severity.toUpperCase()}] ${r.category}`, { width: pageW });
        doc.fontSize(SMALL).font("Helvetica").fillColor("#374151").text(`  Potential risk — needs CA review: ${r.reason}`, { width: pageW });
        if (r.suggestedAction) {
          doc.fontSize(SMALL).fillColor(C_MUTED).text(`  Suggested: ${r.suggestedAction}`, { width: pageW });
        }
        doc.moveDown(0.4);
      }
      rule();
    }

    // ── CA Review Queue ──
    if (pack.caReviewQueue.length > 0) {
      sectionTitle("CA Review Queue");
      for (const item of pack.caReviewQueue) {
        const sevColor = item.severity === "high" ? C_DANGER : item.severity === "medium" ? C_WARN : C_MUTED;
        doc.fontSize(BODY).font("Helvetica-Bold").fillColor(sevColor).text(`#${item.id}  ${item.title}`, { width: pageW });
        doc.fontSize(SMALL).font("Helvetica").fillColor(C_MUTED).text(`  Status: ${item.status}${item.founderNote ? `  ·  Note: ${item.founderNote.slice(0, 80)}` : ""}`, { width: pageW });
        doc.moveDown(0.35);
      }
      rule();
    }

    // ── Missing Documents ──
    if (pack.missingDocuments.length > 0) {
      sectionTitle(`Missing Documents (${pack.missingDocuments.length})`);
      for (const d of pack.missingDocuments.slice(0, 40)) {
        doc.fontSize(SMALL).font("Courier").fillColor("#374151")
          .text(`${d.date}  ₹${Number(d.amount).toLocaleString("en-IN")}  ${d.type.toUpperCase()}  ${d.narration.slice(0, 60)}`, { width: pageW });
        doc.moveDown(0.15);
      }
      if (pack.missingDocuments.length > 40) {
        doc.fontSize(SMALL).font("Helvetica").fillColor(C_MUTED).text(`… and ${pack.missingDocuments.length - 40} more`);
      }
      rule();
    }

    // ── Disclaimer ──
    doc.moveDown(0.5);
    doc.fontSize(SMALL).font("Helvetica").fillColor(C_MUTED)
      .text(pack.disclaimer, { width: pageW, align: "left" });

    doc.end();
  });
}

function toCsv(data: Record<string, unknown>[]): string {
  if (!data.length) return "";
  const headers = Object.keys(data[0]);
  const rows = data.map(row => headers.map(header => {
    const value = row[header];
    if (value === null || value === undefined) return "";
    const str = String(value);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }).join(","));
  return [headers.join(","), ...rows].join("\n");
}

router.get("/reports/summary", requirePermission("reports.read"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  const txns = await db.select().from(bankTransactionsTable).where(eq(bankTransactionsTable.companyId, companyId));
  const invoices = await db.select().from(invoicesTable).where(eq(invoicesTable.companyId, companyId));
  const risks = await db.select().from(riskFlagsTable).where(and(eq(riskFlagsTable.companyId, companyId), eq(riskFlagsTable.status, "open")));
  const payroll = await db.select().from(payrollEntriesTable).where(eq(payrollEntriesTable.companyId, companyId));
  const settlements = await db.select().from(gatewaySettlementsTable).where(eq(gatewaySettlementsTable.companyId, companyId));

  const verified = txns.filter(t => t.status === "verified").length;
  const score = txns.length > 0 ? Math.round((verified / txns.length) * 100) : 0;
  const caReady = score >= 85 ? "Ready for CA" : score >= 60 ? "Needs Review" : "Not Ready";
  const highRisks = risks.filter(r => r.severity === "high").length;
  const missingInvoices = txns.filter(t => t.status === "missing_invoice").length + invoices.filter(i => i.status === "unverified").length;
  const totalPayroll = payroll.reduce((sum, p) => sum + parseFloat(p.netAmount as string), 0);
  const totalGateway = settlements.reduce((sum, s) => sum + parseFloat(s.netAmount as string), 0);

  res.json(GetReportSummaryResponse.parse({
    companyName: company?.name ?? "Current workspace",
    month: new Date().toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" }),
    verificationScore: score,
    caReadyStatus: caReady,
    generatedAt: new Date().toISOString(),
    totalTransactions: txns.length,
    verifiedTransactions: verified,
    totalInvoices: invoices.length,
    missingInvoices,
    totalRisks: risks.length,
    highRisks,
    totalPayroll,
    totalGatewaySettlements: totalGateway,
  }));
});

router.get("/reports/export-csv", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const type = (req.query.type as string) || "transactions";
  const companyId = getCompanyId(req);
  let data: Record<string, unknown>[] = [];
  let rowCount = 0;

  if (type === "transactions") {
    const txns = await db.select().from(bankTransactionsTable).where(eq(bankTransactionsTable.companyId, companyId)).orderBy(desc(bankTransactionsTable.date));
    data = txns.map(t => ({
      id: t.id, date: t.date, narration: t.narration,
      amount: t.amount, type: t.type, source: t.source,
      status: t.status, confidenceScore: t.confidenceScore,
    }));
    rowCount = data.length;
  } else if (type === "risks") {
    const risks = await db.select().from(riskFlagsTable).where(eq(riskFlagsTable.companyId, companyId));
    data = risks.map(r => ({
      id: r.id, category: r.category, severity: r.severity,
      reason: r.reason, suggestedAction: r.suggestedAction, status: r.status,
    }));
    rowCount = data.length;
  } else if (type === "invoices") {
    const invs = await db.select().from(invoicesTable).where(eq(invoicesTable.companyId, companyId));
    data = invs.map(i => ({
      id: i.id, invoiceNumber: i.invoiceNumber, vendorName: i.vendorName,
      gstin: i.gstin, date: i.date, amount: i.amount, gstAmount: i.gstAmount,
      paymentStatus: i.paymentStatus, status: i.status,
    }));
    rowCount = data.length;
  } else if (type === "payroll") {
    const p = await db.select().from(payrollEntriesTable).where(eq(payrollEntriesTable.companyId, companyId));
    data = p.map(e => ({
      id: e.id, employeeName: e.employeeName, month: e.month,
      grossAmount: e.grossAmount, netAmount: e.netAmount,
      paymentDate: e.paymentDate, bankReference: e.bankReference, status: e.status,
    }));
    rowCount = data.length;
  } else if (type === "reconciliation") {
    const matches = await db.select().from(reconciliationMatchesTable).where(eq(reconciliationMatchesTable.companyId, companyId));
    data = matches.map(m => ({
      id: m.id,
      bankTransactionId: m.bankTransactionId,
      invoiceId: m.invoiceId,
      ledgerEntryId: m.ledgerEntryId,
      matchType: m.matchType,
      confidenceScore: m.confidenceScore,
      reason: m.reason,
      status: m.status,
    }));
    rowCount = data.length;
  } else if (type === "missing_invoices") {
    const txns = await db.select().from(bankTransactionsTable).where(and(eq(bankTransactionsTable.companyId, companyId), eq(bankTransactionsTable.status, "missing_invoice")));
    data = txns.map(t => ({
      id: t.id,
      date: t.date,
      narration: t.narration,
      amount: t.amount,
      type: t.type,
      reference: t.reference,
      status: t.status,
    }));
    rowCount = data.length;
  } else if (type === "ca_ready") {
    const txns = await db.select().from(bankTransactionsTable).where(and(eq(bankTransactionsTable.companyId, companyId), eq(bankTransactionsTable.status, "verified")));
    data = txns.map(t => ({
      id: t.id,
      date: t.date,
      narration: t.narration,
      amount: t.amount,
      type: t.type,
      confidenceScore: t.confidenceScore,
      status: t.status,
    }));
    rowCount = data.length;
  }

  let storedExport: null | {
    documentId: number;
    storageProvider: string;
    storageKey: string | null;
    checksumSha256: string | null;
    sizeBytes: number | null;
  } = null;

  if (req.query.store === "true") {
    const fileName = `${type}_report_${new Date().toISOString().slice(0, 10)}.csv`;
    const csv = toCsv(data);
    const file = {
      buffer: Buffer.from(csv, "utf8"),
      originalname: fileName,
      mimetype: "text/csv",
      size: Buffer.byteLength(csv, "utf8"),
    };
    const stored = await storeUploadedFile({ companyId, sourceType: "export", file });
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
    const [document] = await db.insert(documentsTable).values({
      companyId,
      uploadBatchId: null,
      fileName,
      sourceType: "export",
      mimeType: "text/csv",
      storageProvider: stored.provider,
      storageBucket: stored.bucket,
      storageRegion: stored.region,
      storageKey: stored.key,
      storageUrl: stored.url,
      sizeBytes: stored.sizeBytes,
      checksumSha256: stored.checksumSha256,
      status: "exported",
      extractedTextStatus: "not_required",
      rowCount,
      detectedColumns: { type, columns: data.length ? Object.keys(data[0]) : [] },
      uploadedByUserId: req.auth?.userId ?? null,
      retentionUntil: retentionUntil(company?.dataRetentionDays),
    }).returning();
    storedExport = {
      documentId: document.id,
      storageProvider: document.storageProvider,
      storageKey: document.storageKey,
      checksumSha256: document.checksumSha256,
      sizeBytes: document.sizeBytes,
    };
  }

  await auditAction(req, "report.exported", "report", null, { type, rowCount, stored: Boolean(storedExport) });
  const payload = ExportReportCsvResponse.parse({
    success: true,
    message: `Exported ${rowCount} ${type} records`,
    rowCount,
    data,
  });
  res.json({ ...payload, storedExport });
});

router.get("/ca-review", requirePermission("reports.read"), async (req, res): Promise<void> => {
  const items = await db.select().from(caReviewItemsTable).where(eq(caReviewItemsTable.companyId, getCompanyId(req))).orderBy(desc(caReviewItemsTable.createdAt));
  res.json(GetCaReviewItemsResponse.parse(
    items.map(i => ({
      id: i.id,
      entityType: i.entityType,
      entityId: i.entityId ?? null,
      title: i.title,
      description: i.description ?? null,
      severity: i.severity,
      status: i.status,
      founderNote: i.founderNote ?? null,
      caNote: i.caNote ?? null,
      createdAt: i.createdAt.toISOString(),
    }))
  ));
});

router.post("/reports/export-ca-pack", requirePermission("reports.export"), async (req, res): Promise<void> => {
  const companyId = getCompanyId(req);

  const [txns, invoices, risks, payroll, settlements, caItems, matches] = await Promise.all([
    db.select().from(bankTransactionsTable).where(eq(bankTransactionsTable.companyId, companyId)).orderBy(desc(bankTransactionsTable.date)),
    db.select().from(invoicesTable).where(eq(invoicesTable.companyId, companyId)).orderBy(desc(invoicesTable.date)),
    db.select().from(riskFlagsTable).where(and(eq(riskFlagsTable.companyId, companyId), eq(riskFlagsTable.status, "open"))).orderBy(desc(riskFlagsTable.createdAt)),
    db.select().from(payrollEntriesTable).where(eq(payrollEntriesTable.companyId, companyId)),
    db.select().from(gatewaySettlementsTable).where(eq(gatewaySettlementsTable.companyId, companyId)),
    db.select().from(caReviewItemsTable).where(eq(caReviewItemsTable.companyId, companyId)).orderBy(desc(caReviewItemsTable.createdAt)),
    db.select().from(reconciliationMatchesTable).where(eq(reconciliationMatchesTable.companyId, companyId)),
  ]);

  const blockers: string[] = [];
  const highRisks = risks.filter(r => r.severity === "high");
  const pendingCA = caItems.filter(i => i.status === "pending");

  if (matches.length === 0) blockers.push("Reconciliation has not been run yet. Run reconciliation before exporting.");
  if (highRisks.length > 0) blockers.push(`${highRisks.length} high-severity risk flag${highRisks.length > 1 ? "s" : ""} are unresolved.`);
  if (pendingCA.length > 0) blockers.push(`${pendingCA.length} CA review item${pendingCA.length > 1 ? "s" : ""} are still pending.`);

  const verified = txns.filter(t => t.status === "verified").length;
  const verificationScore = txns.length > 0 ? Math.round((verified / txns.length) * 100) : 0;
  const month = new Date().toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

  const pack = {
    generatedAt: new Date().toISOString(),
    month,
    companyId,
    blockers,
    canExport: blockers.length === 0,
    summary: {
      verificationScore,
      totalTransactions: txns.length,
      verifiedTransactions: verified,
      openRisks: risks.length,
      highRisks: highRisks.length,
      totalCAItems: caItems.length,
      pendingCAItems: pendingCA.length,
      reconciliationMatches: matches.length,
    },
    missingDocuments: txns
      .filter(t => t.status === "missing_invoice" || ((t.confidenceScore ?? 0) < 60 && t.type === "debit"))
      .map(t => ({ id: t.id, date: t.date, narration: t.narration, amount: parseFloat(t.amount as string), type: t.type }))
      .slice(0, 50),
    reconciliationReport: matches
      .map(m => ({ id: m.id, matchType: m.matchType, confidenceScore: m.confidenceScore, reason: m.reason, status: m.status }))
      .slice(0, 100),
    gstTdsRisks: risks.filter(r => r.category.toLowerCase().includes("gst") || r.category.toLowerCase().includes("tds"))
      .map(r => ({ id: r.id, category: r.category, severity: r.severity, reason: r.reason, suggestedAction: r.suggestedAction })),
    caReviewQueue: caItems.map(i => ({ id: i.id, title: i.title, severity: i.severity, status: i.status, founderNote: i.founderNote })),
    disclaimer: "This pack is for CA review. All AI extractions were human-reviewed before acceptance. Risk flags are indicative — Potential risk — needs CA review. This report does not constitute legal or tax advice.",
  };

  const wantsPdf = req.headers.accept?.includes("application/pdf") || req.query.format === "pdf";

  if (wantsPdf) {
    if (blockers.length > 0) {
      res.status(422).json({ blockers, canExport: false });
      return;
    }
    const pdfBuffer = await buildCaPackPDF({
      month,
      companyId,
      generatedAt: pack.generatedAt,
      blockers,
      summary: pack.summary,
      missingDocuments: pack.missingDocuments,
      reconciliationReport: pack.reconciliationReport,
      gstTdsRisks: pack.gstTdsRisks,
      caReviewQueue: pack.caReviewQueue,
      disclaimer: pack.disclaimer,
    });
    const monthSlug = month.toLowerCase().replace(/\s+/g, "-");
    await auditAction(req, "report.ca_pack_pdf_exported", "report", null, { month, verificationScore });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="finverify-ca-pack-${monthSlug}.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
    return;
  }

  await auditAction(req, "report.ca_pack_exported", "report", null, {
    month,
    verificationScore,
    blockers: blockers.length,
    canExport: pack.canExport,
  });

  res.json(pack);
});

router.post("/ca-review/:id/action", requirePermission("ca_review.process"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = ProcessCaReviewItemBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const actionToStatus: Record<string, string> = {
    approve: "approved",
    reject: "rejected",
    request: "document_requested",
    resolve: "resolved",
  };

  const newStatus = actionToStatus[parsed.data.action] ?? "pending";
  const updateData: Record<string, string | null> = { status: newStatus };
  if (parsed.data.note) updateData.caNote = parsed.data.note;

  const [item] = await db.update(caReviewItemsTable)
    .set(updateData as any)
    .where(and(eq(caReviewItemsTable.id, id), eq(caReviewItemsTable.companyId, getCompanyId(req))))
    .returning();

  if (!item) { res.status(404).json({ error: "Review item not found" }); return; }
  await auditAction(req, "ca_review.action", "ca_review", item.id, { action: parsed.data.action, status: item.status });

  res.json(ProcessCaReviewItemResponse.parse({
    id: item.id,
    entityType: item.entityType,
    entityId: item.entityId ?? null,
    title: item.title,
    description: item.description ?? null,
    severity: item.severity,
    status: item.status,
    founderNote: item.founderNote ?? null,
    caNote: item.caNote ?? null,
    createdAt: item.createdAt.toISOString(),
  }));
});

export default router;
