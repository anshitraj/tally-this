import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
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
  fmtDate,
  inr,
  isLockedPdf,
  postFiles,
  postJson,
  takePendingFiles,
  toCsv,
  type StatementCheck,
} from "@/components/jobs/jobUi";

interface Side {
  date: string;
  narration?: string;
  ledgerName?: string;
  debit: number | null;
  credit: number | null;
}

interface CompareItem {
  key: string;
  bucket: "confirmed" | "suggested" | "bank_only" | "tally_only" | "amount_difference" | "duplicate";
  status: string;
  confidence: number;
  why: string[];
  bank?: Side;
  tally?: Side;
}

interface CompareResponse {
  runId: string | null;
  /** True when privacy mode was on: nothing about this run was saved. */
  privacy?: boolean;
  needsAiConsent?: boolean;
  bank?: { bankName: string | null; periodLabel: string | null; count: number; source?: string; check?: StatementCheck | null };
  comparison: { items: CompareItem[]; counts: Record<string, number> };
  needsPassword?: boolean;
  wrongPassword?: boolean;
}

type Stage = "idle" | "working" | "consent" | "done" | "error";
type Decision = "approved" | "rejected" | "needs_info";

const STEPS = ["Reading the bank statement", "Reading Tally entries", "Matching amounts and dates", "Listing differences"];

const BUCKETS: Record<CompareItem["bucket"], { title: string; match: boolean }> = {
  suggested: { title: "Probable match — please confirm", match: true },
  amount_difference: { title: "Amounts differ", match: true },
  duplicate: { title: "Possible duplicate", match: true },
  bank_only: { title: "In bank, missing in Tally", match: false },
  tally_only: { title: "In Tally, missing in bank", match: false },
  confirmed: { title: "Matched", match: true },
};

const ORDER: CompareItem["bucket"][] = ["bank_only", "tally_only", "amount_difference", "suggested", "duplicate"];

function amountOf(side?: Side) {
  return side ? side.debit ?? side.credit : null;
}

