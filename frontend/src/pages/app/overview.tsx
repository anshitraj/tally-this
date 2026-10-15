import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowUpRight,
  Banknote,
  Calculator,
  CalendarClock,
  FileCheck2,
  FileSearch,
  FileSpreadsheet,
  FileText,
  GitCompare,
  Receipt,
  Scale,
  ShoppingBag,
  type LucideIcon,
} from "lucide-react";
import { BankLogos } from "@/components/app/BankLogos";
import {
  DropZone,
  Notice,
  PrivacySwitch,
  postFiles,
  setPendingFiles,
  useClients,
} from "@/components/jobs/jobUi";
import { getUser } from "@/lib/auth";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export const AUTOMATIONS: Array<{
  id: string;
  title: string;
  detail: string;
  href: string;
  icon: LucideIcon;
}> = [
  {
    id: "bank-to-tally",
    title: "Bank Statement → Tally",
    detail: "Convert a bank statement PDF or Excel into Tally vouchers.",
    href: "/app/jobs/bank-to-tally",
    icon: FileSpreadsheet,
  },
  {
    id: "ecommerce-gst",
    title: "E-commerce GST",
    detail: "Turn Amazon, Flipkart and Meesho reports into GSTR-1 data.",
    href: "/app/jobs/ecommerce-gst",
    icon: ShoppingBag,
  },
  {
    id: "bank-tally",
    title: "Bank ↔ Tally",
    detail: "Find entries missing in Tally or in the bank.",
    href: "/app/jobs/bank-tally",
    icon: GitCompare,
  },
  {
    id: "invoice-bank",
    title: "Invoice ↔ Bank",
    detail: "See which invoices are paid and which payments lack a bill.",
    href: "/app/jobs/invoice-bank",
    icon: Receipt,
  },
];

/** Quieter than the four jobs above: the checks a CA reaches for at month end. */
const MORE_TOOLS: Array<{ label: string; href: string; icon: LucideIcon }> = [
  { label: "Bills → Tally", href: "/app/jobs/bills-tally", icon: FileText },
  { label: "Sales → GSTR-1 & 3B", href: "/app/jobs/gst-sales", icon: Calculator },
  { label: "Payroll", href: "/app/jobs/payroll", icon: Banknote },
  { label: "GSTR-2B ↔ Books", href: "/app/jobs/gstr-2b", icon: FileCheck2 },
  { label: "26AS TDS", href: "/app/tds-recon", icon: Scale },
  { label: "Tax audit", href: "/app/tax-audit", icon: FileSearch },
  { label: "Due dates", href: "/app/statutory-calendar", icon: CalendarClock },
];

const RUN_LABELS: Record<string, string> = {
  bank_to_tally: "Bank → Tally",
  bank_tally_reconciliation: "Bank ↔ Tally",
  ecommerce_gst: "E-commerce GST",
  bank_invoice_reconciliation: "Invoice ↔ Bank",
  gstr_2b_reconciliation: "GSTR-2B ↔ Books",
  bills_to_tally: "Bills → Tally",
  gst_sales_register: "Sales → GSTR-1 & 3B",
  payroll_register: "Payroll",
};

interface RunRow {
  id: string;
  title: string;
  run_type?: string;
  status: string;
  created_at?: string;
}

