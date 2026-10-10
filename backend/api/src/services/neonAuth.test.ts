import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import {
  createNeonTokenVerifier,
  decideAccountLink,
  defaultWorkspaceName,
  exchangeNeonToken,
  neonAuthConfig,
  type AppUserRecord,
  type ExchangeDeps,
  type NeonUserRecord,
} from "./neonAuth";

const AUTH_URL = "https://ep-test-123.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth";
const ISSUER = "https://ep-test-123.neonauth.c-4.ap-southeast-1.aws.neon.tech";

test("Neon Auth is off until a valid https address is set", () => {
  assert.equal(neonAuthConfig({}), null);
  assert.equal(neonAuthConfig({ NEON_AUTH_URL: "not a url" }), null);
  assert.equal(neonAuthConfig({ NEON_AUTH_URL: "http://example.com/auth" }), null, "plain http is only allowed for localhost");
  assert.ok(neonAuthConfig({ NEON_AUTH_URL: "http://localhost:3000/auth" }));
  const config = neonAuthConfig({ NEON_AUTH_URL: `${AUTH_URL}/` })!;
  assert.equal(config.authUrl, AUTH_URL);
  assert.equal(config.issuer, ISSUER);
  assert.equal(config.jwksUrl, `${AUTH_URL}/.well-known/jwks.json`);
  assert.equal(neonAuthConfig({ NEON_AUTH_URL: AUTH_URL, NEON_JWKS_URL: "https://keys.example.com/jwks.json" })!.jwksUrl, "https://keys.example.com/jwks.json");
});

async function keySet(kid = "key-1") {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA" };
  return { privateKey, keys: createLocalJWKSet({ keys: [jwk] }) };
}

async function sign(privateKey: CryptoKey | Uint8Array, options: { issuer?: string; subject?: string | null; expires?: string; kid?: string } = {}) {
  let jwt = new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: options.kid ?? "key-1" }).setIssuedAt().setIssuer(options.issuer ?? ISSUER).setExpirationTime(options.expires ?? "15m");
  if (options.subject !== null) jwt = jwt.setSubject(options.subject ?? "neon-user-1");
  return jwt.sign(privateKey);
}

test("a genuine Neon token gives the user id, anything else gives nothing", async () => {
  const config = neonAuthConfig({ NEON_AUTH_URL: AUTH_URL })!;
  const { privateKey, keys } = await keySet();
  const verify = createNeonTokenVerifier(config, keys);

  assert.equal(await verify(await sign(privateKey)), "neon-user-1");
  assert.equal(await verify(await sign(privateKey, { issuer: "https://evil.example.com" })), null, "another issuer is refused");
  assert.equal(await verify(await sign(privateKey, { expires: "-1m" })), null, "an expired token is refused");
  assert.equal(await verify(await sign(privateKey, { subject: null })), null, "a token without a user is refused");
  const other = await keySet();
  assert.equal(await verify(await sign(other.privateKey)), null, "a token signed by some other key is refused");
  assert.equal(await verify("not-a-token"), null);
  assert.equal(await verify(""), null);

  // A token signed with a shared secret must not pass just because it names the right issuer.
  const secret = new TextEncoder().encode("shared-secret-shared-secret-shared-secret");
  const hs = await new SignJWT({}).setProtectedHeader({ alg: "HS256", kid: "key-1" }).setIssuer(ISSUER).setSubject("neon-user-1").setExpirationTime("15m").sign(secret);
  assert.equal(await verify(hs), null, "only EdDSA is accepted");
});

const neonUser = (over: Partial<NeonUserRecord> = {}): NeonUserRecord => ({ id: "neon-user-1", email: "asha@firm.in", name: "Asha Rao", emailVerified: true, banned: false, ...over });
const appUser = (over: Partial<AppUserRecord> = {}): AppUserRecord => ({ id: 7, email: "asha@firm.in", neonUserId: null, status: "active", ...over });

