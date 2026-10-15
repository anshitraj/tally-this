import { Landmark } from "lucide-react";
import { BrandLogo, LogoStrip, hasOfficialLogo } from "@/components/app/BrandLogo";

export const BANK_LOGOS = [
  { name: "SBI", file: "sbi.png" },
  { name: "HDFC Bank", file: "hdfc.svg" },
  { name: "ICICI Bank", file: "icici.svg" },
  { name: "Axis Bank", file: "axis.svg" },
] as const;

const SHOWN_BANKS = [
  "State Bank of India",
  "HDFC Bank",
  "ICICI Bank",
  "Axis Bank",
  "Kotak Mahindra Bank",
  "Punjab National Bank",
  "IDFC FIRST Bank",
  "DBS Bank India",
];

/** Identifies the bank found on one uploaded statement. */
export function BankIdentity({ name }: { name: string | null | undefined }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="fv-identity-logo">
        {name && hasOfficialLogo(name)
          ? <BrandLogo name={name} size="md" withName={false} />
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
    <LogoStrip
      names={compact ? SHOWN_BANKS.slice(0, 4) : SHOWN_BANKS}
      size={compact ? "sm" : "md"}
      label="Bank statement sources"
      className={compact ? "is-compact" : undefined}
    />
  );
}
