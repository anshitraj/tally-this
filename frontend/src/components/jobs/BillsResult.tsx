import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, FileSpreadsheet, Receipt, Sparkles } from "lucide-react";
import {
  BigStat,
  MoreOptions,
  Notice,
  ResultCard,
  downloadBlob,
  downloadText,
  getJson,
  inr,
  postDownload,
  postJson,
} from "@/components/jobs/jobUi";
import { SendToTally, type TallySendResult } from "@/components/jobs/SendToTally";
import { NextSteps } from "@/components/jobs/NextSteps";
import { getActiveClient } from "@/lib/activeClient";
import { cn } from "@/lib/utils";

export interface BillIssue {
  level: "block" | "warn";
  code: string;
  message: string;
}

export interface Bill {
  key: string;
  source: "pdf" | "sheet" | "ai";
  fileName: string;
  row: number;
  supplierName: string;
  supplierGstin: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  placeOfSupply: string | null;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  total: number;
  reverseCharge: boolean;
  ledger?: string | null;
  include?: boolean;
  derived?: boolean;
  note?: boolean;
  gstinValid?: boolean;
  roundOff?: number;
  issues?: BillIssue[];
  blocked?: boolean;
  duplicateOf?: string | null;
  supplierState?: string | null;
}

const EXPENSE_LEDGERS = [
  "Purchase",
  "Rent",
  "Electricity Expenses",
  "Telephone & Internet",
  "Software Expenses",
  "Professional Fees",
  "Office Expenses",
  "Travelling Expenses",
  "Advertisement Expenses",
  "Insurance Premium",
];

const SOURCE_LABEL: Record<Bill["source"], string> = { pdf: "Read from PDF", sheet: "From list", ai: "Read by AI" };

