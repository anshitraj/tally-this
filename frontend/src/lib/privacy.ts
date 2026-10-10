import { useEffect, useSyncExternalStore } from "react";
import { getUser } from "@/lib/auth";
import { BRAND } from "@/lib/brand";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface AccountPlan {
  plan: string;
  planUntil: string | null;
  privacyAvailable: boolean;
  historyMonths: number;
  supportEmail: string;
}

// ── The plan, fetched once and shared by every page ─────────────────────────

let plan: AccountPlan | null = null;
let planRequest: Promise<void> | null = null;
let planOwner = "";
let planStatus: "loading" | "ready" | "error" = "loading";
let requestVersion = 0;
const accountKey = () => `${getUser()?.companyId ?? ""}:${getUser()?.email ?? "anonymous"}`;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function loadPlan(force = false): Promise<void> {
  const owner = accountKey();
  if (planOwner !== owner) {
    planOwner = owner;
    plan = null;
    planRequest = null;
  }
  if (planRequest && !force) return planRequest;
  const version = ++requestVersion;
  planStatus = "loading";
  notify();
  planRequest = fetch(`${BASE}/api/account/plan`)
    .then(response => (response.ok ? response.json() : null))
    .then(data => {
      if (version !== requestVersion || owner !== accountKey()) return;
      if (data?.ok) {
        plan = {
          plan: String(data.plan ?? "free"),
          planUntil: data.planUntil ?? null,
          privacyAvailable: data.privacyAvailable === true,
          historyMonths: Number(data.historyMonths) || 3,
          supportEmail: String(data.supportEmail || BRAND.contactEmail),
        };
        planStatus = "ready";
      } else {
        plan = null;
        planStatus = "error";
      }
      notify();
    })
    .catch(() => {
      if (version !== requestVersion || owner !== accountKey()) return;
      plan = null;
      planStatus = "error";
      planRequest = null;
      notify();
    });
  return planRequest;
}

// ── The switch ──────────────────────────────────────────────────────────────
// Stored per person in this browser. It is only ever a request: the server checks the plan
// again on every call and refuses the upload rather than quietly saving it.

const switchKey = () => `finverify_privacy_mode:${getUser()?.email ?? "anonymous"}`;
// A second tab must not change the mode of a job already open in this tab.
const tabModes = new Map<string, boolean>();

export function isPrivacyOn(): boolean {
  const key = switchKey();
  const selected = tabModes.get(key);
  if (selected != null) return selected;
  try {
    const on = localStorage.getItem(key) === "1";
    tabModes.set(key, on);
    return on;
  } catch {
    tabModes.set(key, false);
    return false;
  }
}

export function setPrivacyOn(on: boolean) {
  tabModes.set(switchKey(), on);
  try {
    if (on) localStorage.setItem(switchKey(), "1");
    else localStorage.removeItem(switchKey());
  } catch {
    // This tab still works when the browser disallows preference storage.
  }
  notify();
}

export function usePrivacy() {
  const owner = accountKey();
  useEffect(() => {
    void loadPlan();
  }, [owner]);
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const on = useSyncExternalStore(subscribe, isPrivacyOn, () => false);
  const current = useSyncExternalStore(subscribe, () => planOwner === owner ? plan : null, () => null);
  const status = useSyncExternalStore(subscribe, () => planOwner === owner ? planStatus : "loading", () => "loading");
  return {
    on,
    loaded: status !== "loading",
    status,
    available: status === "ready" && current?.privacyAvailable === true,
    supportEmail: current?.supportEmail ?? BRAND.contactEmail,
    historyMonths: current?.historyMonths ?? 3,
    set: setPrivacyOn,
  };
}

/** The address people write to for a paid plan or for older history. */
export function upgradeMailto(subject: string) {
  return `mailto:${plan?.supportEmail ?? BRAND.contactEmail}?subject=${encodeURIComponent(subject)}`;
}
