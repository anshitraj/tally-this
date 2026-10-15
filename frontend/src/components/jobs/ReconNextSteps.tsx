import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ClipboardList, Copy, FileSpreadsheet, Scale } from "lucide-react";
import {
  Notice,
  downloadBlob,
  downloadText,
  inr,
  postDownload,
  postJson,
} from "@/components/jobs/jobUi";

/** One row of a Bank ↔ Tally comparison, as the page holds it. */
export interface BankTallyItem {
  key: string;
  bucket: "confirmed" | "suggested" | "bank_only" | "tally_only" | "amount_difference" | "duplicate";
  status: string;
  why: string[];
  // The server sends the whole bank row; only the fields used here are named.
  bank?: Record<string, any>;
  tally?: Record<string, any>;
}

interface Figures {
  bankClosing: number | null;
  depositsNotCredited: number;
  paymentsNotPresented: number;
  creditsNotBooked: number;
  debitsNotBooked: number;
  differences: number;
  computedBooks: number | null;
  booksClosing: number | null;
  gap: number | null;
  unresolved: number;
}

/** Negative amounts read as −₹3,000, which is how a statement shows them. */
function signed(value: number) {
  return value < 0 ? `−${inr(-value)}` : inr(value);
}

function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[₹,\s]/g, "").replace(/dr$/i, "");
  if (!cleaned) return null;
  const negative = /^\(.*\)$/.test(cleaned) || /cr$/i.test(cleaned);
  const value = Number(cleaned.replace(/[()]/g, "").replace(/cr$/i, ""));
  return Number.isFinite(value) ? (negative ? -value : value) : null;
}

/**
 * What a CA does after finding the differences: a reconciliation statement that adds up, and the
 * Tally entries that are missing. Both are built from the result on screen.
 */
