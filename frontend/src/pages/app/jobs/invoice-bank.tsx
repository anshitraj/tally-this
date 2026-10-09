import { useEffect, useState } from "react";
import { CheckCircle2, Sparkles } from "lucide-react";
import {
  AiConsentPrompt,
  BigStat,
  Choice,
  DropZone,
  JobShell,
  Notice,
  PasswordPrompt,
  ResultCard,
  Working,
  downloadText,
  fmtDate,
  inr,
  isLockedPdf,
  postFiles,
  postJson,
  takePendingFiles,
  toCsv,
} from "@/components/jobs/jobUi";

interface Item {
  key: string;
  bucket: "matched" | "suggested" | "amount_mismatch" | "payment_without_invoice" | "invoice_without_payment" | "no_invoice_expected";
  status: string;
  confidence: number;
  why: string[];
  bank?: { narration: string; date: string; debit: number | null; credit: number | null };
  invoice?: { invoiceNumber: string; vendorName: string; total: number; invoiceDate: string | null; label?: string };
}

interface CompareResponse {
  runId: string | null;
  /** True when privacy mode was on: nothing about this run was saved. */
  privacy?: boolean;
  needsAiConsent?: boolean;
  comparison: { items: Item[] };
  invoiceCount: number;
  bankCount: number;
  aiRead: number;
  unreadable: string[];
  needsPassword?: boolean;
  wrongPassword?: boolean;
}

type Stage = "idle" | "working" | "consent" | "done" | "error";
type Decision = "approved" | "rejected" | "needs_info";

const STEPS = ["Reading the bank statement", "Reading invoices", "Matching payments to invoices", "Listing what is missing"];

const GROUPS: Array<{ bucket: Item["bucket"]; title: string; match: boolean }> = [
  { bucket: "payment_without_invoice", title: "Bank entries without an invoice", match: false },
  { bucket: "invoice_without_payment", title: "Invoices not paid yet", match: false },
  { bucket: "amount_mismatch", title: "Amount differs", match: true },
  { bucket: "suggested", title: "Probable match — please confirm", match: true },
];

