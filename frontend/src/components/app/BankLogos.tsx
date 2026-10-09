const BASE = import.meta.env.BASE_URL;

export const BANK_LOGOS = [
  { name: "SBI", file: "sbi.png" },
  { name: "HDFC Bank", file: "hdfc.svg" },
  { name: "ICICI Bank", file: "icici.svg" },
  { name: "Axis Bank", file: "axis.svg" },
] as const;

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
