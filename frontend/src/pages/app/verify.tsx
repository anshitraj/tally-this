/**
 * Verify — unified verification hub.
 * One page, 6 tabs: Bank · Invoices · Ledger · GST · Payroll · Gateway
 * Replaces the separate /reconciliation, /ledger-match, /gst-tds-risks,
 * /payroll, /gateway-settlements, and /invoices routes in the sidebar.
 * Those pages still exist at their routes for direct links.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeftRight, AlertTriangle, BadgeIndianRupee, CheckSquare,
  CreditCard, FileText, GitMerge, Users, Zap, ExternalLink,
} from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { PageTransition } from "@/components/app/finverify-ui";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// Tab definitions — each tab embeds the relevant page iframe-free via navigation
const TABS = [
  {
    id: "bank",
    label: "Bank",
    icon: ArrowLeftRight,
    href: "/app/reconciliation",
    description: "Match bank transactions against invoices and ledger",
    color: "text-blue-600",
    bgColor: "bg-blue-50",
    borderColor: "border-blue-200",
  },
  {
    id: "invoices",
    label: "Invoices",
    icon: FileText,
    href: "/app/invoices",
    description: "Review uploaded invoices and AI-extracted fields",
    color: "text-amber-600",
    bgColor: "bg-amber-50",
    borderColor: "border-amber-200",
  },
  {
    id: "ledger",
    label: "Ledger",
    icon: GitMerge,
    href: "/app/ledger-match",
    description: "Match Tally / Zoho ledger exports against bank",
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
    borderColor: "border-emerald-200",
  },
  {
    id: "gst",
    label: "GST & TDS",
    icon: BadgeIndianRupee,
    href: "/app/gst-tds-risks",
    description: "Risk flags, GST-2B ITC match, and TDS exposure",
    color: "text-red-600",
    bgColor: "bg-red-50",
    borderColor: "border-red-200",
  },
  {
    id: "payroll",
    label: "Payroll",
    icon: Users,
    href: "/app/payroll",
    description: "Salary disbursements vs bank debits reconciliation",
    color: "text-purple-600",
    bgColor: "bg-purple-50",
    borderColor: "border-purple-200",
  },
  {
    id: "gateway",
    label: "Gateway",
    icon: CreditCard,
    href: "/app/gateway-settlements",
    description: "Razorpay / Cashfree settlement vs bank credits",
    color: "text-sky-600",
    bgColor: "bg-sky-50",
    borderColor: "border-sky-200",
  },
] as const;

type TabId = (typeof TABS)[number]["id"];

// Per-tab quick-stat cards (pulled from respective API endpoints)
interface TabStats {
  label: string;
  value: string;
  tone?: "success" | "warning" | "risk" | "neutral";
}

const TAB_QUICK_ACTIONS: Record<TabId, { label: string; href: string }[]> = {
  bank: [
    { label: "Run reconciliation", href: "/app/reconciliation" },
    { label: "View transactions", href: "/app/transactions" },
  ],
  invoices: [
    { label: "View all invoices", href: "/app/invoices" },
    { label: "Upload invoices", href: "/app/uploads" },
  ],
  ledger: [
    { label: "Open ledger match", href: "/app/ledger-match" },
    { label: "Upload Tally export", href: "/app/uploads" },
  ],
  gst: [
    { label: "GST / TDS risks", href: "/app/gst-tds-risks" },
    { label: "GSTR-2B reconciliation", href: "/app/gstr-2b-recon" },
  ],
  payroll: [
    { label: "View payroll", href: "/app/payroll" },
    { label: "Upload payroll sheet", href: "/app/uploads" },
  ],
  gateway: [
    { label: "Gateway settlements", href: "/app/gateway-settlements" },
    { label: "Upload settlement", href: "/app/uploads" },
  ],
};

export default function VerifyPage() {
  const [activeTab, setActiveTab] = useState<TabId>("bank");
  const [, navigate] = useLocation();

  const currentTab = TABS.find(t => t.id === activeTab)!;
  const quickActions = TAB_QUICK_ACTIONS[activeTab];

  return (
    <PageTransition className="mx-auto max-w-6xl">
      <PageHeader
        title="Verify"
        subtitle="One place for all your verification — pick a category, run checks, export."
        actions={
          <button
            type="button"
            onClick={() => navigate(currentTab.href)}
            className="fv-button-primary"
          >
            <Zap className="h-4 w-4" />
            Open {currentTab.label} in full
          </button>
        }
      />

      {/* Tab row */}
      <div className="mb-6 flex flex-wrap gap-1 rounded-xl border border-border bg-muted/20 p-1">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex flex-1 min-w-[6rem] items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                active
                  ? "bg-card shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
        >
          {/* Current tab hero */}
          <div className={`mb-6 rounded-2xl border ${currentTab.borderColor} ${currentTab.bgColor} p-6`}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/80 border ${currentTab.borderColor}`}>
                  <currentTab.icon className={`h-5 w-5 ${currentTab.color}`} />
                </div>
                <div>
                  <div className="text-base font-semibold text-foreground">{currentTab.label} Verification</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">{currentTab.description}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => navigate(currentTab.href)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-current/20 bg-white/80 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-white"
                style={{ color: currentTab.color.replace("text-", "").replace("-600", "") }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Full page
              </button>
            </div>
          </div>

          {/* Quick action grid */}
          <div className="mb-6 grid gap-3 sm:grid-cols-2">
            {quickActions.map((action, i) => (
              <motion.button
                key={action.href}
                type="button"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 * i }}
                onClick={() => navigate(action.href)}
                className="group rounded-xl border border-border bg-card p-4 text-left transition-all hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-foreground group-hover:text-primary">
                    {action.label}
                  </span>
                  <ExternalLink className="h-4 w-4 text-muted-foreground/50 transition-colors group-hover:text-primary" />
                </div>
              </motion.button>
            ))}
          </div>

          {/* GST-specific: show GSTR-2B card */}
          {activeTab === "gst" && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  <div className="text-sm font-semibold text-foreground">GSTR-2B ITC Reconciliation</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Upload your GSTR-2B JSON (version 2.1 and 2.2 supported) and match against your purchase register to find ITC gaps.
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate("/app/gstr-2b-recon")}
                    className="mt-3 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-50"
                  >
                    Open GSTR-2B reconciliation →
                  </button>
                </div>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* All sections overview */}
      <div className="mt-8">
        <div className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
          All verification areas
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => { setActiveTab(tab.id); navigate(tab.href); }}
                className="group rounded-xl border border-border bg-card p-4 text-left transition-all hover:border-primary/30 hover:shadow-sm"
              >
                <div className="flex items-center gap-3">
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${tab.borderColor} ${tab.bgColor}`}>
                    <Icon className={`h-4 w-4 ${tab.color}`} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground group-hover:text-primary">{tab.label}</div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">{tab.description}</div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </PageTransition>
  );
}
