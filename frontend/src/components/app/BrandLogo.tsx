import type { CSSProperties } from "react";
import type { IconType } from "react-icons";
import {
  SiFlipkart,
  SiGooglepay,
  SiPaytm,
  SiPhonepe,
  SiQuickbooks,
  SiRazorpay,
  SiShopify,
  SiStripe,
  SiWoocommerce,
  SiXero,
  SiZoho,
} from "react-icons/si";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL;

export type LogoSize = "sm" | "md" | "lg";

interface LogoDef {
  label: string;
  /** Official artwork kept in public/brands, shown exactly as published. */
  file?: string;
  /** A single-colour glyph from the open Simple Icons set. */
  icon?: IconType;
  /** Used only to tint a glyph or an initials tile. */
  color?: string;
  initials?: string;
}

/**
 * One place that decides how every bank, marketplace and accounting package looks, so a row of
 * them always reads as one family. Official artwork is used where we hold it; otherwise a glyph;
 * otherwise a plain initials tile. Showing a name here only identifies an uploaded file's source.
 */
const LOGOS: Record<string, LogoDef> = {
  // Banks with official artwork
  sbi: { label: "State Bank of India", file: "sbi.png" },
  hdfc: { label: "HDFC Bank", file: "hdfc.svg" },
  icici: { label: "ICICI Bank", file: "icici.svg" },
  axis: { label: "Axis Bank", file: "axis.svg" },
  kotak: { label: "Kotak Mahindra Bank", file: "kotak.svg" },
  pnb: { label: "Punjab National Bank", file: "pnb.png" },
  idfc: { label: "IDFC FIRST Bank", file: "idfc.svg" },
  dbs: { label: "DBS Bank India", file: "dbs.svg" },
  // Marketplaces
  amazon: { label: "Amazon", color: "#ff9900", initials: "a" },
  flipkart: { label: "Flipkart", icon: SiFlipkart, color: "#2874f0" },
  meesho: { label: "Meesho", color: "#9f2089", initials: "M" },
  myntra: { label: "Myntra", color: "#ff3f6c", initials: "My" },
  jiomart: { label: "JioMart", color: "#0078ad", initials: "JM" },
  snapdeal: { label: "Snapdeal", color: "#e40046", initials: "Sd" },
  ajio: { label: "AJIO", color: "#2c4152", initials: "AJ" },
  paytm: { label: "Paytm", icon: SiPaytm, color: "#00baf2" },
  shopify: { label: "Shopify", icon: SiShopify, color: "#5e8e3e" },
  woocommerce: { label: "WooCommerce", icon: SiWoocommerce, color: "#96588a" },
  glowroad: { label: "GlowRoad", initials: "GR" },
  shop101: { label: "Shop101", initials: "S1" },
  citymall: { label: "CityMall", initials: "CM" },
  limeroad: { label: "LimeRoad", initials: "LR" },
  // Books and payments
  tally: { label: "Tally", color: "#1b4f8f", initials: "T" },
  zoho: { label: "Zoho Books", icon: SiZoho, color: "#c8202b" },
  quickbooks: { label: "QuickBooks", icon: SiQuickbooks, color: "#2ca01c" },
  xero: { label: "Xero", icon: SiXero, color: "#0f9bc4" },
  razorpay: { label: "Razorpay", icon: SiRazorpay, color: "#3395ff" },
  stripe: { label: "Stripe", icon: SiStripe, color: "#635bff" },
  phonepe: { label: "PhonePe", icon: SiPhonepe, color: "#5f259f" },
  googlepay: { label: "Google Pay", icon: SiGooglepay, color: "#3c4043" },
  cashfree: { label: "Cashfree", initials: "CF" },
};

/** Keys are a name with everything except letters and digits removed, in lower case. */
const ALIASES: Record<string, string> = {
  statebankofindia: "sbi",
  hdfcbank: "hdfc",
  icicibank: "icici",
  axisbank: "axis",
  kotakmahindrabank: "kotak",
  kotakmahindra: "kotak",
  punjabnationalbank: "pnb",
  idfcfirstbank: "idfc",
  idfcfirst: "idfc",
  dbsbankindia: "dbs",
  dbsbank: "dbs",
  zohobooks: "zoho",
  tallyprime: "tally",
  tallyerp9: "tally",
  gpay: "googlepay",
};

function keyFor(name: string): string {
  const flat = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return ALIASES[flat] ?? flat;
}

function initialsOf(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2);
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function hasOfficialLogo(name: string | null | undefined): boolean {
  return Boolean(name && LOGOS[keyFor(name)]?.file);
}

/** The plain name we show next to a logo, so the page never relies on artwork alone. */
export function brandLabel(name: string): string {
  return LOGOS[keyFor(name)]?.label ?? name;
}

interface BrandLogoProps {
  name: string;
  size?: LogoSize;
  /** Show the name beside a glyph or initials tile. Official artwork already carries the name. */
  withName?: boolean;
  muted?: boolean;
  className?: string;
}

export function BrandLogo({ name, size = "md", withName = true, muted = false, className }: BrandLogoProps) {
  const def = LOGOS[keyFor(name)];
  const label = def?.label ?? name;
  const style = def?.color ? ({ "--logo-tint": def.color } as CSSProperties) : undefined;

  if (def?.file) {
    return (
      <span className={cn("fv-logo is-artwork", `is-${size}`, muted && "is-muted", className)} title={label}>
        <img src={`${BASE}brands/${def.file}`} alt={label} loading="lazy" decoding="async" />
      </span>
    );
  }

  const Icon = def?.icon;
  return (
    <span
      className={cn("fv-logo is-mark", `is-${size}`, muted && "is-muted", className)}
      style={style}
      title={label}
    >
      <span className="fv-logo-tile" aria-hidden="true">
        {Icon ? <Icon /> : <span>{def?.initials ?? initialsOf(label)}</span>}
      </span>
      {withName ? <span className="fv-logo-name">{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}

/** A calm row of logos for "works with" strips. */
export function LogoStrip({
  names,
  size = "md",
  muted = true,
  label,
  className,
}: {
  names: string[];
  size?: LogoSize;
  muted?: boolean;
  label: string;
  className?: string;
}) {
  return (
    <ul className={cn("fv-logo-strip", className)} aria-label={label}>
      {names.map(name => (
        <li key={name}>
          <BrandLogo name={name} size={size} muted={muted} />
        </li>
      ))}
    </ul>
  );
}

/** The marketplaces a result was built from, as small logos. "amazon + flipkart" shows both. */
export function PlatformLogos({ platform, size = "sm" }: { platform: string; size?: LogoSize }) {
  const names = platform
    .split("+")
    .map(name => name.trim())
    .filter(name => name && name.toLowerCase() !== "generic" && name.toLowerCase() !== "auto");
  if (names.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {names.map(name => (
        <BrandLogo key={name} name={name} size={size} withName={false} />
      ))}
    </span>
  );
}
