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
  /** The sample workspace can be opened here (never in production). */
  demo: boolean;
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
    .then(response => {
      if (!response.ok) throw new Error(`config ${response.status}`);
      return response.json();
    })
    .then((data): NeonConfig => ({ enabled: data?.enabled === true && typeof data.authUrl === "string", authUrl: data?.authUrl ?? null, legacyLogin: data?.legacyLogin !== false, demo: data?.demo === true }))
    .catch((): NeonConfig => {
      // Ask again next time instead of remembering a moment when the server could not be reached.
      configRequest = null;
      return { enabled: false, authUrl: null, legacyLogin: true, demo: false };
    });
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

// Neon's messages are written for developers; these are the ones a person can act on. The first
// match wins, so the more specific cases come first.
const FRIENDLY: Array<[RegExp, string]> = [
  [/email_not_confirmed|email_not_verified|not verified|not confirmed/i, "Confirm your email address first."],
  [/invalid origin|(^|\s)(http )?403(\s|$)|forbidden/i, "Sign-in is not switched on for this web address yet. Please try again soon or email us."],
  [/invalid_credentials|invalid[ _](email|password|login)|incorrect/i, "That email and password do not match."],
  [/already exists|user_already_exists|already registered|email_exists/i, "This email already has an account. Sign in instead."],
  [/weak_password|too_short|password.*(short|least|characters)/i, "Use a password with at least 8 characters."],
  [/over_request_rate_limit|too many|rate.?limit|429/i, "Too many tries. Please wait a few minutes and try again."],
  [/otp|invalid[ _]token|expired|bad_jwt|invalid[ _]code/i, "That code is not right or has expired. Ask for a new one."],
];

interface Failure {
  message?: string;
  code?: string;
  status?: number;
}

/** The text shown for a failed sign-in step. Exported so it can be checked on its own. */
export function describeAuthFailure(error: Failure | null | undefined, fallback: string): string {
  const raw = `${error?.code ?? ""} ${error?.message ?? ""}`;
  return FRIENDLY.find(([pattern]) => pattern.test(raw))?.[1] ?? fallback;
}

function fail(error: Failure | null | undefined, fallback: string): never {
  throw new NeonAuthError(describeAuthFailure(error, fallback), error?.code);
}

/**
 * The Neon SDK throws for some failures and returns { error } for others. Both come back here as one
 * failure (or null when the step worked).
 */
async function failureOf(step: () => Promise<unknown>): Promise<Failure | null> {
  try {
    const result = (await step()) as { error?: Failure | null } | null | undefined;
    return result?.error ?? null;
  } catch (err) {
    const thrown = err as Failure | undefined;
    return { message: thrown?.message ?? "Sign-in failed", code: thrown?.code, status: thrown?.status };
  }
}

export async function neonSignUp(name: string, email: string, password: string) {
  const error = await failureOf(async () => (await neon()).signUp.email({ name, email, password }));
  if (error) fail(error, "Your account could not be created. Please try again.");
}

export async function neonSendCode(email: string, type: "email-verification" | "forget-password") {
  const error = await failureOf(async () => (await neon()).emailOtp.sendVerificationOtp({ email, type }));
  if (error) fail(error, "The code could not be sent. Please try again in a moment.");
}

export async function neonVerifyEmail(email: string, otp: string) {
  const error = await failureOf(async () => (await neon()).emailOtp.verifyEmail({ email, otp }));
  if (error) fail(error, "That code is not right or has expired. Ask for a new one.");
}

/** Returns false when the account exists but its email is not confirmed yet. */
export async function neonSignIn(email: string, password: string): Promise<boolean> {
  const error = await failureOf(async () => (await neon()).signIn.email({ email, password }));
  if (!error) return true;
  if (/email_not_confirmed|email_not_verified|not verified|not confirmed/i.test(`${error.code ?? ""} ${error.message ?? ""}`)) return false;
  fail(error, "Sign-in failed. Check your email and password.");
}

export async function neonResetPassword(email: string, otp: string, password: string) {
  const error = await failureOf(async () => (await neon()).emailOtp.resetPassword({ email, otp, password }));
  if (error) fail(error, "The password could not be changed. Ask for a new code and try again.");
}

export async function neonSocialStart(provider: "google" | "github", returnPath: string) {
  const back = `${window.location.origin}${returnPath}`;
  // First-time sign-ins and errors are sent back here too; otherwise Neon may land them on the home page.
  const error = await failureOf(async () => (await neon()).signIn.social({ provider, callbackURL: back, newUserCallbackURL: back, errorCallbackURL: `${back}?error=oauth` }));
  if (error) fail(error, "That sign-in could not be started. Please try again.");
}

/** The signed token Neon holds for the person who just signed in, or null. */
export async function neonToken(): Promise<string | null> {
  // The SDK puts the signed token it receives from Neon on the session as `token`.
  try {
    const session = await (await neon()).getSession();
    return session.data?.session?.token ?? null;
  } catch (err) {
    fail(err as Failure, "Sign-in could not be completed. Please try again.");
  }
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
