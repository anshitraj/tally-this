import { statusColor, statusLabel } from "@/lib/format";

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export default function StatusBadge({ status, className = "" }: StatusBadgeProps) {
  const riskStatuses = new Set(["gst_risk", "tds_risk", "amount_mismatch", "date_mismatch", "payroll_mismatch", "gateway_settlement_mismatch", "tds_review", "potential_risk"]);
  const reviewStatuses = new Set(["needs_ca_review", "pending", "document_requested", "needs_ai_extraction", "needs_conversion", "metadata_only"]);
  const missingStatuses = new Set(["missing_invoice", "missing_gstin", "missing", "unmatched", "partial", "suspense", "fee_mismatch"]);
  const verifiedStatuses = new Set(["verified", "ca_ready", "matched", "approved", "resolved", "paid", "processed", "batch_confirmed", "none", "exact"]);

  const semanticClass = riskStatuses.has(status)
    ? "fv-status-risk"
    : reviewStatuses.has(status)
      ? "fv-status-review"
      : missingStatuses.has(status)
        ? "fv-status-missing"
        : verifiedStatuses.has(status)
          ? "fv-status-verified"
          : statusColor(status);

  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${semanticClass} ${className}`}
    >
      {statusLabel(status)}
    </span>
  );
}
