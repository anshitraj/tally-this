import { useMemo, useState } from "react";
import { Copy, MessageSquare, MoreVertical } from "lucide-react";
import { Choice, inr } from "@/components/jobs/jobUi";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type VoucherType = "Receipt" | "Payment" | "Contra";

export interface StatementRow {
  rowNumber: number;
  date: string;
  valueDate?: string | null;
  narration: string;
  reference: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
}

export interface RowLedger {
  ledger: string;
  /** False while the ledger is a suggestion nobody has chosen or confirmed. */
  confirmed: boolean;
  /** True when this row has its own ledger, different from the rest of the party. */
  ownChoice: boolean;
  party: string;
}

type View = "default" | "bank";

const PAGE = 100;

const QUESTIONS = {
  out: ["What was this payment for?", "Please share the bill or invoice for this payment.", "Is this a personal expense?"],
  in: ["What was this money received for?", "Please share the invoice for this receipt.", "Is this a loan or capital introduced?"],
};

function money(value: number | null) {
  return value == null ? "" : value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dmy(iso: string | null | undefined) {
  const match = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : iso ?? "";
}

function amountLine(row: StatementRow) {
  return row.debit != null ? `Paid ${inr(row.debit)}` : `Received ${inr(row.credit)}`;
}

/** Every transaction in statement order, as the bank printed it or as it will go to Tally. */
export function BankStatementTable<T extends StatementRow>({
  rows,
  openingBalance,
  closingBalance,
  ledgerOptions,
  ledgerOf,
  voucherOf,
  isLeftOut,
  needsCheck,
  queries,
  onLedger,
  onConfirm,
  onVoucher,
  onFlip,
  onLeaveOut,
  onQuery,
}: {
  rows: T[];
  openingBalance: number | null;
  closingBalance: number | null;
  ledgerOptions: string[];
  ledgerOf: (row: T) => RowLedger;
  voucherOf: (row: T) => VoucherType;
  isLeftOut: (row: T) => boolean;
  needsCheck: (row: T) => boolean;
  queries: Record<number, string>;
  onLedger: (row: T, ledger: string, scope: "row" | "party") => void;
  onConfirm: (row: T) => void;
  onVoucher: (row: T, voucher: VoucherType) => void;
  onFlip: (row: T) => void;
  onLeaveOut: (row: T, leftOut: boolean) => void;
  onQuery: (row: T, question: string | null) => void;
}) {
  const [view, setView] = useState<View>("default");
  const [shown, setShown] = useState(PAGE);
  const [asking, setAsking] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [queriesOpen, setQueriesOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const queried = useMemo(() => rows.filter(row => queries[row.rowNumber]), [rows, queries]);
  const visible = rows.slice(0, shown);
  const hasReferences = rows.some(row => row.reference);
  const columns = view === "bank" ? (hasReferences ? 8 : 7) : 6;

  const startQuery = (row: StatementRow) => {
    setAsking(row.rowNumber);
    setDraft(queries[row.rowNumber] ?? "");
  };

  const copyQueries = async () => {
    const text = queried.map((row, index) => `${index + 1}. ${dmy(row.date)} · ${amountLine(row)}\n   ${row.narration}\n   Q: ${queries[row.rowNumber]}`).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-sm" role="tablist" aria-label="Statement view">
          {([["default", "Tally view"], ["bank", "Bank statement"]] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              onClick={() => setView(value)}
              className={cn("rounded-md px-3 py-1.5 font-medium transition", view === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-lg border border-border bg-card px-2.5 py-1.5">Opening <span className="font-semibold">{inr(openingBalance)}</span></span>
          <span className="rounded-lg border border-border bg-card px-2.5 py-1.5">Closing <span className="font-semibold">{inr(closingBalance)}</span></span>
          {queried.length > 0 && (
            <button type="button" onClick={() => setQueriesOpen(open => !open)} className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 font-semibold text-sky-900">
              <MessageSquare className="h-3.5 w-3.5" />Client queries ({queried.length})
            </button>
          )}
        </div>
      </div>

      {queriesOpen && queried.length > 0 && (
        <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Questions for the client</h3>
            <button type="button" onClick={copyQueries} className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--fv-accent-dark)] hover:underline">
              <Copy className="h-3.5 w-3.5" />{copied ? "Copied" : "Copy all"}
            </button>
          </div>
          <ol className="mt-3 space-y-2">
            {queried.map(row => (
              <li key={row.rowNumber} className="min-w-0">
                <div className="text-xs text-muted-foreground">{dmy(row.date)} · {amountLine(row)} · <span className="break-all">{row.narration}</span></div>
                <div className="font-medium">{queries[row.rowNumber]}</div>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">These are also on the "Client queries" sheet of the Excel download, with a column for the client's answers.</p>
        </div>
      )}

      <div className="relative overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[700px] text-sm">
          <thead className="bg-muted/50 text-left text-xs font-semibold text-muted-foreground">
            {view === "bank" ? (
              <tr>
                <th className="px-3 py-2.5">Transaction date</th>
                <th className="px-3 py-2.5">Value date</th>
                <th className="px-3 py-2.5">Details of transaction</th>
                {hasReferences && <th className="px-3 py-2.5">Chq / Ref no</th>}
                <th className="px-3 py-2.5 text-right">Debit</th>
                <th className="px-3 py-2.5 text-right">Credit</th>
                <th className="px-3 py-2.5 text-right">Balance</th>
                <th className="w-10 px-2 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            ) : (
              <tr>
                <th className="px-3 py-2.5">Date</th>
                <th className="px-3 py-2.5">Details of transaction</th>
                <th className="px-3 py-2.5 text-right">Debit</th>
                <th className="px-3 py-2.5 text-right">Credit</th>
                <th className="w-[200px] px-3 py-2.5">Tally voucher and ledger</th>
                <th className="w-10 px-2 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            )}
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map(row => {
              const leftOut = isLeftOut(row);
              const ledger = ledgerOf(row);
              const voucher = voucherOf(row);
              const question = queries[row.rowNumber];
              const direction = row.credit != null ? "in" : "out";
              const details = (
                <td className="max-w-[340px] px-3 py-2.5">
                  <div className={cn("break-words", leftOut && "line-through")}>{row.narration}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {needsCheck(row) && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Check with statement</span>}
                    {leftOut && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Left out of Tally file</span>}
                    {question && <button type="button" onClick={() => startQuery(row)} className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-800">Query raised</button>}
                  </div>
                </td>
              );
              const amounts = (
                <>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-red-700">{money(row.debit)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-emerald-700">{money(row.credit)}</td>
                </>
              );
              const menu = (
                <td className="px-2 py-2.5 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label={`Actions for ${dmy(row.date)} ${amountLine(row)}`} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                      {!leftOut && !ledger.confirmed && <DropdownMenuItem onSelect={() => onConfirm(row)}>Confirm {ledger.ledger} for {ledger.party}</DropdownMenuItem>}
                      {!leftOut && ledger.ownChoice && <DropdownMenuItem onSelect={() => onLedger(row, ledger.ledger, "party")}>Use {ledger.ledger} for all {ledger.party} rows</DropdownMenuItem>}
                      <DropdownMenuItem onSelect={() => onFlip(row)}>{direction === "out" ? "It's money in" : "It's money out"}</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onLeaveOut(row, !leftOut)}>{leftOut ? "Include in Tally file" : "Leave out of Tally file"}</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => startQuery(row)}>{question ? "Edit client query" : "Raise query with client"}</DropdownMenuItem>
                      {question && <DropdownMenuItem onSelect={() => onQuery(row, null)}>Remove query</DropdownMenuItem>}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              );
              return [
                <tr key={row.rowNumber} className={cn("align-top", leftOut && "bg-muted/30 text-muted-foreground")}>
                  {view === "bank" ? (
                    <>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{dmy(row.date)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{dmy(row.valueDate)}</td>
                      {details}
                      {hasReferences && <td className="whitespace-nowrap px-3 py-2.5 text-xs">{row.reference ?? ""}</td>}
                      {amounts}
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{money(row.balance)}</td>
                    </>
                  ) : (
                    <>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{dmy(row.date)}</td>
                      {details}
                      {amounts}
                      <td className="px-3 py-2.5">
                        {!leftOut && (
                          <div className="flex flex-col gap-1.5">
                            <select
                              aria-label={`Voucher type for ${dmy(row.date)} ${amountLine(row)}`}
                              value={voucher}
                              onChange={event => onVoucher(row, event.target.value as VoucherType)}
                              className="fv-input h-8 w-full text-xs"
                            >
                              <option value={direction === "in" ? "Receipt" : "Payment"}>{direction === "in" ? "Receipt" : "Payment"}</option>
                              <option value="Contra">Contra</option>
                            </select>
                            <select
                              aria-label={`Ledger for ${dmy(row.date)} ${amountLine(row)}`}
                              value={ledger.ledger}
                              onChange={event => onLedger(row, event.target.value, "row")}
                              title={ledger.confirmed ? undefined : "Suggested. Choose or confirm this ledger."}
                              className={cn("fv-input h-8 w-full text-xs", !ledger.confirmed && "border-amber-300 bg-amber-50/60")}
                            >
                              {!ledgerOptions.includes(ledger.ledger) && <option value={ledger.ledger}>{ledger.ledger}</option>}
                              {ledgerOptions.map(option => <option key={option} value={option}>{option}</option>)}
                            </select>
                          </div>
                        )}
                      </td>
                    </>
                  )}
                  {menu}
                </tr>,
                asking === row.rowNumber && (
                  <tr key={`${row.rowNumber}-query`} className="bg-sky-50/50">
                    <td colSpan={columns} className="px-3 py-3">
                      <div className="text-xs font-semibold text-sky-900">Question for the client about {dmy(row.date)} · {amountLine(row)}</div>
                      <div className="mt-2"><Choice size="sm" value={draft} options={QUESTIONS[direction].map(text => ({ value: text, label: text }))} onChange={setDraft} /></div>
                      <input
                        aria-label="Question for the client"
                        className="fv-input mt-2 h-9 w-full text-sm"
                        placeholder="Or write your own question"
                        value={draft}
                        maxLength={500}
                        onChange={event => setDraft(event.target.value)}
                      />
                      <div className="mt-2 flex gap-2">
                        <button type="button" className="fv-button-primary h-9 px-4 text-sm" disabled={!draft.trim()} onClick={() => { onQuery(row, draft.trim()); setAsking(null); }}>Save query</button>
                        <button type="button" className="fv-button-secondary h-9 text-sm" onClick={() => setAsking(null)}>Cancel</button>
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <button type="button" className="text-sm font-medium text-[var(--fv-accent-dark)] hover:underline" onClick={() => setShown(count => count + PAGE)}>
          Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown} remaining
        </button>
      )}
    </div>
  );
}