export default function BankTallyPage() {
  const [stage, setStage] = useState<Stage>("idle");
  const [bankFile, setBankFile] = useState<File | null>(null);
  const [tallyFile, setTallyFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [data, setData] = useState<CompareResponse | null>(null);
  const [items, setItems] = useState<CompareItem[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [limit, setLimit] = useState(20);
  const [decided, setDecided] = useState<Record<string, Decision>>({});
  const [locked, setLocked] = useState(false);
  const [bankPassword, setBankPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [consentMessage, setConsentMessage] = useState("");

  const compare = async (bank: File, tally: File, password = bankPassword, allowAi = false) => {
    setStage("working");
    setError("");
    setPasswordError("");
    const response = await postFiles<CompareResponse>("/api/jobs/bank-tally/compare", { bank, tally, bankFileName: bank.name, password: password || undefined, allowAi: allowAi ? "1" : undefined });
    if (!response.ok) {
      if (response.data.needsAiConsent) {
        setConsentMessage(response.data.message ?? "");
        setStage("consent");
        return;
      }
      if (response.data.needsPassword) {
        setLocked(true);
        setBankPassword("");
        setPasswordError(response.data.wrongPassword || password ? response.data.message ?? "" : "");
        setStage("idle");
        return;
      }
      setError(response.data.message || "The files could not be compared.");
      setStage("error");
      return;
    }
    setData(response.data);
    setItems(response.data.comparison.items);
    setDecided({});
    setReviewOpen(false);
    setLimit(20);
    setStage("done");
  };

  useEffect(() => {
    const pending = takePendingFiles("bank-tally");
    if (!pending) return;
    // Home already sorted the files; the first is the bank file.
    if (pending[0]) setBankFile(pending[0]);
    if (pending[1]) setTallyFile(pending[1]);
    if (pending[0] && pending[1]) void compare(pending[0], pending[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = async (kind: "bank" | "tally", file: File) => {
    const bank = kind === "bank" ? file : bankFile;
    const tally = kind === "tally" ? file : tallyFile;
    let needsPassword = locked && !bankPassword;
    if (kind === "bank") {
      setBankFile(file);
      setBankPassword("");
      setPasswordError("");
      needsPassword = await isLockedPdf(file);
      setLocked(needsPassword);
    } else {
      setTallyFile(file);
    }
    if (bank && tally && !needsPassword) void compare(bank, tally, kind === "bank" ? "" : bankPassword);
  };

  const unlock = (password: string) => {
    setBankPassword(password);
    setLocked(false);
    if (bankFile && tallyFile) void compare(bankFile, tallyFile, password);
  };

  const decide = async (key: string, status: Decision) => {
    setDecided(current => ({ ...current, [key]: status }));
    setItems(current => current.map(item => item.key === key ? { ...item, status } : item));
    // A private run has nothing on the server to update; the choice stays on this page.
    if (!data?.runId) return;
    const response = await postJson<{ items: CompareItem[] }>(`/api/jobs/runs/${data.runId}/decision`, { key, status });
    if (response.ok && response.data.items) setItems(response.data.items);
  };

  const matched = items.filter(item => item.bucket === "confirmed");
  const attention = items.filter(item => item.bucket !== "confirmed");
  const open = attention.filter(item => !decided[item.key]);

  const downloadReport = () => {
    const label: Record<string, string> = { approved: "Confirmed", rejected: "Not a match", needs_info: "Ask client", suggested: "Not reviewed" };
    downloadText(
      "bank-vs-tally-report.csv",
      toCsv(
        ["Result", "Decision", "Bank date", "Bank narration", "Bank amount", "Tally date", "Tally ledger", "Tally amount", "Why"],
        items.map(item => [
          BUCKETS[item.bucket].title,
          item.bucket === "confirmed" ? "Matched" : label[decided[item.key] ?? "suggested"],
          item.bank?.date ?? "",
          item.bank?.narration ?? "",
          amountOf(item.bank) ?? "",
          item.tally?.date ?? "",
          item.tally?.ledgerName ?? "",
          amountOf(item.tally) ?? "",
          item.why.join("; "),
        ]),
      ),
      "text/csv",
    );
  };

  const downloadJson = async (final: boolean) => {
    const response = await postJson<{ report: unknown }>(`/api/jobs/runs/${data?.runId}/report`, { final });
    if (!response.ok) {
      setError(response.data.message || "Report not created.");
      return;
    }
    downloadText(final ? "reconciliation-final.json" : "reconciliation-draft.json", JSON.stringify(response.data.report, null, 2), "application/json");
  };

  const reset = () => {
    setStage("idle");
    setBankFile(null);
    setTallyFile(null);
    setData(null);
    setItems([]);
    setError("");
  };

  const grouped = ORDER.map(bucket => ({ bucket, rows: attention.filter(item => item.bucket === bucket) })).filter(group => group.rows.length > 0);
  let shown = 0;

  return (
    <JobShell title="Bank ↔ Tally" outcome="Upload your bank statement and Tally export to find mismatches." modeLocked={stage !== "idle" && stage !== "error"}>
      {(stage === "idle" || stage === "error") && (
        <div className="space-y-4">
          {stage === "error" && <Notice tone="error">{error}</Notice>}
          <div className="grid gap-3 sm:grid-cols-2">
            <DropZone size="sm" label="Bank statement" hint="PDF, Excel or CSV" files={bankFile ? [bankFile] : []} onFiles={files => choose("bank", files[0])} />
            <DropZone size="sm" label="Tally export" hint="Bank ledger from Tally · Excel or CSV" accept=".xlsx,.xls,.csv" files={tallyFile ? [tallyFile] : []} onFiles={files => choose("tally", files[0])} />
          </div>
          {locked && bankFile && (
            <PasswordPrompt fileName={bankFile.name} error={passwordError} onSubmit={unlock} onSkip={() => { setLocked(false); if (tallyFile) void compare(bankFile, tallyFile, ""); }} />
          )}
          <p className="text-center text-xs text-muted-foreground">We compare as soon as both files are in. In Tally: open the bank ledger → Export → Excel.</p>
        </div>
      )}

      {stage === "working" && <Working steps={STEPS} />}

      {stage === "consent" && bankFile && tallyFile && (
        <AiConsentPrompt fileName={bankFile.name} message={consentMessage} onAllow={() => compare(bankFile, tallyFile, bankPassword, true)} onCancel={reset} />
      )}

      {stage === "done" && data && (
        <div className="space-y-4">
          <ResultCard
            eyebrow={`${data.bank?.bankName ?? "Bank"} vs Tally${data.bank?.periodLabel ? ` · ${data.bank.periodLabel}` : ""}`}
            actions={
              <>
                {attention.length > 0 ? (
                  <button type="button" className="fv-button-primary h-11 px-6" onClick={() => setReviewOpen(true)}>Review {attention.length} {attention.length === 1 ? "item" : "items"}</button>
                ) : (
                  <button type="button" className="fv-button-primary h-11 px-6" onClick={downloadReport}>Download Report</button>
                )}
                {attention.length > 0 && <button type="button" className="fv-button-secondary h-11" onClick={downloadReport}>Download Report</button>}
                <button type="button" className="text-sm font-medium text-muted-foreground hover:text-foreground sm:ml-auto" onClick={reset}>Compare other files</button>
              </>
            }
          >
            <div className="grid grid-cols-2 gap-6">
              <BigStat value={matched.length} label="matched" tone="good" />
              <BigStat value={attention.length} label="need attention" tone={attention.length > 0 ? "attention" : "good"} />
            </div>
            <StatementProof check={data.bank?.check} />
            {attention.length > 0 && open.length < attention.length && (
              <p className="mt-4 text-sm text-muted-foreground">{attention.length - open.length} of {attention.length} reviewed.</p>
            )}
          </ResultCard>

          {data.privacy && <Notice tone="success">Incognito: this file and result aren’t saved to your workspace. Download the report before leaving.</Notice>}
          {error && <Notice tone="error" onClose={() => setError("")}>{error}</Notice>}

          {reviewOpen && (
            <ResultCard eyebrow="Review">
              {open.length === 0 && (
                <div className="mb-4 flex items-center gap-2 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />Everything is reviewed. Download the report.</div>
              )}
              <div className="space-y-6">
                {grouped.map(group => {
                  if (shown >= limit) return null;
                  const rows = group.rows.slice(0, Math.max(0, limit - shown));
                  shown += rows.length;
                  const isMatch = BUCKETS[group.bucket].match;
                  return (
                    <div key={group.bucket}>
                      <h2 className="font-semibold">{BUCKETS[group.bucket].title} <span className="text-muted-foreground">({group.rows.length})</span></h2>
                      <div className="mt-3 divide-y divide-border rounded-xl border border-border">
                        {rows.map(item => (
                          <div key={item.key} className="space-y-3 p-3">
                            <div className="grid gap-2 text-sm sm:grid-cols-2">
                              <SideBox title="Bank" date={item.bank?.date} text={item.bank?.narration} amount={amountOf(item.bank)} />
                              <SideBox title="Tally" date={item.tally?.date} text={item.tally?.ledgerName} amount={amountOf(item.tally)} />
                            </div>
                            <Choice<Decision>
                              size="sm"
                              value={decided[item.key] ?? null}
                              onChange={status => decide(item.key, status)}
                              options={isMatch
                                ? [{ value: "approved", label: "Confirm match", tone: "good" }, { value: "rejected", label: "Not a match", tone: "bad" }, { value: "needs_info", label: "Ask client" }]
                                : [{ value: "approved", label: "Noted", tone: "good" }, { value: "rejected", label: "Ignore", tone: "bad" }, { value: "needs_info", label: "Ask client" }]}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              {attention.length > limit && (
                <button type="button" className="mt-4 text-sm font-semibold text-[var(--fv-accent-dark)] hover:underline" onClick={() => setLimit(value => value + 20)}>Show more</button>
              )}
            </ResultCard>
          )}

          <MoreOptions>
            <div className="text-sm text-muted-foreground">{data.bank?.count ?? 0} bank rows and {data.comparison.counts.tally ?? 0} Tally rows were compared.</div>
            {data.runId && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="fv-button-secondary" onClick={() => downloadJson(false)}>Draft report (JSON)</button>
                <button type="button" className="fv-button-secondary" onClick={() => downloadJson(true)}>Final report (JSON)</button>
              </div>
            )}
          </MoreOptions>
        </div>
      )}
    </JobShell>
  );
}

function SideBox({ title, date, text, amount }: { title: string; date?: string; text?: string; amount: number | null }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      {date ? (
        <>
          <div className="font-medium">{inr(amount)} <span className="font-normal text-muted-foreground">· {fmtDate(date)}</span></div>
          <div className="truncate text-xs text-muted-foreground">{text || "—"}</div>
        </>
      ) : (
        <div className="text-muted-foreground">Not found</div>
      )}
    </div>
  );
}