export function BankTallyNextSteps({
  items,
  bankName,
  periodLabel,
  bankClosing,
  clientName,
}: {
  items: BankTallyItem[];
  bankName: string | null;
  periodLabel: string | null;
  bankClosing: number | null;
  clientName: string;
}) {
  const [bankText, setBankText] = useState(bankClosing == null ? "" : String(bankClosing));
  const [booksText, setBooksText] = useState("");
  const [ledger, setLedger] = useState(bankName ? `${bankName}` : "Bank Account");
  const [figures, setFigures] = useState<Figures | null>(null);
  const [busy, setBusy] = useState<"brs" | "xml" | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const payload = useMemo(
    () => ({
      clientName,
      bankName,
      periodLabel,
      bankClosing: parseAmount(bankText),
      booksClosing: parseAmount(booksText),
      items: items.map(item => ({
        key: item.key,
        bucket: item.bucket,
        status: item.status,
        why: item.why,
        bank: item.bank
          ? { date: item.bank.date, narration: item.bank.narration ?? "", reference: item.bank.reference ?? null, debit: item.bank.debit ?? null, credit: item.bank.credit ?? null }
          : undefined,
        tally: item.tally
          ? {
              date: item.tally.date,
              ledgerName: item.tally.ledgerName ?? "",
              voucherNumber: item.tally.voucherNumber ?? null,
              narration: item.tally.narration,
              debit: item.tally.debit ?? null,
              credit: item.tally.credit ?? null,
            }
          : undefined,
      })),
    }),
    [items, clientName, bankName, periodLabel, bankText, booksText],
  );

  // The figures update as the balances are typed, so the person sees whether it adds up.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const response = await postJson<{ figures: Figures }>("/api/jobs/bank-tally/brs-preview", payload);
      if (!cancelled && response.ok) setFigures(response.data.figures);
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [payload]);

  const missingInTally = items.filter(item => item.bucket === "bank_only" && item.bank && item.status !== "rejected");

  const downloadBrs = async () => {
    setBusy("brs");
    setMessage(null);
    const response = await postDownload("/api/jobs/bank-tally/brs", payload);
    setBusy(null);
    if (!response.ok || !response.blob) {
      setMessage({ tone: "error", text: response.message || "The reconciliation statement could not be created." });
      return;
    }
    downloadBlob("TallyThis_Bank_Reconciliation.xlsx", response.blob);
    setMessage({ tone: "success", text: "Reconciliation statement downloaded. Potential risk — needs CA review." });
  };

  const downloadEntries = async () => {
    setBusy("xml");
    setMessage(null);
    const response = await postJson<{ xml?: string; fileName?: string; voucherCount?: number; errors?: string[] }>("/api/jobs/bank-to-tally/xml", {
      clientName,
      bankLedger: ledger.trim() || "Bank Account",
      transactions: missingInTally.map(item => item.bank),
      createLedgers: true,
    });
    setBusy(null);
    if (!response.ok || !response.data.xml) {
      setMessage({ tone: "error", text: response.data.errors?.slice(0, 2).join(" ") || response.data.message || "The Tally entries could not be created." });
      return;
    }
    downloadText(response.data.fileName || "TallyThis_Missing_Entries.xml", response.data.xml, "application/xml");
    setMessage({
      tone: "success",
      text: `${response.data.voucherCount ?? missingInTally.length} entries downloaded. Rows with no known party are posted to Suspense. Check them in a test company first.`,
    });
  };

  const gap = figures?.gap ?? null;

  return (
    <section className="fv-reveal rounded-xl border border-border bg-card p-4 sm:p-5" aria-label="Next steps">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Scale className="h-4 w-4 text-[var(--fv-leaf)]" />
        Reconciliation statement
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        The balance as per your books, worked out from the bank balance and the entries that differ.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium">
          Closing balance as per bank statement
          <input
            className="fv-input mt-1 w-full"
            inputMode="decimal"
            placeholder="e.g. 1,25,000.00"
            value={bankText}
            onChange={event => setBankText(event.target.value)}
          />
        </label>
        <label className="text-xs font-medium">
          Closing balance of the bank ledger in Tally <span className="font-normal text-muted-foreground">(optional)</span>
          <input
            className="fv-input mt-1 w-full"
            inputMode="decimal"
            placeholder="to check the statement adds up"
            value={booksText}
            onChange={event => setBooksText(event.target.value)}
          />
        </label>
      </div>

      {figures && figures.computedBooks != null && (
        <dl className="mt-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Row label="Add: in books, not yet in bank" value={figures.depositsNotCredited} />
          <Row label="Less: payments in books, not yet in bank" value={-figures.paymentsNotPresented} />
          <Row label="Less: in bank, not yet in books" value={-figures.creditsNotBooked} />
          <Row label="Add: bank debits not yet in books" value={figures.debitsNotBooked} />
          {figures.differences !== 0 && <Row label="Entries with a different amount" value={figures.differences} />}
          <div className="col-span-full mt-1 flex items-baseline justify-between gap-3 border-t border-border pt-2">
            <dt className="font-semibold">Balance as per books, worked out</dt>
            <dd className="font-semibold tabular-nums">{signed(figures.computedBooks)}</dd>
          </div>
          {gap != null && (
            <div className="col-span-full flex items-baseline justify-between gap-3">
              <dt className={gap === 0 ? "font-medium text-emerald-800" : "font-medium text-amber-800"}>
                {gap === 0 ? "Matches the Tally balance" : "Difference from the Tally balance"}
              </dt>
              <dd className={gap === 0 ? "tabular-nums text-emerald-800" : "tabular-nums text-amber-800"}>{signed(gap)}</dd>
            </div>
          )}
        </dl>
      )}
      {figures && figures.computedBooks == null && (
        <p className="mt-4 text-xs text-muted-foreground">Add the closing balance from the statement to see the balance as per books.</p>
      )}
      {figures && figures.unresolved > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {figures.unresolved} probable {figures.unresolved === 1 ? "match is" : "matches are"} not decided yet and not included above.
        </p>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <button type="button" className="fv-button-primary h-11 px-5" disabled={busy !== null} onClick={() => void downloadBrs()}>
          <FileSpreadsheet className="h-4 w-4" />
          {busy === "brs" ? "Preparing…" : "Download statement (Excel)"}
        </button>
      </div>

      {missingInTally.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardList className="h-4 w-4 text-[var(--fv-leaf)]" />
            {missingInTally.length} {missingInTally.length === 1 ? "entry is" : "entries are"} missing in Tally
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Create them as vouchers and import the file into Tally. Entries you marked “Ignore” are left out.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-xs font-medium">
              Bank ledger name in Tally
              <input className="fv-input mt-1 w-full" value={ledger} onChange={event => setLedger(event.target.value)} />
            </label>
            <button type="button" className="fv-button-secondary h-11" disabled={busy !== null} onClick={() => void downloadEntries()}>
              {busy === "xml" ? "Preparing…" : "Download Tally entries (XML)"}
            </button>
          </div>
        </div>
      )}

      {message && (
        <div className="mt-4">
          <Notice tone={message.tone} onClose={() => setMessage(null)}>
            {message.text}
          </Notice>
        </div>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{signed(value)}</dd>
    </div>
  );
}

/** Invoice ↔ Bank: the message to the client and the Excel copy of what was found. */
export function InvoiceBankNextSteps({
  items,
  clientName,
}: {
  items: Array<{
    key: string;
    bucket: string;
    decision?: string;
    why?: string[];
    bank?: { date: string; narration: string; debit: number | null; credit: number | null };
    invoice?: { invoiceNumber: string; vendorName: string; total: number; invoiceDate: string | null; label?: string };
  }>;
  clientName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const withoutInvoice = items.filter(item => item.bucket === "payment_without_invoice" && item.bank && item.decision !== "rejected");

  const request = useMemo(() => {
    if (withoutInvoice.length === 0) return "";
    const lines = withoutInvoice.slice(0, 40).map(item => {
      const money = item.bank!.debit ?? item.bank!.credit ?? 0;
      return `• ${item.bank!.date} — ${inr(money)} — ${item.bank!.narration.slice(0, 80)}`;
    });
    return [
      `Hello${clientName ? ` ${clientName}` : ""},`,
      "",
      "Please share the invoice or bill for these payments from the bank statement:",
      ...lines,
      withoutInvoice.length > 40 ? `…and ${withoutInvoice.length - 40} more.` : "",
      "",
      "Thank you.",
    ]
      .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
      .join("\n");
  }, [withoutInvoice, clientName]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(request);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setMessage({ tone: "error", text: "The message could not be copied. Download the Excel file instead." });
    }
  };

  const download = async () => {
    setBusy(true);
    setMessage(null);
    const response = await postDownload("/api/jobs/invoice-bank/excel", {
      clientName,
      items: items.map(item => ({
        key: item.key,
        bucket: item.bucket,
        decision: (item.decision as string) || "suggested",
        why: item.why ?? [],
        bank: item.bank,
        invoice: item.invoice,
      })),
    });
    setBusy(false);
    if (!response.ok || !response.blob) {
      setMessage({ tone: "error", text: response.message || "The Excel file could not be created." });
      return;
    }
    downloadBlob("TallyThis_Invoice_Bank.xlsx", response.blob);
    setMessage({ tone: "success", text: "Excel file downloaded." });
  };

  return (
    <section className="fv-reveal rounded-xl border border-border bg-card p-4 sm:p-5" aria-label="Next steps">
      <div className="text-sm font-semibold">Next</div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <button type="button" className="fv-button-primary h-11 px-5" disabled={busy} onClick={() => void download()}>
          <FileSpreadsheet className="h-4 w-4" />
          {busy ? "Preparing…" : "Download Excel"}
        </button>
        {withoutInvoice.length > 0 && (
          <button type="button" className="fv-button-secondary h-11" onClick={() => void copy()}>
            {copied ? <CheckCircle2 className="h-4 w-4 text-emerald-700" /> : <Copy className="h-4 w-4" />}
            {copied ? "Copied" : `Copy request for ${withoutInvoice.length} missing ${withoutInvoice.length === 1 ? "invoice" : "invoices"}`}
          </button>
        )}
      </div>
      {withoutInvoice.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          The message lists each payment with no invoice behind it. Entries you marked “Ignore” are left out.
        </p>
      )}
      {message && (
        <div className="mt-3">
          <Notice tone={message.tone} onClose={() => setMessage(null)}>
            {message.text}
          </Notice>
        </div>
      )}
    </section>
  );
}
