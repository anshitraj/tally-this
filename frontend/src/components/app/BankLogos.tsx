import { Landmark } from "lucide-react";

const BASE = import.meta.env.BASE_URL;

export const BANK_LOGOS = [
  { name: "SBI", file: "sbi.png" },
  { name: "HDFC Bank", file: "hdfc.svg" },
  { name: "ICICI Bank", file: "icici.svg" },
  { name: "Axis Bank", file: "axis.svg" },
] as const;

const STATEMENT_LOGOS: Record<string, string> = {
  "State Bank of India": "sbi.png",
  "HDFC Bank": "hdfc.svg",
  "ICICI Bank": "icici.svg",
  "Axis Bank": "axis.svg",
  "Kotak Mahindra Bank": "kotak.svg",
  "Punjab National Bank": "pnb.png",
  "IDFC FIRST Bank": "idfc.svg",
};

/** Identifies the bank found on one uploaded statement. */
export function BankIdentity({ name }: { name: string | null | undefined }) {
  const logo = name ? STATEMENT_LOGOS[name] : undefined;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-lg border border-border bg-white p-1.5">
        {logo
          ? <img src={`${BASE}brands/${logo}`} alt="" className="max-h-full max-w-full object-contain" />
          : <Landmark className="h-6 w-6 text-muted-foreground" aria-hidden="true" />}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted-foreground">Statement bank</div>
        <div className="truncate text-base font-semibold text-foreground">{name || "Choose the bank"}</div>
      </div>
    </div>
  );
}

/** Bank names identify uploaded statement sources, never connected accounts. */
export function BankLogos({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`fv-bank-logos ${compact ? "is-compact" : ""}`}
      aria-label="Bank statement sources"
    >
      {BANK_LOGOS.map((bank) => (
        <div key={bank.name} className="fv-bank-logo">
          <img
            src={`${BASE}brands/${bank.file}`}
            alt={bank.name}
            width="140"
            height="32"
            loading="lazy"
          />
        </div>
      ))}
    </div>
  );
}
