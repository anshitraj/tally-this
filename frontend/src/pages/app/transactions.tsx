import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Download, Search } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import StatusBadge from "@/components/app/StatusBadge";
import { ConfidenceBar, EmptyState, PageTransition } from "@/components/app/finverify-ui";
import { exportToCsv, formatCurrencyFull, formatDate } from "@/lib/format";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Transaction {
  id: number;
  date: string;
  narration: string;
  amount: number;
  type: string;
  source: string;
  bankName?: string | null;
  reference?: string | null;
  status: string;
  confidenceScore: number;
  matchedInvoiceId?: number | null;
  note?: string | null;
}

const STATUS_OPTIONS = ["all", "verified", "unverified", "missing_invoice", "amount_mismatch", "gst_risk", "tds_risk", "needs_ca_review"];

export default function TransactionsPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("all");

  const { data = [], isLoading } = useQuery<Transaction[]>({
    queryKey: ["transactions"],
    queryFn: () => fetch(`${BASE}/api/transactions`).then(r => r.json()),
  });

  const filtered = data.filter(t => {
    const needle = search.toLowerCase();
    const matchSearch = !needle || t.narration.toLowerCase().includes(needle) || (t.reference || "").toLowerCase().includes(needle);
    const matchStatus = status === "all" || t.status === status;
    const matchType = type === "all" || t.type === type;
    return matchSearch && matchStatus && matchType;
  });

  const handleExport = () => {
    exportToCsv(filtered.map(t => ({
      Date: t.date,
      Narration: t.narration,
      Amount: t.amount,
      Type: t.type,
      Source: t.source,
      Bank: t.bankName || "",
      Reference: t.reference || "",
      Status: t.status,
      ConfidenceScore: t.confidenceScore,
    })), "transactions.csv");
  };

  return (
    <PageTransition className="mx-auto max-w-7xl">
      <PageHeader
        title="Bank Transactions"
        subtitle={`${filtered.length} of ${data.length} transactions. Review confidence, missing documents, and CA review status.`}
        actions={
          <button type="button" onClick={handleExport} className="fv-button-secondary">
            <Download className="h-4 w-4" />
            Export CSV
          </button>
        }
      />

      <div className="mb-5 flex flex-wrap gap-3 rounded-2xl border border-border bg-card p-3">
        <div className="fv-search-field min-w-56 flex-1">
          <Search className="fv-search-icon" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search narration or reference..."
            className="fv-search-input"
          />
        </div>
        <select value={status} onChange={e => setStatus(e.target.value)} className="fv-input">
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s === "all" ? "All statuses" : s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</option>)}
        </select>
        <select value={type} onChange={e => setType(e.target.value)} className="fv-input">
          <option value="all">All types</option>
          <option value="credit">Credit</option>
          <option value="debit">Debit</option>
        </select>
      </div>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="fv-card-flat overflow-hidden">
        <div className="max-h-[68vh] overflow-auto">
          <table className="fv-table min-w-[920px]">
            <thead>
              <tr>
                <th>Date</th>
                <th>Narration</th>
                <th>Bank</th>
                <th className="text-right">Amount</th>
                <th>Confidence</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="py-8 text-center text-muted-foreground">Loading...</td></tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-6">
                    <EmptyState title="No transactions found" description="Adjust filters or upload a bank statement to add transaction rows." />
                  </td>
                </tr>
              ) : filtered.map(t => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap text-muted-foreground">{formatDate(t.date)}</td>
                  <td>
                    <div className="font-medium">{t.narration}</div>
                    {t.reference && <div className="mt-0.5 font-mono text-xs text-muted-foreground">{t.reference}</div>}
                    {t.note && <div className="fv-text-brand-accent mt-1 text-xs">{t.note}</div>}
                  </td>
                  <td className="text-muted-foreground">{t.bankName || t.source}</td>
                  <td className={`text-right font-mono font-semibold ${t.type === "credit" ? "text-success" : "text-foreground"}`}>
                    {t.type === "credit" ? "+" : "-"}{formatCurrencyFull(t.amount)}
                  </td>
                  <td><ConfidenceBar score={t.confidenceScore} /></td>
                  <td><StatusBadge status={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>
    </PageTransition>
  );
}