function supplierKey(bill: Pick<Bill, "supplierGstin" | "supplierName">) {
  const gstin = bill.supplierGstin.trim().toUpperCase();
  return gstin || `name:${bill.supplierName.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function firstBlock(bill: Bill) {
  return bill.issues?.find(issue => issue.level === "block")?.message ?? "";
}

function firstWarn(bill: Bill) {
  return bill.issues?.find(issue => issue.level === "warn")?.message ?? "";
}

interface Config {
  purchaseLedger: string;
  igstLedger: string;
  cgstLedger: string;
  sgstLedger: string;
  cessLedger: string;
  roundOffLedger: string;
  createParties: boolean;
  billWise: boolean;
  numbering: "auto" | "series";
}

const DEFAULT_CONFIG: Config = {
  purchaseLedger: "Purchase",
  igstLedger: "Input IGST",
  cgstLedger: "Input CGST",
  sgstLedger: "Input SGST",
  cessLedger: "Input Cess",
  roundOffLedger: "Round Off",
  createParties: true,
  billWise: true,
  numbering: "auto",
};

export interface BillsResultProps {
  bills: Bill[];
  runId: string | null;
  privacy?: boolean;
  recipientGstin?: string | null;
  counts?: { pdf?: number; sheet?: number; ai?: number };
  notes?: string[];
  unreadable?: Array<{ fileName: string; reason: string }>;
  /** A Tally file saved with the run, offered as it was created. */
  savedXml?: { xml: string; title: string } | null;
  onReset?: () => void;
  clientName?: string;
}

/** The bills read from an upload (or a saved run): fix, then download or send to Tally. */
export function BillsResult({ bills: initial, runId, privacy = false, recipientGstin = null, counts, notes = [], unreadable = [], savedXml = null, onReset, clientName }: BillsResultProps) {
  const [bills, setBills] = useState<Bill[]>(initial);
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [partyLedgers, setPartyLedgers] = useState<Record<string, string>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [busy, setBusy] = useState<"xml" | "excel" | "check" | "">("");
  const [message, setMessage] = useState<{ tone: "error" | "success" | "warn"; text: string } | null>(null);
  const [tallyLedgers, setTallyLedgers] = useState<string[]>([]);
  const [tallyCompany, setTallyCompany] = useState("");
  const loadedMappings = useRef(false);
  const client = getActiveClient();
  const name = clientName || client?.name || "Client";

  useEffect(() => {
    setBills(initial);
  }, [initial]);

  // Ledger choices the person made on earlier bills for the same suppliers.
  useEffect(() => {
    if (privacy || loadedMappings.current) return;
    loadedMappings.current = true;
    void getJson<{ mappings?: Array<{ counterparty: string; ledgerName: string }> }>(`/api/jobs/ledger-mappings?clientId=${client?.id ?? ""}`).then(response => {
      const mappings = response.data.mappings ?? [];
      if (mappings.length === 0) return;
      const party: Record<string, string> = {};
      const expense = new Map<string, string>();
      for (const mapping of mappings) {
        if (mapping.counterparty.startsWith("party:")) party[mapping.counterparty.slice(6)] = mapping.ledgerName;
        if (mapping.counterparty.startsWith("bill:")) expense.set(mapping.counterparty.slice(5), mapping.ledgerName);
      }
      setPartyLedgers(party);
      setBills(current => current.map(bill => (bill.ledger ? bill : { ...bill, ledger: expense.get(supplierKey(bill)) ?? bill.ledger ?? null })));
    });
  }, [privacy, client?.id]);

  const included = bills.filter(bill => bill.include !== false && !bill.note);
  const blocked = included.filter(bill => bill.blocked);
  const ready = included.length - blocked.length;
  const leftOut = bills.length - included.length;
  const warned = included.filter(bill => !bill.blocked && firstWarn(bill));
  const totals = useMemo(
    () => included.reduce((sum, bill) => ({ taxable: sum.taxable + bill.taxable, tax: sum.tax + bill.igst + bill.cgst + bill.sgst + bill.cess, total: sum.total + bill.total }), { taxable: 0, tax: 0, total: 0 }),
    [included],
  );

  const payload = () => ({
    clientName: name,
    recipientGstin: recipientGstin ?? undefined,
    bills,
    ...config,
    partyLedgers,
    runId: runId ?? undefined,
    tallyCompany: tallyCompany || undefined,
  });

  const recheck = async (next: Bill[]) => {
    setBills(next);
    setBusy("check");
    const response = await postJson<{ bills: Bill[] }>("/api/jobs/bills/check", { bills: next, recipientGstin: recipientGstin ?? undefined });
    setBusy("");
    if (response.ok && response.data.bills) setBills(response.data.bills);
    else setMessage({ tone: "error", text: response.data.message || "The bills could not be checked again." });
  };

  const patchBill = (key: string, patch: Partial<Bill>) => {
    void recheck(bills.map(bill => (bill.key === key ? { ...bill, ...patch } : bill)));
  };

  const rememberChoices = () => {
    if (privacy) return;
    const mappings: Array<{ counterparty: string; ledgerName: string }> = [];
    for (const bill of bills) {
      if (bill.ledger && bill.ledger !== config.purchaseLedger) mappings.push({ counterparty: `bill:${supplierKey(bill)}`, ledgerName: bill.ledger });
    }
    for (const [key, ledgerName] of Object.entries(partyLedgers)) mappings.push({ counterparty: `party:${key}`, ledgerName });
    if (mappings.length === 0) return;
    void postJson("/api/jobs/ledger-mappings", { clientId: client?.id, clientName: name, mappings });
  };

  const downloadXml = async () => {
    setMessage(null);
    if (savedXml && JSON.stringify(bills) === JSON.stringify(initial)) {
      downloadText(savedXml.title || "purchase-vouchers.xml", savedXml.xml, "application/xml");
      return;
    }
    setBusy("xml");
    const response = await postJson<{ xml: string; fileName: string; message: string; bills?: Bill[] }>("/api/jobs/bills/xml", payload());
    setBusy("");
    if (!response.ok || !response.data.xml) {
      if (response.data.bills) setBills(response.data.bills);
      setReviewOpen(true);
      setMessage({ tone: "error", text: response.data.errors?.slice(0, 3).join(" ") || response.data.message || "The Tally file was not created." });
      return;
    }
    downloadText(response.data.fileName || "purchase-vouchers.xml", response.data.xml, "application/xml");
    setMessage({ tone: "success", text: `${response.data.message} Import it in TallyPrime: Gateway of Tally → Import → Vouchers. Try a copy of the company first.` });
    rememberChoices();
  };

  const downloadExcel = async () => {
    setBusy("excel");
    const response = await postDownload("/api/jobs/bills/excel", { clientName: name, bills, recipientGstin: recipientGstin ?? undefined });
    setBusy("");
    if (!response.ok || !response.blob) {
      setMessage({ tone: "error", text: response.message || "The Excel file could not be created." });
      return;
    }
    downloadBlob("TallyThis_Purchase_Bills.xlsx", response.blob);
  };

  const sendToTally = async (company: string): Promise<TallySendResult> => {
    setTallyCompany(company);
    const response = await postJson<TallySendResult>("/api/jobs/bills/send", { ...payload(), tallyCompany: company });
    if (response.ok) rememberChoices();
    return { ...response.data, ok: response.ok && response.data.ok !== false } as TallySendResult;
  };

  const primaryBlocked = blocked.length > 0;
  const ledgerOptions = [...new Set([...EXPENSE_LEDGERS, ...tallyLedgers])];

  return (
    <div className="space-y-4">
      <ResultCard
        eyebrow={`${bills.length} ${bills.length === 1 ? "bill" : "bills"}${counts?.ai ? ` · ${counts.ai} read by AI` : ""}`}
        actions={
          <>
            {primaryBlocked ? (
              <button type="button" className="fv-button-primary h-11 px-6" onClick={() => setReviewOpen(true)}>
                Fix {blocked.length} {blocked.length === 1 ? "bill" : "bills"}
              </button>
            ) : (
              <button type="button" className="fv-button-primary h-11 px-6" onClick={() => void downloadXml()} disabled={busy === "xml" || included.length === 0}>
                {busy === "xml" ? "Preparing…" : "Download Tally File"}
              </button>
            )}
            <button type="button" className="fv-button-secondary h-11" onClick={() => void downloadExcel()} disabled={busy === "excel"}>
              <FileSpreadsheet className="mr-2 inline h-4 w-4" />Excel
            </button>
            {onReset && (
              <button type="button" className="text-sm font-medium text-muted-foreground hover:text-foreground sm:ml-auto" onClick={onReset}>
                Upload other bills
              </button>
            )}
          </>
        }
      >
        <div className="grid grid-cols-3 gap-6">
          <BigStat value={ready} label="ready for Tally" tone="good" />
          <BigStat value={blocked.length} label={blocked.length === 1 ? "needs a fix" : "need a fix"} tone={blocked.length > 0 ? "attention" : "good"} />
          <BigStat value={leftOut} label="left out" />
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Purchases {inr(totals.taxable)} · GST {inr(totals.tax)} · Total {inr(totals.total)}
        </p>
        {warned.length > 0 && <p className="mt-2 text-xs text-amber-800">{warned.length} {warned.length === 1 ? "bill has" : "bills have"} something worth a look. Potential risk — needs CA review.</p>}
      </ResultCard>

      {message && <Notice tone={message.tone} onClose={() => setMessage(null)}>{message.text}</Notice>}
      {unreadable.length > 0 && (
        <Notice tone="warn">
          <div className="font-semibold">{unreadable.length === 1 ? "One file could not be read" : `${unreadable.length} files could not be read`}</div>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
            {unreadable.slice(0, 6).map(item => <li key={item.fileName}><span className="font-medium">{item.fileName}</span>: {item.reason}</li>)}
          </ul>
        </Notice>
      )}
      {notes.length > 0 && <Notice tone="info">{notes.slice(0, 3).join(" ")}</Notice>}

      <section className="rounded-2xl border border-border bg-card">
        <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold" onClick={() => setReviewOpen(open => !open)} aria-expanded={reviewOpen}>
          <span>{reviewOpen ? "Bills" : primaryBlocked ? "Review the bills that need a fix" : "Show the bills"}</span>
          {reviewOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {reviewOpen && (
          <div className="divide-y divide-border border-t border-border">
            {bills.map(bill => {
              const open = openKey === bill.key;
              const problem = firstBlock(bill);
              const warning = firstWarn(bill);
              return (
                <div key={bill.key} className={cn("px-4 py-3 text-sm", bill.include === false && "bg-muted/30 text-muted-foreground")}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium [overflow-wrap:anywhere]">{bill.supplierName || "Supplier not found"}</div>
                      <div className="text-xs text-muted-foreground">
                        {bill.invoiceNumber || "No invoice number"} · {bill.invoiceDate ?? "No date"} · {SOURCE_LABEL[bill.source]}
                        {bill.supplierGstin ? ` · ${bill.supplierGstin}` : " · no GSTIN"}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <div className="font-semibold">{inr(bill.total)}</div>
                        <div className="text-xs text-muted-foreground">GST {inr(bill.igst + bill.cgst + bill.sgst + bill.cess)}</div>
                      </div>
                      <button type="button" className="text-xs font-semibold text-[var(--fv-accent-dark)] hover:underline" onClick={() => setOpenKey(open ? null : bill.key)}>
                        {open ? "Close" : "Edit"}
                      </button>
                    </div>
                  </div>
                  {bill.include === false ? (
                    <div className="mt-1 text-xs">{bill.note ? "Credit or debit note: not converted here." : bill.duplicateOf ? "Repeats another bill: left out." : "Left out."}</div>
                  ) : problem ? (
                    <div className="mt-1 text-xs font-medium text-red-700">{problem}</div>
                  ) : warning ? (
                    <div className="mt-1 text-xs text-amber-800">{warning}</div>
                  ) : (
                    <div className="mt-1 inline-flex items-center gap-1 text-xs text-emerald-800"><CheckCircle2 className="h-3.5 w-3.5" />Ready</div>
                  )}
                  {open && (
                    <BillEditor
                      bill={bill}
                      ledgerOptions={ledgerOptions}
                      tallyLedgers={tallyLedgers}
                      partyLedger={partyLedgers[supplierKey(bill)] ?? ""}
                      onSave={(patch, partyLedger) => {
                        const key = supplierKey({ supplierGstin: patch.supplierGstin ?? bill.supplierGstin, supplierName: patch.supplierName ?? bill.supplierName });
                        setPartyLedgers(current => {
                          const next = { ...current };
                          delete next[supplierKey(bill)];
                          if (partyLedger) next[key] = partyLedger;
                          return next;
                        });
                        patchBill(bill.key, patch);
                        setOpenKey(null);
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <MoreOptions label="More options">
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-semibold">Ledger names in Tally</h3>
            <p className="mt-1 text-xs text-muted-foreground">These must exist in your Tally company as shown. Change them to match your own names.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {([
                ["purchaseLedger", "Purchase ledger"],
                ["cgstLedger", "Input CGST ledger"],
                ["sgstLedger", "Input SGST ledger"],
                ["igstLedger", "Input IGST ledger"],
                ["cessLedger", "Input cess ledger"],
                ["roundOffLedger", "Round off ledger"],
              ] as const).map(([field, label]) => (
                <label key={field} className="block text-xs font-semibold text-muted-foreground">
                  {label}
                  <input className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground" list="bill-ledger-names" value={config[field]} onChange={event => setConfig(current => ({ ...current, [field]: event.target.value }))} />
                </label>
              ))}
            </div>
            <datalist id="bill-ledger-names">{ledgerOptions.map(option => <option key={option} value={option} />)}</datalist>
          </div>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={config.createParties} onChange={event => setConfig(current => ({ ...current, createParties: event.target.checked }))} />Create supplier ledgers that are not in Tally yet</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={config.billWise} onChange={event => setConfig(current => ({ ...current, billWise: event.target.checked }))} />Track each invoice number as a bill reference (outstanding report)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={config.numbering === "series"} onChange={event => setConfig(current => ({ ...current, numbering: event.target.checked ? "series" : "auto" }))} />Number vouchers PUR-00001, PUR-00002… (otherwise Tally numbers them)</label>
          </div>
          <SendToTally
            entries={included.length - blocked.length}
            noun="purchase voucher"
            nounPlural="purchase vouchers"
            showBankChoices={false}
            blockedReason={primaryBlocked ? `${blocked.length} ${blocked.length === 1 ? "bill needs" : "bills need"} a fix first.` : included.length === 0 ? "No bills are included." : null}
            bankHint={[]}
            defaultBankLedger=""
            onLedgers={setTallyLedgers}
            onSend={sendToTally}
          />
          <p className="text-xs text-muted-foreground">
            The file has been checked to balance to the paise. It has not been proved to import into every Tally company: test it on a copy first, then check the Purchase Register and the GST report.
          </p>
        </div>
      </MoreOptions>

      <NextSteps
        steps={[
          { label: "Match these bills with payments", hint: "Invoice ↔ Bank: upload the bank statement to see what is paid", href: "/app/jobs/invoice-bank", icon: Receipt },
          { label: "Check input credit with GSTR-2B", hint: "GSTR-2B ↔ Books: find bills your suppliers have not filed", href: "/app/jobs/gstr-2b", icon: Sparkles },
        ]}
      />
    </div>
  );
}

function BillEditor({
  bill,
  ledgerOptions,
  tallyLedgers,
  partyLedger,
  onSave,
}: {
  bill: Bill;
  ledgerOptions: string[];
  tallyLedgers: string[];
  partyLedger: string;
  onSave: (patch: Partial<Bill>, partyLedger: string) => void;
}) {
  const [party, setParty] = useState(partyLedger);
  const [form, setForm] = useState({
    supplierName: bill.supplierName,
    supplierGstin: bill.supplierGstin,
    invoiceNumber: bill.invoiceNumber,
    invoiceDate: bill.invoiceDate ?? "",
    taxable: String(bill.taxable),
    cgst: String(bill.cgst),
    sgst: String(bill.sgst),
    igst: String(bill.igst),
    total: String(bill.total),
    ledger: bill.ledger ?? "",
    include: bill.include !== false,
  });
  const set = (field: keyof typeof form, value: string | boolean) => setForm(current => ({ ...current, [field]: value }));
  const number = (value: string) => {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
  };
  const splitTax = (mode: "intra" | "inter") => {
    const tax = Math.max(0, Math.round((number(form.total) - number(form.taxable)) * 100) / 100);
    if (mode === "inter") {
      setForm(current => ({ ...current, igst: String(tax), cgst: "0", sgst: "0" }));
    } else {
      const half = Math.round(tax * 50) / 100;
      setForm(current => ({ ...current, igst: "0", cgst: String(half), sgst: String(Math.round((tax - half) * 100) / 100) }));
    }
  };
  const field = (label: string, key: keyof typeof form, props: { type?: string; mono?: boolean } = {}) => (
    <label className="block text-xs font-semibold text-muted-foreground">
      {label}
      <input
        className={cn("fv-input mt-1 h-10 w-full text-sm font-normal text-foreground", props.mono && "font-mono")}
        type={props.type ?? "text"}
        value={String(form[key])}
        onChange={event => set(key, event.target.value)}
      />
    </label>
  );
  return (
    <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {field("Supplier name", "supplierName")}
        {field("Supplier GSTIN", "supplierGstin", { mono: true })}
        {field("Invoice number", "invoiceNumber")}
        {field("Invoice date", "invoiceDate", { type: "date" })}
        {field("Taxable value", "taxable", { type: "number" })}
        {field("Invoice total", "total", { type: "number" })}
        {field("CGST", "cgst", { type: "number" })}
        {field("SGST", "sgst", { type: "number" })}
        {field("IGST", "igst", { type: "number" })}
        <label className="block text-xs font-semibold text-muted-foreground">
          Book it under
          <input className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground" list="bill-editor-ledgers" value={form.ledger} placeholder="Purchase" onChange={event => set("ledger", event.target.value)} />
          <datalist id="bill-editor-ledgers">{ledgerOptions.map(option => <option key={option} value={option} />)}</datalist>
        </label>
        <label className="block text-xs font-semibold text-muted-foreground sm:col-span-2">
          Supplier ledger in Tally
          <input
            className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground"
            list="bill-editor-parties"
            value={party}
            placeholder={`Create “${form.supplierName || "supplier name"}”`}
            onChange={event => setParty(event.target.value)}
          />
          <datalist id="bill-editor-parties">{tallyLedgers.map(option => <option key={option} value={option} />)}</datalist>
          <span className="mt-1 block font-normal">Pick the ledger this supplier already has in Tally, or leave it empty to create one with the supplier's name.</span>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Tax is the difference between total and taxable value:</span>
        <button type="button" className="fv-button-secondary h-8 text-xs" onClick={() => splitTax("intra")}>CGST + SGST</button>
        <button type="button" className="fv-button-secondary h-8 text-xs" onClick={() => splitTax("inter")}>IGST</button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!form.include} onChange={event => set("include", !event.target.checked)} />Leave this bill out</label>
        <button
          type="button"
          className="fv-button-primary ml-auto h-9 px-4 text-sm"
          onClick={() =>
            onSave(
              {
                supplierName: form.supplierName.trim(),
                supplierGstin: form.supplierGstin.trim().toUpperCase(),
                invoiceNumber: form.invoiceNumber.trim(),
                invoiceDate: form.invoiceDate || null,
                taxable: number(form.taxable),
                cgst: number(form.cgst),
                sgst: number(form.sgst),
                igst: number(form.igst),
                total: number(form.total),
                ledger: form.ledger.trim() || null,
                include: form.include,
                derived: false,
              },
              party.trim(),
            )
          }
        >
          Save and check again
        </button>
      </div>
    </div>
  );
}
