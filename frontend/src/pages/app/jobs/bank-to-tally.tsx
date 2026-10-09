import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { CheckCircle2, Sparkles } from "lucide-react";
import { BankIdentity } from "@/components/app/BankLogos";
import {
  AiConsentPrompt,
  BigStat,
  Choice,
  DropZone,
  JobShell,
  MoreOptions,
  Notice,
  PasswordPrompt,
  ResultCard,
  StatementProof,
  Working,
  downloadText,
  downloadBlob,
  fmtDate,
  inr,
  isLockedPdf,
  postFiles,
  postJson,
  postDownload,
  takePendingFiles,
  toCsv,
  type StatementCheck,
} from "@/components/jobs/jobUi";
import { getActiveClient } from "@/lib/activeClient";
import { getUser } from "@/lib/auth";
import { cn } from "@/lib/utils";

interface BankTxn {
  date: string;
  narration: string;
  reference: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  counterparty: string | null;
  confidence: number;
  rowNumber: number;
}

interface LedgerGroup {
  key: string;
  label: string;
  ledger: string;
  source: "remembered" | "rule" | "ai" | "none";
  count: number;
  total: number;
  direction: "in" | "out" | "both";
  sample: string;
}

interface NormalizeResponse {
  ok: boolean;
  message: string;
  needsPassword?: boolean;
  wrongPassword?: boolean;
  needsAiConsent?: boolean;
  /** True when privacy mode was on: nothing about this run was saved. */
  privacy?: boolean;
  runId?: string | null;
  bankName?: string | null;
  bankOptions?: string[];
  accountNumberMasked?: string | null;
  periodLabel?: string | null;
  transactions?: BankTxn[];
  debitTotal?: number;
  creditTotal?: number;
  check?: StatementCheck | null;
  source?: "sheet" | "pdf_layout" | "pdf_text" | "ocr" | "ai";
  ledgerGroups?: LedgerGroup[];
  ledgerOptions?: string[];
}

type Stage = "idle" | "working" | "password" | "consent" | "done" | "error";

const STEPS = ["Reading your statement", "Finding transactions", "Checking the running balance", "Suggesting Tally ledgers"];

const QUICK: Record<LedgerGroup["direction"], string[]> = {
  in: ["Sundry Debtors", "Sales", "Suspense"],
  out: ["Sundry Creditors", "Office Expenses", "Suspense"],
  both: ["Sundry Debtors", "Sundry Creditors", "Suspense"],
};

/** Same grouping the server uses for ledger suggestions. */
function groupKeyOf(txn: BankTxn) {
  return (txn.counterparty || txn.narration.slice(0, 40)).trim();
}

