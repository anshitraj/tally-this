/**
 * Sign-in with Neon Auth. Neon looks after passwords, email codes and Google/GitHub; once it has
 * confirmed the person we swap its token for a normal TallyThis session. The Neon code is loaded
 * only when somebody opens the sign-in page.
 */
import type { AuthUser } from "@/lib/auth";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function makeClient(authUrl: string) {
  const [{ createAuthClient }, { BetterAuthVanillaAdapter }] = await Promise.all([
    import("@neondatabase/auth"),
    import("@neondatabase/auth/vanilla/adapters"),
  ]);
  return createAuthClient(authUrl, { adapter: BetterAuthVanillaAdapter() });
}

type NeonClient = Awaited<ReturnType<typeof makeClient>>;

export interface NeonConfig {
  enabled: boolean;
  authUrl: string | null;
  legacyLogin: boolean;
}

export interface TallySession {
  token: string;
  expiresAt: string;
  created?: boolean;
  user: AuthUser & { id: number; companyId: number | null };
}

/** An error with a message that is fine to show as it is. */
export class NeonAuthError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

let configRequest: Promise<NeonConfig> | null = null;
export function loadNeonConfig(): Promise<NeonConfig> {
  configRequest ??= fetch(`${BASE}/api/auth/neon/config`)
    .then(response => (response.ok ? response.json() : null))
    .then((data): NeonConfig => ({ enabled: data?.enabled === true && typeof data.authUrl === "string", authUrl: data?.authUrl ?? null, legacyLogin: data?.legacyLogin !== false }))
    .catch((): NeonConfig => ({ enabled: false, authUrl: null, legacyLogin: true }));
  return configRequest;
}

let clientRequest: Promise<NeonClient> | null = null;
async function neon(): Promise<NeonClient> {
  clientRequest ??= (async () => {
    const config = await loadNeonConfig();
    if (!config.enabled || !config.authUrl) throw new NeonAuthError("Sign-in is not available right now.");
    return makeClient(config.authUrl);
  })();
  return clientRequest;
}

// Neon's messages are written for developers; these are the ones a person can act on.
const FRIENDLY: Array<[RegExp, string]> = [
  [/invalid (email|password)|invalid_email_or_password|incorrect/i, "That email and password do not match."],
  [/not verified|email_not_verified/i, "Confirm your email address first."],
  [/already exists|user_already_exists|already registered/i, "This email already has an account. Sign in instead."],
  [/otp|code/i, "That code is not right or has expired. Ask for a new one."],
  [/password.*(short|least|characters)|too_short/i, "Use a password with at least 8 characters."],
  [/too many|rate.?limit|429/i, "Too many tries. Please wait a few minutes and try again."],
];

function fail(error: { message?: string; code?: string; status?: number } | null | undefined, fallback: string): never {
  const raw = `${error?.code ?? ""} ${error?.message ?? ""} ${error?.status ?? ""}`;
  const friendly = FRIENDLY.find(([pattern]) => pattern.test(raw));
  throw new NeonAuthError(friendly?.[1] ?? fallback, error?.code);
}

export async function neonSignUp(name: string, email: string, password: string) {
  const { error } = await (await neon()).signUp.email({ name, email, password });
  if (error) fail(error, "Your account could not be created. Please try again.");
}

export async function neonSendCode(email: string, type: "email-verification" | "forget-password") {
  const { error } = await (await neon()).emailOtp.sendVerificationOtp({ email, type });
  if (error) fail(error, "The code could not be sent. Please try again in a moment.");
}

export async function neonVerifyEmail(email: string, otp: string) {
  const { error } = await (await neon()).emailOtp.verifyEmail({ email, otp });
  if (error) fail(error, "That code is not right or has expired. Ask for a new one.");
}

/** Returns false when the account exists but its email is not confirmed yet. */
export async function neonSignIn(email: string, password: string): Promise<boolean> {
  const { error } = await (await neon()).signIn.email({ email, password });
  if (!error) return true;
  if (/verif/i.test(`${error.code ?? ""} ${error.message ?? ""}`) || error.status === 403) return false;
  fail(error, "Sign-in failed. Check your email and password.");
}

export async function neonResetPassword(email: string, otp: string, password: string) {
  const { error } = await (await neon()).emailOtp.resetPassword({ email, otp, password });
  if (error) fail(error, "The password could not be changed. Ask for a new code and try again.");
}

export async function neonSocialStart(provider: "google" | "github", returnPath: string) {
  const { error } = await (await neon()).signIn.social({ provider, callbackURL: `${window.location.origin}${returnPath}` });
  if (error) fail(error, "That sign-in could not be started. Please try again.");
}

/** The signed token Neon holds for the person who just signed in, or null. */
export async function neonToken(): Promise<string | null> {
  // The SDK puts the signed token it receives from Neon on the session as `token`.
  const session = await (await neon()).getSession();
  return session.data?.session?.token ?? null;
}

export async function neonSignOut() {
  try {
    const config = await loadNeonConfig();
    if (config.enabled) await (await neon()).signOut();
  } catch {
    // Signing out of this app must never fail because of the sign-in provider.
  }
}

/** Swaps Neon's token for the session TallyThis uses everywhere else. */
export async function exchangeForSession(token: string, companyName?: string): Promise<TallySession> {
  const response = await fetch(`${BASE}/api/auth/neon/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, companyName }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new NeonAuthError(data?.error || "Sign-in could not be completed. Please try again.", data?.code);
  return data;
}
