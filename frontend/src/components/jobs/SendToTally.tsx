import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Plug } from "lucide-react";
import { Choice, Notice, getJson } from "@/components/jobs/jobUi";
import { useLiveTally } from "@/lib/liveTally";

export interface TallySendResult {
  ok: boolean;
  created?: number;
  expected?: number;
  ledgersCreated?: number;
  messages?: string[];
  errors?: string[];
  message?: string;
  tallyCompany?: string;
}

export interface TallyLedger {
  name: string;
  parent: string;
}

export interface TallyChoices {
  /** An existing Tally bank ledger; empty keeps TallyThis's bank ledger name. */
  bankLedger: string;
  /** An existing Tally ledger for Suspense rows; empty creates "Suspense". */
  suspenseLedger: string;
}

interface TallyStatus {
  running?: boolean;
  companies?: string[];
  message?: string;
}

/**
 * Sends the reviewed entries into the company open in TallyPrime.
 * TallyThis reaches Tally on its own computer or network only; it never claims an import it did not see confirmed.
 */
export function SendToTally({
  entries,
  blockedReason,
  bankHint,
  defaultBankLedger,
  onLedgers,
  onSend,
  showBankChoices = true,
  noun = "entry",
  nounPlural = "entries",
}: {
  entries: number;
  /** Bank statements pick a bank and Suspense ledger; other jobs only need the company. */
  showBankChoices?: boolean;
  noun?: string;
  nounPlural?: string;
  /** Why sending is not allowed yet, e.g. items still under review. */
  blockedReason: string | null;
  /** Words that identify the statement's bank ledger in Tally, e.g. ["DBS", "4321"]. */
  bankHint: string[];
  /** The bank ledger name TallyThis would create. */
  defaultBankLedger: string;
  /** Called with the Tally company's ledger names so the ledger lists can offer them. */
  onLedgers: (names: string[]) => void;
  onSend: (tallyCompany: string, choices: TallyChoices) => Promise<TallySendResult>;
}) {
  const live = useLiveTally();
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<TallyStatus | null>(null);
  const [company, setCompany] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TallySendResult | null>(null);
  const [confirmAgain, setConfirmAgain] = useState(false);
  const [ledgers, setLedgers] = useState<TallyLedger[] | null>(null);
  const [ledgerError, setLedgerError] = useState("");
  const [choices, setChoices] = useState<TallyChoices>({ bankLedger: "", suspenseLedger: "" });

  const check = async () => {
    setChecking(true);
    const response = await getJson<TallyStatus>("/api/jobs/tally/status");
    setChecking(false);
    setStatus(response.data);
    const companies = response.data.companies ?? [];
    if (companies.length > 0 && !companies.includes(company)) setCompany(companies[0]);
  };

  const connected = Boolean(status?.running && (status.companies?.length ?? 0) > 0);

  // Load the company's own ledgers so rows, the bank and Suspense map to names that already exist.
  useEffect(() => {
    if (!connected || !company) return;
    let cancelled = false;
    setLedgers(null);
    setLedgerError("");
    void getJson<{ ledgers?: TallyLedger[] }>(`/api/jobs/tally/ledgers?company=${encodeURIComponent(company)}`).then(response => {
      if (cancelled) return;
      if (!response.ok) { setLedgerError(response.data.message || "Tally did not return its ledger list."); return; }
      const list = response.data.ledgers ?? [];
      setLedgers(list);
      onLedgers(list.map(ledger => ledger.name));
      const banks = list.filter(ledger => /bank/i.test(ledger.parent));
      const hints = bankHint.map(word => word.toLowerCase()).filter(Boolean);
      const bank = banks.find(ledger => hints.length > 0 && hints.every(word => ledger.name.toLowerCase().includes(word)))
        ?? banks.find(ledger => hints.some(word => ledger.name.toLowerCase().includes(word)));
      const suspense = list.find(ledger => /suspense/i.test(ledger.name));
      setChoices({ bankLedger: bank?.name ?? "", suspenseLedger: suspense?.name ?? "" });
    });
    return () => { cancelled = true; };
    // bankHint and onLedgers come from the page; reload only when the company changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, company]);

  const send = async () => {
    setSending(true);
    setConfirmAgain(false);
    const sent = await onSend(company, choices);
    setSending(false);
    setResult(sent);
  };

  // Entries may already be in Tally when some were created or Tally never confirmed either way.
  const sentBefore = Boolean(result && ((result.created ?? 0) > 0 || (result.created == null && !result.errors?.length)));

  // The hosted site cannot reach the accountant's own TallyPrime. Say so, and point to the file that does work.
  if (live.checked && !live.available) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm font-semibold"><Plug className="h-4 w-4" />Sending straight to Tally is not available on this site</div>
        <p className="text-xs text-muted-foreground">
          {live.message || "It only works when TallyThis runs on the same computer as TallyPrime."} In Tally: open the company → Import → Vouchers → choose the downloaded file.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold"><Plug className="h-4 w-4" />Send straight to Tally <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">Experimental</span></div>
        <p className="mt-1 text-xs text-muted-foreground">
          Tried with sample data only, not yet with a live TallyPrime. The downloaded Tally file is the safer route.
          Works when TallyPrime is open on this computer with F1 Help → Settings → Connectivity → TallyPrime acts as: Server (port 9000).
          Back up the Tally company first.
        </p>
      </div>

      {!connected && (
        <button type="button" className="fv-button-secondary inline-flex items-center gap-2" onClick={check} disabled={checking}>
          {checking && <Loader2 className="h-4 w-4 animate-spin" />}
          {checking ? "Looking for Tally…" : status ? "Check again" : "Connect to Tally"}
        </button>
      )}
      {status && !connected && <Notice tone="warn">{status.message || "Tally is not reachable."}</Notice>}

      {connected && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />Connected to Tally</div>
          <div>
            <div className="mb-2 text-xs font-semibold text-muted-foreground">Tally company</div>
            <Choice size="sm" value={company} options={(status?.companies ?? []).map(name => ({ value: name, label: name }))} onChange={setCompany} />
          </div>
          {ledgerError && <Notice tone="warn">{ledgerError} New ledgers will be created where needed.</Notice>}
          {ledgers && !showBankChoices && (
            <p className="text-xs text-muted-foreground">{ledgers.length} ledgers from {company} are available in the ledger lists under More options.</p>
          )}
          {ledgers && showBankChoices && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-semibold text-muted-foreground">
                Bank ledger in Tally
                <select className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground" value={choices.bankLedger} onChange={event => setChoices(current => ({ ...current, bankLedger: event.target.value }))}>
                  <option value="">Create "{defaultBankLedger}"</option>
                  {ledgers.filter(ledger => /bank/i.test(ledger.parent)).map(ledger => <option key={ledger.name} value={ledger.name}>{ledger.name}</option>)}
                </select>
              </label>
              <label className="block text-xs font-semibold text-muted-foreground">
                Suspense ledger in Tally
                <select className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground" value={choices.suspenseLedger} onChange={event => setChoices(current => ({ ...current, suspenseLedger: event.target.value }))}>
                  <option value="">Create "Suspense"</option>
                  {ledgers.filter(ledger => /suspense/i.test(ledger.name) || /suspense/i.test(ledger.parent)).map(ledger => <option key={ledger.name} value={ledger.name}>{ledger.name}</option>)}
                </select>
              </label>
              <p className="text-xs text-muted-foreground sm:col-span-2">{ledgers.length} ledgers from {company} are now in the ledger lists, so rows can go to names that already exist in Tally.</p>
            </div>
          )}
          {blockedReason ? (
            <p className="text-sm text-amber-900">{blockedReason}</p>
          ) : sentBefore && !confirmAgain ? (
            <button type="button" className="fv-button-secondary" onClick={() => setConfirmAgain(true)}>Send again</button>
          ) : confirmAgain ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Sending again creates a second copy of every entry already in Tally.
              <div className="mt-2 flex gap-2">
                <button type="button" className="fv-button-primary h-9 px-4 text-sm" onClick={send} disabled={sending}>Send again anyway</button>
                <button type="button" className="fv-button-secondary h-9 text-sm" onClick={() => setConfirmAgain(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="fv-button-primary h-11 px-6" onClick={send} disabled={sending || !company}>
              {sending ? "Sending to Tally…" : `Send ${entries} ${entries === 1 ? noun : nounPlural} to ${company || "Tally"}`}
            </button>
          )}
        </div>
      )}

      {result && (
        <Notice tone={result.ok ? "success" : "error"}>
          <div className="font-semibold">{result.message}</div>
          {result.ok && result.tallyCompany && <div className="mt-1">Open Day Book in {result.tallyCompany} to see them.</div>}
          {(result.messages ?? result.errors ?? []).length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
              {(result.messages ?? result.errors ?? []).map(line => <li key={line}>{line}</li>)}
            </ul>
          )}
        </Notice>
      )}
    </div>
  );
}
