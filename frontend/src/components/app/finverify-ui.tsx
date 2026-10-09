import type { ReactNode, ComponentType } from "react";
import { motion } from "framer-motion";
import { FileQuestion, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import StatusBadge from "@/components/app/StatusBadge";
import { BRAND } from "@/lib/brand";

export function BrandMark({ compact = false, light = false }: { compact?: boolean; light?: boolean }) {
  return (
    <span className={`fv-brand ${light ? "fv-brand-light" : ""}`} aria-label={BRAND.name}>
      <svg className="fv-brand-symbol" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M4 7h19M12 7v18" stroke="currentColor" strokeWidth="3.5" strokeLinecap="square" />
        <path d="m18 20 4 4 7-11" stroke="currentColor" strokeWidth="3.5" strokeLinecap="square" strokeLinejoin="miter" />
      </svg>
      {!compact && <span className="fv-brand-name">{BRAND.wordmark}<span className="fv-brand-period">.</span></span>}
    </span>
  );
}

export function PageTransition({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
      className={cn("p-4 sm:p-6", className)}
    >
      {children}
    </motion.div>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div>
        {eyebrow && <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</div>}
        <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{title}</h2>
        {description && <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "success" | "warning" | "risk" | "info";
}) {
  const toneClass = {
    default: "bg-muted text-muted-foreground",
    success: "fv-status-verified",
    warning: "fv-status-missing",
    risk: "fv-status-risk",
    info: "fv-status-review",
  }[tone];

  return (
    <div className="fv-card-flat p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-muted-foreground">{label}</div>
        {Icon && (
          <div className={cn("flex h-9 w-9 items-center justify-center rounded-xl", toneClass)}>
            <Icon className="h-4 w-4" />
          </div>
        )}
      </div>
      <div className="text-2xl font-bold tracking-tight text-foreground">{value}</div>
      {detail && <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div>}
    </div>
  );
}

export function MetricTrend({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "up" | "down" | "neutral" }) {
  const className = tone === "up"
    ? "fv-status-verified"
    : tone === "down"
      ? "fv-status-risk"
      : "text-muted-foreground bg-muted";
  return <span className={cn("rounded-full px-2 py-1 text-[11px] font-semibold", className)}>{label}: {value}</span>;
}

export function ScoreCard({
  score,
  title = "Finance Verification Score",
  status,
  description,
}: {
  score: number;
  title?: string;
  status: string;
  description?: string;
}) {
  const circumference = 2 * Math.PI * 48;
  const offset = circumference * (1 - score / 100);
  const color = score >= 85 ? "var(--fv-success)" : score >= 60 ? "var(--fv-warning)" : "var(--fv-risk)";

  return (
    <div className="fv-card p-6">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <div className="relative flex h-32 w-32 shrink-0 items-center justify-center">
          <svg className="absolute inset-0 -rotate-90" viewBox="0 0 128 128">
            <circle cx="64" cy="64" r="48" fill="none" stroke="var(--fv-border)" strokeWidth="10" />
            <motion.circle
              cx="64"
              cy="64"
              r="48"
              fill="none"
              stroke={color}
              strokeLinecap="round"
              strokeWidth="10"
              strokeDasharray={circumference}
              initial={{ strokeDashoffset: circumference }}
              animate={{ strokeDashoffset: offset }}
              transition={{ duration: 0.8, ease: "easeOut" }}
            />
          </svg>
          <div className="text-center">
            <div className="text-3xl font-bold" style={{ color }}>{score}</div>
            <div className="text-[11px] font-semibold text-muted-foreground">/ 100</div>
          </div>
        </div>
        <div>
          <div className="text-sm font-semibold text-muted-foreground">{title}</div>
          <div className="mt-2 text-2xl font-bold tracking-tight">{status}</div>
          {description && <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>}
        </div>
      </div>
    </div>
  );
}

export function ConfidenceBar({ score, label = true }: { score: number | null | undefined; label?: boolean }) {
  if (score === null || score === undefined) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const pct = Math.max(0, Math.min(100, score));
  const color = pct >= 85 ? "bg-success" : pct >= 60 ? "bg-warning" : "bg-destructive";
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
      {label && <span className="w-7 text-xs font-medium tabular-nums text-muted-foreground">{pct}</span>}
    </div>
  );
}


export function EmptyState({
  icon: Icon = FileQuestion,
  title,
  description,
  action,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="fv-card-flat flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Icon className="h-5 w-5" />
      </div>
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function UploadCard({
  title,
  formats,
  status,
  lastFile,
  folderName,
  icon: Icon,
  onClick,
}: {
  title: string;
  formats: string;
  status: "Available now" | "Coming soon" | "Upload-based";
  lastFile?: string;
  folderName?: string;
  icon: LucideIcon;
  onClick?: () => void;
}) {
  const enabled = status !== "Coming soon";
  const uploaded = Boolean(lastFile);
  return (
    <button
      type="button"
      onClick={enabled ? onClick : undefined}
      className={cn(
        "fv-card-flat flex h-full flex-col p-5 text-left transition hover:-translate-y-0.5 hover:border-primary/40",
        !enabled && "cursor-default opacity-75 hover:translate-y-0 hover:border-border"
      )}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <span className={cn("rounded-full border px-2 py-1 text-[11px] font-semibold", enabled ? "fv-status-review" : "fv-status-missing")}>
          {status}
        </span>
      </div>
      <div className="font-semibold">{title}</div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">{formats}</div>
      <div className="mt-auto space-y-2 pt-4">
        <span className={cn(
          "inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold",
          uploaded ? "fv-status-verified" : "border-destructive/25 bg-destructive/10 text-destructive"
        )}>
          {uploaded ? "Uploaded successfully" : "Not uploaded"}
        </span>
        <div className="text-xs leading-5 text-muted-foreground">
          <div>Folder: {folderName ?? title}</div>
          <div className="break-words">{lastFile ? `Last file: ${lastFile}` : "No file uploaded yet"}</div>
        </div>
      </div>
    </button>
  );
}

export function IntegrationCard({
  name,
  handles,
  status,
  notes,
  icon: Icon,
}: {
  name: string;
  handles: string;
  status: string;
  notes: string;
  icon: LucideIcon;
}) {
  const statusClass = status === "Available" || status === "Available now"
    ? "fv-status-verified"
    : status === "Upload-based"
      ? "fv-status-review"
      : "fv-status-missing";

  return (
    <div className="fv-card-flat p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold">{name}</div>
            <div className="text-xs text-muted-foreground">Finance data source</div>
          </div>
        </div>
        <span className={cn("rounded-full border px-2 py-1 text-[11px] font-semibold", statusClass)}>{status}</span>
      </div>
      <p className="text-xs leading-5 text-muted-foreground"><span className="font-semibold text-foreground">Handles:</span> {handles}</p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{notes}</p>
    </div>
  );
}

export function ReportCard({
  title,
  description,
  icon: Icon,
  action,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  action: ReactNode;
}) {
  return (
    <div className="fv-card-flat flex items-center justify-between gap-4 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{title}</div>
          <div className="text-xs leading-5 text-muted-foreground">{description}</div>
        </div>
      </div>
      {action}
    </div>
  );
}

export function ReviewQueueItem({
  title,
  description,
  severity,
  status,
  meta,
  action,
}: {
  title: string;
  description?: ReactNode;
  severity?: ReactNode;
  status: string;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="fv-card-flat p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {severity}
            <div className="font-semibold">{title}</div>
          </div>
          {meta && <div className="mt-1 text-xs text-muted-foreground">{meta}</div>}
          {description && <div className="mt-3 text-sm leading-6 text-muted-foreground">{description}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={status} />
          {action}
        </div>
      </div>
    </div>
  );
}
