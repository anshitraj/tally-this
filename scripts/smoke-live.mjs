#!/usr/bin/env node
/**
 * Checks a deployed TallyThis from the outside, the way anyone on the internet can: no account, no password, nothing is
 * created or changed. It never calls the sample-workspace route (which would write data if a server were misconfigured).
 *
 *   node scripts/smoke-live.mjs https://api.tallythis.xyz
 *   node scripts/smoke-live.mjs https://api.tallythis.xyz --site https://www.tallythis.xyz
 *
 * The first address is the backend itself (Caddy on the VM); --site is the website, whose /api must reach the same
 * backend. Exit code 1 if any check fails. What it does not do: sign in, upload a real file, or test email delivery.
 */
import tls from "node:tls";

const args = process.argv.slice(2);
const backend = (args.find(arg => /^https?:\/\//.test(arg)) ?? "").replace(/\/$/, "");
const siteIndex = args.indexOf("--site");
const site = siteIndex >= 0 ? String(args[siteIndex + 1] ?? "").replace(/\/$/, "") : "";
if (!backend) {
  console.error("Usage: node scripts/smoke-live.mjs <backend address> [--site <website address>]");
  process.exit(2);
}

const results = [];
function record(status, name, detail = "") {
  results.push({ status, name, detail });
  const mark = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "info";
  console.log(`${mark.padEnd(5)} ${name}${detail ? `  (${detail})` : ""}`);
}
const check = (ok, name, detail) => record(ok ? "pass" : "fail", name, detail);

async function call(base, path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeout ?? 30_000);
  try {
    const response = await fetch(`${base}${path}`, { redirect: "manual", signal: controller.signal, ...init });
    const text = await response.text().catch(() => "");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, headers: response.headers, text, json };
  } catch (error) {
    return { status: 0, headers: new Headers(), text: String(error), json: null };
  } finally {
    clearTimeout(timer);
  }
}

function certificate(host) {
  return new Promise(resolve => {
    const socket = tls.connect({ host, port: 443, servername: host }, () => {
      const cert = socket.getPeerCertificate();
      resolve({ ok: socket.authorized, error: socket.authorizationError, expires: new Date(cert.valid_to), issuer: cert.issuer?.O ?? cert.issuer?.CN });
      socket.end();
    });
    socket.on("error", error => resolve({ ok: false, error: error.message }));
    socket.setTimeout(15_000, () => {
      socket.destroy();
      resolve({ ok: false, error: "timed out" });
    });
  });
}

const PROTECTED = [
  ["GET", "/api/uploads"], ["GET", "/api/company"], ["GET", "/api/users"], ["GET", "/api/jobs/history"], ["GET", "/api/workflow/runs"],
  ["GET", "/api/action-history"], ["GET", "/api/account/plan"], ["GET", "/api/practice/clients"], ["GET", "/api/audit-logs"],
  ["POST", "/api/jobs/detect"], ["POST", "/api/jobs/bank-statement/normalize"], ["POST", "/api/jobs/invoice-bank/compare"],
  ["POST", "/api/reconciliation/run"], ["POST", "/api/practice/clients"], ["PATCH", "/api/company"], ["DELETE", "/api/documents/1"],
];

