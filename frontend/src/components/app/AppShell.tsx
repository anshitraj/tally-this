import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "framer-motion";
import { Building2, ChevronDown, LogOut, Menu, Search, X } from "lucide-react";
import { BrandMark } from "@/components/app/finverify-ui";
import CommandPalette from "@/components/app/CommandPalette";
import ErrorBoundary from "@/components/app/ErrorBoundary";
import { getUser, logout } from "@/lib/auth";
import { useClients } from "@/components/jobs/jobUi";
import {
  ADVANCED_GROUPS,
  ADVANCED_NAV,
  JOB_NAV,
  SECONDARY_NAV,
  WORKSPACE_NAV,
  findNav,
  parentOf,
  type NavEntry,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { usePrivacy } from "@/lib/privacy";
import { IncognitoIcon } from "@/components/app/IncognitoIcon";

/** The mobile menu slides away when closed by hand, and is gone at once when a page was chosen. */
const drawerVariants = {
  closed: (instant: boolean) => ({ x: -280, transition: instant ? { duration: 0 } : { type: "spring" as const, damping: 30, stiffness: 260 } }),
  open: { x: 0, transition: { type: "spring" as const, damping: 30, stiffness: 260 } },
};
const fadeVariants = {
  hidden: (instant: boolean) => ({ opacity: 0, transition: { duration: instant ? 0 : 0.18 } }),
  shown: { opacity: 1, transition: { duration: 0.18 } },
};

function isActive(location: string, href: string) {
  const path = href.split("?")[0];
  return location === path || location.startsWith(`${path}/`) || (location === "/app" && path === "/app/overview");
}

/** One select for whose books you are working on. Hidden when there is only one choice. */
function ClientSwitcher() {
  const user = getUser();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { clients, active, choose } = useClients();
  const [workspaceName, setWorkspaceName] = useState(user?.company || "My business");

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
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
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
    ...(ownId ? [{ id: ownId, name: workspaceName, linkId: null as number | null }] : []),
    ...clients
      .filter(client => client.companyId && client.companyId !== ownId)
      .map(client => ({
        id: client.companyId as number,
        name: client.name,
        linkId: client.linkId,
      })),
  ];
  if (options.length < 2)
    return (
      <button type="button" className="fv-client-switcher" onClick={() => navigate("/app/clients")}>
        <Building2 size={15} />
        <span>{active?.name || options[0]?.name || "Select a client"}</span>
        <ChevronDown size={13} />
      </button>
    );
  const selected = active?.id && options.some(option => option.id === active.id) ? active.id : options[0].id;

  return (
    <label className="fv-client-switcher">
      <span className="hidden shrink-0 sm:inline">Client</span>
      <select
        aria-label="Client"
        className="min-w-0 max-w-[11rem] truncate rounded-lg bg-transparent py-1 text-sm font-semibold text-foreground focus:outline-none sm:max-w-[16rem]"
        value={String(selected)}
        onChange={event => {
          const id = Number(event.target.value);
          const option = options.find(item => item.id === id);
          if (!option) return;
          choose({
            id: option.id,
            name: option.name,
            accounting: active?.accounting ?? "Tally",
            linkId: option.linkId,
          });
        }}
      >
        {options.map(option => (
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
  sub = false,
}: {
  items: NavEntry[];
  location: string;
  onNavigate: (href: string) => void;
  sub?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      {items.map(item => {
        const Icon = item.icon;
        const active = isActive(location, item.href);
        return (
          <button
            key={item.href}
            type="button"
            onClick={() => onNavigate(item.href)}
            aria-current={active ? "page" : undefined}
            className={cn("fv-app-nav-item", sub && "is-sub", active && "is-active")}
          >
            {active && (
              <motion.span
                layoutId="fv-nav-pill"
                className="fv-nav-pill"
                transition={{ type: "spring", stiffness: 520, damping: 42 }}
              />
            )}
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(() => ADVANCED_NAV.some(item => isActive(location, item.href)));
  const mainRef = useRef<HTMLElement>(null);
  // Choosing a page closes the drawer at once; closing it by hand slides it away.
  const [closeAtOnce, setCloseAtOnce] = useState(false);
  const user = getUser();

  const current = findNav(location);
  const parent = parentOf(location);
  const pageName = current?.label || "Workspace";

  // A new page starts at its top, and the drawer closes by itself.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    setCloseAtOnce(true);
    setMobileOpen(false);
    if (ADVANCED_NAV.some(item => isActive(location, item.href))) setAdvancedOpen(true);
  }, [location]);

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
    setCloseAtOnce(true);
    navigate(href);
    setMobileOpen(false);
  };

  const handleLogout = () => {
    void logout();
    navigate("/login");
  };

  const sidebar = (group: string) => (
    <LayoutGroup id={group}>
      <div className="fv-sidebar-content">
        <div className="fv-sidebar-brand">
          <button type="button" onClick={() => go("/app/overview")} aria-label="Home">
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
        <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Main">
          <div className="fv-nav-label">Your workspace</div>
          <NavItems items={WORKSPACE_NAV} location={location} onNavigate={go} />
          <div className="fv-nav-label">Choose a job</div>
          <NavItems items={JOB_NAV} location={location} onNavigate={go} />
          <div className="fv-nav-divider">
            <NavItems items={SECONDARY_NAV} location={location} onNavigate={go} />
          </div>
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setAdvancedOpen(open => !open)}
              aria-expanded={advancedOpen}
              className="fv-app-advanced"
            >
              <span className="flex-1 text-left">Advanced</span>
              <ChevronDown className={cn("h-3.5 w-3.5 transition", advancedOpen && "rotate-180")} />
            </button>
            <AnimatePresence initial={false}>
              {advancedOpen && (
                <motion.div
                  key="advanced"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  style={{ overflow: "hidden" }}
                >
                  {ADVANCED_GROUPS.map(section => (
                    <div key={section.title}>
                      <div className="fv-nav-subtitle">{section.title}</div>
                      <NavItems items={section.items} location={location} onNavigate={go} sub />
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </nav>
        <div className="fv-sidebar-account">
          <div className="flex items-center gap-3 rounded-xl px-2 py-1.5">
            <div className="fv-account-avatar">
              {user.name
                .split(" ")
                .map(part => part[0])
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
    </LayoutGroup>
  );

  return (
    <MotionConfig reducedMotion="user">
      <div
        className={cn(
          "fv-app-shell flex h-screen overflow-hidden bg-background text-foreground",
          privacy.on && "is-incognito dark",
        )}
        data-upload-mode={privacy.on ? "incognito" : "normal"}
      >
        <a href="#workspace-content" className="fv-skip-link">
          Skip to content
        </a>
        <aside className="fv-app-sidebar hidden shrink-0 lg:flex">{sidebar("desktop")}</aside>

        <AnimatePresence custom={closeAtOnce}>
          {mobileOpen && (
            <>
              <motion.div
                custom={closeAtOnce}
                variants={fadeVariants}
                initial="hidden"
                animate="shown"
                exit="hidden"
                onClick={() => {
                  setCloseAtOnce(false);
                  setMobileOpen(false);
                }}
                className="fixed inset-0 z-40 bg-black/30 lg:hidden"
              />
              <motion.aside
                custom={closeAtOnce}
                variants={drawerVariants}
                initial="closed"
                animate="open"
                exit="closed"
                className="fv-app-sidebar fixed inset-y-0 left-0 z-50 flex w-72 flex-col lg:hidden"
                aria-label="Workspace navigation"
              >
                {sidebar("mobile")}
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="fv-app-topbar">
            <button
              type="button"
              onClick={() => {
                setCloseAtOnce(false);
                setMobileOpen(true);
              }}
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
            <nav className="fv-app-breadcrumb" aria-label="Breadcrumb">
              <button type="button" onClick={() => go("/app/overview")}>
                Workspace
              </button>
              {parent && (
                <>
                  <span>/</span>
                  <button type="button" onClick={() => go(parent.href)}>
                    {parent.label}
                  </button>
                </>
              )}
              {pageName !== "Workspace" && (
                <>
                  <span>/</span>
                  <strong>{parent ? "Details" : pageName}</strong>
                </>
              )}
            </nav>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              {privacy.on && (
                <span className="fv-incognito-indicator">
                  <IncognitoIcon />
                  <span>Incognito</span>
                </span>
              )}
              <button
                type="button"
                className="fv-search-trigger"
                onClick={() => setPaletteOpen(true)}
                aria-label="Search jobs, pages and clients"
              >
                <Search size={15} />
                <span>Search</span>
                <kbd className="fv-kbd">Ctrl K</kbd>
              </button>
              <ClientSwitcher />
            </div>
          </header>
          <main
            id="workspace-content"
            ref={mainRef}
            className="fv-app-main min-h-0 flex-1 overflow-y-auto"
            tabIndex={-1}
          >
            <ErrorBoundary resetKey={location} onHome={() => go("/app/overview")}>
              <motion.div
                key={location}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                {children}
              </motion.div>
            </ErrorBoundary>
          </main>
        </div>

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onNavigate={href => {
            setPaletteOpen(false);
            go(href);
          }}
          onSignOut={handleLogout}
        />
      </div>
    </MotionConfig>
  );
}
