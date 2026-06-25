import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeftRight,
  Bell,
  BookOpen,
  Building2,
  Calendar,
  CheckSquare,
  ChevronLeft,
  ClipboardCheck,
  Clock,
  CreditCard,
  FileBarChart,
  FileCheck,
  GitCompare,
  LayoutDashboard,
  LogOut,
  Menu,
  Puzzle,
  Receipt,
  Scale,
  Settings,
  ShieldCheck,
  Upload,
  UserCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { BrandMark } from "@/components/app/finverify-ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getUser, logout } from "@/lib/auth";
import { cn } from "@/lib/utils";

const navGroups = [
  {
    label: "Home",
    items: [
      { label: "Overview", href: "/app/overview", icon: LayoutDashboard },
      { label: "Upload", href: "/app/uploads", icon: Upload },
    ],
  },
  {
    label: "Books & Ledgers",
    items: [
      { label: "Transactions", href: "/app/transactions", icon: ArrowLeftRight },
      { label: "Invoices", href: "/app/invoices", icon: Receipt },
      { label: "Ledger Match", href: "/app/ledger-match", icon: GitCompare },
      { label: "Trial Balance", href: "/app/trial-balance", icon: Scale },
      { label: "Journal Entries", href: "/app/journal-entries", icon: BookOpen },
    ],
  },
  {
    label: "Tax Audit",
    items: [
      { label: "Practice Console", href: "/app/practice", icon: Users },
      { label: "Tax Audit & Scrutiny", href: "/app/tax-audit", icon: ShieldCheck },
      { label: "GST & TDS Risks", href: "/app/gst-tds-risks", icon: AlertTriangle },
      { label: "GSTR-2B Recon", href: "/app/gstr-2b-recon", icon: FileCheck },
      { label: "Statutory Calendar", href: "/app/statutory-calendar", icon: Calendar },
    ],
  },
  {
    label: "Reconcile",
    items: [
      { label: "Reconciliation", href: "/app/reconciliation", icon: GitCompare },
      { label: "Vendor Aging", href: "/app/vendor-aging", icon: Clock },
      { label: "Payroll", href: "/app/payroll", icon: Users },
      { label: "Gateway Settlements", href: "/app/gateway-settlements", icon: CreditCard },
    ],
  },
  {
    label: "Review & Report",
    items: [
      { label: "Verify", href: "/app/verify", icon: CheckSquare },
      { label: "Action Items", href: "/app/action-items", icon: ClipboardCheck },
      { label: "CA Review", href: "/app/ca-review", icon: UserCheck },
      { label: "Reports", href: "/app/reports", icon: FileBarChart },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Integrations", href: "/app/integrations", icon: Puzzle },
      { label: "Admin", href: "/app/admin", icon: Building2 },
      { label: "Settings", href: "/app/settings", icon: Settings },
      { label: "Docs", href: "/app/docs", icon: BookOpen },
    ],
  },
] as const;

/** Current active FY month — shown instead of cryptic WorkspacePill. */
function MonthSelector() {
  const months = [
    "April 2026", "March 2026", "February 2026", "January 2026",
    "December 2025", "November 2025", "October 2025",
  ];
  const [selected, setSelected] = useState(months[0]);
  return (
    <select
      aria-label="Active month"
      value={selected}
      onChange={e => setSelected(e.target.value)}
      className="hidden h-8 cursor-pointer items-center gap-1.5 rounded-xl border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-semibold text-primary hover:bg-primary/10 focus:outline-none focus:ring-2 focus:ring-primary/20 md:inline-flex"
    >
      {months.map(m => <option key={m} value={m}>{m}</option>)}
    </select>
  );
}


