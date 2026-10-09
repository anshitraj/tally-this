export function formatCurrency(amount: number): string {
  if (amount >= 10000000) {
    return `₹${(amount / 10000000).toFixed(1)}Cr`;
  }
  if (amount >= 100000) {
    return `₹${(amount / 100000).toFixed(1)}L`;
  }
  if (amount >= 1000) {
    return `₹${(amount / 1000).toFixed(1)}K`;
  }
  return `₹${amount.toLocaleString("en-IN")}`;
}

export function formatCurrencyFull(amount: number): string {
  return `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function statusColor(status: string): string {
  const verified = "fv-status-verified";
  const unverified = "fv-status-unverified";
  const missing = "fv-status-missing";
  const risk = "fv-status-risk";
  const review = "fv-status-review";
  const map: Record<string, string> = {
    verified,
    unverified,
    missing_invoice: missing,
    missing_gstin: missing,
    amount_mismatch: risk,
    date_mismatch: risk,
    gst_risk: risk,
    tds_risk: risk,
    payroll_mismatch: risk,
    gateway_settlement_mismatch: missing,
    needs_ca_review: review,
    ca_ready: verified,
    duplicate: missing,
    matched: verified,
    unmatched: missing,
    pending: review,
    approved: verified,
    rejected: risk,
    open: risk,
    potential_risk: risk,
    resolved: verified,
    partial: missing,
    paid: verified,
    unpaid: unverified,
    missing: missing,
    suspense: missing,
    fee_mismatch: missing,
    processed: verified,
    metadata_only: review,
    document_requested: review,
    none: verified,
    tds_review: risk,
  };
  return map[status] || unverified;
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    verified: "Verified",
    unverified: "Unverified",
    missing_invoice: "Missing Invoice",
    missing_gstin: "Missing GSTIN",
    amount_mismatch: "Amount Mismatch",
    date_mismatch: "Date Mismatch",
    gst_risk: "Potential GST Risk",
    tds_risk: "Potential TDS Risk",
    payroll_mismatch: "Payroll Mismatch",
    gateway_settlement_mismatch: "Gateway Settlement Mismatch",
    needs_ca_review: "Needs CA Review",
    ca_ready: "CA-ready",
    duplicate: "Duplicate",
    matched: "Matched",
    unmatched: "Unmatched",
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
    open: "Open",
    potential_risk: "Potential risk",
    resolved: "Resolved",
    partial: "Partial",
    paid: "Paid",
    unpaid: "Unpaid",
    missing: "Missing",
    suspense: "Suspense",
    fee_mismatch: "Fee Mismatch",
    processed: "Processed",
    batch_confirmed: "Imported",
    metadata_only: "Metadata only",
    needs_ai_extraction: "Needs AI extraction",
    needs_conversion: "Convert to CSV / Excel",
    removed: "Removed",
    partial_payment: "Partial Payment",
    exact: "Exact Match",
    potential: "Potential Match",
    document_requested: "Doc Requested",
    none: "No Risk",
    tds_review: "TDS Review",
  };
  return map[status] || status.replace(/_/g, " ");
}

export function severityColor(severity: string): string {
  const map: Record<string, string> = {
    high: "fv-status-risk",
    medium: "fv-status-missing",
    low: "fv-status-review",
  };
  return map[severity] || "fv-status-unverified";
}

export function confidenceColor(score: number): string {
  if (score >= 85) return "bg-success";
  if (score >= 60) return "bg-warning";
  return "bg-destructive";
}

export function exportToCsv(data: Record<string, unknown>[], filename: string): void {
  if (!data.length) return;
  const headers = Object.keys(data[0]);
  const rows = data.map(row =>
    headers.map(h => {
      const v = row[h];
      if (v === null || v === undefined) return "";
      const str = String(v);
      return str.includes(",") ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(",")
  );
  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
