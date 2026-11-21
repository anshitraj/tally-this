import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, FileSpreadsheet, UploadCloud } from "lucide-react";
import { BrandLogo } from "@/components/app/BrandLogo";
import type { MarketplaceInfo } from "@/lib/ecommerce";
import { cn } from "@/lib/utils";

const CAPABILITY_TEXT: Record<string, string> = {
  file_import: "Report import",
  sales: "Sales",
  returns: "Returns",
  credit_notes: "Credit notes",
  gst: "GST & HSN",
  tcs: "TCS working",
  documents: "Invoice numbers",
  settlements: "Settlements",
  fees: "Fees",
  api_sync: "API sync",
};

/**
 * One marketplace on the E-commerce page. It says how data arrives (a report you import, never a live connection),
 * what the import covers, and the one thing to do next. A marketplace that cannot import yet says so and offers nothing.
 */
export function MarketplaceCard({ marketplace, index, onOpen, onFiles }: { marketplace: MarketplaceInfo; index: number; onOpen: () => void; onFiles?: (files: File[]) => void }) {
  const reduce = useReducedMotion();
  const available = marketplace.status === "available";
  const usage = marketplace.usage;
  const [over, setOver] = useState(false);
  const takesFiles = available && Boolean(onFiles);
  return (
    <motion.article
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: reduce ? 0 : index * 0.05, ease: "easeOut" }}
      onDragOver={takesFiles ? event => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); setOver(true); } } : undefined}
      onDragLeave={takesFiles ? event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); } : undefined}
      onDrop={takesFiles ? event => {
        event.preventDefault();
        setOver(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) onFiles!(files);
      } : undefined}
      className={cn(
        "group relative flex h-full flex-col rounded-2xl border bg-card p-5 transition-[box-shadow,border-color,transform] duration-200",
        available ? "border-border hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-[var(--fv-shadow-card)] motion-reduce:hover:translate-y-0" : "border-dashed border-border/80 bg-card/60",
        over && "border-[var(--fv-accent)] bg-orange-50/60 ring-2 ring-[var(--fv-accent)]/30",
      )}
      aria-label={marketplace.name}
      data-testid={`marketplace-${marketplace.id}`}
    >
      {over && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl bg-orange-50/90 text-center">
          <UploadCloud className="h-8 w-8 text-[var(--fv-accent)]" aria-hidden="true" />
          <p className="mt-2 text-sm font-semibold text-orange-950">Drop to import {marketplace.name} reports</p>
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-white", !available && "opacity-80")}>
            <BrandLogo name={marketplace.name} size="lg" withName={false} className="[&_img]:!h-9 [&_img]:!w-9 [&_.fv-logo-tile]:!h-9 [&_.fv-logo-tile]:!w-9" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{marketplace.name}</h2>
            <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground"><FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />Report import</p>
          </div>
        </div>
        <span className={cn(
          "shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
          available ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-border bg-muted text-muted-foreground",
        )}>
          {available ? "Available" : "Coming soon"}
        </span>
      </div>

      <p className="mt-4 text-sm text-muted-foreground">{marketplace.description}</p>

      {available && marketplace.capabilities.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="What the import covers">
          {marketplace.capabilities.filter(c => c !== "file_import").map(c => (
            <li key={c} className="rounded-md bg-muted px-2 py-0.5 text-xs text-foreground/80">{CAPABILITY_TEXT[c] ?? c}</li>
          ))}
        </ul>
      )}

      <div className="mt-auto pt-5">
        {takesFiles && !usage && <p className="mb-3 text-xs text-muted-foreground">Or drop the report files on this card.</p>}
        {usage && (
          <p className="mb-3 text-xs text-muted-foreground">
            {usage.transactions.toLocaleString("en-IN")} transactions · {usage.periods} {usage.periods === 1 ? "month" : "months"} imported
          </p>
        )}
        {available ? (
          <button type="button" onClick={onOpen} className="fv-button-primary w-full">
            {usage ? "Open workspace" : `Import ${marketplace.name} reports`}
            <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
          </button>
        ) : (
          <button type="button" disabled className="fv-button-ghost w-full" aria-disabled="true">Coming soon</button>
        )}
      </div>
    </motion.article>
  );
}
