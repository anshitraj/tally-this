import { useMemo, useState, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertTriangle, ArrowLeft, ChevronDown, Copy, Download, Loader2, MoreVertical } from "lucide-react";
import { Choice, downloadText, inr, toCsv } from "@/components/jobs/jobUi";
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

export interface DownloadItem {
  key: string;
  label: string;
  hint: string;
  busy?: boolean;
  onSelect: () => void;
}

/** What the person can change in the viewer. A saved statement from History has none of this. */
export interface RowEditing<T> {
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
}

type View = "default" | "bank" | "tally";

const PAGE = 200;

const QUESTIONS = {
  out: ["What was this payment for?", "Please share the bill or invoice for this payment.", "Is this a personal expense?"],
  in: ["What was this money received for?", "Please share the invoice for this receipt.", "Is this a loan or capital introduced?"],
};

const HEAD = "px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

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

/**
 * The statement opens full screen, like an editor: balances and downloads along the top, every
 * transaction in one wide table underneath. Going back returns to the job page.
 */
export function StatementViewer<T extends StatementRow>({
  title,
  rows,
  openingBalance,
  closingBalance,
  onClose,
  backLabel = "Back",
  downloads,
  review,
  actions,
  notice,
  edit,
}: {
  title: string;
  rows: T[];
  openingBalance: number | null;
  closingBalance: number | null;
  onClose: () => void;
  backLabel?: string;
  downloads: DownloadItem[];
  /** Shown when something still needs a decision; opens the review. */
  review?: { count: number; onClick: () => void };
  actions?: ReactNode;
  notice?: ReactNode;
  edit?: RowEditing<T>;
}) {
  const [view, setView] = useState<View>("default");
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [asking, setAsking] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [queriesOpen, setQueriesOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const queries = edit?.queries ?? {};
  const queried = useMemo(() => rows.filter(row => queries[row.rowNumber]), [rows, queries]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? rows.filter(row => [row.narration, row.reference, row.date, row.valueDate, dmy(row.date), dmy(row.valueDate), row.debit, row.credit, row.balance, money(row.debit), money(row.credit), money(row.balance)].some(value => String(value ?? "").toLowerCase().includes(term))) : rows;
  }, [rows, search]);
  const visible = filtered.slice(0, shown);
  const hasReferences = rows.some(row => row.reference);
  const totals = useMemo(() => rows.reduce((sum, row) => ({ debit: sum.debit + (row.debit ?? 0), credit: sum.credit + (row.credit ?? 0) }), { debit: 0, credit: 0 }), [rows]);
  const views: Array<[View, string]> = edit ? [["default", "Default"], ["bank", "Bank"], ["tally", "Tally"]] : [["default", "Default"], ["bank", "Bank"]];
  const columns = (view === "bank" ? (hasReferences ? 7 : 6) : view === "tally" ? 5 : 5) + (edit ? 1 : 0);

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
    <DialogPrimitive.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content aria-describedby={undefined} className="fixed inset-0 z-50 flex flex-col bg-background outline-none" data-testid="statement-viewer">
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>

          <header className="shrink-0 border-b border-border bg-card px-3 py-2.5 sm:px-5">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={onClose} aria-label={backLabel} title={backLabel} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-foreground hover:bg-muted">
                <ArrowLeft className="h-5 w-5" />
              </button>
              <span className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs">Opening Bal. <span className="font-semibold tabular-nums">{inr(openingBalance)}</span></span>
              <span className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs">Closing Bal. <span className="font-semibold tabular-nums">{inr(closingBalance)}</span></span>

              <div className="ml-auto flex flex-wrap items-center gap-2">
                <div role="tablist" aria-label="Statement view" className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-sm">
                  {views.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={view === value}
                      onClick={() => setView(value)}
                      className={cn("rounded-md px-3 py-1.5 font-medium transition", view === value ? "bg-[var(--fv-accent)] text-white shadow-sm" : "text-muted-foreground hover:text-foreground")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {review && review.count > 0 && (
                  <button type="button" onClick={review.onClick} className="inline-flex h-9 items-center rounded-lg border border-amber-300 bg-amber-50 px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100">
                    Review {review.count} {review.count === 1 ? "item" : "items"}
                  </button>
                )}
                {edit && (
                  <button type="button" onClick={() => setQueriesOpen(open => !open)} aria-expanded={queriesOpen} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-orange-300 bg-orange-50 px-3 text-sm font-semibold text-orange-800 hover:bg-orange-100">
                    <AlertTriangle className="h-4 w-4" />Raise Query{queried.length > 0 ? ` (${queried.length})` : ""}
                  </button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className="inline-flex h-9 items-center gap-2 rounded-lg border border-foreground/80 bg-card px-3 text-sm font-semibold hover:bg-muted">
                      <Download className="h-4 w-4" />Download<ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-72">
                    {downloads.map(item => (
                      <DropdownMenuItem key={item.key} disabled={item.busy} onSelect={item.onSelect} className="flex-col items-start gap-0.5 py-2">
                        <span className="flex items-center gap-2 font-semibold">{item.busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{item.busy ? `Creating ${item.label}…` : item.label}</span>
                        <span className="text-xs text-muted-foreground">{item.hint}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                {actions}
              </div>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
            {notice && <div className="space-y-2 px-3 pt-3 sm:px-5">{notice}</div>}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3 sm:px-5">
              <input type="search" className="fv-input h-9 w-full sm:w-80" aria-label="Search transactions" placeholder="Search narration, date or amount" value={search} onChange={event => { setSearch(event.target.value); setShown(PAGE); }} />
              <span className="text-xs text-muted-foreground" role="status">
                {search.trim()
                  ? `${filtered.length} of ${rows.length} transactions match. Downloads include every transaction.`
                  : `${rows.length} transactions · Money in ${inr(totals.credit)} · Money out ${inr(totals.debit)}`}
              </span>
            </div>

            {edit && queriesOpen && (
              <div className="mx-3 mb-3 rounded-xl border border-sky-200 bg-sky-50/60 p-4 text-sm sm:mx-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">Questions for the client</h3>
                  {queried.length > 0 && (
                    <div className="flex flex-wrap gap-3">
                      <button type="button" onClick={copyQueries} className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--fv-accent-dark)] hover:underline">
                        <Copy className="h-3.5 w-3.5" />{copied ? "Copied" : "Copy all"}
                      </button>
                      <button type="button" className="text-sm font-medium text-[var(--fv-accent-dark)] hover:underline" onClick={() => downloadText("TallyThis_Client_Questions.csv", toCsv(["Date", "Narration", "Paid", "Received", "Question", "Client answer"], queried.map(row => [dmy(row.date), row.narration, row.debit ?? "", row.credit ?? "", queries[row.rowNumber], ""])), "text/csv")}>Download questions</button>
                    </div>
                  )}
                </div>
                {queried.length === 0 ? (
                  <p className="mt-2 text-muted-foreground">No questions yet. Open the ⋮ menu on any transaction and choose “Raise query with client”.</p>
                ) : (
                  <>
                    <ol className="mt-3 space-y-2">
                      {queried.map(row => (
                        <li key={row.rowNumber} className="min-w-0">
                          <div className="text-xs text-muted-foreground">{dmy(row.date)} · {amountLine(row)} · <span className="break-all">{row.narration}</span></div>
                          <div className="font-medium">{queries[row.rowNumber]}</div>
                        </li>
                      ))}
                    </ol>
                    <p className="mt-3 text-xs text-muted-foreground">These are also on the “Client queries” sheet of the Excel download, with a column for the client's answers.</p>
                  </>
                )}
              </div>
            )}

            <div className="relative overflow-x-auto">
              <table className={cn("w-full border-collapse text-[13px]", view === "default" ? "sm:min-w-[720px]" : "min-w-[720px]")} aria-label="Transactions">
                <thead className="sticky top-0 z-10 bg-muted/70 text-left backdrop-blur">
                  {view === "bank" ? (
                    <tr>
                      <th className={HEAD}>Transaction date</th>
                      <th className={HEAD}>Value date</th>
                      <th className={HEAD}>Details of transaction</th>
                      {hasReferences && <th className={HEAD}>Chq / Ref no</th>}
                      <th className={cn(HEAD, "text-right")}>Debit</th>
                      <th className={cn(HEAD, "text-right")}>Credit</th>
                      <th className={cn(HEAD, "text-right")}>Balance</th>
                      {edit && <th className="w-10 px-2"><span className="sr-only">Actions</span></th>}
                    </tr>
                  ) : view === "tally" ? (
                    <tr>
                      <th className={HEAD}>Date</th>
                      <th className={HEAD}>Narration</th>
                      <th className={cn(HEAD, "text-right")}>Dr. amount</th>
                      <th className={cn(HEAD, "text-right")}>Cr. amount</th>
                      <th className={cn(HEAD, "w-[210px]")}>Tally voucher and ledger</th>
                      <th className="w-10 px-2"><span className="sr-only">Actions</span></th>
                    </tr>
                  ) : (
                    <tr>
                      <th className={HEAD}>Date</th>
                      <th className={HEAD}>Narration</th>
                      <th className={cn(HEAD, "text-right")}>Dr. amount</th>
                      <th className={cn(HEAD, "text-right")}>Cr. amount</th>
                      <th className={cn(HEAD, "hidden text-right sm:table-cell")}>Balance</th>
                      {edit && <th className="w-10 px-2"><span className="sr-only">Actions</span></th>}
                    </tr>
                  )}
                </thead>
                <tbody className="divide-y divide-border">
                  {visible.length === 0 && <tr><td colSpan={columns} className="p-4 text-sm text-muted-foreground">No transactions match. Clear the search to see your statement.</td></tr>}
                  {visible.map(row => {
                    const leftOut = edit?.isLeftOut(row) ?? false;
                    const question = queries[row.rowNumber];
                    const direction = row.credit != null ? "in" : "out";
                    const details = (
                      <td className="max-w-[420px] px-3 py-2">
                        <div className={cn("break-words", leftOut && "line-through")}>{row.narration}</div>
                        {(edit?.needsCheck(row) || leftOut || question) && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {edit?.needsCheck(row) && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Check with statement</span>}
                            {leftOut && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Left out of Tally file</span>}
                            {question && <button type="button" onClick={() => startQuery(row)} className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-800">Query raised</button>}
                          </div>
                        )}
                      </td>
                    );
                    const amounts = (
                      <>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-red-600">{money(row.debit)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-emerald-600">{money(row.credit)}</td>
                      </>
                    );
                    const menu = edit && (
                      <td className="px-2 py-1.5 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button type="button" aria-label={`Actions for ${dmy(row.date)} ${amountLine(row)}`} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                              <MoreVertical className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-64">
                            {(() => {
                              const ledger = edit.ledgerOf(row);
                              return (
                                <>
                                  {!leftOut && !ledger.confirmed && <DropdownMenuItem onSelect={() => edit.onConfirm(row)}>Confirm {ledger.ledger} for {ledger.party}</DropdownMenuItem>}
                                  {!leftOut && ledger.ownChoice && <DropdownMenuItem onSelect={() => edit.onLedger(row, ledger.ledger, "party")}>Use {ledger.ledger} for all {ledger.party} rows</DropdownMenuItem>}
                                </>
                              );
                            })()}
                            <DropdownMenuItem onSelect={() => edit.onFlip(row)}>{direction === "out" ? "It's money in" : "It's money out"}</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => edit.onLeaveOut(row, !leftOut)}>{leftOut ? "Include in Tally file" : "Leave out of Tally file"}</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => startQuery(row)}>{question ? "Edit client query" : "Raise query with client"}</DropdownMenuItem>
                            {question && <DropdownMenuItem onSelect={() => edit.onQuery(row, null)}>Remove query</DropdownMenuItem>}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    );
                    const ledger = edit && view === "tally" ? edit.ledgerOf(row) : null;
                    const voucher = edit && view === "tally" ? edit.voucherOf(row) : null;
                    return [
                      <tr key={row.rowNumber} className={cn("align-top hover:bg-muted/30", leftOut && "bg-muted/30 text-muted-foreground")}>
                        {view === "bank" ? (
                          <>
                            <td className="whitespace-nowrap px-3 py-2 tabular-nums">{dmy(row.date)}</td>
                            <td className="whitespace-nowrap px-3 py-2 tabular-nums">{dmy(row.valueDate)}</td>
                            {details}
                            {hasReferences && <td className="whitespace-nowrap px-3 py-2 text-xs">{row.reference ?? ""}</td>}
                            {amounts}
                            <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(row.balance)}</td>
                          </>
                        ) : view === "tally" && edit && ledger && voucher ? (
                          <>
                            <td className="whitespace-nowrap px-3 py-2 tabular-nums">{dmy(row.date)}</td>
                            {details}
                            {amounts}
                            <td className="px-3 py-1.5">
                              {!leftOut && (
                                <div className="flex flex-col gap-1.5">
                                  <select
                                    aria-label={`Voucher type for ${dmy(row.date)} ${amountLine(row)}`}
                                    value={voucher}
                                    onChange={event => edit.onVoucher(row, event.target.value as VoucherType)}
                                    className="fv-input h-8 w-full text-xs"
                                  >
                                    <option value={direction === "in" ? "Receipt" : "Payment"}>{direction === "in" ? "Receipt" : "Payment"}</option>
                                    <option value="Contra">Contra</option>
                                  </select>
                                  <select
                                    aria-label={`Ledger for ${dmy(row.date)} ${amountLine(row)}`}
                                    value={ledger.ledger}
                                    onChange={event => edit.onLedger(row, event.target.value, "row")}
                                    title={ledger.confirmed ? undefined : "Suggested. Choose or confirm this ledger."}
                                    className={cn("fv-input h-8 w-full text-xs", !ledger.confirmed && "border-amber-300 bg-amber-50/60")}
                                  >
                                    {!edit.ledgerOptions.includes(ledger.ledger) && <option value={ledger.ledger}>{ledger.ledger}</option>}
                                    {edit.ledgerOptions.map(option => <option key={option} value={option}>{option}</option>)}
                                  </select>
                                </div>
                              )}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="whitespace-nowrap px-3 py-2 tabular-nums">{dmy(row.date)}</td>
                            {details}
                            {amounts}
                            <td className="hidden whitespace-nowrap px-3 py-2 text-right tabular-nums sm:table-cell">{money(row.balance)}</td>
                          </>
                        )}
                        {menu}
                      </tr>,
                      edit && asking === row.rowNumber && (
                        <tr key={`${row.rowNumber}-query`} className="bg-sky-50/50">
                          <td colSpan={columns} className="px-3 py-3">
                            <div className="text-xs font-semibold text-sky-900">Question for the client about {dmy(row.date)} · {amountLine(row)}</div>
                            <div className="mt-2"><Choice size="sm" value={draft} options={QUESTIONS[direction].map(text => ({ value: text, label: text }))} onChange={setDraft} /></div>
                            <input
                              aria-label="Question for the client"
                              className="fv-input mt-2 h-9 w-full max-w-xl text-sm"
                              placeholder="Or write your own question"
                              value={draft}
                              maxLength={500}
                              onChange={event => setDraft(event.target.value)}
                            />
                            <div className="mt-2 flex gap-2">
                              <button type="button" className="fv-button-primary h-9 px-4 text-sm" disabled={!draft.trim()} onClick={() => { edit.onQuery(row, draft.trim()); setAsking(null); }}>Save query</button>
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
            {filtered.length > shown && (
              <div className="px-3 py-4 sm:px-5">
                <button type="button" className="text-sm font-medium text-[var(--fv-accent-dark)] hover:underline" onClick={() => setShown(count => count + PAGE)}>
                  Show {Math.min(PAGE, filtered.length - shown)} more of {filtered.length - shown} remaining
                </button>
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
