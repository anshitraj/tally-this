/**
 * Neon Auth (managed Better Auth) sign-in. The browser signs people in with Neon, which hands back a
 * short-lived signed token. This module only decides two things: is that token genuine, and which
 * TallyThis account does the person belong to. The rest of the product keeps using its own session.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface NeonAuthConfig {
  authUrl: string;
  jwksUrl: string;
  /** Tokens must name this origin as their issuer. */
  issuer: string;
}

export function neonAuthConfig(env: Record<string, string | undefined> = process.env): NeonAuthConfig | null {
  const authUrl = (env.NEON_AUTH_URL ?? "").trim().replace(/\/+$/, "");
  if (!authUrl) return null;
  let url: URL;
  try {
    url = new URL(authUrl);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  const jwksUrl = (env.NEON_JWKS_URL ?? "").trim() || `${authUrl}/.well-known/jwks.json`;
  return { authUrl, jwksUrl, issuer: url.origin };
}

/**
 * Returns the Neon user id when the token is signed by the configured keys, is not expired, was
 * issued by this Neon Auth origin and uses the expected algorithm. Anything else returns null.
 */
export function createNeonTokenVerifier(config: NeonAuthConfig, keys?: JWTVerifyGetKey) {
  const jwks = keys ?? createRemoteJWKSet(new URL(config.jwksUrl));
  return async (token: string): Promise<string | null> => {
    if (!token || token.split(".").length !== 3) return null;
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: config.issuer, algorithms: ["EdDSA"], clockTolerance: 5 });
      return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
    } catch {
      return null;
    }
  };
}

// ── Which TallyThis account is this? ────────────────────────────────────────

export interface NeonUserRecord {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  banned: boolean;
}

export interface AppUserRecord {
  id: number;
  email: string;
  neonUserId: string | null;
  status: string;
}

export type RejectReason = "email_not_verified" | "banned" | "inactive" | "linked_elsewhere";

export type LinkDecision =
  | { action: "sign_in"; userId: number }
  | { action: "link"; userId: number }
  | { action: "create" }
  | { action: "reject"; reason: RejectReason };

/**
 * A person is matched by their Neon id first. An existing TallyThis account with the same email is
 * claimed only when Neon has verified that the person owns that email; an unverified address can
 * never take over somebody else's workspace.
 */
export function decideAccountLink(neon: NeonUserRecord, byNeonId: AppUserRecord | null, byEmail: AppUserRecord | null): LinkDecision {
  if (neon.banned) return { action: "reject", reason: "banned" };
  if (!neon.emailVerified) return { action: "reject", reason: "email_not_verified" };
  if (byNeonId) {
    return byNeonId.status === "active" ? { action: "sign_in", userId: byNeonId.id } : { action: "reject", reason: "inactive" };
  }
  if (byEmail) {
    if (byEmail.neonUserId && byEmail.neonUserId !== neon.id) return { action: "reject", reason: "linked_elsewhere" };
    return byEmail.status === "active" ? { action: "link", userId: byEmail.id } : { action: "reject", reason: "inactive" };
  }
  return { action: "create" };
}

export const NEON_REJECTION_MESSAGES: Record<RejectReason, string> = {
  email_not_verified: "Confirm your email address first, then sign in.",
  banned: "This account has been blocked. Email us if you think this is a mistake.",
  inactive: "This account is switched off. Email us to get it turned back on.",
  linked_elsewhere: "This email is already connected to a different sign-in. Email us and we will sort it out.",
};

export function defaultWorkspaceName(neon: Pick<NeonUserRecord, "name" | "email">, requested?: string) {
  const asked = (requested ?? "").trim().slice(0, 120);
  if (asked) return asked;
  const first = (neon.name ?? "").trim().split(/\s+/)[0] || neon.email.split("@")[0];
  return `${first}'s workspace`;
}

// ── Putting it together ─────────────────────────────────────────────────────

export interface ExchangeDeps {
  verify(token: string): Promise<string | null>;
  loadNeonUser(id: string): Promise<NeonUserRecord | null>;
  findAppUsers(neonId: string, email: string): Promise<{ byNeonId: AppUserRecord | null; byEmail: AppUserRecord | null }>;
  linkUser(userId: number, neonId: string): Promise<void>;
  createWorkspace(input: { neon: NeonUserRecord; companyName: string }): Promise<number>;
  startSession(userId: number, how: "sign_in" | "link" | "create"): Promise<{ status: number; body: Record<string, unknown> }>;
}

export async function exchangeNeonToken(token: string, companyName: string | undefined, deps: ExchangeDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const neonId = await deps.verify(token);
  if (!neonId) return { status: 401, body: { error: "Your sign-in has expired. Please sign in again." } };

  const neon = await deps.loadNeonUser(neonId);
  if (!neon) return { status: 401, body: { error: "Your sign-in could not be confirmed. Please sign in again." } };

  const { byNeonId, byEmail } = await deps.findAppUsers(neon.id, neon.email.toLowerCase());
  const decision = decideAccountLink(neon, byNeonId, byEmail);
  if (decision.action === "reject") {
    return { status: 403, body: { error: NEON_REJECTION_MESSAGES[decision.reason], code: decision.reason } };
  }
  if (decision.action === "link") {
    await deps.linkUser(decision.userId, neon.id);
    return deps.startSession(decision.userId, "link");
  }
  if (decision.action === "sign_in") return deps.startSession(decision.userId, "sign_in");

  const userId = await deps.createWorkspace({ neon, companyName: defaultWorkspaceName(neon, companyName) });
  return deps.startSession(userId, "create");
}
