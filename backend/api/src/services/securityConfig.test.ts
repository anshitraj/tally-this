import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { isProduction, jwtSecret, signingSecretProblem } from "./auth";
import { checkTallyTarget, tallyConnectorEnabled } from "./tallyTarget";
import { workerHeaders, workerUrl } from "./workerClient";
import { validateServerEnv } from "../server/envValidation";

const STRONG = "a-long-random-production-secret-0123456789abcdef";
const DEV_VALUE = "finverify-dev-session-secret-change-me";
const SAMPLE_VALUE = "replace-with-a-long-random-secret";
// Tests run from backend/api (pnpm test); the sample file is at the repository root.
const SAMPLE_ENV_FILE = path.resolve(process.cwd(), "../../.env.example");

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const NONE = { NODE_ENV: undefined, APP_ENV: undefined, JWT_SECRET: undefined, SESSION_SECRET: undefined };

// ── the worker token ────────────────────────────────────────────────────────

test("the API sends the worker token when it has one, and nothing otherwise", () => {
  assert.deepEqual(workerHeaders({}, {}), {});
  assert.deepEqual(workerHeaders({}, { WORKER_SERVICE_TOKEN: "   " }), {});
  assert.deepEqual(workerHeaders({}, { WORKER_SERVICE_TOKEN: " tok " }), { "X-Service-Token": "tok" });
  assert.deepEqual(workerHeaders({ "Content-Type": "application/json" }, { WORKER_SERVICE_TOKEN: "tok" }), { "X-Service-Token": "tok", "Content-Type": "application/json" });
  assert.equal(workerUrl({}), "http://localhost:8091");
  assert.equal(workerUrl({ PYTHON_WORKER_URL: "http://worker.internal:8091" }), "http://worker.internal:8091");
});

// ── the signing secret ──────────────────────────────────────────────────────

test("production will not run without a strong signing secret", () => {
  assert.equal(signingSecretProblem({}), null, "a developer machine may run without one");
  for (const env of ["NODE_ENV", "APP_ENV"]) {
    assert.match(signingSecretProblem({ [env]: "production" }) ?? "", /must be set in production/, `${env}=production with no secret`);
    assert.match(signingSecretProblem({ [env]: "production", JWT_SECRET: DEV_VALUE }) ?? "", /at least 32/, "the published development value");
    assert.match(signingSecretProblem({ [env]: "production", JWT_SECRET: SAMPLE_VALUE }) ?? "", /published in this repository/, "the sample in .env.example");
    assert.match(signingSecretProblem({ [env]: "production", JWT_SECRET: "short" }) ?? "", /at least 32/, "a short secret");
    assert.match(signingSecretProblem({ [env]: "production", JWT_SECRET: "x".repeat(31) }) ?? "", /at least 32/, "31 characters");
    assert.equal(signingSecretProblem({ [env]: "production", JWT_SECRET: STRONG }), null);
    assert.equal(signingSecretProblem({ [env]: "production", SESSION_SECRET: STRONG }), null);
    assert.equal(signingSecretProblem({ [env]: "production", JWT_SECRET: "", SESSION_SECRET: STRONG }), null, "an empty JWT_SECRET falls back to SESSION_SECRET");
  }
  assert.equal(isProduction({ NODE_ENV: " Production " }), true);
  assert.equal(isProduction({ NODE_ENV: "development" }), false);
});

