import assert from "node:assert/strict";
import test from "node:test";
import { scrubSecrets, scrubValue } from "../lib/scrub";

/**
 * Everything below that looks like a key, token or password is made up. Each one is put together from pieces at
 * run time, so that no complete secret-shaped string sits in the source, where secret scanners would report it as
 * a leak. None of them was ever a real credential.
 */
const join = (...parts: string[]) => parts.join("");
const pgUrl = (scheme: "postgres" | "postgresql", user: string, password: string, host: string, rest = "/db") =>
  `${scheme}://${user}:${password}@${host}${rest}`;

const FAKE = {
  neonPassword: join("np", "g_", "ExampleOnly", "123456"),
  googleKey: join("AI", "za", "Sy", "ExampleOnly", "0123456789", "ABCDEFGHIJKLMNOPQRSTU"),
  anthropicKey: join("sk", "-ant-", "api03-", "abcdefghijklmnopqrstuv"),
  githubToken: join("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"),
  resendKey: join("re", "_", "ExampleOnly1234567890abcdef"),
  webToken: join("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxIn0", ".", "abcdefghijklmnopqrst"),
};

test("a database connection string never reaches the logs", () => {
  const neon = `Error connecting to database: ${pgUrl("postgresql", "example_owner", FAKE.neonPassword, "ep-example-host-pooler.ap-southeast-1.aws.neon.tech", "/exampledb?sslmode=require")} failed`;
  const clean = scrubSecrets(neon);
  assert.ok(!clean.includes("npg_"), clean);
  assert.ok(!clean.includes("example_owner"), clean);
  assert.ok(!clean.includes("ep-example"), clean);
  assert.match(clean, /^Error connecting to database: postgresql:\/\/<hidden> failed$/);
  assert.equal(scrubSecrets(pgUrl("postgres", "u", "p", "h")).includes("p@h"), false);
});

test("API keys and bearer tokens are hidden", () => {
  const samples = [
    `key ${FAKE.googleKey} was rejected`,
    `using ${FAKE.anthropicKey}`,
    `token ${FAKE.githubToken}`,
    `resend ${FAKE.resendKey}`,
    `Authorization: Bearer ${FAKE.webToken}`,
  ];
  for (const sample of samples) {
    const clean = scrubSecrets(sample);
    assert.match(clean, /<(key )?hidden>/, clean);
    assert.ok(!/AIza|sk-ant|ghp_|re_Example|eyJ/.test(clean), clean);
  }
  assert.equal(scrubSecrets('{"password":"hunter2-secret"}').includes("hunter2"), false);
  assert.equal(scrubSecrets("api_key=abcdef123456").includes("abcdef123456"), false);
});

test("ordinary log text is left exactly as it is", () => {
  for (const text of [
    "Server listening",
    "AI document read failed",
    "400 invalid_request_error: This API key is not scoped to a workspace",
    "request completed in 184 ms for /api/jobs/history?limit=30",
    "Match #12 marked approved.",
  ]) {
    assert.equal(scrubSecrets(text), text);
  }
});

test("an error stays an error, with its secrets taken out of the message and the stack", () => {
  const leaky = `connect failed: ${pgUrl("postgresql", "u", "secretpass", "host")}`;
  const original = new Error(leaky);
  const clean = scrubValue({ err: original }) as { err: Error };
  assert.ok(clean.err instanceof Error);
  assert.equal(clean.err.message, "connect failed: postgresql://<hidden>");
  assert.ok(!String(clean.err.stack).includes("secretpass"));
  assert.ok(String(clean.err.stack).startsWith("Error: connect failed"), "the stack is kept so the error can still be traced");
  assert.equal(original.message, leaky, "the original error is not changed");
  const withCause = scrubValue(new Error("outer", { cause: new Error(`inner ${pgUrl("postgres", "a", "b", "c", "/d")}`) })) as Error;
  assert.equal((withCause.cause as Error).message, "inner postgres://<hidden>");
});

test("objects are scrubbed in a copy, deeply, without looping on cycles", () => {
  const cyc: Record<string, unknown> = { note: "fine" };
  cyc.self = cyc;
  const leaky = `bad ${pgUrl("postgres", "a", "b", "c", "/d")}`;
  const original = { err: { message: leaky }, list: ["ok", "Bearer abcdefghijklmnop1234"], n: 5, cyc };
  const clean = scrubValue(original) as typeof original;
  assert.equal(clean.err.message, "bad postgres://<hidden>");
  assert.equal(clean.list[1], "Bearer <hidden>");
  assert.equal(clean.n, 5);
  assert.equal((clean.cyc as Record<string, unknown>).self, "[circular]");
  assert.equal(original.err.message, leaky, "the original is not changed");
});