export default function InvoiceBankPage() {
  const [stage, setStage] = useState<Stage>("idle");
  const [bankFile, setBankFile] = useState<File | null>(null);
  const [invoiceFiles, setInvoiceFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [data, setData] = useState<CompareResponse | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [decided, setDecided] = useState<Record<string, Decision>>({});
  const [locked, setLocked] = useState(false);
  const [bankPassword, setBankPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [consentMessage, setConsentMessage] = useState("");

  const compare = async (bank: File, invoices: File[], password = bankPassword, allowAi = false) => {
    setStage("working");
    setError("");
    setPasswordError("");
    const response = await postFiles<CompareResponse>("/api/jobs/invoice-bank/compare", { bank, invoices, bankFileName: bank.name, password: password || undefined, allowAi: allowAi ? "1" : undefined });
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
    setStage("done");
  };

  useEffect(() => {
    const pending = takePendingFiles("invoice-bank");
    if (!pending?.length) return;
    // Home sorted the files; the first is the bank statement, the rest are invoices.
    const [bank, ...invoices] = pending;
    setBankFile(bank);
    setInvoiceFiles(invoices);
    if (bank && invoices.length > 0) void compare(bank, invoices);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseBank = async (file: File) => {
    setBankFile(file);
    setBankPassword("");
    setPasswordError("");
    const isLocked = await isLockedPdf(file);
    setLocked(isLocked);
    if (!isLocked && invoiceFiles.length > 0) void compare(file, invoiceFiles, "");
  };
  const chooseInvoices = (files: File[]) => {
    setInvoiceFiles(files);
    if (bankFile && !(locked && !bankPassword)) void compare(bankFile, files);
  };
  const unlock = (password: string) => {
    setBankPassword(password);
    setLocked(false);
    if (bankFile && invoiceFiles.length > 0) void compare(bankFile, invoiceFiles, password);
  };

  const decide = async (key: string, status: Decision) => {
    setDecided(current => ({ ...current, [key]: status }));
    setItems(current => current.map(item => item.key === key ? { ...item, status } : item));
    // A private run has nothing on the server to update; the choice stays on this page.
    if (!data?.runId) return;
    const response = await postJson<{ items: Item[] }>(`/api/jobs/runs/${data.runId}/decision`, { key, status });
    if (response.ok && response.data.items) setItems(response.data.items);
  };

  const matched = items.filter(item => item.bucket === "matched");
  const skipped = items.filter(item => item.bucket === "no_invoice_expected");
  const attention = items.filter(item => item.bucket !== "matched" && item.bucket !== "no_invoice_expected");
  const open = attention.filter(item => !decided[item.key]);
  const reviewed = attention.length - open.length;

  const downloadReport = () => {
    const label: Record<string, string> = { approved: "Confirmed", rejected: "Not a match", needs_info: "Ask client", suggested: "Not reviewed" };
    const title = Object.fromEntries(GROUPS.map(group => [group.bucket, group.title]));
    downloadText(
      "invoice-vs-bank-report.csv",
      toCsv(
        ["Result", "Decision", "Bank date", "Bank narration", "Bank amount", "Invoice", "Vendor", "Invoice date", "Invoice total", "Source"],
        items.map(item => [
          item.bucket === "matched" ? "Matched" : item.bucket === "no_invoice_expected" ? "No invoice expected" : title[item.bucket] ?? item.bucket,
          item.bucket === "matched" ? "Matched" : label[decided[item.key] ?? "suggested"],
          item.bank?.date ?? "",
          item.bank?.narration ?? "",
          item.bank ? item.bank.debit ?? item.bank.credit ?? "" : "",
          item.invoice?.invoiceNumber ?? "",
          item.invoice?.vendorName ?? "",
          item.invoice?.invoiceDate ?? "",
          item.invoice?.total ?? "",
          item.invoice?.label ?? "",
        ]),
      ),
      "text/csv",
    );
  };

  const reset = () => {
    setStage("idle");
    setBankFile(null);
    setInvoiceFiles([]);
    setData(null);
    setItems([]);
    setError("");
  };

  return (
    <JobShell title="Invoice ↔ Bank" outcome="Upload invoices and bank statement to find missing or unmatched payments.">
      {(stage === "idle" || stage === "error") && (
        <div className="space-y-4">
          {stage === "error" && <Notice tone="error">{error}</Notice>}
          <div className="grid gap-3 sm:grid-cols-2">
            <DropZone size="sm" label="Bank statement" hint="PDF, Excel or CSV" files={bankFile ? [bankFile] : []} onFiles={files => chooseBank(files[0])} />
            <DropZone size="sm" multiple label="Invoices" hint="Invoice list (Excel/CSV) or invoice PDFs and photos" files={invoiceFiles} onFiles={chooseInvoices} />
          </div>
          {locked && bankFile && (
            <PasswordPrompt fileName={bankFile.name} error={passwordError} onSubmit={unlock} onSkip={() => { setLocked(false); if (invoiceFiles.length > 0) void compare(bankFile, invoiceFiles, ""); }} />
          )}
          <p className="text-center text-xs text-muted-foreground">We match as soon as both are in. Invoice PDFs are read automatically.</p>
        </div>
      )}

      {stage === "working" && <Working steps={STEPS} />}

      {stage === "consent" && bankFile && (
        <AiConsentPrompt
          fileName={invoiceFiles.length > 0 ? `${bankFile.name} + ${invoiceFiles.length} invoice ${invoiceFiles.length === 1 ? "file" : "files"}` : bankFile.name}
          message={consentMessage}
          onAllow={() => compare(bankFile, invoiceFiles, bankPassword, true)}
          onCancel={reset}
        />
      )}

      {stage === "done" && data && (
        <div className="space-y-4">
          <ResultCard
            eyebrow={`${data.invoiceCount} invoices · ${data.bankCount} bank entries`}
            actions={
              <>
                {attention.length > 0 ? (
                  <button type="button" className="fv-button-primary h-11 px-6" onClick={() => setReviewOpen(true)}>Review {attention.length} {attention.length === 1 ? "item" : "items"}</button>
                ) : (
                  <button type="button" className="fv-button-primary h-11 px-6" onClick={downloadReport}>Download Report</button>
                )}
                {attention.length > 0 && <button type="button" className="fv-button-secondary h-11" onClick={downloadReport}>Download Report</button>}
                <button type="button" className="text-sm font-medium text-muted-foreground hover:text-foreground sm:ml-auto" onClick={reset}>Match other files</button>
              </>
            }
          >
            <div className="grid grid-cols-2 gap-6">
              <BigStat value={matched.length} label="matched" tone="good" />
              <BigStat value={attention.length} label="need attention" tone={attention.length > 0 ? "attention" : "good"} />
            </div>
            {reviewed > 0 && <p className="mt-4 text-sm text-muted-foreground">{reviewed} of {attention.length} reviewed.</p>}
            {skipped.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{skipped.length} salary, cash, tax or bank-charge {skipped.length === 1 ? "entry was" : "entries were"} skipped — these usually have no invoice.</p>}
            {data.aiRead > 0 && (
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-800">
                <Sparkles className="h-3.5 w-3.5" />{data.aiRead} invoices read by AI — pending review
              </p>
            )}
          </ResultCard>

          {data.privacy && <Notice tone="success">Privacy mode: nothing here is saved. Download the report before you leave this page.</Notice>}
          {data.unreadable.length > 0 && (
            <Notice tone="warn">Could not read: {data.unreadable.join(", ")}. Upload a clearer copy or an invoice list.</Notice>
          )}

          {reviewOpen && (
            <ResultCard eyebrow="Review">
              {open.length === 0 && (
                <div className="mb-4 flex items-center gap-2 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />Everything is reviewed. Download the report.</div>
              )}
              <div className="space-y-6">
                {GROUPS.map(group => {
                  const rows = attention.filter(item => item.bucket === group.bucket);
                  if (rows.length === 0) return null;
                  return (
                    <div key={group.bucket}>
                      <h2 className="font-semibold">{group.title} <span className="text-muted-foreground">({rows.length})</span></h2>
                      <div className="mt-3 divide-y divide-border rounded-xl border border-border">
                        {rows.slice(0, 40).map(item => (
                          <div key={item.key} className="space-y-3 p-3">
                            <div className="grid gap-2 text-sm sm:grid-cols-2">
                              <div className="min-w-0 rounded-lg bg-muted/50 px-3 py-2">
                                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Bank</div>
                                {item.bank ? (
                                  <>
                                    <div className="font-medium">{inr(item.bank.debit ?? item.bank.credit)} <span className="font-normal text-muted-foreground">· {fmtDate(item.bank.date)}</span></div>
                                    <div className="truncate text-xs text-muted-foreground">{item.bank.narration}</div>
                                  </>
                                ) : <div className="text-muted-foreground">No payment found</div>}
                              </div>
                              <div className="min-w-0 rounded-lg bg-muted/50 px-3 py-2">
                                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Invoice</div>
                                {item.invoice ? (
                                  <>
                                    <div className="font-medium">{inr(item.invoice.total)} <span className="font-normal text-muted-foreground">· {item.invoice.invoiceNumber}</span></div>
                                    <div className="truncate text-xs text-muted-foreground">{item.invoice.vendorName}{item.invoice.label === "AI extracted — pending review" ? " · read by AI" : ""}</div>
                                  </>
                                ) : <div className="text-muted-foreground">No invoice found</div>}
                              </div>
                            </div>
                            <Choice<Decision>
                              size="sm"
                              value={decided[item.key] ?? null}
                              onChange={status => decide(item.key, status)}
                              options={group.match
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
              <p className="mt-4 text-xs text-muted-foreground">Suggested match — needs review. Nothing is marked verified without your decision.</p>
            </ResultCard>
          )}
        </div>
      )}
    </JobShell>
  );
}