test("accounts are matched by Neon id, then by a verified email, and never taken over", () => {
  assert.deepEqual(decideAccountLink(neonUser(), appUser({ neonUserId: "neon-user-1" }), null), { action: "sign_in", userId: 7 });
  assert.deepEqual(decideAccountLink(neonUser(), null, appUser()), { action: "link", userId: 7 }, "an older account with the same verified email is claimed");
  assert.deepEqual(decideAccountLink(neonUser(), null, null), { action: "create" });
  assert.deepEqual(decideAccountLink(neonUser({ emailVerified: false }), null, appUser()), { action: "reject", reason: "email_not_verified" }, "an unverified address cannot claim a workspace");
  assert.deepEqual(decideAccountLink(neonUser({ banned: true }), appUser({ neonUserId: "neon-user-1" }), null), { action: "reject", reason: "banned" });
  assert.deepEqual(decideAccountLink(neonUser(), null, appUser({ neonUserId: "someone-else" })), { action: "reject", reason: "linked_elsewhere" });
  assert.deepEqual(decideAccountLink(neonUser(), appUser({ neonUserId: "neon-user-1", status: "suspended" }), null), { action: "reject", reason: "inactive" });
  assert.deepEqual(decideAccountLink(neonUser(), null, appUser({ status: "suspended" })), { action: "reject", reason: "inactive" });
});

test("a new workspace is named from the form, or from the person's name", () => {
  assert.equal(defaultWorkspaceName(neonUser(), "  Mehta & Co  "), "Mehta & Co");
  assert.equal(defaultWorkspaceName(neonUser(), ""), "Asha's workspace");
  assert.equal(defaultWorkspaceName(neonUser({ name: null, email: "ravi@x.in" })), "ravi's workspace");
});

function fakeDeps(over: Partial<ExchangeDeps> & { neon?: NeonUserRecord | null; byNeonId?: AppUserRecord | null; byEmail?: AppUserRecord | null } = {}) {
  const calls: string[] = [];
  const deps: ExchangeDeps = {
    verify: async token => (token === "good" ? "neon-user-1" : null),
    loadNeonUser: async () => (over.neon === undefined ? neonUser() : over.neon),
    findAppUsers: async () => ({ byNeonId: over.byNeonId ?? null, byEmail: over.byEmail ?? null }),
    linkUser: async (userId, neonId) => { calls.push(`link:${userId}:${neonId}`); },
    createWorkspace: async ({ companyName }) => { calls.push(`create:${companyName}`); return 99; },
    startSession: async (userId, how) => { calls.push(`session:${userId}:${how}`); return { status: 200, body: { token: "our-token", userId } }; },
    ...over,
  };
  return { deps, calls };
}

test("signing in with Neon ends in the usual TallyThis session", async () => {
  const bad = await exchangeNeonToken("bad", undefined, fakeDeps().deps);
  assert.equal(bad.status, 401);

  const missing = await exchangeNeonToken("good", undefined, fakeDeps({ neon: null }).deps);
  assert.equal(missing.status, 401, "a token for a user Neon does not know is refused");

  const returning = fakeDeps({ byNeonId: appUser({ neonUserId: "neon-user-1" }) });
  assert.equal((await exchangeNeonToken("good", undefined, returning.deps)).status, 200);
  assert.deepEqual(returning.calls, ["session:7:sign_in"]);

  const claiming = fakeDeps({ byEmail: appUser() });
  await exchangeNeonToken("good", undefined, claiming.deps);
  assert.deepEqual(claiming.calls, ["link:7:neon-user-1", "session:7:link"]);

  const fresh = fakeDeps();
  const made = await exchangeNeonToken("good", "Mehta & Co", fresh.deps);
  assert.equal(made.status, 200);
  assert.deepEqual(fresh.calls, ["create:Mehta & Co", "session:99:create"]);

  const unverified = fakeDeps({ neon: neonUser({ emailVerified: false }), byEmail: appUser() });
  const refused = await exchangeNeonToken("good", undefined, unverified.deps);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "email_not_verified");
  assert.deepEqual(unverified.calls, [], "nothing is linked or created for an unverified address");
});
