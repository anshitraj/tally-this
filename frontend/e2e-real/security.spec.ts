import crypto from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { MAY_STATEMENT } from "./data";
import { addTeamMember } from "./db";
import { PASSWORD, uniqueEmail } from "./helpers";

/**
 * Who can reach what, against the real backend: signed-out callers, forged tokens, another company's work, a person
 * with a read-only role, repeated wrong passwords, cross-site calls and oversized files.
 */

interface Person {
  email: string;
  token: string;
  companyId: number;
}

async function register(request: APIRequestContext, label: string): Promise<Person> {
  const email = uniqueEmail(label);
  const response = await request.post("/api/auth/register", { data: { name: "Test Person", email, password: PASSWORD, companyName: `${label} Co` } });
  expect(response.status(), await response.text()).toBe(201);
  const body = await response.json();
  return { email, token: body.token, companyId: body.user.companyId };
}

const as = (person: Pick<Person, "token">, headers: Record<string, string> = {}) => ({ Authorization: `Bearer ${person.token}`, ...headers });

async function signInAs(request: APIRequestContext, email: string): Promise<Person> {
  const response = await request.post("/api/auth/login", { data: { email, password: PASSWORD } });
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  return { email, token: body.token, companyId: body.user.companyId };
}

test.describe("signed out", () => {
  const PROTECTED: Array<[string, string]> = [
    ["GET", "/api/uploads"], ["GET", "/api/transactions"], ["GET", "/api/invoices"], ["GET", "/api/ledger"], ["GET", "/api/reports/summary"],
    ["GET", "/api/company"], ["GET", "/api/users"], ["GET", "/api/roles"], ["GET", "/api/audit-logs"], ["GET", "/api/documents"],
    ["GET", "/api/practice/clients"], ["GET", "/api/jobs/history"], ["GET", "/api/jobs/history/1"], ["GET", "/api/jobs/runs/1"],
    ["GET", "/api/workflow/runs"], ["GET", "/api/workflow/runs/1"], ["GET", "/api/action-history"], ["GET", "/api/account/plan"],
    ["GET", "/api/periods/locks"], ["GET", "/api/auth/me"], ["GET", "/api/jobs/ledger-mappings"], ["GET", "/api/tax-audit"],
    ["POST", "/api/jobs/detect"], ["POST", "/api/jobs/bank-statement/normalize"], ["POST", "/api/jobs/bank-to-tally/xml"],
    ["POST", "/api/jobs/bank-to-tally/send"], ["POST", "/api/jobs/ecommerce/normalize"], ["POST", "/api/jobs/invoice-bank/compare"],
    ["POST", "/api/jobs/runs/1/decision"], ["POST", "/api/reconciliation/run"], ["POST", "/api/practice/clients"],
    ["POST", "/api/account/profile"], ["PATCH", "/api/company"], ["DELETE", "/api/documents/1"], ["POST", "/api/periods/2026-05/lock"],
  ];

  test("every route that reads or changes work refuses a caller who is not signed in", async ({ request }) => {
    const wrong: string[] = [];
    for (const [method, path] of PROTECTED) {
      const response = await request.fetch(path, { method, data: method === "GET" ? undefined : {} });
      if (response.status() !== 401) wrong.push(`${method} ${path} answered ${response.status()}`);
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  test("the public routes answer without a sign-in and say nothing private", async ({ request }) => {
    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
    const body = await health.json();
    expect(body).toMatchObject({ ok: true, database: "ok", pythonWorker: "ok" });
    // The health answer names no host, key or address.
    expect(JSON.stringify(body)).not.toMatch(/postgres|password|secret|token|127\.0\.0\.1|localhost/i);
    expect((await request.get("/api/auth/neon/config")).status()).toBe(200);
  });

  test("an unknown API address is a plain 404 in JSON, not a page or a stack trace", async ({ request }) => {
    const response = await request.get("/api/this-does-not-exist");
    expect(response.status()).toBe(404);
    const text = await response.text();
    expect(text).not.toMatch(/at .*\(.*:\d+:\d+\)|node_modules|<html/i);
  });

  test("the website sends the basic security headers on every page", async ({ request }) => {
    for (const path of ["/", "/login", "/app/overview"]) {
      const headers = (await request.get(path)).headers();
      expect(headers["x-content-type-options"], path).toBe("nosniff");
      expect(headers["x-frame-options"], path).toBe("SAMEORIGIN");
      expect(headers["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
      expect(headers["permissions-policy"], path).toContain("camera=()");
    }
  });

  test("the sample workspace login is closed in a production setup", async ({ request }) => {
    const response = await request.post("/api/auth/demo", { data: { intent: "load_demo_workspace" } });
    expect(response.status()).toBe(403);
  });
});

test.describe("tokens", () => {
  function base64url(value: Buffer | string) {
    return Buffer.from(value).toString("base64url");
  }

  test("a token that was made up, altered or signed with another secret is refused", async ({ request }) => {
    const person = await register(request, "tokens");
    const [header, payload, signature] = person.token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

    const forged: Record<string, string> = {
      "random text": "not-a-token",
      "no signature": `${header}.${payload}.`,
      "alg none": `${base64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${payload}.`,
      "payload changed to another company": `${header}.${base64url(JSON.stringify({ ...claims, cid: claims.cid + 1 }))}.${signature}`,
      "payload changed to another person": `${header}.${base64url(JSON.stringify({ ...claims, sub: claims.sub + 1 }))}.${signature}`,
      "signed with another secret": (() => {
        const signed = `${header}.${payload}`;
        return `${signed}.${crypto.createHmac("sha256", "a-different-secret-that-is-long-enough-1234").update(signed).digest("base64url")}`;
      })(),
    };
    for (const [name, token] of Object.entries(forged)) {
      const response = await request.get("/api/company", { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status(), name).toBe(401);
    }
    // The real one still works.
    expect((await request.get("/api/company", { headers: as(person) })).status()).toBe(200);
  });

  test("signing out ends the session for good", async ({ request }) => {
    const person = await register(request, "logout");
    expect((await request.get("/api/auth/me", { headers: as(person) })).status()).toBe(200);
    expect((await request.post("/api/auth/logout", { headers: as(person) })).status()).toBe(200);
    expect((await request.get("/api/auth/me", { headers: as(person) })).status()).toBe(401);
  });
});

test.describe("two companies", () => {
  test("one company's saved work is invisible and untouchable to another", async ({ request }) => {
    const alice = await register(request, "alice");
    const bob = await register(request, "bob");

    // Alice reads a statement through the real endpoint.
    const upload = await request.post("/api/jobs/bank-statement/normalize", {
      headers: as(alice),
      multipart: { file: { name: "alice-statement.csv", mimeType: "text/csv", buffer: Buffer.from(MAY_STATEMENT.csv) } },
    });
    expect(upload.status(), await upload.text()).toBe(200);
    const history = await (await request.get("/api/jobs/history", { headers: as(alice) })).json();
    expect(history.runs).toHaveLength(1);
    const runId = history.runs[0].id as string;

    // Bob sees nothing of it, by any door.
    expect((await (await request.get("/api/jobs/history", { headers: as(bob) })).json()).runs).toEqual([]);
    for (const path of [`/api/jobs/history/${runId}`, `/api/jobs/runs/${runId}`, `/api/workflow/runs/${runId}`, `/api/workflow/runs/${runId}/progress`]) {
      const response = await request.get(path, { headers: as(bob) });
      expect([403, 404], `${path} answered ${response.status()}`).toContain(response.status());
      expect(await response.text()).not.toContain("alice-statement.csv");
    }
    const decision = await request.post(`/api/jobs/runs/${runId}/decision`, { headers: as(bob), data: { key: "x", status: "approved" } });
    expect([403, 404]).toContain(decision.status());
    // Bob cannot act as Alice's company by naming it.
    const named = await request.get("/api/jobs/history", { headers: as(bob, { "X-Client-Company-Id": String(alice.companyId) }) });
    expect(named.status()).toBe(403);
    // And Alice's work is still there, unchanged.
    expect((await (await request.get("/api/jobs/history", { headers: as(alice) })).json()).runs).toHaveLength(1);
  });
});

test.describe("roles", () => {
  test("a read-only team member can look but not change or upload", async ({ request }) => {
    const owner = await register(request, "owner");
    const viewerEmail = uniqueEmail("viewer");
    await addTeamMember(owner.email, viewerEmail, "viewer", "Read Only");
    const viewer = await signInAs(request, viewerEmail);

    expect((await request.get("/api/jobs/history", { headers: as(viewer) })).status()).toBe(200);
    expect((await request.get("/api/account/plan", { headers: as(viewer) })).status()).toBe(200);
    const denied: Array<[string, () => Promise<number>]> = [
      ["upload a statement", async () => (await request.post("/api/jobs/bank-statement/normalize", { headers: as(viewer), multipart: { file: { name: "s.csv", mimeType: "text/csv", buffer: Buffer.from(MAY_STATEMENT.csv) } } })).status()],
      ["add a client", async () => (await request.post("/api/practice/clients", { headers: as(viewer), data: { name: "Viewer Client" } })).status()],
      ["change the company", async () => (await request.patch("/api/company", { headers: as(viewer), data: { name: "Hacked" } })).status()],
      ["read the team list", async () => (await request.get("/api/users", { headers: as(viewer) })).status()],
    ];
    for (const [what, call] of denied) expect(await call(), `a viewer should not be able to ${what}`).toBe(403);
    // The owner's company is unchanged.
    expect((await (await request.get("/api/company", { headers: as(owner) })).json()).name).toBe("owner Co");
  });
});

test.describe("abuse", () => {
  test("repeated wrong passwords are slowed down", async ({ request }) => {
    const person = await register(request, "throttle");
    let last = 0;
    let retryAfter: string | undefined;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await request.post("/api/auth/login", { data: { email: person.email, password: `wrong-password-${attempt}` } });
      last = response.status();
      retryAfter = response.headers()["retry-after"];
      if (last === 429) break;
    }
    expect(last).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // The right password is refused too while the lock lasts.
    expect((await request.post("/api/auth/login", { data: { email: person.email, password: PASSWORD } })).status()).toBe(429);
  });

  test("a file over the size limit is refused with a plain message", async ({ request }) => {
    const person = await register(request, "big");
    const huge = Buffer.alloc(61 * 1024 * 1024, "a");
    const response = await request.post("/api/jobs/detect", { headers: as(person), multipart: { files: { name: "huge.csv", mimeType: "text/csv", buffer: huge } }, timeout: 120_000 });
    expect(response.status()).toBe(413);
    expect((await response.json()).message).toMatch(/60 MB/);
  });

  test("a request body that is not valid JSON is a client error, not a server error", async ({ request }) => {
    const person = await register(request, "badjson");
    const response = await request.post("/api/practice/clients", { headers: { ...as(person), "Content-Type": "application/json" }, data: "{not json" });
    expect(response.status()).toBe(400);
    expect(await response.text()).not.toMatch(/SyntaxError|at .*\(.*:\d+:\d+\)/);
  });

  test("a call from another website is not allowed to read the answer, one from the app is", async ({ request }) => {
    const gateway = process.env.STACK_GATEWAY_PORT || "18090";
    const web = `http://127.0.0.1:${process.env.STACK_WEB_PORT || "14173"}`;
    const url = `http://127.0.0.1:${gateway}/api/health`;
    const evil = await request.fetch(url, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
    expect(evil.headers()["access-control-allow-origin"]).toBeUndefined();
    const ours = await request.fetch(url, { method: "OPTIONS", headers: { Origin: web, "Access-Control-Request-Method": "GET" } });
    expect(ours.headers()["access-control-allow-origin"]).toBe(web);
  });
});
