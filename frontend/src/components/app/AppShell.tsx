import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  ArrowLeftRight,
  BookOpen,
  Building2,
  ChevronDown,
  FileBarChart,
  FileSpreadsheet,
  GitCompare,
  History,
  LogOut,
  Menu,
  Receipt,
  Settings,
  ShoppingBag,
  X,
  type LucideIcon,
} from "lucide-react";
import { BrandMark } from "@/components/app/finverify-ui";
import { getUser, logout } from "@/lib/auth";
import { useClients } from "@/components/jobs/jobUi";
import { cn } from "@/lib/utils";
import { usePrivacy } from "@/lib/privacy";
import { IncognitoIcon } from "@/components/app/IncognitoIcon";

type NavItem = { label: string; href: string; icon: LucideIcon };

const primaryNav: NavItem[] = [
  { label: "Clients", href: "/app/clients", icon: Building2 },
];

const automationNav: NavItem[] = [
  {
    label: "Bank → Tally",
    href: "/app/jobs/bank-to-tally",
    icon: FileSpreadsheet,
  },
  { label: "Bank ↔ Tally", href: "/app/jobs/bank-tally", icon: GitCompare },
  {
    label: "E-commerce GST",
    href: "/app/jobs/ecommerce-gst",
    icon: ShoppingBag,
  },
  { label: "Invoice ↔ Bank", href: "/app/jobs/invoice-bank", icon: Receipt },
];

const secondaryNav: NavItem[] = [
  { label: "Reports", href: "/app/reports", icon: FileBarChart },
  { label: "Activity", href: "/app/activity", icon: Activity },
];

const advancedNav: NavItem[] = [
  { label: "History", href: "/app/history", icon: History },
  { label: "Settings", href: "/app/settings", icon: Settings },
  { label: "Upload center", href: "/app/uploads", icon: ArrowLeftRight },
  { label: "Transactions", href: "/app/transactions", icon: ArrowLeftRight },
  { label: "Invoices", href: "/app/invoices", icon: Receipt },
  { label: "Reconciliation", href: "/app/reconciliation", icon: GitCompare },
  { label: "CA Review", href: "/app/ca-review", icon: BookOpen },
  { label: "Tax Audit", href: "/app/tax-audit", icon: BookOpen },
  { label: "Practice console", href: "/app/practice", icon: Building2 },
  { label: "GST & TDS", href: "/app/gst-tds-risks", icon: FileBarChart },
  { label: "GSTR-2B", href: "/app/gstr-2b-recon", icon: FileBarChart },
  { label: "26AS TDS", href: "/app/tds-recon", icon: FileBarChart },
  { label: "Payroll", href: "/app/payroll", icon: Activity },
  {
    label: "Gateway settlements",
    href: "/app/gateway-settlements",
    icon: FileSpreadsheet,
  },
  { label: "Vendor aging", href: "/app/vendor-aging", icon: FileBarChart },
  { label: "Ledger match", href: "/app/ledger-match", icon: GitCompare },
  { label: "Trial balance", href: "/app/trial-balance", icon: FileBarChart },
  { label: "Journal entries", href: "/app/journal-entries", icon: BookOpen },
  { label: "Action items", href: "/app/action-items", icon: Activity },
  { label: "Verify", href: "/app/verify", icon: GitCompare },
  {
    label: "Statutory calendar",
    href: "/app/statutory-calendar",
    icon: Activity,
  },
  { label: "Integrations", href: "/app/integrations", icon: Settings },
  { label: "Admin", href: "/app/admin", icon: Building2 },
  { label: "Docs", href: "/app/docs", icon: BookOpen },
];

