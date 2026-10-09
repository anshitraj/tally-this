/**
 * Statutory Due-Date Calendar
 * Shows all Indian statutory filing deadlines — GST, TDS, PF, PT, ESI, ROC.
 * CAs get blamed if these are missed, so this must be always visible.
 */
import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Calendar, CheckCircle, Clock, Info } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { PageTransition } from "@/components/app/finverify-ui";

interface DueDate {
  id: string;
  name: string;
  description: string;
  day: number;        // day of month
  month?: number;     // 1-12 if specific month, undefined = every month
  category: "GST" | "TDS" | "PF" | "PT" | "ESI" | "ROC" | "IT";
  penalty: string;
  form?: string;
  who: "All businesses" | "GST registered" | "TDS deductors" | "Companies (ROC)" | "PF employers" | "ESI employers" | "PT state";
}

const STATUTORY_DATES: DueDate[] = [
  // ── GST ───────────────────────────────────────────────────────────────────
  {
    id: "gstr1-monthly",
    name: "GSTR-1 (Monthly)",
    description: "Outward supply details for previous month",
    day: 11,
    category: "GST",
    form: "GSTR-1",
    who: "GST registered",
    penalty: "₹50/day (₹20/day for NIL return), max ₹10,000",
  },
  {
    id: "gstr3b",
    name: "GSTR-3B",
    description: "Monthly GST return — summary of sales, ITC, and tax payment",
    day: 20,
    category: "GST",
    form: "GSTR-3B",
    who: "GST registered",
    penalty: "₹50/day + 18% interest on late payment, max ₹10,000",
  },
  {
    id: "gstr9",
    name: "GSTR-9 (Annual)",
    description: "Annual GST return — due Dec 31 for previous FY",
    day: 31,
    month: 12,
    category: "GST",
    form: "GSTR-9",
    who: "GST registered",
    penalty: "0.25% of turnover, max ₹25,000",
  },
  {
    id: "gst-payment",
    name: "GST Payment",
    description: "Monthly GST liability must be paid by 20th",
    day: 20,
    category: "GST",
    who: "GST registered",
    penalty: "18% p.a. interest on delayed payment",
  },
  // ── TDS ───────────────────────────────────────────────────────────────────
  {
    id: "tds-payment",
    name: "TDS Payment",
    description: "TDS deducted in previous month must be deposited",
    day: 7,
    category: "TDS",
    who: "TDS deductors",
    penalty: "1.5% per month + ₹200/day late fee under section 234E",
  },
  {
    id: "tds-q1",
    name: "TDS Return Q1 (Apr–Jun)",
    description: "Quarterly TDS return for Q1",
    day: 31,
    month: 7,
    category: "TDS",
    form: "Form 24Q / 26Q",
    who: "TDS deductors",
    penalty: "₹200/day late fee, max equal to TDS deducted",
  },
  {
    id: "tds-q2",
    name: "TDS Return Q2 (Jul–Sep)",
    description: "Quarterly TDS return for Q2",
    day: 31,
    month: 10,
    category: "TDS",
    form: "Form 24Q / 26Q",
    who: "TDS deductors",
    penalty: "₹200/day late fee",
  },
  {
    id: "tds-q3",
    name: "TDS Return Q3 (Oct–Dec)",
    description: "Quarterly TDS return for Q3",
    day: 31,
    month: 1,
    category: "TDS",
    form: "Form 24Q / 26Q",
    who: "TDS deductors",
    penalty: "₹200/day late fee",
  },
  {
    id: "tds-q4",
    name: "TDS Return Q4 (Jan–Mar)",
    description: "Quarterly TDS return for Q4",
    day: 31,
    month: 5,
    category: "TDS",
    form: "Form 24Q / 26Q",
    who: "TDS deductors",
    penalty: "₹200/day late fee",
  },
  // ── PF ────────────────────────────────────────────────────────────────────
  {
    id: "pf-payment",
    name: "PF (Provident Fund) Payment",
    description: "Employee and employer PF contribution for previous month",
    day: 15,
    category: "PF",
    who: "PF employers",
    penalty: "12% p.a. interest on delayed payment + damages up to 25%",
  },
  {
    id: "esi-payment",
    name: "ESI Payment",
    description: "Employee State Insurance contribution",
    day: 15,
    category: "ESI",
    who: "ESI employers",
    penalty: "12% p.a. simple interest on delayed payment",
  },
  // ── Advance Tax ───────────────────────────────────────────────────────────
  {
    id: "adv-tax-q1",
    name: "Advance Tax Q1",
    description: "15% of estimated annual tax liability",
    day: 15,
    month: 6,
    category: "IT",
    who: "All businesses",
    penalty: "1% per month interest u/s 234B & 234C",
  },
  {
    id: "adv-tax-q2",
    name: "Advance Tax Q2",
    description: "45% of estimated annual tax liability (cumulative)",
    day: 15,
    month: 9,
    category: "IT",
    who: "All businesses",
    penalty: "1% per month interest u/s 234B & 234C",
  },
  {
    id: "adv-tax-q3",
    name: "Advance Tax Q3",
    description: "75% of estimated annual tax liability (cumulative)",
    day: 15,
    month: 12,
    category: "IT",
    who: "All businesses",
    penalty: "1% per month interest u/s 234B & 234C",
  },
  {
    id: "adv-tax-q4",
    name: "Advance Tax Q4 / Final",
    description: "100% of estimated annual tax liability",
    day: 15,
    month: 3,
    category: "IT",
    who: "All businesses",
    penalty: "1% per month interest u/s 234B & 234C",
  },
  // ── ROC ───────────────────────────────────────────────────────────────────
  {
    id: "mca-mgdt",
    name: "MGT-7 Annual Return",
    description: "Annual return for Companies with MCA — within 60 days of AGM",
    day: 29,
    month: 11,
    category: "ROC",
    form: "MGT-7",
    who: "Companies (ROC)",
    penalty: "₹100/day delay, no ceiling",
  },
  {
    id: "mca-aoc4",
    name: "AOC-4 Financial Statements",
    description: "Filing audited financial statements — within 30 days of AGM",
    day: 29,
    month: 10,
    category: "ROC",
    form: "AOC-4",
    who: "Companies (ROC)",
    penalty: "₹100/day delay",
  },
];

