import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { CreditCard } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import StatusBadge from "@/components/app/StatusBadge";
import { formatCurrencyFull, formatDate } from "@/lib/format";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface GatewaySettlement {
  id: number;
  provider: string;
  settlementId: string;
  grossAmount: number;
  fees: number;
  gstOnFees?: number | null;
  netAmount: number;
  settlementDate: string;
  bankReference?: string | null;
  status: string;
  bankTransactionId?: number | null;
}

const PROVIDER_COLORS: Record<string, string> = {
  razorpay: "fv-status-review",
  stripe: "bg-primary/10 text-primary",
  paytm: "bg-warning/10 text-warning",
  phonepe: "fv-status-unverified",
};

export default function GatewaySettlementsPage() {
  const { data = [], isLoading } = useQuery<GatewaySettlement[]>({
    queryKey: ["gateway"],
    queryFn: () => fetch(`${BASE}/api/gateway-settlements`).then(r => r.json()),
  });

  const totalGross = data.reduce((s, e) => s + e.grossAmount, 0);
  const totalNet = data.reduce((s, e) => s + e.netAmount, 0);
  const totalFees = data.reduce((s, e) => s + e.fees, 0);
  const matched = data.filter(e => e.status === "matched").length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Gateway Settlements"
        subtitle={`${data.length} settlements · ${matched} matched to bank`}
      />

      {/* Summary */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: "Total Gross", val: formatCurrencyFull(totalGross) },
          { label: "Total Net", val: formatCurrencyFull(totalNet), highlight: true },
          { label: "Total Fees", val: formatCurrencyFull(totalFees) },
          { label: "Matched", val: `${matched} / ${data.length}` },
        ].map(s => (
          <div key={s.label} className="bg-card border border-border rounded-xl p-4">
            <div className={`text-lg font-bold ${s.highlight ? "text-success" : ""}`}>{s.val}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-card border border-border rounded-xl overflow-hidden"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Provider</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Settlement ID</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Gross</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Fees</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">GST on Fees</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Net</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Bank Ref</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center">
                    <CreditCard className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                    <div className="text-muted-foreground">No settlements found</div>
                  </td>
                </tr>
              ) : data.map(e => (
                <tr key={e.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold capitalize ${PROVIDER_COLORS[e.provider] || "bg-muted text-muted-foreground"}`}>
                      {e.provider}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{e.settlementId}</td>
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{formatDate(e.settlementDate)}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCurrencyFull(e.grossAmount)}</td>
                  <td className="px-4 py-3 text-right font-mono text-destructive">{formatCurrencyFull(e.fees)}</td>
                  <td className="px-4 py-3 text-right font-mono text-muted-foreground text-xs">
                    {e.gstOnFees ? formatCurrencyFull(e.gstOnFees) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-success">{formatCurrencyFull(e.netAmount)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{e.bankReference || "—"}</td>
                  <td className="px-4 py-3 text-center"><StatusBadge status={e.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}
