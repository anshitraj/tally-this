import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Search, Download, FileText } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import StatusBadge from "@/components/app/StatusBadge";
import { formatCurrencyFull, formatDate, exportToCsv } from "@/lib/format";
import InvoiceExtractionReviewPanel from "@/components/invoices/InvoiceExtractionReviewPanel";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Invoice {
  id: number;
  invoiceNumber: string;
  vendorName: string;
  customerName?: string | null;
  gstin?: string | null;
  date: string;
  amount: number;
  gstAmount?: number | null;
  type: string;
  paymentStatus: string;
  status: string;
  linkedTransactionId?: number | null;
}

export default function InvoicesPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("all");

  const { data = [], isLoading } = useQuery<Invoice[]>({
    queryKey: ["invoices"],
    queryFn: () => fetch(`${BASE}/api/invoices`).then(r => r.json()),
  });

  const filtered = data.filter(inv => {
    const matchSearch = !search ||
      inv.invoiceNumber.toLowerCase().includes(search.toLowerCase()) ||
      inv.vendorName.toLowerCase().includes(search.toLowerCase()) ||
      (inv.gstin || "").toLowerCase().includes(search.toLowerCase());
    const matchStatus = status === "all" || inv.status === status;
    const matchType = type === "all" || inv.type === type;
    return matchSearch && matchStatus && matchType;
  });

  const handleExport = () => {
    exportToCsv(filtered.map(i => ({
      InvoiceNumber: i.invoiceNumber,
      Vendor: i.vendorName,
      Customer: i.customerName || "",
      GSTIN: i.gstin || "",
      Date: i.date,
      Amount: i.amount,
      GSTAmount: i.gstAmount || "",
      Type: i.type,
      PaymentStatus: i.paymentStatus,
      Status: i.status,
    })), "invoices.csv");
  };

  const totalGST = filtered.reduce((sum, i) => sum + (i.gstAmount || 0), 0);
  const totalAmount = filtered.reduce((sum, i) => sum + i.amount, 0);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Invoices"
        subtitle={`${filtered.length} invoices · GST ₹${(totalGST / 1000).toFixed(0)}K · Total ₹${(totalAmount / 100000).toFixed(1)}L`}
        actions={
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-2 border border-border rounded-lg text-sm hover:bg-muted/40 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
        }
      />

      <InvoiceExtractionReviewPanel />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="fv-search-field flex-1 min-w-48">
          <Search className="fv-search-icon" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search invoice number, vendor, GSTIN…"
            className="fv-search-input"
          />
        </div>
        <select
          value={type}
          onChange={e => setType(e.target.value)}
          className="fv-input"
        >
          <option value="all">All Types</option>
          <option value="purchase">Purchase</option>
          <option value="sales">Sales</option>
        </select>
        <select
          value={status}
          onChange={e => setStatus(e.target.value)}
          className="fv-input"
        >
          <option value="all">All Statuses</option>
          <option value="verified">Verified</option>
          <option value="unverified">Unverified</option>
          <option value="missing_gstin">Missing GSTIN</option>
          <option value="amount_mismatch">Amount Mismatch</option>
          <option value="gst_risk">GST Risk</option>
        </select>
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
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Invoice #</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Vendor</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">GSTIN</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Amount</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">GST</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Type</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Payment</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center">
                    <FileText className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                    <div className="text-muted-foreground">No invoices found</div>
                  </td>
                </tr>
              ) : filtered.map(inv => (
                <tr key={inv.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs font-semibold">{inv.invoiceNumber}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{inv.vendorName}</div>
                    {inv.customerName && <div className="text-xs text-muted-foreground">to {inv.customerName}</div>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{inv.gstin || <span className="fv-text-brand-accent">Missing</span>}</td>
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{formatDate(inv.date)}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold">{formatCurrencyFull(inv.amount)}</td>
                  <td className="px-4 py-3 text-right font-mono text-muted-foreground text-xs">
                    {inv.gstAmount ? formatCurrencyFull(inv.gstAmount) : "—"}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${inv.type === "purchase" ? "fv-status-review" : "fv-status-verified"}`}>
                      {inv.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center"><StatusBadge status={inv.paymentStatus} /></td>
                  <td className="px-4 py-3 text-center"><StatusBadge status={inv.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}
