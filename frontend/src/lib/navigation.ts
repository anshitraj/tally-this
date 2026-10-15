import {
  Activity,
  Banknote,
  BookOpen,
  Building2,
  CalendarClock,
  Calculator,
  ClipboardCheck,
  FileBarChart,
  FileCheck2,
  FileSearch,
  FileSpreadsheet,
  FileText,
  GitCompare,
  History,
  Hourglass,
  Landmark,
  LifeBuoy,
  ListChecks,
  Percent,
  Plug,
  Receipt,
  Scale,
  Settings,
  ShieldCheck,
  ShoppingBag,
  UploadCloud,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export interface NavEntry {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Plain words a person might type to find this page. Only used by search. */
  keywords?: string;
  /** One line shown under the name in search. */
  hint?: string;
}

export interface NavGroup {
  title: string;
  items: NavEntry[];
}

/** Where the client list lives. */
export const WORKSPACE_NAV: NavEntry[] = [
  {
    label: "Clients",
    href: "/app/clients",
    icon: Building2,
    keywords: "customer company business switch add",
    hint: "Add a client or switch whose books you are working on",
  },
];

/** The four everyday jobs. */
export const JOB_NAV: NavEntry[] = [
  {
    label: "Bank → Tally",
    href: "/app/jobs/bank-to-tally",
    icon: FileSpreadsheet,
    keywords: "bank statement pdf excel convert vouchers import xml",
    hint: "Turn a bank statement into a Tally-ready file",
  },
  {
    label: "Bank ↔ Tally",
    href: "/app/jobs/bank-tally",
    icon: GitCompare,
    keywords: "reconcile brs bank reconciliation mismatch missing entries",
    hint: "Find entries missing in Tally or in the bank",
  },
  {
    label: "E-commerce GST",
    href: "/app/jobs/ecommerce-gst",
    icon: ShoppingBag,
    keywords: "amazon flipkart meesho gstr-1 tcs marketplace hsn b2c",
    hint: "Marketplace reports to GST-ready data",
  },
  {
    label: "Invoice ↔ Bank",
    href: "/app/jobs/invoice-bank",
    icon: Receipt,
    keywords: "invoices payments unpaid vendor bills match",
    hint: "See which invoices are paid and which payments lack a bill",
  },
];

export const SECONDARY_NAV: NavEntry[] = [
  {
    label: "Reports",
    href: "/app/reports",
    icon: FileBarChart,
    keywords: "ca pack export download excel pdf",
    hint: "CA review pack and saved outputs",
  },
  {
    label: "Activity",
    href: "/app/activity",
    icon: Activity,
    keywords: "log audit trail who did what",
    hint: "Every upload, decision and download",
  },
];

/**
 * The fifth job. It is the monthly ITC check every CA does, so Home, search and the client page
 * offer it, while the side menu keeps it under Advanced to stay at four everyday jobs.
 */
export const GST_RECON_JOB: NavEntry = {
  label: "GSTR-2B ↔ Books",
  href: "/app/jobs/gstr-2b",
  icon: FileCheck2,
  keywords: "itc 2b purchase register reconcile input tax credit supplier gstr2b",
  hint: "Match GSTR-2B with your purchase register and see ITC at risk",
};

/** Purchase bills to Tally Purchase vouchers: the daily data-entry job. */
export const BILLS_JOB: NavEntry = {
  label: "Bills → Tally",
  href: "/app/jobs/bills-tally",
  icon: FileText,
  keywords: "purchase invoice bill voucher supplier gst input credit import xml vendor",
  hint: "Purchase bills to Tally purchase vouchers",
};

/** The sales register to GSTR-1 tables and a GSTR-3B working. */
export const GST_SALES_JOB: NavEntry = {
  label: "Sales → GSTR-1 & 3B",
  href: "/app/jobs/gst-sales",
  icon: Calculator,
  keywords: "gstr-1 gstr1 gstr-3b gstr3b sales register b2b b2cs hsn return outward liability",
  hint: "Sales register to GSTR-1 tables and a GSTR-3B working",
};

/** Salary sheet to a register with the employer's details, PF, ESI and TDS working, and a Tally entry. */
export const PAYROLL_JOB: NavEntry = {
  label: "Payroll",
  href: "/app/jobs/payroll",
  icon: Banknote,
  keywords: "salary pf esi epf pt tds 192 employer employee payslip register uan",
  hint: "Salary sheet to register, PF/ESI/TDS working and a Tally entry",
};

/** The jobs beyond the four everyday ones. Home and search offer them; the menu keeps them under Advanced. */
export const MORE_JOBS: NavEntry[] = [BILLS_JOB, GST_SALES_JOB, GST_RECON_JOB, PAYROLL_JOB];

/** Everything else. Shown only when the person opens Advanced. */
export const ADVANCED_GROUPS: NavGroup[] = [
  {
    title: "More jobs",
    items: MORE_JOBS,
  },
  {
    title: "GST and TDS",
    items: [
      {
        label: "GST and TDS risks",
        href: "/app/gst-tds-risks",
        icon: Percent,
        keywords: "gst tds risk flags compliance",
        hint: "Potential risks that need CA review",
      },
      {
        label: "26AS TDS",
        href: "/app/tds-recon",
        icon: Scale,
        keywords: "tds 26as form 26q reconcile credit",
        hint: "Compare TDS credit in 26AS with your books",
      },
      {
        label: "Vendor aging",
        href: "/app/vendor-aging",
        icon: Hourglass,
        keywords: "payables overdue msme 43b(h) creditors",
        hint: "Who is owed money, and for how long",
      },
      {
        label: "Statutory calendar",
        href: "/app/statutory-calendar",
        icon: CalendarClock,
        keywords: "due dates gstr tds filing deadline",
        hint: "GST, TDS and ROC due dates",
      },
    ],
  },
  {
    title: "Books and uploads",
    items: [
      {
        label: "Upload center",
        href: "/app/uploads",
        icon: UploadCloud,
        keywords: "files month close import",
        hint: "Every file you have uploaded, month by month",
      },
      {
        label: "Transactions",
        href: "/app/transactions",
        icon: Wallet,
        keywords: "bank entries verify",
        hint: "Bank transactions and their status",
      },
      {
        label: "Invoices",
        href: "/app/invoices",
        icon: Receipt,
        keywords: "purchase sales bills extraction",
        hint: "Purchase and sales invoices",
      },
      {
        label: "Ledger match",
        href: "/app/ledger-match",
        icon: GitCompare,
        keywords: "ledger entries tally",
        hint: "Bank against ledger entries",
      },
      {
        label: "Trial balance",
        href: "/app/trial-balance",
        icon: ListChecks,
        keywords: "tb accounts debit credit",
        hint: "Account-wise debit and credit totals",
      },
      {
        label: "Journal entries",
        href: "/app/journal-entries",
        icon: BookOpen,
        keywords: "adjustments jv",
        hint: "Draft and post journal vouchers",
      },
    ],
  },
  {
    title: "Review and audit",
    items: [
      {
        label: "Reconciliation",
        href: "/app/reconciliation",
        icon: GitCompare,
        keywords: "month close runs",
        hint: "Run and approve month-end reconciliation",
      },
      {
        label: "CA review",
        href: "/app/ca-review",
        icon: ClipboardCheck,
        keywords: "queue comments approve",
        hint: "Items waiting for the CA",
      },
      {
        label: "Action items",
        href: "/app/action-items",
        icon: ListChecks,
        keywords: "todo tasks pending",
        hint: "What still needs doing",
      },
      {
        label: "Verify",
        href: "/app/verify",
        icon: ShieldCheck,
        keywords: "check gstin invoice",
        hint: "Quick checks on GSTIN and invoice details",
      },
      {
        label: "Tax audit",
        href: "/app/tax-audit",
        icon: FileSearch,
        keywords: "3cd clause 44 269ss 40a(3) ledger scrutiny tally xml",
        hint: "Checks on Tally data for tax audit",
      },
      {
        label: "Practice console",
        href: "/app/practice",
        icon: Users,
        keywords: "all clients overview partner",
        hint: "Flagged items across all clients",
      },
    ],
  },
  {
    title: "Data sources",
    items: [
      {
        label: "Gateway settlements",
        href: "/app/gateway-settlements",
        icon: Landmark,
        keywords: "razorpay cashfree stripe payout",
        hint: "Payment gateway payouts and bank match",
      },
      {
        label: "Connections",
        href: "/app/integrations",
        icon: Plug,
        keywords: "integrations tally connector zoho api",
        hint: "What TallyThis can read, and how Tally connects",
      },
    ],
  },
  {
    title: "Account",
    items: [
      {
        label: "History",
        href: "/app/history",
        icon: History,
        keywords: "saved jobs downloads previous results",
        hint: "Reopen a saved result or download again",
      },
      {
        label: "Settings",
        href: "/app/settings",
        icon: Settings,
        keywords: "team profile company security",
        hint: "Company, team and security",
      },
      {
        label: "Admin",
        href: "/app/admin",
        icon: Building2,
        keywords: "workspace usage",
        hint: "Workspace overview",
      },
      {
        label: "Help and docs",
        href: "/app/docs",
        icon: LifeBuoy,
        keywords: "guide how to documentation support",
        hint: "How each job works",
      },
    ],
  },
];

export const ADVANCED_NAV: NavEntry[] = ADVANCED_GROUPS.flatMap(group => group.items);

export const ALL_NAV: NavEntry[] = [
  ...WORKSPACE_NAV,
  ...JOB_NAV,
  ...SECONDARY_NAV,
  ...ADVANCED_NAV,
];

/** The entry that owns a path, matching nested paths such as /app/history/12. */
export function findNav(path: string): NavEntry | undefined {
  const clean = path.split("?")[0];
  return (
    ALL_NAV.find(item => item.href === clean) ??
    ALL_NAV.find(item => clean.startsWith(`${item.href}/`))
  );
}

/** Pages that sit under another page, so the top bar can offer a way back. */
export function parentOf(path: string): NavEntry | undefined {
  const clean = path.split("?")[0];
  const match = clean.match(/^(\/app\/[a-z0-9-]+)\/.+/);
  if (!match) return undefined;
  const parent = ALL_NAV.find(item => item.href === match[1]);
  return parent && parent.href !== clean ? parent : undefined;
}
