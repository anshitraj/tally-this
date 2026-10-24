import assert from "node:assert/strict";
import test from "node:test";
import { scrubSecrets, scrubValue } from "../lib/scrub";

test("a database connection string never reaches the logs", () => {
  const neon = "Error connecting to database: postgresql://neondb_owner:npg_AbCdEf123456@ep-quiet-hat-a1b2c3d4-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require failed";
  const clean = scrubSecrets(neon);
  assert.ok(!clean.includes("npg_"), clean);
  assert.ok(!clean.includes("neondb_owner"), clean);
  assert.ok(!clean.includes("ep-quiet"), clean);
  assert.match(clean, /^Error connecting to database: postgresql:\/\/<hidden> failed$/);
  assert.equal(scrubSecrets("postgres://u:p@h/db").includes("p@h"), false);
});

test("API keys and bearer tokens are hidden", () => {
  const samples = [
    "key AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q was rejected",
    "using sk-ant-api03-abcdefghijklmnopqrstuv",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "resend re_AbCdEf1234567890abcdef",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrst",
  ];
  for (const sample of samples) {
    const clean = scrubSecrets(sample);
    assert.match(clean, /<(key )?hidden>/, clean);
    assert.ok(!/AIza|sk-ant|ghp_|re_AbC|eyJ/.test(clean), clean);
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
  const original = new Error("connect failed: postgresql://u:secretpass@host/db");
  const clean = scrubValue({ err: original }) as { err: Error };
  assert.ok(clean.err instanceof Error);
  assert.equal(clean.err.message, "connect failed: postgresql://<hidden>");
  assert.ok(!String(clean.err.stack).includes("secretpass"));
  assert.ok(String(clean.err.stack).startsWith("Error: connect failed"), "the stack is kept so the error can still be traced");
  assert.equal(original.message, "connect failed: postgresql://u:secretpass@host/db", "the original error is not changed");
  const withCause = scrubValue(new Error("outer", { cause: new Error("inner postgres://a:b@c/d") })) as Error;
  assert.equal((withCause.cause as Error).message, "inner postgres://<hidden>");
});

test("objects are scrubbed in a copy, deeply, without looping on cycles", () => {
  const cyc: Record<string, unknown> = { note: "fine" };
  cyc.self = cyc;
  const original = { err: { message: "bad postgres://a:b@c/d" }, list: ["ok", "Bearer abcdefghijklmnop1234"], n: 5, cyc };
  const clean = scrubValue(original) as typeof original;
  assert.equal(clean.err.message, "bad postgres://<hidden>");
  assert.equal(clean.list[1], "Bearer <hidden>");
  assert.equal(clean.n, 5);
  assert.equal((clean.cyc as Record<string, unknown>).self, "[circular]");
  assert.equal(original.err.message, "bad postgres://a:b@c/d", "the original is not changed");
});
