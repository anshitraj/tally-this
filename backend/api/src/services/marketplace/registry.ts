/**
 * Marketplaces TallyThis knows about. A marketplace is "available" only when an adapter reads its files; the others are
 * listed as coming soon and advertise nothing they cannot do. Adding one means writing its adapter and switching it on
 * here: the workspace, engines and exports are shared.
 */
import { meeshoAdapter } from "./adapters/meesho";
import type { Capability, MarketplaceAdapter } from "./types";

export interface MarketplaceInfo {
  id: string;
  name: string;
  description: string;
  status: "available" | "coming_soon";
  /** What the marketplace's own files are, so the import screen can say what to upload. */
  sourceFiles: string[];
  capabilities: Capability[];
  /** How data arrives. Every marketplace today is a manual report import, never a live connection. */
  connection: "report_import";
  /** Official artwork under /brands in the website (see SOURCES.md there), or null while none is on file. */
  logo: string | null;
}

const ADAPTERS: Record<string, MarketplaceAdapter> = { meesho: meeshoAdapter };

export const MARKETPLACES: MarketplaceInfo[] = [
  {
    id: "meesho",
    name: "Meesho",
    description: "Automate sales, returns, and GST reconciliation.",
    status: "available",
    sourceFiles: ["tcs_sales.xlsx (GST Reports)", "tcs_sales_return.xlsx (GST Reports)", "Tax_invoice_details.xlsx (Tax Invoice, optional)"],
    capabilities: meeshoAdapter.capabilities,
    connection: "report_import",
    logo: "meesho.png",
  },
  {
    id: "amazon",
    name: "Amazon",
    description: "Sales, settlements, refunds, and GST reconciliation.",
    status: "coming_soon",
    sourceFiles: ["MTR B2C and B2B reports", "Settlement reports"],
    capabilities: [],
    connection: "report_import",
    logo: "amazon.svg",
  },
  {
    id: "flipkart",
    name: "Flipkart",
    description: "Marketplace sales, returns, and settlement reconciliation.",
    status: "coming_soon",
    sourceFiles: ["Sales report", "GST report", "Settlement report"],
    capabilities: [],
    connection: "report_import",
    logo: "flipkart.png",
  },
  {
    id: "myntra",
    name: "Myntra",
    description: "Sales, returns and GST from Myntra seller reports.",
    status: "coming_soon",
    sourceFiles: ["Sales and returns reports"],
    capabilities: [],
    connection: "report_import",
    logo: "myntra.png",
  },
  {
    id: "ajio",
    name: "AJIO",
    description: "Sales, returns and GST from AJIO seller reports.",
    status: "coming_soon",
    sourceFiles: ["Sales and returns reports"],
    capabilities: [],
    connection: "report_import",
    logo: null,
  },
  {
    id: "shopify",
    name: "Shopify",
    description: "Orders, refunds and GST from your own store's exports.",
    status: "coming_soon",
    sourceFiles: ["Orders export"],
    capabilities: [],
    connection: "report_import",
    logo: "shopify.svg",
  },
];

export function marketplaceInfo(id: string): MarketplaceInfo | null {
  return MARKETPLACES.find(item => item.id === id) ?? null;
}

/** The adapter for a marketplace that can import, or null. */
export function adapterFor(id: string): MarketplaceAdapter | null {
  return ADAPTERS[id] ?? null;
}
