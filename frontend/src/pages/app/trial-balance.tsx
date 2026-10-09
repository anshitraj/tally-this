import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Scale, ChevronDown, ChevronRight, X } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { PageTransition, EmptyState } from "@/components/app/finverify-ui";
import { formatCurrencyFull, formatDate } from "@/lib/format";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface TrialBalanceAccount {
  accountName: string;
  classification: string;
  totalDebit: number;
  totalCredit: number;
  balance: number;
  entryCount: number;
}

interface TrialBalance {
  asOf: string;
  totals: { totalDebit: number; totalCredit: number; balanced: boolean };
  groups: Record<string, TrialBalanceAccount[]>;
  accounts: TrialBalanceAccount[];
}

interface AccountTxn {
  id: number; date: string; voucherNumber: string | null; amount: number; debitCredit: string; status: string;
}

const GROUP_LABELS: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  income: "Income",
  expense: "Expenses",
  equity: "Equity",
  unknown: "Unclassified",
};

const GROUP_TONES: Record<string, string> = {
  asset: "text-emerald-700 bg-emerald-50",
  liability: "text-amber-700 bg-amber-50",
  income: "text-blue-700 bg-blue-50",
  expense: "text-red-700 bg-red-50",
  equity: "text-purple-700 bg-purple-50",
  unknown: "text-muted-foreground bg-muted",
};

export default function TrialBalancePage() {
  const [drilldown, setDrilldown] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["asset", "liability", "income", "expense"]));

  const { data, isLoading } = useQuery<TrialBalance>({
    queryKey: ["trial-balance"],
    queryFn: () => fetch(`${BASE}/api/trial-balance`).then(r => r.json()),
  });

  const { data: drilldownData = [] } = useQuery<AccountTxn[]>({
    queryKey: ["trial-balance-drilldown", drilldown],
    queryFn: () => fetch(`${BASE}/api/trial-balance/account/${encodeURIComponent(drilldown!)}/transactions`).then(r => r.json()),
    enabled: Boolean(drilldown),
  });

  const toggleGroup = (k: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  return (
    <PageTransition className="mx-auto max-w-6xl">
      <PageHeader
        title="Trial Balance"
        subtitle={data
          ? `As of ${data.asOf} · Total Dr ${formatCurrencyFull(data.totals.totalDebit)} · Total Cr ${formatCurrencyFull(data.totals.totalCredit)} · ${data.totals.balanced ? "✅ Balanced" : "⚠ Unbalanced"}`
          : "Loading..."}
      />

      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading trial balance…</div>
      ) : !data || data.accounts.length === 0 ? (
        <EmptyState icon={Scale} title="No ledger entries" description="Upload Tally or Zoho ledger export, then return here." />
      ) : (
        <div className="space-y-4">
          {Object.entries(GROUP_LABELS).map(([key, label]) => {
            const accounts = data.groups[key] ?? [];
            if (accounts.length === 0) return null;
            const groupDebit = accounts.reduce((s, a) => s + a.totalDebit, 0);
            const groupCredit = accounts.reduce((s, a) => s + a.totalCredit, 0);
            const isOpen = expanded.has(key);
            return (
              <div key={key} className="fv-card-flat overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleGroup(key)}
                  className="flex w-full items-center justify-between border-b border-border px-5 py-3 hover:bg-muted/30"
                >
                  <div className="flex items-center gap-2">
                    {isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${GROUP_TONES[key]}`}>{label}</span>
                    <span className="text-xs text-muted-foreground">{accounts.length} accounts</span>
                  </div>
                  <div className="flex gap-6 text-xs">
                    <span className="text-muted-foreground">Dr <span className="font-mono font-semibold text-foreground">{formatCurrencyFull(groupDebit)}</span></span>
                    <span className="text-muted-foreground">Cr <span className="font-mono font-semibold text-foreground">{formatCurrencyFull(groupCredit)}</span></span>
                  </div>
                </button>
                {isOpen && (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/20">
                        <th className="text-left px-5 py-2 font-medium text-muted-foreground">Account</th>
                        <th className="text-right px-5 py-2 font-medium text-muted-foreground">Debit</th>
                        <th className="text-right px-5 py-2 font-medium text-muted-foreground">Credit</th>
                        <th className="text-right px-5 py-2 font-medium text-muted-foreground">Balance</th>
                        <th className="text-right px-5 py-2 font-medium text-muted-foreground">Entries</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accounts.map(a => (
                        <tr key={a.accountName} className="border-b border-border last:border-0 hover:bg-muted/30 cursor-pointer" onClick={() => setDrilldown(a.accountName)}>
                          <td className="px-5 py-2 font-medium">{a.accountName}</td>
                          <td className="px-5 py-2 text-right font-mono">{a.totalDebit > 0 ? formatCurrencyFull(a.totalDebit) : "—"}</td>
                          <td className="px-5 py-2 text-right font-mono">{a.totalCredit > 0 ? formatCurrencyFull(a.totalCredit) : "—"}</td>
                          <td className={`px-5 py-2 text-right font-mono font-semibold ${a.balance >= 0 ? "text-emerald-700" : "text-red-700"}`}>{formatCurrencyFull(Math.abs(a.balance))} {a.balance >= 0 ? "Dr" : "Cr"}</td>
                          <td className="px-5 py-2 text-right text-xs text-muted-foreground">{a.entryCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      {drilldown && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-3xl rounded-2xl border border-border bg-card p-5 shadow-xl max-h-[80vh] overflow-y-auto">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-bold text-foreground">Account: {drilldown}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{drilldownData.length} transactions</div>
              </div>
              <button type="button" onClick={() => setDrilldown(null)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Voucher</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Amount</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Dr/Cr</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody>
                {drilldownData.map(t => (
                  <tr key={t.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 text-muted-foreground">{formatDate(t.date)}</td>
                    <td className="px-3 py-2 font-mono">{t.voucherNumber ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatCurrencyFull(t.amount)}</td>
                    <td className="px-3 py-2 text-right uppercase text-xs">{t.debitCredit}</td>
                    <td className="px-3 py-2 text-right text-xs text-muted-foreground">{t.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PageTransition>
  );
}