/** One select for whose books you are working on. Hidden when there is only one choice. */
function ClientSwitcher() {
  const user = getUser();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { clients, active, choose } = useClients();
  const [workspaceName, setWorkspaceName] = useState(
    user?.company || "My business",
  );

  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries();
    };
    window.addEventListener("finverify-client", refresh);
    return () => window.removeEventListener("finverify-client", refresh);
  }, [queryClient]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const name = data?.company?.name || data?.user?.company;
        if (!cancelled && name) setWorkspaceName(name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const ownId = user?.companyId ?? null;
  const options = [
    ...(ownId
      ? [{ id: ownId, name: workspaceName, linkId: null as number | null }]
      : []),
    ...clients
      .filter((client) => client.companyId && client.companyId !== ownId)
      .map((client) => ({
        id: client.companyId as number,
        name: client.name,
        linkId: client.linkId,
      })),
  ];
  if (options.length < 2)
    return (
      <button
        type="button"
        className="fv-client-switcher"
        onClick={() => navigate("/app/clients")}
      >
        <Building2 size={15} />
        <span>{active?.name || options[0]?.name || "Select a client"}</span>
        <ChevronDown size={13} />
      </button>
    );
  const selected =
    active?.id && options.some((option) => option.id === active.id)
      ? active.id
      : options[0].id;

  return (
    <label className="fv-client-switcher">
      <span className="hidden shrink-0 sm:inline">Client</span>
      <select
        aria-label="Client"
        className="min-w-0 max-w-[11rem] truncate rounded-lg bg-transparent py-1 text-sm font-semibold text-foreground focus:outline-none sm:max-w-[16rem]"
        value={String(selected)}
        onChange={(event) => {
          const id = Number(event.target.value);
          const option = options.find((item) => item.id === id);
          if (!option) return;
          choose({
            id: option.id,
            name: option.name,
            accounting: active?.accounting ?? "Tally",
            linkId: option.linkId,
          });
        }}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function NavItems({
  items,
  location,
  onNavigate,
}: {
  items: NavItem[];
  location: string;
  onNavigate: (href: string) => void;
}) {
  return (
    <div className="space-y-0.5">
      {items.map((item) => {
        const Icon = item.icon;
        const path = item.href.split("?")[0];
        const active =
          location === path ||
          location.startsWith(`${path}/`) ||
          (location === "/app" && path === "/app/overview");
        return (
          <button
            key={item.href}
            type="button"
            onClick={() => onNavigate(item.href)}
            aria-current={active ? "page" : undefined}
            className={cn("fv-app-nav-item", active && "is-active")}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const privacy = usePrivacy();
  const [location, navigate] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    advancedNav.some((item) => location.startsWith(item.href.split("?")[0])),
  );
  const user = getUser();
  const pageName =
    [...primaryNav, ...automationNav, ...secondaryNav, ...advancedNav].find(
      (item) => location === item.href || location.startsWith(`${item.href}/`),
    )?.label || "Workspace";

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  useEffect(() => {
    if (!user) navigate("/login");
  }, [user, navigate]);

  if (!user) return null;

  const go = (href: string) => {
    navigate(href);
    setMobileOpen(false);
  };

  const handleLogout = () => {
    void logout();
    navigate("/login");
  };

  const sidebar = (
    <div className="fv-sidebar-content">
      <div className="fv-sidebar-brand">
        <button
          type="button"
          onClick={() => go("/app/overview")}
          aria-label="Home"
        >
          <BrandMark light />
        </button>
        <button
          type="button"
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close menu"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        <div className="fv-nav-label">Your workspace</div>
        <NavItems items={primaryNav} location={location} onNavigate={go} />
        <div className="fv-nav-label">Choose a job</div>
        <NavItems items={automationNav} location={location} onNavigate={go} />
        <div className="fv-nav-divider">
          <NavItems items={secondaryNav} location={location} onNavigate={go} />
        </div>
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
            className="fv-app-advanced"
          >
            <span className="flex-1 text-left">Advanced</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition",
                advancedOpen && "rotate-180",
              )}
            />
          </button>
          {advancedOpen && (
            <NavItems items={advancedNav} location={location} onNavigate={go} />
          )}
        </div>
      </nav>
      <div className="fv-sidebar-account">
        <div className="flex items-center gap-3 rounded-xl px-2 py-1.5">
          <div className="fv-account-avatar">
            {user.name
              .split(" ")
              .map((part) => part[0])
              .join("")
              .slice(0, 2)
              .toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{user.name}</div>
            <div className="fv-account-email truncate">{user.email}</div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Log out"
            title="Log out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className={cn("fv-app-shell flex h-screen overflow-hidden bg-background text-foreground", privacy.on && "is-incognito dark")} data-upload-mode={privacy.on ? "incognito" : "normal"}>
      <aside className="fv-app-sidebar hidden shrink-0 lg:flex">
        {sidebar}
      </aside>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
              className="fixed inset-0 z-40 bg-black/30 lg:hidden"
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: "spring", damping: 30, stiffness: 260 }}
              className="fv-app-sidebar fixed inset-y-0 left-0 z-50 flex w-72 flex-col lg:hidden"
              aria-label="Workspace navigation"
            >
              {sidebar}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="fv-app-topbar">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>
          {pageName === "Workspace" && (
            <div className="lg:hidden">
              <BrandMark compact />
            </div>
          )}
          <div className="fv-app-breadcrumb">
            <button type="button" onClick={() => go("/app/overview")}>
              Workspace
            </button>
            {pageName !== "Workspace" && (
              <>
                <span>/</span>
                <strong>{pageName}</strong>
              </>
            )}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {privacy.on && <span className="fv-incognito-indicator"><IncognitoIcon /><span>Incognito</span></span>}
            <ClientSwitcher />
          </div>
        </header>
        <main
          id="workspace-content"
          className="fv-app-main min-h-0 flex-1 overflow-y-auto"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
