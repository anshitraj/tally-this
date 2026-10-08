import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { auditLogsTable, authSessionsTable, companiesTable, oauthAccountsTable, rolePermissionsTable, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { defaultRolePermissions } from "./permissions";
import { sessionDurationMs, signAuthToken, signOAuthState, tokenHash, verifyOAuthState } from "./auth";

export type OAuthProvider = "google" | "github";

type OAuthProfile = {
  provider: OAuthProvider;
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  avatarUrl?: string | null;
};

type OAuthProviderConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

function publicAppUrl(req: Request) {
  return (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

function apiBaseUrl(req: Request) {
  return (process.env.API_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

function oauthConfig(req: Request, provider: OAuthProvider): OAuthProviderConfig | null {
  if (provider === "google") {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      redirectUri: process.env.GOOGLE_REDIRECT_URI || `${apiBaseUrl(req)}/api/auth/google/callback`,
    };
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: process.env.GITHUB_REDIRECT_URI || `${apiBaseUrl(req)}/api/auth/github/callback`,
  };
}

export function oauthProviderStatus() {
  return {
    google: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? "configured" : "missing",
    github: process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET ? "configured" : "missing",
  };
}

export function startOAuth(req: Request, res: Response, provider: OAuthProvider) {
  const config = oauthConfig(req, provider);
  if (!config) {
    res.status(503).json({ error: `${provider} auth is not configured` });
    return;
  }

  const returnTo = typeof req.query.returnTo === "string" && req.query.returnTo.startsWith("/") ? req.query.returnTo : "/app/overview";
  const state = signOAuthState({ provider, returnTo });
  res.cookie("finverify_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 10 * 60 * 1000,
    path: "/api/auth",
  });

  if (provider === "google") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "select_account");
    res.redirect(url.toString());
    return;
  }

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
}

async function exchangeGoogleCode(config: OAuthProviderConfig, code: string): Promise<OAuthProfile> {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) throw new Error("google_token_exchange_failed");
  const tokenPayload = await tokenResponse.json() as { access_token?: string };
  if (!tokenPayload.access_token) throw new Error("google_missing_access_token");

  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
  });
  if (!profileResponse.ok) throw new Error("google_userinfo_failed");
  const profile = await profileResponse.json() as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  if (!profile.sub || !profile.email) throw new Error("google_profile_incomplete");
  return {
    provider: "google",
    providerUserId: profile.sub,
    email: profile.email.toLowerCase(),
    emailVerified: profile.email_verified === true,
    name: profile.name || profile.email,
    avatarUrl: profile.picture ?? null,
  };
}

async function exchangeGitHubCode(config: OAuthProviderConfig, code: string): Promise<OAuthProfile> {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }),
  });
  if (!tokenResponse.ok) throw new Error("github_token_exchange_failed");
  const tokenPayload = await tokenResponse.json() as { access_token?: string };
  if (!tokenPayload.access_token) throw new Error("github_missing_access_token");

  const headers = {
    Authorization: `Bearer ${tokenPayload.access_token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "TallyThis-OS",
  };
  const [userResponse, emailsResponse] = await Promise.all([
    fetch("https://api.github.com/user", { headers }),
    fetch("https://api.github.com/user/emails", { headers }),
  ]);
  if (!userResponse.ok || !emailsResponse.ok) throw new Error("github_profile_failed");
  const user = await userResponse.json() as { id?: number; login?: string; name?: string | null; avatar_url?: string | null };
  const emails = await emailsResponse.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
  const primary = emails.find((item) => item.primary && item.verified) ?? emails.find((item) => item.verified);
  if (!user.id || !primary) throw new Error("github_verified_email_required");
  return {
    provider: "github",
    providerUserId: String(user.id),
    email: primary.email.toLowerCase(),
    emailVerified: primary.verified,
    name: user.name || user.login || primary.email,
    avatarUrl: user.avatar_url ?? null,
  };
}

function workspaceName(profile: OAuthProfile) {
  const domain = profile.email.split("@")[1]?.split(".")[0];
  if (!domain) return `${profile.name}'s Workspace`;
  return `${domain.charAt(0).toUpperCase()}${domain.slice(1)} Workspace`;
}

