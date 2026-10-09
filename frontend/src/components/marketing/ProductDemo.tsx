import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "framer-motion";
import {
  ArrowDown,
  Check,
  CheckCircle2,
  Download,
  FileText,
  MousePointer2,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";

export const DEMO_JOBS = [
  {
    title: "Bank Statement → Tally",
    file: "bank-statement.pdf",
    output: "tally-vouchers.xml",
    total: "347 transactions",
    matched: "344 ready",
    attention: "3 need review",
    column: "Tally ledger",
    rows: [
      ["NEFT · Sharma Traders", "₹24,500", "Sundry Debtors"],
      ["UPI · Office supplies", "₹2,400", "Office Expenses"],
      ["Transfer · A. Kumar", "₹8,000", "Choose a ledger"],
    ],
    choice: "Sundry Creditors",
    final: "Tally file ready",
    description:
      "Review the suggested ledger, then generate a file to import into Tally.",
  },
  {
    title: "Bank ↔ Tally",
    file: "bank + tally-export.xlsx",
    output: "reconciliation.csv",
    total: "329 entries",
    matched: "312 matched",
    attention: "17 need attention",
    column: "In Tally",
    rows: [
      ["NEFT · Sharma Traders", "₹24,500", "Matched"],
      ["UPI · Office supplies", "₹2,400", "Matched"],
      ["Transfer · A. Kumar", "₹8,000", "Missing entry"],
    ],
    choice: "Mark for follow-up",
    final: "Review report ready",
    description:
      "Matched entries stay out of the way. Review the differences and export a report.",
  },
  {
    title: "E-commerce GST",
    file: "marketplace-sales.xlsx",
    output: "gst-summary.csv",
    total: "Marketplace data",
    matched: "Data prepared",
    attention: "4 need review",
    column: "GST treatment",
    rows: [
      ["Order · Mumbai", "₹2,400", "Intra-state"],
      ["Order · Bengaluru", "₹3,600", "Inter-state"],
      ["Return · Delhi", "₹1,200", "Review return"],
    ],
    choice: "Confirm return",
    final: "GST summary ready",
    description:
      "Check the exceptions and download prepared data for your GST review.",
  },
  {
    title: "Invoice ↔ Bank",
    file: "invoices + bank.csv",
    output: "payment-review.csv",
    total: "33 invoices",
    matched: "28 matched",
    attention: "5 need attention",
    column: "Payment",
    rows: [
      ["INV-104 · Sharma Traders", "₹24,500", "Matched"],
      ["INV-105 · Studio North", "₹12,000", "Matched"],
      ["INV-106 · A. Kumar", "₹8,000", "Unmatched"],
    ],
    choice: "Mark for follow-up",
    final: "Payment report ready",
    description:
      "See unpaid invoices and payments that still need an invoice, then export.",
  },
] as const;

/** A local, illustrative timeline. It never calls APIs or changes accounting data. */
export function ProductDemo({
  job = 0,
  hero = false,
}: {
  job?: number;
  hero?: boolean;
}) {
  const data = DEMO_JOBS[job];
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInView(ref, { amount: 0.25 });
  const reducedMotion = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!visible || paused || reducedMotion) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        setTick((value) => (value + 1) % 110);
    }, 140);
    return () => window.clearInterval(timer);
  }, [visible, paused, reducedMotion]);

  const phase = reducedMotion
    ? 3
    : tick < 18
      ? 0
      : tick < 46
        ? 1
        : tick < 81
          ? 2
          : 3;
  const resolved = phase === 3 || (phase === 2 && tick >= 68);
  const typed = reducedMotion
    ? data.file
    : data.file.slice(0, Math.max(0, tick * 2));

  return (
    <div
      ref={ref}
      className={`fv-product-demo ${hero ? "is-hero" : ""} ${paused ? "is-paused" : ""} phase-${phase}`}
    >
      {hero && (
        <div className="fv-demo-source" aria-hidden="true">
          <span className="fv-micro">YOUR FILES</span>
          <div className="fv-paper-stack">
            <FileText />
            <span>Bank statement</span>
            <div className="fv-paper-lines">
              <i />
              <i />
              <i />
              <i />
            </div>
            <b>PDF / EXCEL / CSV</b>
          </div>
          <svg className="fv-demo-connector" viewBox="0 0 120 80" fill="none">
            <path d="M0 15H45Q60 15 60 30V55Q60 70 75 70H120" />
            <path
              className="fv-flow-line"
              d="M0 15H45Q60 15 60 30V55Q60 70 75 70H120"
            />
          </svg>
        </div>
      )}
      <figure
        className="fv-demo-window"
        aria-label={`Sample walkthrough: ${data.title}. Upload, check, review, export.`}
      >
        <figcaption className="fv-demo-titlebar">
          <span className="fv-demo-dot" />
          <strong>Sharma & Co.</strong>
          <span className="fv-demo-example">Sample workspace</span>
        </figcaption>
        <div className="fv-demo-content">
          <div className="fv-demo-job">
            <span className="fv-micro">ACCOUNTING, IN MOTION</span>
            <h3>{data.title}</h3>
          </div>
          <div className="fv-demo-file">
            <FileText size={18} />
            <span>
              {typed || "Choose a file"}
              <i className={phase === 0 ? "fv-type-caret" : ""} />
            </span>
            <span className="fv-file-type">
              {phase === 0 ? "Uploading" : <Check size={15} />}
            </span>
          </div>
          <div className="fv-demo-totals">
            <div>
              <strong>{phase === 0 ? "Reading file…" : data.total}</strong>
              <span>{phase < 2 ? "Checking your entries" : data.matched}</span>
            </div>
            <span
              className={`fv-demo-status ${phase >= 2 && !resolved ? "needs-review" : ""}`}
            >
              {phase < 2 ? "Checking" : resolved ? "Reviewed" : data.attention}
            </span>
          </div>
          <div className="fv-demo-table" aria-hidden="true">
            <div className="fv-demo-table-head">
              <span>Transaction</span>
              <span>Amount</span>
              <span>{data.column}</span>
            </div>
            {data.rows.map((row, index) => (
              <div
                key={row[0]}
                className={`fv-demo-row ${phase === 0 || (phase === 1 && tick < 24 + index * 7) ? "is-reading" : ""} ${index === 2 && phase >= 2 && !resolved ? "is-exception" : ""}`}
              >
                <span>{row[0]}</span>
                <span>{row[1]}</span>
                <span>
                  {index === 2 && resolved ? data.choice : row[2]}
                  {(index < 2 && phase >= 1) || resolved ? (
                    <Check size={12} />
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          <div className="fv-demo-decision" aria-hidden="true">
            {phase < 2 ? (
              <>
                <span className="fv-check-spinner" />
                <span>
                  {phase === 0
                    ? "Reading the uploaded file"
                    : "Checking entries against the source"}
                </span>
              </>
            ) : phase === 2 && !resolved ? (
              <>
                <span>One decision at a time</span>
                <span className="fv-demo-choice">
                  {data.choice}
                  <MousePointer2 className="fv-demo-pointer" size={18} />
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 size={17} />
                <span>{data.final}</span>
              </>
            )}
          </div>
          <div
            className={`fv-demo-export ${phase === 3 ? "is-ready" : ""}`}
            aria-hidden="true"
          >
            <Download size={16} />
            <span>{phase === 3 ? data.output : "Review before export"}</span>
            {phase === 3 && <Check size={15} />}
          </div>
        </div>
        <div className="fv-demo-steps" aria-hidden="true">
          {["Upload", "Check", "Review", "Export"].map((name, index) => (
            <span className={index <= phase ? "is-active" : ""} key={name}>
              <i>{index < phase ? <Check size={10} /> : index + 1}</i>
              {name}
            </span>
          ))}
        </div>
      </figure>
      <div className="fv-demo-controls">
        <span>
          <span className="fv-demo-dot" />
          Illustrative walkthrough
        </span>
        <div>
          <button
            type="button"
            aria-label={paused ? "Play walkthrough" : "Pause walkthrough"}
            onClick={() => setPaused((value) => !value)}
            disabled={Boolean(reducedMotion)}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
          <button
            type="button"
            aria-label="Replay walkthrough"
            onClick={() => {
              setTick(0);
              setPaused(false);
            }}
            disabled={Boolean(reducedMotion)}
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>
      {hero && (
        <div className="fv-demo-output" aria-hidden="true">
          <CheckCircle2 size={18} />
          <span>
            From statement <ArrowDown size={12} /> to Tally-ready file
          </span>
        </div>
      )}
    </div>
  );
}
