import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save, Trash2, CheckCircle2, FileText, X } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { PageTransition, EmptyState } from "@/components/app/finverify-ui";
import StatusBadge from "@/components/app/StatusBadge";
import { formatCurrencyFull, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface JE {
  id: number; entry_date: string; voucher_no: string | null; narration: string;
  total_debit: string; total_credit: string; status: string; created_at: string;
}

interface Template {
  key: string; narration: string; lines: { accountName: string; debit?: number; credit?: number }[];
}

interface JELine { accountName: string; description?: string; debit: number; credit: number; }

export default function JournalEntriesPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showNew, setShowNew] = useState(false);
  const [entryDate, setEntryDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [voucherNo, setVoucherNo] = useState("");
  const [narration, setNarration] = useState("");
  const [lines, setLines] = useState<JELine[]>([
    { accountName: "", debit: 0, credit: 0 },
    { accountName: "", debit: 0, credit: 0 },
  ]);

  const { data: entries = [] } = useQuery<JE[]>({
    queryKey: ["journal-entries"],
    queryFn: () => fetch(`${BASE}/api/journal-entries`).then(r => r.json()),
  });

  const { data: templates = [] } = useQuery<Template[]>({
    queryKey: ["je-templates"],
    queryFn: () => fetch(`${BASE}/api/journal-entries/templates`).then(r => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: () => fetch(`${BASE}/api/journal-entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryDate, voucherNo: voucherNo || null, narration, lines }),
    }).then(async r => {
      const body = await r.json();
      if (!r.ok) throw new Error(body?.detail || body?.error || "Failed");
      return body;
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal-entries"] });
      qc.invalidateQueries({ queryKey: ["trial-balance"] });
      toast({ title: "Journal entry saved", description: "Status: draft. Post to apply to trial balance." });
      setShowNew(false);
      setNarration(""); setVoucherNo("");
      setLines([{ accountName: "", debit: 0, credit: 0 }, { accountName: "", debit: 0, credit: 0 }]);
    },
    onError: err => toast({ title: "Save failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" }),
  });

  const postMutation = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/journal-entries/${id}/post`, { method: "POST" }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal-entries"] });
      qc.invalidateQueries({ queryKey: ["trial-balance"] });
      toast({ title: "Posted", description: "Entry applied to trial balance." });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/journal-entries/${id}`, { method: "DELETE" }).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["journal-entries"] }); toast({ title: "Deleted" }); },
  });

  const loadTemplate = (key: string) => {
    const t = templates.find(t => t.key === key);
    if (!t) return;
    setNarration(t.narration);
    setLines(t.lines.map(l => ({ accountName: l.accountName, debit: l.debit ?? 0, credit: l.credit ?? 0 })));
  };

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;

  return (
    <PageTransition className="mx-auto max-w-6xl">
      <PageHeader
        title="Journal Entries"
        subtitle={`${entries.length} entries. Manual journal entries — depreciation, prepaids, accruals, reclassifications.`}
        actions={
          <button type="button" onClick={() => setShowNew(true)} className="fv-button-primary">
            <Plus className="h-4 w-4" /> New Entry
          </button>
        }
      />

      {entries.length === 0 ? (
        <EmptyState icon={FileText} title="No journal entries yet" description="Click New Entry to record depreciation, accruals, prepaid amortization, or any manual JE." />
      ) : (
        <div className="fv-card-flat overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Voucher</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Narration</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Debit</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Credit</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{formatDate(e.entry_date)}</td>
                  <td className="px-4 py-3 font-mono text-xs">{e.voucher_no ?? "—"}</td>
                  <td className="px-4 py-3">{e.narration}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCurrencyFull(parseFloat(e.total_debit))}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCurrencyFull(parseFloat(e.total_credit))}</td>
                  <td className="px-4 py-3 text-center"><StatusBadge status={e.status} /></td>
                  <td className="px-4 py-3 text-right">
                    {e.status === "draft" && (
                      <>
                        <button type="button" onClick={() => postMutation.mutate(e.id)} className="mr-1 rounded-md border border-success/20 bg-success/5 px-2 py-1 text-[11px] font-semibold text-success hover:bg-success/10">
                          <CheckCircle2 className="inline h-3 w-3" /> Post
                        </button>
                        <button type="button" onClick={() => deleteMutation.mutate(e.id)} className="rounded-md border border-destructive/20 bg-destructive/5 px-2 py-1 text-[11px] font-semibold text-destructive hover:bg-destructive/10">
                          <Trash2 className="inline h-3 w-3" /> Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-3xl rounded-2xl border border-border bg-card p-5 shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <div className="text-base font-bold text-foreground">New Journal Entry</div>
                <div className="mt-0.5 text-xs text-muted-foreground">Manual JE — debit total must equal credit total.</div>
              </div>
              <button type="button" onClick={() => setShowNew(false)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <label className="block text-xs">
                <div className="mb-1 font-semibold text-muted-foreground">Date</div>
                <input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} className="fv-input w-full" />
              </label>
              <label className="block text-xs">
                <div className="mb-1 font-semibold text-muted-foreground">Voucher No (optional)</div>
                <input type="text" value={voucherNo} onChange={e => setVoucherNo(e.target.value)} placeholder="JE-001" className="fv-input w-full" />
              </label>
              <label className="block text-xs">
                <div className="mb-1 font-semibold text-muted-foreground">Template</div>
                <select onChange={e => loadTemplate(e.target.value)} className="fv-input w-full">
                  <option value="">— None —</option>
                  {templates.map(t => <option key={t.key} value={t.key}>{t.key.replace(/_/g, " ")}</option>)}
                </select>
              </label>
            </div>

            <label className="mb-4 block text-xs">
              <div className="mb-1 font-semibold text-muted-foreground">Narration</div>
              <input type="text" value={narration} onChange={e => setNarration(e.target.value)} placeholder="e.g. Depreciation for the month — SLM" className="fv-input w-full" />
            </label>

            <div className="mb-2 text-xs font-semibold text-muted-foreground">Lines</div>
            <table className="w-full mb-3 text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-2 py-2 font-medium text-muted-foreground text-xs">Account</th>
                  <th className="text-left px-2 py-2 font-medium text-muted-foreground text-xs">Description</th>
                  <th className="text-right px-2 py-2 font-medium text-muted-foreground text-xs">Debit</th>
                  <th className="text-right px-2 py-2 font-medium text-muted-foreground text-xs">Credit</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-2 py-1">
                      <input type="text" value={l.accountName} onChange={e => setLines(prev => prev.map((p, j) => j === i ? { ...p, accountName: e.target.value } : p))} className="w-full rounded border border-border bg-card px-2 py-1 text-sm" placeholder="Account name" />
                    </td>
                    <td className="px-2 py-1">
                      <input type="text" value={l.description ?? ""} onChange={e => setLines(prev => prev.map((p, j) => j === i ? { ...p, description: e.target.value } : p))} className="w-full rounded border border-border bg-card px-2 py-1 text-sm" />
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" step="0.01" value={l.debit || ""} onChange={e => setLines(prev => prev.map((p, j) => j === i ? { ...p, debit: parseFloat(e.target.value) || 0 } : p))} className="w-full rounded border border-border bg-card px-2 py-1 text-sm text-right font-mono" />
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" step="0.01" value={l.credit || ""} onChange={e => setLines(prev => prev.map((p, j) => j === i ? { ...p, credit: parseFloat(e.target.value) || 0 } : p))} className="w-full rounded border border-border bg-card px-2 py-1 text-sm text-right font-mono" />
                    </td>
                    <td className="px-2 py-1 text-right">
                      {lines.length > 2 && (
                        <button type="button" onClick={() => setLines(prev => prev.filter((_, j) => j !== i))} className="text-destructive">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" onClick={() => setLines(prev => [...prev, { accountName: "", debit: 0, credit: 0 }])} className="mb-4 fv-button-secondary text-xs">
              <Plus className="h-3 w-3" /> Add line
            </button>

            <div className={`mb-4 rounded-xl border p-3 text-xs ${balanced ? "border-success/30 bg-success/5 text-success" : "border-warning/30 bg-warning/10 text-warning"}`}>
              Total Dr: <span className="font-mono font-bold">{formatCurrencyFull(totalDebit)}</span> ·
              Total Cr: <span className="font-mono font-bold">{formatCurrencyFull(totalCredit)}</span> ·
              {balanced ? " ✅ Balanced" : ` ⚠ Out by ${formatCurrencyFull(Math.abs(totalDebit - totalCredit))}`}
            </div>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowNew(false)} className="fv-button-secondary">Cancel</button>
              <button type="button" disabled={!balanced || !narration || createMutation.isPending} onClick={() => createMutation.mutate()} className="fv-button-primary disabled:opacity-50">
                <Save className="h-4 w-4" /> Save as Draft
              </button>
            </div>
          </div>
        </div>
      )}
    </PageTransition>
  );
}