interface DetectResponse {
  job: string | null;
  files: Array<{ fileName: string; kind: string }>;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function when(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default function OverviewPage() {
  const [, navigate] = useLocation();
  const user = getUser();
  const { active } = useClients();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const { data: runs = [] } = useQuery<RunRow[]>({
    queryKey: ["workflow-runs", active?.id ?? null],
    queryFn: async () => {
      const response = await fetch(`${BASE}/api/workflow/runs`);
      if (!response.ok) return [];
      const body = await response.json();
      return Array.isArray(body) ? body : [];
    },
  });

  const recent = runs
    .filter(
      (run) =>
        run.run_type &&
        RUN_LABELS[run.run_type] &&
        !/^Saved ledger/i.test(run.title),
    )
    .slice(0, 6);

  const onDrop = async (files: File[]) => {
    setBusy(true);
    setNotice("");
    const response = await postFiles<DetectResponse>("/api/jobs/detect", {
      files,
    });
    setBusy(false);
    const job = response.data?.job;
    if (!response.ok || !job) {
      setNotice(
        "This looks like something else, so we could not match it to a job. Pick a job below, or drop a bank statement, Tally export, sales register, salary sheet, marketplace report or bills.",
      );
      return;
    }
    // Bank file first: the two-file jobs read it that way.
    const kindOf = new Map(
      (response.data.files ?? []).map((item) => [item.fileName, item.kind]),
    );
    const ordered = [...files].sort(
      (a, b) =>
        Number(kindOf.get(b.name) === "bank_statement") -
        Number(kindOf.get(a.name) === "bank_statement"),
    );
    setPendingFiles(job, ordered);
    navigate(`/app/jobs/${job}`);
  };

  return (
    <div className="fv-workspace-home">
      <div className="fv-workspace-heading">
        <div>
          <span className="fv-micro">
            LET’S MAKE THE BOOKS A LITTLE CLEARER
          </span>
          <h1>
            {greeting()}
            {user?.name ? `, ${user.name.split(" ")[0]}` : ""}
            <span>.</span>
          </h1>
          <p>
            {active ? (
              <>
                Working on{" "}
                <span className="font-semibold text-foreground">
                  {active.name}
                </span>
                .{" "}
              </>
            ) : null}
            Upload a file or choose a job to get started.
          </p>
        </div>
        <span className="fv-workspace-date">
          {new Date().toLocaleDateString("en-IN", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </span>
      </div>

      <div className="fv-home-upload">
        <div className="fv-upload-heading">
          <span className="fv-micro">01 / START WITH YOUR FILE</span>
          <span>Upload → Review → Export</span>
        </div>
        <PrivacySwitch locked={busy} />
        <DropZone
          multiple
          busy={busy}
          label="Drop your files here, or browse"
          hint="Bank statements, Tally exports, sales registers, bills, salary sheets or marketplace reports"
          accept=".pdf,.csv,.xlsx,.xls,.xml,.html,.htm,.png,.jpg,.jpeg,.webp"
          onFiles={onDrop}
        />
        <div className="fv-upload-footer">
          <span>We’ll identify the file and open the right job.</span>
          <span>PDF · Excel · CSV · XML · Photos</span>
        </div>
        {notice && (
          <div className="mt-3">
            <Notice tone="warn" onClose={() => setNotice("")}>
              {notice}
            </Notice>
          </div>
        )}
      </div>

      <div className="fv-home-section-title">
        <h2>What are we working on?</h2>
        <span>Four jobs. One simple flow.</span>
      </div>
      <div className="fv-job-grid">
        {AUTOMATIONS.map((item, index) => {
          const Icon = item.icon;
          return (
            <button
              key={item.href}
              type="button"
              onClick={() => navigate(item.href)}
              className="fv-home-job"
            >
              <span className="fv-home-job-icon">
                <Icon className="h-5 w-5" />
              </span>
              <span className="fv-home-job-copy">
                <span className="block font-semibold">{item.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {item.detail}
                </span>
              </span>
              <span className="fv-home-job-number">
                0{index + 1}
                <ArrowUpRight size={17} />
              </span>
            </button>
          );
        })}
      </div>

      <div className="fv-more-tools" aria-label="More tools">
        <span>More for CAs</span>
        {MORE_TOOLS.map(tool => {
          const Icon = tool.icon;
          return (
            <button key={tool.href} type="button" onClick={() => navigate(tool.href)}>
              <Icon size={15} />
              {tool.label}
            </button>
          );
        })}
      </div>

      <div className="fv-home-section-title">
        <h2>Pick up where you left off</h2>
        <button
          type="button"
          className="text-sm font-semibold text-[var(--fv-accent-dark)] hover:underline"
          onClick={() => navigate("/app/history")}
        >
          View all history
        </button>
      </div>
      <div className="mt-3 divide-y divide-border rounded-2xl border border-border bg-card">
        {recent.length === 0 && (
          <div className="fv-recent-empty">
            <FileSpreadsheet size={24} strokeWidth={1.4} />
            <div>
              <strong>A clear desk. A fresh start.</strong>
              <p>Your saved jobs will appear here after you upload a file.</p>
            </div>
          </div>
        )}
        {recent.map((run) => (
          <button
            key={run.id}
            type="button"
            onClick={() => navigate(`/app/history/${run.id}`)}
            className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-muted/40"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {run.title.replace(/^.*? — /, "") || run.title}
              </span>
              <span className="block text-xs text-muted-foreground">
                {RUN_LABELS[run.run_type ?? ""]} · {when(run.created_at)}
              </span>
            </span>
            <span
              className={
                run.status === "completed"
                  ? "shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800"
                  : "shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold"
              }
            >
              {run.status === "completed"
                ? "Done"
                : run.status === "failed"
                  ? "Failed"
                  : "In progress"}
            </span>
          </button>
        ))}
      </div>
      <div className="fv-home-sources">
        <span>Bank statement uploads</span>
        <BankLogos compact />
        <span>Your files. No bank connection required.</span>
      </div>
    </div>
  );
}