export default function BankToTallyPage() {
  const [, navigate] = useLocation();
  const [stage, setStage] = useState<Stage>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<NormalizeResponse | null>(null);
  const [ledgers, setLedgers] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [checkedRows, setCheckedRows] = useState<Set<number>>(new Set());
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  const [totalsConfirmed, setTotalsConfirmed] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [bankLedger, setBankLedger] = useState("Bank Account");
  const [bankOverride, setBankOverride] = useState<string | null>(null);
  const [otherBank, setOtherBank] = useState("");
  const [bankPickerOpen, setBankPickerOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [generated, setGenerated] = useState<{ count: number; fileName: string } | null>(null);
  const [createLedgers, setCreateLedgers] = useState<"yes" | "no">("yes");
  const [suggesting, setSuggesting] = useState(false);
  const reviewRef = useRef<HTMLDivElement>(null);
  const [consentMessage, setConsentMessage] = useState("");
  // Kept only in memory so a scan can be retried after the person agrees to AI.
  const passwordRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (reviewOpen) reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [reviewOpen]);

  const runFile = async (picked: File, pdfPassword?: string, allowAi = false) => {
    setFile(picked);
    setStage("working");
    setError("");
    setGenerated(null);
    passwordRef.current = pdfPassword;
    const response = await postFiles<NormalizeResponse>("/api/jobs/bank-statement/normalize", {
      file: picked,
      fileName: picked.name,
      password: pdfPassword,
      allowAi: allowAi ? "1" : undefined,
    });
    if (!response.ok) {
      if (response.data.needsPassword) {
        setStage("password");
        setError(response.data.wrongPassword || pdfPassword ? response.data.message ?? "" : "");
        return;
      }
      if (response.data.needsAiConsent) {
        setConsentMessage(response.data.message ?? "");
        setStage("consent");
        return;
      }
      setError(response.data.message || "This statement could not be read.");
      setStage("error");
      return;
    }
    const data = response.data;
    setResult(data);
    setLedgers(Object.fromEntries((data.ledgerGroups ?? []).map(group => [group.key, group.ledger])));
    setConfirmed(new Set((data.ledgerGroups ?? []).filter(group => group.source === "remembered" || group.source === "rule").map(group => group.key)));
    setSkipped(new Set());
    setCheckedRows(new Set());
    setFlipped(new Set());
    setTotalsConfirmed(false);
    setReviewOpen(false);
    setBankLedger(data.bankName ?? "Bank Account");
    setBankOverride(null);
    setOtherBank("");
    setBankPickerOpen(!data.bankName);
    setStage("done");
    // Privacy mode sends no names to AI, so the quick rule-based choices are all it offers.
    if (!data.privacy) void askAiForLedgers(data);
  };

  // Rules answer at once; AI picks for the remaining parties arrive a few seconds later.
  const askAiForLedgers = async (data: NormalizeResponse) => {
    const unknown = (data.ledgerGroups ?? []).filter(group => group.source === "none");
    if (unknown.length === 0) return;
    setSuggesting(true);
    const response = await postJson<{ picks?: Array<{ key: string; ledger: string }> }>("/api/jobs/ledger-suggestions", {
      parties: unknown.map(group => ({ key: group.key, direction: group.direction, sample: group.sample })),
    });
    setSuggesting(false);
    const picks = (response.data.picks ?? []).filter(pick => pick.ledger !== "Suspense");
    if (picks.length === 0) return;
    const byKey = new Map(picks.map(pick => [pick.key, pick.ledger]));
    setResult(current => current && current.runId === data.runId
      ? { ...current, ledgerGroups: (current.ledgerGroups ?? []).map(group => byKey.has(group.key) && group.source === "none" ? { ...group, ledger: byKey.get(group.key)!, source: "ai" as const } : group) }
      : current);
    setLedgers(current => {
      const next = { ...current };
      for (const [key, ledger] of byKey) if (next[key] === "Suspense") next[key] = ledger;
      return next;
    });
  };

  // A locked PDF asks for its password straight away, before anything is uploaded.
  const takeFile = async (picked: File) => {
    setResult(null);
    setGenerated(null);
    if (await isLockedPdf(picked)) {
      setFile(picked);
      setError("");
      setStage("password");
      return;
    }
    await runFile(picked);
  };

  useEffect(() => {
    const pending = takePendingFiles("bank-to-tally");
    if (pending?.[0]) void takeFile(pending[0]);
    // Runs once for files handed over from Home.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A reviewer can say a row is money in rather than out (or the reverse).
  const txns = useMemo(
    () => (result?.transactions ?? []).map(txn => flipped.has(txn.rowNumber) ? { ...txn, debit: txn.credit, credit: txn.debit } : txn),
    [result?.transactions, flipped],
  );
  const activeTxns = txns.filter(txn => !skipped.has(txn.rowNumber));
  const activeParties = new Set(activeTxns.map(groupKeyOf));
  const totals = activeTxns.reduce(
    (sum, txn) => ({ debit: sum.debit + (txn.debit ?? 0), credit: sum.credit + (txn.credit ?? 0) }),
    { debit: 0, credit: 0 },
  );
  const groups = result?.ledgerGroups ?? [];
  const options = result?.ledgerOptions ?? [];
  // Direction follows the reviewer's flips, so the quick choices offer the right side.
  const directions = useMemo(() => {
    const map = new Map<string, LedgerGroup["direction"]>();
    for (const txn of txns) {
      const key = groupKeyOf(txn);
      const dir = txn.credit != null ? "in" : "out";
      const seen = map.get(key);
      map.set(key, seen && seen !== dir ? "both" : dir);
    }
    return map;
  }, [txns]);
  const failedRows = new Set(result?.check?.failedRows ?? []);
  const flaggedRows = activeTxns.filter(txn => txn.confidence < 0.9 || failedRows.has(txn.rowNumber));
  const activeGroups = groups.filter(group => activeParties.has(group.key));
  const groupsToReview = activeGroups.filter(group => !confirmed.has(group.key));
  const rowsToReview = flaggedRows.filter(txn => !checkedRows.has(txn.rowNumber) && !skipped.has(txn.rowNumber));
  const suspenseLeft = activeGroups.filter(group => (ledgers[group.key] ?? group.ledger) === "Suspense").length;
  const statementEdited = flipped.size > 0 || skipped.size > 0;
  const proofFailure = result?.check?.closingMatches === false || result?.check?.serialComplete === false;
  const needsTotalsCheck = Boolean(result && !proofFailure && (result.check?.verified !== true || statementEdited) && !totalsConfirmed);
  const reviewItems = groupsToReview.length + rowsToReview.length + (needsTotalsCheck ? 1 : 0);
  const attentionItems = reviewItems + (proofFailure ? 1 : 0);
  const hasReview = reviewItems > 0;
  const aiRead = result?.source === "ai" || result?.source === "ocr";
  const displayBankName = bankOverride === "__other__" ? otherBank.trim() : (bankOverride ?? result?.bankName ?? "");

  const pick = (key: string, ledger: string) => {
    setLedgers(current => ({ ...current, [key]: ledger }));
    setConfirmed(current => new Set(current).add(key));
  };

  const flipRow = (txn: BankTxn) => {
    setFlipped(current => new Set(current).add(txn.rowNumber));
    setTotalsConfirmed(false);
    // A customer becomes a supplier (and back) when money changes direction.
    const key = groupKeyOf(txn);
    setLedgers(current => {
      const ledger = current[key];
      if (ledger === "Sundry Debtors") return { ...current, [key]: "Sundry Creditors" };
      if (ledger === "Sundry Creditors") return { ...current, [key]: "Sundry Debtors" };
      return current;
    });
  };

  const acceptSuggestions = () => {
    setConfirmed(current => {
      const next = new Set(current);
      groups.filter(group => group.source === "ai").forEach(group => next.add(group.key));
      return next;
    });
  };

  const generate = async () => {
    if (!result) return;
    if (proofFailure) { setError("The statement totals or row sequence do not agree. Upload another bank export before creating a Tally file."); return; }
    if (!displayBankName) { setError("Choose the statement bank before creating the Tally file."); setBankPickerOpen(true); return; }
    if (hasReview) { setError("Finish reviewing the items below before creating the Tally file."); setReviewOpen(true); return; }
    setGenerating(true);
    const client = getActiveClient();
    const mappings = groups.map(group => ({ counterparty: group.key, ledgerName: ledgers[group.key] ?? group.ledger }));
    const response = await postJson<{ xml?: string; fileName?: string; voucherCount?: number }>("/api/jobs/bank-to-tally/xml", {
      runId: result.runId ?? undefined,
      clientId: client?.id ?? undefined,
      clientName: client?.name || getUser()?.company || "Client",
      bankLedger,
      transactions: txns.filter(txn => !skipped.has(txn.rowNumber)),
      mappings,
      createLedgers: createLedgers === "yes",
    });
    setGenerating(false);
    if (!response.ok || !response.data.xml) {
      setError(response.data.errors?.join(" ") || response.data.message || "The Tally file could not be created.");
      return;
    }
    setError("");
    const fileName = response.data.fileName || "tally-vouchers.xml";
    downloadText(fileName, response.data.xml, "application/xml");
    setGenerated({ count: response.data.voucherCount ?? 0, fileName });
    const remember = mappings.filter(mapping => mapping.ledgerName !== "Suspense");
    if (client?.id && remember.length > 0 && !result.privacy) {
      void postJson("/api/jobs/ledger-mappings", { clientId: client.id, clientName: client.name, mappings: remember });
    }
  };

  const exportCsv = () => {
    downloadText(
      "bank-transactions.csv",
      toCsv(
        ["Date", "Narration", "Reference", "Paid", "Received", "Statement balance", "Ledger choice", "Review"],
        activeTxns.map(txn => {
          const group = groups.find(item => item.key === groupKeyOf(txn));
          const needsReview = txn.confidence < 0.9 || failedRows.has(txn.rowNumber);
          return [txn.date, txn.narration, txn.reference ?? "", txn.debit ?? "", txn.credit ?? "", txn.balance ?? "", group ? ledgers[group.key] ?? group.ledger : "Suspense", flipped.has(txn.rowNumber) ? "Changed in review" : needsReview ? checkedRows.has(txn.rowNumber) ? "Checked" : "Needs review" : "Ready"];
        }),
      ),
      "text/csv",
    );
  };

  const exportExcel = async () => {
    if (!result) return;
    setExportingExcel(true);
    const client = getActiveClient();
    const response = await postDownload("/api/jobs/bank-to-tally/excel", {
      clientName: client?.name || getUser()?.company || "Client",
      bankName: displayBankName || "Bank not identified",
      accountNumberMasked: result.accountNumberMasked ?? null,
      periodLabel: result.periodLabel ?? null,
      rows: txns.map(txn => {
        const group = groups.find(item => item.key === groupKeyOf(txn));
        return {
          rowNumber: txn.rowNumber,
          date: txn.date,
          narration: txn.narration,
          reference: txn.reference,
          debit: txn.debit,
          credit: txn.credit,
          balance: txn.balance,
          counterparty: txn.counterparty,
          ledgerChoice: group ? ledgers[group.key] ?? group.ledger : "Suspense",
          needsReview: txn.confidence < 0.9 || failedRows.has(txn.rowNumber),
          reviewed: checkedRows.has(txn.rowNumber),
          edited: flipped.has(txn.rowNumber),
          excluded: skipped.has(txn.rowNumber),
        };
      }),
    });
    setExportingExcel(false);
    if (!response.ok || !response.blob) { setError(response.message || "The Excel file could not be created."); return; }
    setError("");
    downloadBlob("TallyThis_Bank_Transactions.xlsx", response.blob);
  };

  const reset = () => {
    setStage("idle");
    setResult(null);
    setFile(null);
    setError("");
    setGenerated(null);
    setBankOverride(null);
    setBankPickerOpen(false);
    setTotalsConfirmed(false);
    passwordRef.current = undefined;
  };

  const bankChoices = useMemo(() => {
    const name = displayBankName;
    const last4 = result?.accountNumberMasked;
    const list = name ? [bankLedger, name, `${name} A/c`, ...(last4 ? [`${name} ${last4}`] : []), "Bank Account"] : [bankLedger, "Bank Account"];
    return [...new Set(list)].map(value => ({ value, label: value }));
  }, [bankLedger, displayBankName, result?.accountNumberMasked]);

  return (
    <JobShell title="Bank Statement → Tally" outcome="Upload your bank statement and get a Tally-ready file.">
      {(stage === "idle" || stage === "error") && (
        <div className="space-y-4">
          {stage === "error" && <Notice tone="error">{error}</Notice>}
          <DropZone
            label="Upload Bank Statement"
            hint="PDF, Excel, CSV or a photo. We'll identify the bank when the statement shows it."
            files={file ? [file] : []}
            onFiles={files => takeFile(files[0])}
          />
          <p className="text-center text-xs text-muted-foreground">Bank downloaded Excel, CSV and text PDFs work best. Scans and photos may need an additional reading step.</p>
        </div>
      )}

      {stage === "working" && <Working steps={STEPS} />}

      {stage === "password" && file && (
        <PasswordPrompt
          fileName={file.name}
          error={error}
          onSubmit={password => runFile(file, password)}
          onSkip={() => runFile(file)}
          onCancel={reset}
        />
      )}

      {stage === "consent" && file && (
        <AiConsentPrompt fileName={file.name} message={consentMessage} onAllow={() => runFile(file, passwordRef.current, true)} onCancel={reset} />
      )}

      {stage === "done" && result && (
        <div className="space-y-4">
          <ResultCard
            eyebrow={
              <span className="flex flex-wrap items-center gap-2">
                <span>{result.accountNumberMasked ? `Account ••${result.accountNumberMasked}` : "Bank statement"}{result.periodLabel ? ` · ${result.periodLabel}` : ""}</span>
                {aiRead && !result.check?.verified && <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 normal-case tracking-normal text-amber-900">Extra check needed</span>}
              </span>
            }
            actions={
              <>
                {proofFailure ? (
                  <button type="button" className="fv-button-primary h-11 px-6" onClick={reset}>Upload another statement</button>
                ) : !displayBankName ? (
                  <button type="button" className="fv-button-primary h-11 px-6" onClick={() => document.getElementById("statement-bank")?.focus()}>Choose bank</button>
                ) : hasReview ? (
                  <button type="button" className="fv-button-primary h-11 px-6" onClick={() => setReviewOpen(true)}>Review {reviewItems} {reviewItems === 1 ? "item" : "items"}</button>
                ) : (
                  <button type="button" className="fv-button-primary h-11 px-6" onClick={generate} disabled={generating}>
                    {generating ? "Creating file…" : generated ? "Download Tally File again" : "Generate Tally File"}
                  </button>
                )}
                <button type="button" className="fv-button-secondary h-11" onClick={exportExcel} disabled={exportingExcel}>
                  {exportingExcel ? "Creating Excel…" : "Download Excel"}
                </button>
              </>
            }
          >
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
              <BankIdentity name={displayBankName} />
              {!bankPickerOpen && <button type="button" className="text-sm font-medium text-[var(--fv-accent-dark)] hover:underline" onClick={() => setBankPickerOpen(true)}>Change bank</button>}
            </div>
            {bankPickerOpen && (
              <div className="mb-6 rounded-xl border border-border bg-muted/40 p-4">
                <label htmlFor="statement-bank" className="mb-2 block text-sm font-semibold">Which bank issued this statement?</label>
                <select
                  id="statement-bank"
                  className="fv-input h-11 w-full sm:max-w-sm"
                  value={bankOverride ?? result.bankName ?? ""}
                  onChange={event => {
                    const selected = event.target.value;
                    setBankOverride(selected);
                    setBankLedger(selected === "__other__" ? "Bank Account" : selected || "Bank Account");
                    if (selected && selected !== "__other__") setBankPickerOpen(false);
                  }}
                >
                  <option value="">Choose a bank</option>
                  {[...new Set([result.bankName, ...(result.bankOptions ?? [])].filter((name): name is string => Boolean(name)))].map(name => <option key={name} value={name}>{name}</option>)}
                  <option value="__other__">My bank is not listed</option>
                </select>
                {bankOverride === "__other__" && (
                  <input
                    aria-label="Bank name"
                    className="fv-input mt-3 h-11 w-full sm:max-w-sm"
                    placeholder="Enter the bank name on the statement"
                    value={otherBank}
                    onChange={event => { setOtherBank(event.target.value); setBankLedger(event.target.value || "Bank Account"); }}
                    maxLength={100}
                  />
                )}
                <p className="mt-2 text-xs text-muted-foreground">Use the name printed on your statement. You can set a different Tally ledger under More options.</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-6">
              <BigStat value={activeTxns.length} label={skipped.size > 0 ? "transactions included" : "transactions detected"} />
              <BigStat value={attentionItems} label={attentionItems === 1 ? "item needs attention" : "items need attention"} tone={attentionItems > 0 ? "attention" : "good"} />
            </div>
            <div className="mt-4 text-sm text-muted-foreground">Money in {inr(totals.credit)} · Money out {inr(totals.debit)}</div>
            {statementEdited
              ? <p className="mt-4 text-sm text-amber-800">Transactions were changed or left out. The original running-balance check does not verify the edited export.</p>
              : <StatementProof check={result.check} />}
            {proofFailure && <p className="mt-3 text-sm font-medium text-amber-900">The closing balance or row sequence conflicts with this statement. Try the bank's Excel or CSV download, or a clearer PDF.</p>}
            {groupsToReview.length > 0 && (
              <p className="mt-3 text-sm font-medium">{groupsToReview.length} {groupsToReview.length === 1 ? "party ledger needs" : "party ledgers need"} choosing or confirming. This is separate from the transaction checks.</p>
            )}
            {!generated && suspenseLeft > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">{suspenseLeft} {suspenseLeft === 1 ? "party goes" : "parties go"} to Suspense unless you choose a ledger.</p>
            )}
          </ResultCard>

          {result.privacy && !generated && (
            <Notice tone="success">Privacy mode: nothing here is saved. Download the Tally file before you leave this page.</Notice>
          )}
          {error && <Notice tone="error" onClose={() => setError("")}>{error}</Notice>}
          {generated && (
            <Notice tone="success">
              <div className="font-semibold">Tally file downloaded — {generated.count} vouchers, all balanced.</div>
              <div className="mt-1">In Tally: open the company → Import → Vouchers → choose <span className="font-mono text-xs">{generated.fileName}</span>.{createLedgers === "yes" ? " Missing ledgers are created under the right groups; your existing ledgers are not changed." : ""}</div>
              <div className="mt-1">Back up the Tally company and check its import results. Importing the same file twice can create duplicate vouchers.</div>
            </Notice>
          )}

          {reviewOpen && (
            <div ref={reviewRef} className="scroll-mt-4">
            <ResultCard eyebrow="Review">
              {groupsToReview.length === 0 && rowsToReview.length === 0 && !needsTotalsCheck ? (
                <div className="flex items-center gap-2 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />All done. Generate the Tally file.</div>
              ) : (
                <div className="space-y-6">
                  {groupsToReview.length > 0 && (
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="font-semibold">Choose a ledger for {groupsToReview.length} {groupsToReview.length === 1 ? "party" : "parties"}</h2>
                        {suggesting && <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Sparkles className="h-3.5 w-3.5 animate-pulse" />Finding ledgers…</span>}
                        {!suggesting && groupsToReview.some(group => group.source === "ai") && (
                          <button type="button" className="text-sm font-semibold text-[var(--fv-accent-dark)] hover:underline" onClick={acceptSuggestions}>Accept all suggestions</button>
                        )}
                      </div>
                      <div className="mt-3 divide-y divide-border rounded-xl border border-border">
                        {groupsToReview.map(group => (
                          <LedgerRow key={group.key} group={{ ...group, direction: directions.get(group.key) ?? group.direction }} value={ledgers[group.key] ?? group.ledger} options={options} onPick={ledger => pick(group.key, ledger)} />
                        ))}
                      </div>
                    </div>
                  )}
                  {rowsToReview.length > 0 && (
                    <div>
                      <h2 className="font-semibold">Double-check {rowsToReview.length} {rowsToReview.length === 1 ? "row" : "rows"}</h2>
                      <p className="mt-1 text-xs text-muted-foreground">These rows did not follow the running balance or were hard to read. Compare with the statement.</p>
                      <div className="mt-3 divide-y divide-border rounded-xl border border-border">
                        {rowsToReview.map(txn => (
                          <div key={txn.rowNumber} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0 text-sm">
                              <div className="font-medium">{fmtDate(txn.date)} · {txn.debit != null ? `Paid ${inr(txn.debit)}` : `Received ${inr(txn.credit)}`}</div>
                              <div className="truncate text-xs text-muted-foreground">{txn.narration}</div>
                            </div>
                            <Choice
                              size="sm"
                              value={null}
                              options={[
                                { value: "ok", label: "Looks right", tone: "good" },
                                { value: "flip", label: txn.debit != null ? "It's money in" : "It's money out" },
                                { value: "skip", label: "Leave out", tone: "bad" },
                              ]}
                              onChange={choice => {
                                if (choice === "flip") flipRow(txn);
                                if (choice === "skip") { setSkipped(current => new Set(current).add(txn.rowNumber)); setTotalsConfirmed(false); }
                                else setCheckedRows(current => new Set(current).add(txn.rowNumber));
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {needsTotalsCheck && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
                      <h2 className="font-semibold text-amber-950">Check the statement totals</h2>
                      <p className="mt-1 text-amber-900">Compare {activeTxns.length} transactions, money in {inr(totals.credit)} and money out {inr(totals.debit)} with the bank's original statement. The running balance has not proved this exact export.</p>
                      <button type="button" className="fv-button-secondary mt-3" onClick={() => setTotalsConfirmed(true)}>I checked these totals</button>
                    </div>
                  )}
                </div>
              )}
            </ResultCard>
            </div>
          )}

          <MoreOptions>
            <button type="button" className="text-sm font-medium text-[var(--fv-accent-dark)] hover:underline" onClick={reset}>Upload another statement</button>
            <div>
              <div className="text-sm font-semibold">Bank ledger name in Tally</div>
              <p className="mb-2 text-xs text-muted-foreground">Pick the name your Tally company uses for this bank account.</p>
              <Choice size="sm" value={bankLedger} options={bankChoices} onChange={setBankLedger} />
            </div>
            <div>
              <div className="text-sm font-semibold">Create missing ledgers in Tally</div>
              <p className="mb-2 text-xs text-muted-foreground">New party and expense ledgers are added under the right group. Existing ledgers are never changed.</p>
              <Choice<"yes" | "no"> size="sm" value={createLedgers} onChange={setCreateLedgers} options={[{ value: "yes", label: "Yes, create them" }, { value: "no", label: "No, they already exist" }]} />
            </div>
            <div>
              <div className="mb-2 text-sm font-semibold">All parties ({groups.length})</div>
              <div className="max-h-96 divide-y divide-border overflow-y-auto rounded-xl border border-border bg-card">
                {groups.map(group => (
                  <LedgerRow key={group.key} group={{ ...group, direction: directions.get(group.key) ?? group.direction }} value={ledgers[group.key] ?? group.ledger} options={options} onPick={ledger => pick(group.key, ledger)} compact />
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="fv-button-secondary" onClick={exportCsv}>Download transactions (CSV)</button>
              <button type="button" className="fv-button-secondary" onClick={() => navigate("/app/jobs/bank-tally")}>Compare with Tally</button>
            </div>
            {skipped.size > 0 && <p className="text-xs text-muted-foreground">{skipped.size} row(s) left out of the Tally file.</p>}
          </MoreOptions>
        </div>
      )}
    </JobShell>
  );
}

function LedgerRow({
  group,
  value,
  options,
  onPick,
  compact = false,
}: {
  group: LedgerGroup;
  value: string;
  options: string[];
  onPick: (ledger: string) => void;
  compact?: boolean;
}) {
  const quick = [...new Set([...(group.source === "ai" ? [group.ledger] : []), ...QUICK[group.direction]])].slice(0, 3);
  return (
    <div className={cn("flex flex-col gap-3 p-3", !compact && "sm:flex-row sm:items-center sm:justify-between")}>
      <div className="min-w-0 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{group.label}</span>
          {group.source === "ai" && <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-800">Suggested</span>}
          {group.source === "remembered" && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Used last time</span>}
        </div>
        <div className="text-xs text-muted-foreground">
          {group.direction === "in" ? "Received" : group.direction === "out" ? "Paid" : "Paid & received"} · {group.count} {group.count === 1 ? "entry" : "entries"} · {inr(group.total)}
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:items-end">
        {!compact && <Choice size="sm" value={value} options={quick.map(item => ({ value: item, label: item }))} onChange={onPick} />}
        <select aria-label={`Ledger for ${group.label}`} value={value} onChange={event => onPick(event.target.value)} className="fv-input h-9 w-full text-xs sm:w-56">
          {!options.includes(value) && <option value={value}>{value}</option>}
          {options.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>
    </div>
  );
}