async function checkBackend(base) {
  const url = new URL(base);
  console.log(`\n== Backend: ${base}`);

  if (url.protocol === "https:") {
    const cert = await certificate(url.hostname);
    check(cert.ok, "the HTTPS certificate is valid and trusted", cert.ok ? `${cert.issuer}, expires ${cert.expires.toISOString().slice(0, 10)}` : cert.error);
    if (cert.ok) check((cert.expires.getTime() - Date.now()) / 86_400_000 > 14, "the certificate has more than 14 days left");
    const plain = await call(`http://${url.host}`, "/api/health");
    check([301, 302, 307, 308].includes(plain.status) && String(plain.headers.get("location")).startsWith("https://"), "plain http is sent to https", `status ${plain.status}`);
  }

  const health = await call(base, "/api/health");
  check(health.status === 200 && health.json?.ok === true, "/api/health answers ok", `status ${health.status}`);
  check(health.json?.database === "ok" && health.json?.pythonWorker === "ok" && health.json?.goApi === "ok", "database, worker and gateway report ok", JSON.stringify({ database: health.json?.database, pythonWorker: health.json?.pythonWorker, typeScriptFallback: health.json?.typeScriptFallback }));
  check(!/postgres(ql)?:\/\/|password|secret|token|api[_-]?key|\b10\.\d+\.\d+\.\d+\b|\b127\.0\.0\.1\b/i.test(health.text), "the health answer names no address, key or secret");

  const headers = health.headers;
  if (url.protocol === "https:") check(/max-age=\d{6,}/.test(headers.get("strict-transport-security") ?? ""), "HTTPS is pinned (Strict-Transport-Security)");
  check(headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options: nosniff");
  check(!headers.get("server") && !headers.get("x-powered-by"), "no server or framework name is announced", `server=${headers.get("server") ?? "-"}, x-powered-by=${headers.get("x-powered-by") ?? "-"}`);

  const wrong = [];
  for (const [method, path] of PROTECTED) {
    const response = await call(base, path, { method, headers: method === "GET" ? {} : { "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
    if (response.status !== 401) wrong.push(`${method} ${path} answered ${response.status}`);
  }
  check(wrong.length === 0, `${PROTECTED.length} routes that read or change work refuse a caller who is not signed in`, wrong.join("; "));

  const forged = await call(base, "/api/company", { headers: { Authorization: "Bearer eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOjEsImNpZCI6MSwic2lkIjoxfQ." } });
  check(forged.status === 401, "a token with no signature is refused", `status ${forged.status}`);

  const missing = await call(base, "/api/this-address-does-not-exist");
  check(missing.status === 404 && missing.json !== null && !/<html/i.test(missing.text), "an unknown /api address is a JSON 404, not a framework page", `status ${missing.status}`);

  const evil = await call(base, "/api/health", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
  check(!evil.headers.get("access-control-allow-origin"), "another website is not allowed to read answers (CORS)");
  if (site) {
    const own = await call(base, "/api/health", { method: "OPTIONS", headers: { Origin: site, "Access-Control-Request-Method": "GET" } });
    record(own.headers.get("access-control-allow-origin") === site ? "pass" : "info", "the website's own address is allowed", `allow-origin=${own.headers.get("access-control-allow-origin") ?? "none"}`);
  }

  // Body size at the edge: an unsigned upload is refused with 401 whatever its size, unless something in front of the API
  // refuses the size first. This only asks; nothing is stored.
  for (const megabytes of [1, 5, 20, 61, 81]) {
    const form = new FormData();
    form.append("files", new Blob([new Uint8Array(megabytes * 1024 * 1024)], { type: "text/csv" }), "probe.csv");
    const response = await call(base, "/api/jobs/detect", { method: "POST", body: form, timeout: 120_000 });
    record("info", `a ${megabytes} MB unsigned upload is answered with ${response.status}`, response.status === 401 ? "the API refused it" : response.status === 413 ? "refused for size" : String(response.text).slice(0, 80));
  }
}

async function checkSite(base) {
  console.log(`\n== Website: ${base}`);
  const url = new URL(base);
  const cert = await certificate(url.hostname);
  check(cert.ok, "the HTTPS certificate is valid and trusted", cert.ok ? `expires ${cert.expires.toISOString().slice(0, 10)}` : cert.error);

  for (const path of ["/", "/login", "/onboarding", "/app/overview"]) {
    const page = await call(base, path);
    check(page.status === 200 && /<div id="root"|<title>/i.test(page.text), `${path} serves the app`, `status ${page.status}`);
  }
  const home = await call(base, "/");
  const h = home.headers;
  check(/max-age=\d{6,}/.test(h.get("strict-transport-security") ?? ""), "the website pins HTTPS");
  check(h.get("x-content-type-options") === "nosniff", "the website sends X-Content-Type-Options: nosniff", "needs the frontend deployment that includes the security headers");
  check(Boolean(h.get("x-frame-options")), "the website refuses to be framed by other sites (X-Frame-Options)", "needs the frontend deployment that includes the security headers");
  check(Boolean(h.get("referrer-policy")), "the website sets a Referrer-Policy", "needs the frontend deployment that includes the security headers");

  const proxied = await call(base, "/api/health");
  check(proxied.status === 200 && proxied.json?.ok === true, "/api/health through the website reaches the backend", `status ${proxied.status}${proxied.status === 404 ? " (BACKEND_ORIGIN in Vercel does not point at the backend yet)" : ""}`);
  const direct = await call(backend, "/api/health");
  check(proxied.json?.database === direct.json?.database && proxied.json?.pythonWorker === direct.json?.pythonWorker, "the website's answer matches the backend's own");
  const noAuth = await call(base, "/api/company");
  check(noAuth.status === 401, "through the website, a signed-out call is refused", `status ${noAuth.status}`);

  for (const megabytes of [1, 5, 20, 61]) {
    const form = new FormData();
    form.append("files", new Blob([new Uint8Array(megabytes * 1024 * 1024)], { type: "text/csv" }), "probe.csv");
    const response = await call(base, "/api/jobs/detect", { method: "POST", body: form, timeout: 120_000 });
    record(response.status === 401 ? "pass" : "info", `a ${megabytes} MB unsigned upload through the website is answered with ${response.status}`, response.status === 401 ? "it reached the API" : String(response.text).slice(0, 100));
  }
}

await checkBackend(backend);
if (site) await checkSite(site);

const failed = results.filter(result => result.status === "fail");
console.log(`\n${results.filter(result => result.status === "pass").length} passed, ${failed.length} failed, ${results.filter(result => result.status === "info").length} for information.`);
process.exit(failed.length ? 1 : 0);