const CATEGORY_COLORS: Record<DueDate["category"], { bg: string; border: string; text: string; badge: string }> = {
  GST: { bg: "bg-blue-50", border: "border-blue-200", text: "text-blue-700", badge: "bg-blue-100 text-blue-700" },
  TDS: { bg: "bg-orange-50", border: "border-orange-200", text: "text-orange-700", badge: "bg-orange-100 text-orange-700" },
  PF:  { bg: "bg-purple-50", border: "border-purple-200", text: "text-purple-700", badge: "bg-purple-100 text-purple-700" },
  ESI: { bg: "bg-pink-50", border: "border-pink-200", text: "text-pink-700", badge: "bg-pink-100 text-pink-700" },
  PT:  { bg: "bg-slate-50", border: "border-slate-200", text: "text-slate-700", badge: "bg-slate-100 text-slate-700" },
  ROC: { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", badge: "bg-emerald-100 text-emerald-700" },
  IT:  { bg: "bg-red-50", border: "border-red-200", text: "text-red-700", badge: "bg-red-100 text-red-700" },
};

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function getDueDatesForMonth(month: number, year: number): (DueDate & { dueDate: Date; status: "overdue" | "upcoming" | "future" })[] {
  const today = new Date();
  return STATUTORY_DATES
    .filter(d => d.month === undefined || d.month === month + 1)
    .map(d => {
      const due = new Date(year, month, d.day);
      const diffDays = Math.ceil((due.getTime() - today.getTime()) / 86400000);
      let status: "overdue" | "upcoming" | "future";
      if (diffDays < 0) status = "overdue";
      else if (diffDays <= 7) status = "upcoming";
      else status = "future";
      return { ...d, dueDate: due, status };
    })
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

export default function StatutoryCalendarPage() {
  const today = new Date();
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [selectedCategory, setSelectedCategory] = useState<DueDate["category"] | "ALL">("ALL");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const dueDates = useMemo(() => {
    const all = getDueDatesForMonth(viewMonth, viewYear);
    return selectedCategory === "ALL" ? all : all.filter(d => d.category === selectedCategory);
  }, [viewMonth, viewYear, selectedCategory]);

  const overdue = dueDates.filter(d => d.status === "overdue").length;
  const upcoming = dueDates.filter(d => d.status === "upcoming").length;

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };

  return (
    <PageTransition className="mx-auto max-w-5xl">
      <PageHeader
        title="Statutory Calendar"
        subtitle="All Indian statutory filing deadlines — GST, TDS, PF, ESI, Advance Tax, ROC"
      />

      {/* Alert bar */}
      {(overdue > 0 || upcoming > 0) && (
        <div className={`mb-5 flex items-center gap-3 rounded-xl border px-4 py-3 ${overdue > 0 ? "border-destructive/30 bg-destructive/8" : "border-warning/30 bg-warning/8"}`}>
          <AlertTriangle className={`h-4 w-4 shrink-0 ${overdue > 0 ? "text-destructive" : "text-warning"}`} />
          <div className="text-sm">
            {overdue > 0 && <><strong className="text-destructive">{overdue} overdue</strong> — </>}
            {upcoming > 0 && <><strong className="text-foreground">{upcoming} due within 7 days</strong> — </>}
            <span className="text-muted-foreground">review before penalties apply.</span>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={prevMonth} className="fv-button-secondary px-2.5">‹</button>
          <span className="min-w-[10rem] text-center text-sm font-semibold text-foreground">{MONTHS[viewMonth]} {viewYear}</span>
          <button type="button" onClick={nextMonth} className="fv-button-secondary px-2.5">›</button>
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {(["ALL", "GST", "TDS", "PF", "ESI", "IT", "ROC"] as const).map(cat => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                selectedCategory === cat
                  ? "bg-foreground text-background"
                  : "border border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Due date list */}
      {dueDates.length === 0 ? (
        <div className="rounded-xl border border-border py-16 text-center">
          <CheckCircle className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
          <div className="font-semibold">No deadlines this month</div>
          <div className="mt-1 text-sm text-muted-foreground">Filter changed or no dates for this category.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {dueDates.map((d, i) => {
            const colors = CATEGORY_COLORS[d.category];
            const diffDays = Math.ceil((d.dueDate.getTime() - today.getTime()) / 86400000);
            const isExpanded = expandedId === d.id;

            return (
              <motion.div
                key={d.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.025 * i }}
                className={`overflow-hidden rounded-xl border transition-all ${
                  d.status === "overdue"
                    ? "border-destructive/30 bg-destructive/5"
                    : d.status === "upcoming"
                    ? "border-warning/30 bg-warning/5"
                    : "border-border bg-card"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : d.id)}
                  className="flex w-full items-center gap-4 p-4 text-left"
                >
                  {/* Day badge */}
                  <div className={`flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl border ${colors.border} ${colors.bg}`}>
                    <div className={`text-lg font-bold leading-none ${colors.text}`}>{d.day}</div>
                    <div className={`text-[10px] font-medium ${colors.text}`}>{MONTHS[viewMonth].slice(0, 3)}</div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{d.name}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${colors.badge}`}>{d.category}</span>
                      {d.form && <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{d.form}</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground truncate">{d.description}</div>
                  </div>

                  <div className="shrink-0 text-right">
                    {d.status === "overdue" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">
                        <AlertTriangle className="h-3 w-3" />
                        Overdue
                      </span>
                    ) : d.status === "upcoming" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-semibold text-warning">
                        <Clock className="h-3 w-3" />
                        {diffDays === 0 ? "Today" : `${diffDays}d`}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{diffDays}d away</span>
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="border-t border-border bg-muted/30 px-5 py-4"
                  >
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <div className="mb-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Applicable to</div>
                        <div className="text-sm text-foreground">{d.who}</div>
                      </div>
                      <div>
                        <div className="mb-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Penalty for late filing</div>
                        <div className="flex items-start gap-1.5 text-sm">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                          <span className="text-destructive font-medium">{d.penalty}</span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      Potential risk — needs CA review before this deadline.
                    </div>
                  </motion.div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}
    </PageTransition>
  );
}