async function getOrCreateOAuthUser(profile: OAuthProfile) {
  const [linked] = await db.select().from(oauthAccountsTable).where(and(
    eq(oauthAccountsTable.provider, profile.provider),
    eq(oauthAccountsTable.providerUserId, profile.providerUserId),
  )).limit(1);

  if (linked) {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, linked.userId)).limit(1);
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, linked.companyId)).limit(1);
    if (!user || !company || user.status !== "active") throw new Error("oauth_linked_user_inactive");
    await db.update(oauthAccountsTable).set({ lastLoginAt: new Date() }).where(eq(oauthAccountsTable.id, linked.id));
    return { user, company, created: false };
  }

  const [existingUser] = await db.select().from(usersTable).where(eq(usersTable.email, profile.email)).limit(1);
  if (existingUser?.companyId) {
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, existingUser.companyId)).limit(1);
    if (!company || existingUser.status !== "active") throw new Error("oauth_existing_user_inactive");
    await db.insert(oauthAccountsTable).values({
      userId: existingUser.id,
      companyId: company.id,
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl ?? null,
      lastLoginAt: new Date(),
    });
    return { user: existingUser, company, created: false };
  }

  const [company] = await db.insert(companiesTable).values({
    name: workspaceName(profile),
    industry: "Startup finance",
    financialYearStart: "April",
    currency: "INR",
    dataRetentionDays: 365,
  }).returning();
  const [user] = await db.insert(usersTable).values({
    companyId: company.id,
    name: profile.name,
    email: profile.email,
    role: "founder",
    status: "active",
  }).returning();
  await db.insert(rolePermissionsTable).values(defaultRolePermissions(company.id));
  await db.insert(oauthAccountsTable).values({
    userId: user.id,
    companyId: company.id,
    provider: profile.provider,
    providerUserId: profile.providerUserId,
    email: profile.email,
    name: profile.name,
    avatarUrl: profile.avatarUrl ?? null,
    lastLoginAt: new Date(),
  });
  return { user, company, created: true };
}

function callbackHtml(input: {
  token: string;
  expiresAt: string;
  returnTo: string;
  user: Record<string, unknown>;
}) {
  const session = JSON.stringify({
    token: input.token,
    expiresAt: input.expiresAt,
    user: input.user,
  }).replace(/</g, "\\u003c");
  const returnTo = JSON.stringify(input.returnTo);
  return `<!doctype html><html><head><meta charset="utf-8"><title>TallyThis</title></head><body><script>
localStorage.setItem("finverify_auth", ${JSON.stringify(session)});
window.location.replace(${returnTo});
</script></body></html>`;
}

export async function finishOAuth(req: Request, res: Response, provider: OAuthProvider) {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const cookieState = req.cookies?.finverify_oauth_state;
  res.clearCookie("finverify_oauth_state", { path: "/api/auth" });

  if (!code || !state || !cookieState || state !== cookieState) {
    res.redirect(`${publicAppUrl(req)}/login?error=oauth_state`);
    return;
  }

  const parsedState = verifyOAuthState<{ provider: OAuthProvider; returnTo?: string }>(state);
  if (!parsedState || parsedState.provider !== provider) {
    res.redirect(`${publicAppUrl(req)}/login?error=oauth_state`);
    return;
  }

  try {
    const config = oauthConfig(req, provider);
    if (!config) throw new Error(`${provider}_not_configured`);
    const profile = provider === "google" ? await exchangeGoogleCode(config, code) : await exchangeGitHubCode(config, code);
    if (!profile.emailVerified) throw new Error(`${provider}_verified_email_required`);
    const { user, company, created } = await getOrCreateOAuthUser(profile);

    const expiresAt = new Date(Date.now() + sessionDurationMs());
    const [session] = await db.insert(authSessionsTable).values({
      userId: user.id,
      companyId: company.id,
      tokenHash: "pending",
      userAgent: Array.isArray(req.headers["user-agent"]) ? req.headers["user-agent"][0] : req.headers["user-agent"] ?? null,
      ipAddress: req.ip,
      expiresAt,
    }).returning();

    const token = signAuthToken({
      sid: session.id,
      sub: user.id,
      cid: company.id,
      email: user.email,
      role: user.role,
    }, expiresAt);
    await db.update(authSessionsTable).set({ tokenHash: tokenHash(token) }).where(eq(authSessionsTable.id, session.id));
    await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));
    await db.insert(auditLogsTable).values({
      companyId: company.id,
      userId: user.id,
      actorEmail: user.email,
      action: created ? "auth.oauth_workspace_created" : "auth.oauth_login",
      entityType: "user",
      entityId: user.id,
      metadata: { provider, sessionId: session.id },
      ipAddress: req.ip,
    });

    res.type("html").send(callbackHtml({
      token,
      expiresAt: expiresAt.toISOString(),
      returnTo: parsedState.returnTo && parsedState.returnTo.startsWith("/") ? parsedState.returnTo : "/app/overview",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        companyId: company.id,
        company: company.name,
      },
    }));
  } catch {
    res.redirect(`${publicAppUrl(req)}/login?error=oauth_failed`);
  }
}
