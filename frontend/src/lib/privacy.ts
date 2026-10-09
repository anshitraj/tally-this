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
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function loadPlan(force = false): Promise<void> {
  if (planRequest && !force) return planRequest;
  planRequest = fetch(`${BASE}/api/account/plan`)
    .then(response => (response.ok ? response.json() : null))
    .then(data => {
      if (data?.ok) {
        plan = {
          plan: String(data.plan ?? "free"),
          planUntil: data.planUntil ?? null,
          privacyAvailable: data.privacyAvailable === true,
          historyMonths: Number(data.historyMonths) || 3,
          supportEmail: String(data.supportEmail || BRAND.contactEmail),
        };
      }
      notify();
    })
    .catch(() => {
      planRequest = null;
    });
  return planRequest;
}

// ── The switch ──────────────────────────────────────────────────────────────
// Stored per person in this browser. It is only ever a request: the server checks the plan
// again on every call and refuses the upload rather than quietly saving it.

const switchKey = () => `finverify_privacy_mode:${getUser()?.email ?? "anonymous"}`;

export function isPrivacyOn(): boolean {
  try {
    return localStorage.getItem(switchKey()) === "1";
  } catch {
    return false;
  }
}

export function setPrivacyOn(on: boolean) {
  try {
    if (on) localStorage.setItem(switchKey(), "1");
    else localStorage.removeItem(switchKey());
  } catch {
    // Without storage the switch simply stays off.
  }
  notify();
}

export function usePrivacy() {
  useEffect(() => {
    void loadPlan();
  }, []);
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const on = useSyncExternalStore(subscribe, isPrivacyOn, () => false);
  const current = useSyncExternalStore(subscribe, () => plan, () => null);
  return {
    on,
    loaded: current != null,
    available: current?.privacyAvailable === true,
    supportEmail: current?.supportEmail ?? BRAND.contactEmail,
    historyMonths: current?.historyMonths ?? 3,
    set: setPrivacyOn,
  };
}

/** The address people write to for a paid plan or for older history. */
export function upgradeMailto(subject: string) {
  return `mailto:${plan?.supportEmail ?? BRAND.contactEmail}?subject=${encodeURIComponent(subject)}`;
}
