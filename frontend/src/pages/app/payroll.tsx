import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Users } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import StatusBadge from "@/components/app/StatusBadge";
import { formatCurrencyFull, formatDate } from "@/lib/format";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface PayrollEntry {
  id: number;
  employeeName: string;
  month: string;
  grossAmount?: number | null;
  netAmount: number;
  paymentDate?: string | null;
  bankReference?: string | null;
  status: string;
}

export default function PayrollPage() {
  const { data = [], isLoading } = useQuery<PayrollEntry[]>({
    queryKey: ["payroll"],
    queryFn: () => fetch(`${BASE}/api/payroll`).then(r => r.json()),
  });

  const totalNet = data.reduce((s, e) => s + e.netAmount, 0);
  const totalGross = data.reduce((s, e) => s + (e.grossAmount || 0), 0);
  const verified = data.filter(e => e.status === "verified").length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Payroll Register"
        subtitle={`${data.length} employees · ${verified} verified`}
      />

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: "Total Gross", val: formatCurrencyFull(totalGross), color: "text-foreground" },
          { label: "Total Net Pay", val: formatCurrencyFull(totalNet), color: "text-success" },
          { label: "Verified", val: `${verified} / ${data.length}`, color: "text-primary" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-border rounded-xl p-4">
            <div className={`text-xl font-bold ${s.color}`}>{s.val}</div>
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
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Employee</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Month</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Gross</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Net Pay</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Payment Date</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Bank Ref</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <Users className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                    <div className="text-muted-foreground">No payroll entries</div>
                  </td>
                </tr>
              ) : data.map(e => (
                <tr key={e.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 font-medium">{e.employeeName}</td>
                  <td className="px-4 py-3 text-muted-foreground">{e.month}</td>
                  <td className="px-4 py-3 text-right font-mono">{e.grossAmount ? formatCurrencyFull(e.grossAmount) : "—"}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-success">{formatCurrencyFull(e.netAmount)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{e.paymentDate ? formatDate(e.paymentDate) : "—"}</td>
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