// A sample longer than 32 characters passes the length rule, so it has to be refused by name. Whatever the
// sample is changed to, this test follows it.
test("production refuses whatever sample secret .env.example shows", { skip: !fs.existsSync(SAMPLE_ENV_FILE) }, () => {
  const line = fs.readFileSync(SAMPLE_ENV_FILE, "utf8").split(/\r?\n/).find(text => text.trim().startsWith("JWT_SECRET="));
  const sample = (line ?? "").trim().slice("JWT_SECRET=".length).replace(/^["']|["']$/g, "");
  if (!sample) return; // a blank sample cannot be copied into production by accident
  assert.match(signingSecretProblem({ NODE_ENV: "production", JWT_SECRET: sample }) ?? "", /published in this repository/);
});

test("signing refuses in production instead of using the published secret", () => {
  withEnv({ ...NONE, APP_ENV: "production" }, () => assert.throws(() => jwtSecret(), /must be set in production/));
  withEnv({ ...NONE, NODE_ENV: "production", JWT_SECRET: DEV_VALUE }, () => assert.throws(() => jwtSecret(), /at least 32/));
  withEnv({ ...NONE, NODE_ENV: "production", JWT_SECRET: STRONG }, () => assert.equal(jwtSecret(), STRONG));
  withEnv({ ...NONE }, () => assert.equal(jwtSecret(), DEV_VALUE));
  withEnv({ ...NONE, JWT_SECRET: "mine" }, () => assert.equal(jwtSecret(), "mine"));
});

test("the server refuses to start in production with a weak secret", () => {
  const base = { DATABASE_URL: "postgres://example", NODE_ENV: "production" };
  withEnv({ ...NONE, ...base }, () => assert.throws(() => validateServerEnv(), /must be set in production/));
  withEnv({ ...NONE, ...base, JWT_SECRET: DEV_VALUE }, () => assert.throws(() => validateServerEnv(), /at least 32/));
  withEnv({ ...NONE, ...base, APP_ENV: "production", NODE_ENV: undefined, JWT_SECRET: "short" }, () => assert.throws(() => validateServerEnv(), /at least 32/));
  withEnv({ ...NONE, ...base, JWT_SECRET: STRONG }, () => assert.doesNotThrow(() => validateServerEnv()));
  withEnv({ ...NONE, DATABASE_URL: "postgres://example" }, () => assert.doesNotThrow(() => validateServerEnv()));
});

// ── the Tally connector address ─────────────────────────────────────────────

const refused = (host: unknown, port: unknown, env: Record<string, string | undefined> = {}) => {
  const result = checkTallyTarget(host, port, env);
  assert.equal(result.ok, false, `${String(host)}:${String(port)} should be refused`);
  return result.ok ? "" : result.error;
};

test("a live Tally connection is only offered where it can work", () => {
  assert.equal(tallyConnectorEnabled({}), true);
  assert.equal(tallyConnectorEnabled({ NODE_ENV: "production" }), false);
  assert.equal(tallyConnectorEnabled({ APP_ENV: "production" }), false);
  assert.equal(tallyConnectorEnabled({ APP_ENV: "production", TALLY_CONNECTOR_ENABLED: "true" }), true);
  assert.equal(tallyConnectorEnabled({ TALLY_CONNECTOR_ENABLED: "false" }), false);
  assert.match(refused("localhost", 9000, { APP_ENV: "production" }), /switched off/);
});

test("only this computer on the Tally port is allowed by default", () => {
  for (const host of ["localhost", "LOCALHOST", " localhost ", "127.0.0.1", "::1", "[::1]"]) {
    assert.deepEqual(checkTallyTarget(host, 9000, {}), { ok: true, host: host.trim().toLowerCase().replace(/^\[|\]$/g, ""), port: 9000 }, host);
  }
  assert.deepEqual(checkTallyTarget(undefined, "9000", {}), { ok: true, host: "localhost", port: 9000 }, "the page's defaults");
  assert.deepEqual(checkTallyTarget(null, 9000, {}), { ok: true, host: "localhost", port: 9000 }, "no host means this computer");
});

test("every other address is refused", () => {
  for (const host of ["169.254.169.254", "10.0.0.5", "192.168.1.20", "172.16.0.1", "example.com", "evil.example.com", "0.0.0.0", "2130706433", "127.1", "0x7f.0.0.1", "metadata.google.internal", "", "   ", 5, {}]) {
    refused(host, 9000);
  }
});

test("malformed addresses are refused", () => {
  for (const host of ["http://localhost", "localhost/", "localhost:9000", "user@localhost", "local host", "localhost#x", "localhost?x=1", "a..b", "-bad.example.com", "x".repeat(300), "999.1.1.1", "01.1.1.1"]) {
    refused(host, 9000);
  }
});

test("an administrator can add a computer, but never a metadata or link-local address", () => {
  const env = { TALLY_ALLOWED_HOSTS: "tally.office.lan, 192.168.1.20" };
  assert.deepEqual(checkTallyTarget("tally.office.lan", 9000, env), { ok: true, host: "tally.office.lan", port: 9000 });
  assert.deepEqual(checkTallyTarget("192.168.1.20", 9000, env), { ok: true, host: "192.168.1.20", port: 9000 });
  refused("192.168.1.21", 9000, env);
  const hostile = { TALLY_ALLOWED_HOSTS: "169.254.169.254,169.254.10.10,0.0.0.0,224.0.0.1,fe80::1,::,100.100.100.200,168.63.129.16,fd00:ec2::254" };
  for (const host of ["169.254.169.254", "169.254.10.10", "0.0.0.0", "224.0.0.1", "fe80::1", "::", "100.100.100.200", "168.63.129.16", "fd00:ec2::254"]) refused(host, 9000, hostile);
});

test("only the Tally port is allowed unless more are listed", () => {
  assert.equal(checkTallyTarget("localhost", 9001, {}).ok, false);
  assert.equal(checkTallyTarget("localhost", 9001, { TALLY_ALLOWED_PORTS: "9001, nope, 0, 70000" }).ok, true);
  assert.equal(checkTallyTarget("localhost", 70000, { TALLY_ALLOWED_PORTS: "70000" }).ok, false);
  for (const port of [22, 80, 443, 5432, 8080, 8091, 0, 65536, -1, "abc", NaN, null, {}, 9000.5]) refused("localhost", port);
});
