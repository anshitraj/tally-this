import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export interface AuthTokenPayload {
  sid: number;
  sub: number;
  cid: number;
  email: string;
  role: string;
  exp: number;
  iat: number;
}

const DEFAULT_SESSION_HOURS = 12;
const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_DIGEST = "sha512";

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function parseJsonBase64Url<T>(input: string): T {
  return JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as T;
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const hash = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const { hash } = hashPassword(password, salt);
  const actual = Buffer.from(hash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Published in this repository, so it may only ever be used on a developer machine.
const DEVELOPMENT_SECRET = "finverify-dev-session-secret-change-me";
const MIN_PRODUCTION_SECRET_LENGTH = 32;

export function isProduction(env: Record<string, string | undefined> = process.env): boolean {
  return [env.NODE_ENV, env.APP_ENV].some(value => value?.trim().toLowerCase() === "production");
}

/**
 * Why the signing secret cannot be used, or null. A developer machine may run without one;
 * production may not: it needs a real key of at least 32 characters, not the published development value,
 * otherwise anyone could sign their own session token.
 */
export function signingSecretProblem(env: Record<string, string | undefined> = process.env): string | null {
  if (!isProduction(env)) return null;
  const secret = env.JWT_SECRET || env.SESSION_SECRET;
  if (!secret) return "JWT_SECRET or SESSION_SECRET must be set in production";
  if (secret === DEVELOPMENT_SECRET || secret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    return "The production signing secret must be at least 32 characters and not the development value";
  }
  return null;
}

export function jwtSecret(): string {
  const problem = signingSecretProblem();
  if (problem) throw new Error(problem);
  return process.env.JWT_SECRET || process.env.SESSION_SECRET || DEVELOPMENT_SECRET;
}

export function sessionDurationMs(): number {
  const hours = Number(process.env.SESSION_HOURS ?? DEFAULT_SESSION_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SESSION_HOURS) * 60 * 60 * 1000;
}

export function signAuthToken(payload: Omit<AuthTokenPayload, "iat" | "exp">, expiresAt: Date): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body: AuthTokenPayload = {
    ...payload,
    iat: now,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedBody = base64Url(JSON.stringify(body));
  const unsigned = `${encodedHeader}.${encodedBody}`;
  const signature = createHmac("sha256", jwtSecret()).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedBody, signature] = parts;
  const unsigned = `${encodedHeader}.${encodedBody}`;
  const expected = createHmac("sha256", jwtSecret()).update(unsigned).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  const payload = parseJsonBase64Url<AuthTokenPayload>(encodedBody);
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function bearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const [scheme, token] = value.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

export function signOAuthState(payload: Record<string, unknown>): string {
  const body = base64Url(JSON.stringify({
    ...payload,
    nonce: randomBytes(16).toString("base64url"),
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
  }));
  const signature = createHmac("sha256", jwtSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyOAuthState<T extends Record<string, unknown>>(state: string): T | null {
  const [body, signature] = state.split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", jwtSecret()).update(body).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  const payload = parseJsonBase64Url<T & { exp?: number }>(body);
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
