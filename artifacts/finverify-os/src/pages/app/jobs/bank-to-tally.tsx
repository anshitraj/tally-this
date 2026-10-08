import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { CheckCircle2, Sparkles } from "lucide-react";
import {
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
  fmtDate,
  inr,
  isLockedPdf,
  postFiles,
  postJson,
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
  runId?: string;
  bankName?: string | null;
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

type Stage = "idle" | "working" | "password" | "done" | "error";

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
  const [reviewOpen, setReviewOpen] = useState(false);
  const [bankLedger, setBankLedger] = useState("Bank Account");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<{ count: number; fileName: string } | null>(null);
  const [createLedgers, setCreateLedgers] = useState<"yes" | "no">("yes");
  const [suggesting, setSuggesting] = useState(false);
  const reviewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reviewOpen) reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [reviewOpen]);

  const runFile = async (picked: File, pdfPassword?: string) => {
    setFile(picked);
    setStage("working");
    setError("");
    setGenerated(null);
    const response = await postFiles<NormalizeResponse>("/api/jobs/bank-statement/normalize", {
      file: picked,
      fileName: picked.name,
      password: pdfPassword,
    });
    if (!response.ok) {
      if (response.data.needsPassword) {
        setStage("password");
        setError(response.data.wrongPassword || pdfPassword ? response.data.message ?? "" : "");
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
    setReviewOpen(false);
    setBankLedger(data.bankName ?? "Bank Account");
    setStage("done");
    void askAiForLedgers(data);
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
  const totals = txns.filter(txn => !skipped.has(txn.rowNumber)).reduce(
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
  const flaggedRows = txns.filter(txn => txn.confidence < 0.9);
  const groupsToReview = groups.filter(group => !confirmed.has(group.key));
  const rowsToReview = flaggedRows.filter(txn => !checkedRows.has(txn.rowNumber) && !skipped.has(txn.rowNumber));
  const attention = groupsToReview.length + rowsToReview.length;
  const suspenseLeft = groups.filter(group => (ledgers[group.key] ?? group.ledger) === "Suspense").length;
  const aiRead = result?.source === "ai" || result?.source === "ocr";

  const pick = (key: string, ledger: string) => {
    setLedgers(current => ({ ...current, [key]: ledger }));
    setConfirmed(current => new Set(current).add(key));
  };

  const flipRow = (txn: BankTxn) => {
    setFlipped(current => new Set(current).add(txn.rowNumber));
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
    setGenerating(true);
    const client = getActiveClient();
    const mappings = groups.map(group => ({ counterparty: group.key, ledgerName: ledgers[group.key] ?? group.ledger }));
    const response = await postJson<{ xml?: string; fileName?: string; voucherCount?: number }>("/api/jobs/bank-to-tally/xml", {
      runId: result.runId,
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
    if (client?.id && remember.length > 0) {
      void postJson("/api/jobs/ledger-mappings", { clientId: client.id, clientName: client.name, mappings: remember });
    }
  };

  const exportCsv = () => {
    downloadText(
      "bank-transactions.csv",
      toCsv(
        ["Date", "Narration", "Reference", "Debit", "Credit", "Balance", "Ledger"],
        txns.map(txn => {
          const group = groups.find(item => item.key === groupKeyOf(txn));
          return [txn.date, txn.narration, txn.reference ?? "", txn.debit ?? "", txn.credit ?? "", txn.balance ?? "", group ? ledgers[group.key] ?? group.ledger : ""];
        }),
      ),
      "text/csv",
    );
  };

  const reset = () => {
    setStage("idle");
    setResult(null);
    setFile(null);
    setError("");
    setGenerated(null);
  };

  const bankChoices = useMemo(() => {
    const name = result?.bankName;
    const last4 = result?.accountNumberMasked;
    const list = name ? [name, `${name} A/c`, ...(last4 ? [`${name} ${last4}`] : []), "Bank Account"] : ["Bank Account"];
    return [...new Set(list)].map(value => ({ value, label: value }));
  }, [result?.bankName, result?.accountNumberMasked]);

  return (
    <JobShell title="Bank Statement → Tally" outcome="Upload your bank statement and get a Tally-ready file.">
      {(stage === "idle" || stage === "error") && (
        <div className="space-y-4">
          {stage === "error" && <Notice tone="error">{error}</Notice>}
          <DropZone
            label="Upload Bank Statement"
            hint="PDF, Excel, CSV or a photo. The bank is detected automatically."
            files={file ? [file] : []}
            onFiles={files => takeFile(files[0])}
          />
          <p className="text-center text-xs text-muted-foreground">Works with HDFC, SBI, ICICI, Axis, Kotak, Bank of Baroda, PNB and other Indian banks. Scanned PDFs and photos work too.</p>
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

      {stage === "done" && result && (
        <div className="space-y-4">
          <ResultCard
            eyebrow={
              <span className="flex flex-wrap items-center gap-2">
                <span>{result.bankName ?? "Bank statement"}{result.accountNumberMasked ? ` · ••${result.accountNumberMasked}` : ""}{result.periodLabel ? ` · ${result.periodLabel}` : ""}</span>
                {aiRead && <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 normal-case tracking-normal text-sky-800"><Sparkles className="h-3 w-3" />{result.check?.verified ? "Read by AI" : "Read by AI — please check"}</span>}
              </span>
            }
            actions={
              <>
                <button type="button" className="fv-button-primary h-11 px-6" onClick={generate} disabled={generating}>
                  {generating ? "Creating file…" : generated ? "Download Tally File again" : "Generate Tally File"}
                </button>
                {attention > 0 && (
                  <button type="button" className="fv-button-secondary h-11" onClick={() => setReviewOpen(true)}>Review {attention} {attention === 1 ? "item" : "items"}</button>
                )}
                <button type="button" className="text-sm font-medium text-muted-foreground hover:text-foreground sm:ml-auto" onClick={reset}>Upload another statement</button>
              </>
            }
          >
            <div className="grid grid-cols-2 gap-6">
              <BigStat value={txns.length} label="transactions detected" />
              <BigStat value={attention} label={attention === 1 ? "needs review" : "need review"} tone={attention > 0 ? "attention" : "good"} />
            </div>
            <div className="mt-4 text-sm text-muted-foreground">Money in {inr(totals.credit)} · Money out {inr(totals.debit)}</div>
            <StatementProof check={result.check} />
            {!generated && suspenseLeft > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">{suspenseLeft} {suspenseLeft === 1 ? "party goes" : "parties go"} to Suspense unless you choose a ledger.</p>
            )}
          </ResultCard>

          {error && <Notice tone="error" onClose={() => setError("")}>{error}</Notice>}
          {generated && (
            <Notice tone="success">
              <div className="font-semibold">Tally file downloaded — {generated.count} vouchers, all balanced.</div>
              <div className="mt-1">In Tally: open the company → Import → Vouchers → choose <span className="font-mono text-xs">{generated.fileName}</span>.{createLedgers === "yes" ? " Missing ledgers are created under the right groups; your existing ledgers are not changed." : ""}</div>
            </Notice>
          )}

          {reviewOpen && (
            <div ref={reviewRef} className="scroll-mt-4">
            <ResultCard eyebrow="Review">
              {groupsToReview.length === 0 && rowsToReview.length === 0 ? (
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
                                if (choice === "skip") setSkipped(current => new Set(current).add(txn.rowNumber));
                                else setCheckedRows(current => new Set(current).add(txn.rowNumber));
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </ResultCard>
            </div>
          )}

          <MoreOptions>
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