const notifications: Array<{
  title: string;
  description: string;
  time: string;
  href: string;
  icon: LucideIcon;
  tone: "risk" | "review" | "upload";
}> = [];

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const [location, navigate] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const user = getUser();

  useEffect(() => {
    if (!user) navigate("/login");
  }, [user, navigate]);

  if (!user) return null;

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const Sidebar = () => (
    <div className="flex h-full flex-col">
      <div className={cn("flex h-20 items-center border-b border-white/10 px-4", collapsed ? "justify-center" : "justify-between")}>
        <div className={cn("min-w-0", collapsed && "hidden")}>
          <div className="fv-wordmark-chip inline-flex rounded-2xl px-3 py-2 shadow-sm">
            <BrandMark />
          </div>
          <div className="mt-2 truncate text-xs text-white/65">{user.company}</div>
        </div>
        {collapsed && <div className="fv-wordmark-chip rounded-2xl p-2 shadow-sm"><BrandMark compact /></div>}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-4">
        {navGroups.map(group => (
          <div key={group.label} className="mb-4">
            {!collapsed && (
              <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">
                {group.label}
              </div>
            )}
            <div className="space-y-1">
              {group.items.map(item => {
                const Icon = item.icon;
                const active = location === item.href || (location === "/app" && item.href === "/app/overview");
                return (
                  <button
                    key={item.href}
                    type="button"
                    title={collapsed ? item.label : undefined}
                    onClick={() => {
                      navigate(item.href);
                      setMobileOpen(false);
                    }}
                    className={cn(
                      "group relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition",
                      collapsed && "justify-center",
                      active
                        ? "fv-brand-accent-bg shadow-sm"
                        : "text-white/72 hover:bg-white/10 hover:text-white"
                    )}
                  >
                    {active && <span className="absolute left-0 top-2 h-6 w-1 rounded-r-full bg-white/80" />}
                    <Icon className={cn("h-4 w-4 shrink-0", active ? "text-white" : "text-white/60 group-hover:text-white")} />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className={cn("border-t border-white/10 p-3", collapsed && "flex justify-center")}>
        {collapsed ? (
          <button type="button" onClick={handleLogout} className="rounded-xl p-2 text-white/65 hover:bg-white/10 hover:text-white" aria-label="Logout">
            <LogOut className="h-4 w-4" />
          </button>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-white/10 p-3">
            <div className="flex items-center gap-3">
              <div className="fv-text-brand-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-sm font-bold">
                {user.name.split(" ").map(n => n[0]).join("").slice(0, 2)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-white">{user.name}</div>
                <div className="mt-0.5 inline-flex rounded-full border border-white/10 bg-white/10 px-2 py-0.5 text-[11px] font-semibold capitalize text-white/75">
                  {user.role}
                </div>
              </div>
              <button type="button" onClick={handleLogout} className="rounded-lg p-1.5 text-white/65 hover:bg-white/10 hover:text-white" aria-label="Logout">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside className={cn("fv-brand-primary-bg hidden shrink-0 border-r border-primary/20 transition-all duration-200 lg:flex", collapsed ? "w-[4.5rem]" : "w-64")}>
        <Sidebar />
      </aside>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
              className="fixed inset-0 z-40 bg-black/35 lg:hidden"
            />
            <motion.aside
              initial={{ x: -288 }}
              animate={{ x: 0 }}
              exit={{ x: -288 }}
              transition={{ type: "spring", damping: 28, stiffness: 220 }}
              className="fv-brand-primary-bg fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-primary/20 lg:hidden"
            >
              <Sidebar />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur sm:px-5">
          <button
            type="button"
            onClick={() => setCollapsed(v => !v)}
            className="hidden rounded-xl p-2 text-muted-foreground hover:bg-muted hover:text-foreground lg:inline-flex"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <Menu className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-xl p-2 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>

          <div className="fv-search-field hidden min-w-0 max-w-2xl flex-1 md:flex">
            <Search className="fv-search-icon" />
            <input
              aria-label="Global search"
              placeholder="Search invoices, UTRs, vendors, risks..."
              className="fv-search-input"
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <MonthSelector />
            <select aria-label="Company switcher" className="fv-input hidden w-48 md:block">
              <option>{user.company}</option>
            </select>
            <select aria-label="Month selector" className="fv-input hidden w-32 sm:block">
              <option>May 2026</option>
              <option>April 2026</option>
            </select>
            <button
              type="button"
              onClick={() => navigate("/app/uploads")}
              className="fv-button-primary hidden sm:inline-flex"
            >
              <Upload className="h-4 w-4" />
              Upload
            </button>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="relative rounded-xl border border-border bg-card p-2 text-muted-foreground transition hover:border-primary/30 hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-secondary/20"
                  aria-label="Open notifications"
                >
                  <Bell className="h-4 w-4" />
                  {notifications.length > 0 && <span className="fv-brand-accent-bg absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full" />}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" sideOffset={10} className="w-[22rem] rounded-2xl border-border bg-card p-0 shadow-[0_20px_60px_rgba(6,95,70,0.14)]">
                <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
                  <div>
                    <div className="text-sm font-semibold text-foreground">Notifications</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">Finance checks that need attention</div>
                  </div>
                  <span className="fv-status-review rounded-full border px-2 py-0.5 text-[11px] font-semibold">
                    {notifications.length} open
                  </span>
                </div>
                <div className="max-h-[22rem] overflow-y-auto p-2">
                  {notifications.length === 0 && (
                    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                      No notifications yet. Upload files or run reconciliation to create review events.
                    </div>
                  )}
                  {notifications.map(item => {
                    const ItemIcon = item.icon;
                    return (
                      <button
                        key={item.title}
                        type="button"
                        onClick={() => navigate(item.href)}
                        className="group flex w-full gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-muted/60"
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border",
                            item.tone === "risk" && "fv-status-risk",
                            item.tone === "review" && "fv-status-missing",
                            item.tone === "upload" && "fv-status-verified"
                          )}
                        >
                          <ItemIcon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-3">
                            <span className="truncate text-sm font-semibold text-foreground">{item.title}</span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">{item.time}</span>
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">{item.description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between border-t border-border px-4 py-3">
                  <button type="button" onClick={() => navigate("/app/action-items")} className="text-xs font-semibold text-primary hover:underline">
                    Open Action Items
                  </button>
                  <button type="button" onClick={() => navigate("/app/settings")} className="text-xs font-medium text-muted-foreground hover:text-foreground">
                    Notification settings
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
