import { useState } from "react";
import { BookOpen, X } from "lucide-react";

export default function ReconciliationGuide() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="mb-5 rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">What does reconciliation do?</div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              Reconciliation compares records from different sources to find matches, mismatches, missing documents, duplicate invoices, and items that need CA review.
            </p>
          </div>
          <button type="button" onClick={() => setOpen(true)} className="fv-button-secondary">
            <BookOpen className="h-4 w-4" />
            Learn more
          </button>
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-bold">Reconciliation guide</div>
                <div className="mt-1 text-xs text-muted-foreground">Rules match. Humans approve. CA reviews.</div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 text-sm leading-6 text-muted-foreground">
              <p><strong className="text-foreground">Bank to Invoices:</strong> checks whether payments match accepted invoices.</p>
              <p><strong className="text-foreground">Bank to Tally:</strong> checks whether bank entries match ledger entries.</p>
              <p><strong className="text-foreground">Bank to Payroll:</strong> checks whether salary payments match the payroll sheet.</p>
              <p><strong className="text-foreground">Bank to Gateway:</strong> checks whether settlement credits match payment gateway reports.</p>
              <p>Unresolved items become exceptions or Potential risk — needs CA review items.</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
