import { getActiveClient } from "@/lib/activeClient";

export type UserRole = "founder" | "admin" | "finance" | "ca" | "ca_auditor" | "viewer";

export interface AuthUser {
  id?: number;
  email: string;
  name: string;
  role: UserRole;
  company: string;
  companyId?: number | null;
}

export interface AuthSession {
  user: AuthUser;
  token?: string;
  expiresAt?: string;
}

const AUTH_KEY = "finverify_auth";

function readSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser | AuthSession;
    if ("user" in parsed) return parsed;
    return { user: parsed };
  } catch {
    return null;
  }
}

export function getUser(): AuthUser | null {
  const session = readSession();
  if (!session) return null;
  if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) {
    localStorage.removeItem(AUTH_KEY);
    return null;
  }
  return session.user;
}

export function getAuthToken(): string | null {
  const session = readSession();
  if (!session?.token) return null;
  if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) {
    localStorage.removeItem(AUTH_KEY);
    return null;
  }
  return session.token;
}

export function login(userOrSession: AuthUser | AuthSession): void {
  const session = "user" in userOrSession ? userOrSession : { user: userOrSession };
  localStorage.setItem(AUTH_KEY, JSON.stringify(session));
  window.dispatchEvent(new Event("finverify-session"));
}

export async function logout(): Promise<void> {
  const token = getAuthToken();
  localStorage.removeItem(AUTH_KEY);
  // The chosen client belongs to the account that just left; the next sign-in picks its own.
  localStorage.removeItem("finverify_active_client");
  window.dispatchEvent(new Event("finverify-session"));
  if (localStorage.getItem("finverify_neon")) {
    localStorage.removeItem("finverify_neon");
    void import("@/lib/neonAuth").then(module => module.neonSignOut());
  }
  if (!token) return;
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Local logout should still succeed if the API is unavailable.
  }
}

export function isLoggedIn(): boolean {
  return getUser() !== null;
}

let fetchInstalled = false;
let leavingExpiredSession = false;

/** Sign-in and sign-up calls answer 401 for a wrong password; that is not an expired session. */
const SIGN_IN_ENDPOINT = /\/api\/auth\/(login|register|demo|providers|neon|logout|google|github|forgot|reset)/;

/**
 * Any other 401 means the saved sign-in no longer works. Rather than leave pages blank, send
 * the person to sign in again and bring them back to where they were.
 */
function leaveExpiredSession() {
  if (leavingExpiredSession) return;
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const path = window.location.pathname;
  if (!path.startsWith(`${base}/app`)) return;
  leavingExpiredSession = true;
  try {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem("finverify_active_client");
  } catch {
    // Storage can be blocked; the redirect below still ends the session on screen.
  }
  const back = path.slice(base.length) + window.location.search;
  window.location.assign(`${base}/login?reason=expired&next=${encodeURIComponent(back)}`);
}

export function installAuthenticatedFetch(): void {
  if (fetchInstalled) return;
  fetchInstalled = true;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const isApiRequest = url.includes("/api/") || url.startsWith("/api");
    if (!isApiRequest) return nativeFetch(input, init);

    const watch = (request: Promise<Response>) =>
      request.then(response => {
        if (response.status === 401 && !SIGN_IN_ENDPOINT.test(url)) leaveExpiredSession();
        return response;
      });

    const token = getAuthToken();
    if (!token) return watch(nativeFetch(input, init));

    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const client = getActiveClient();
    if (client?.id && client.id > 0 && !headers.has("X-Client-Company-Id")) {
      headers.set("X-Client-Company-Id", String(client.id));
    }
    return watch(nativeFetch(input, { ...init, headers }));
  };
}
