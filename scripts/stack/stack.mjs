#!/usr/bin/env node
/**
 * Runs the whole product on this computer the way it runs in production:
 *
 *   browser -> web server (static site + Vercel-style rewrites, /api passed on)
 *           -> Go gateway -> Express API -> Python worker
 *                                  \-> a Postgres on this computer
 *
 * Used by the real-stack browser tests (`pnpm --filter @workspace/finverify-os run test:real`) and for looking at
 * the product by hand. Nothing here talks to a real database, file store or AI service:
 *   - the database must be on this computer (the same check the API itself uses to pick its driver),
 *   - files go to a temporary folder, and no AI key is passed, so AI features are off,
 *   - the child processes get a short list of environment variables, never the whole environment, and run in an
 *     empty folder so a `.env` file in the repository cannot be picked up.
 *
 *   STACK_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/tallythis_stack \
 *     node --experimental-strip-types scripts/stack/stack.mjs
 *
 * Options (environment):
 *   STACK_DATABASE_URL  required, a database on this computer; the migrations are applied to it
 *   STACK_FRESH=1       empty the database first (drops the public schema; allowed only because it is local)
 *   STACK_MODE          production (default) or development (turns on the sample workspace)
 *   STACK_WEB_PORT, STACK_GATEWAY_PORT, STACK_API_PORT, STACK_WORKER_PORT   defaults 14173, 18090, 18080, 18091
 *   STACK_PYTHON        python executable for the worker (default: python on Windows, python3 elsewhere)
 *   STACK_SKIP_BUILD=1  do not rebuild the API and the website (they are built from the current source otherwise)
 *   STACK_KEEP=1        keep the temporary folder (logs, uploaded files) when stopping
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createVercelConfig } from "../../frontend/vercel.mjs";
import { isLoopbackDatabaseUrl } from "../../lib/db/src/driver.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const windows = process.platform === "win32";

function fail(message) {
  console.error(`stack: ${message}`);
  process.exit(2);
}

// ── Settings ────────────────────────────────────────────────────────────────
const databaseUrl = process.env.STACK_DATABASE_URL;
if (!databaseUrl) fail("STACK_DATABASE_URL must be set to a Postgres database on this computer.");
if (!isLoopbackDatabaseUrl(databaseUrl)) fail("STACK_DATABASE_URL is not on this computer. This runner only uses a local database.");

const port = (name, fallback) => Number(process.env[name]) || fallback;
const ports = { web: port("STACK_WEB_PORT", 14173), gateway: port("STACK_GATEWAY_PORT", 18090), api: port("STACK_API_PORT", 18080), worker: port("STACK_WORKER_PORT", 18091) };
const mode = process.env.STACK_MODE === "development" ? "development" : "production";
const webOrigin = `http://127.0.0.1:${ports.web}`;
const jwtSecret = crypto.randomBytes(24).toString("hex");
const workerToken = crypto.randomBytes(24).toString("hex");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tallythis-stack-"));
const runDir = path.join(work, "run");
const logDir = path.join(work, "logs");
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

/** The only variables a child process inherits: what it needs to start, never a key or an address. */
const INHERITED = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TESSERACT_PATH", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "GOCACHE", "GOPATH", "GOMODCACHE", "GOFLAGS"];
function childEnv(extra) {
  const env = {};
  for (const name of INHERITED) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, PYTHONUNBUFFERED: "1", ...extra };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed (exit ${result.status ?? result.error?.message}).`);
}

const children = [];
let webServer = null;
function start(name, command, args, options) {
  const log = fs.openSync(path.join(logDir, `${name}.log`), "w");
  const child = spawn(command, args, { stdio: ["ignore", log, log], ...options });
  child.on("exit", code => {
    if (!stopping) {
      console.error(`stack: ${name} stopped (exit ${code}). Last lines of its log:\n${tail(name)}`);
      stop(1);
    }
  });
  children.push({ name, child });
}

function tail(name, lines = 25) {
  try {
    return fs.readFileSync(path.join(logDir, `${name}.log`), "utf8").split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

async function waitFor(name, url, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  console.error(`stack: ${name} did not become ready at ${url}. Last lines of its log:\n${tail(name)}`);
  stop(1);
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (child.exitCode !== null || !child.pid) continue;
    if (windows) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  webServer?.close();
  if (process.env.STACK_KEEP === "1") console.log(`stack: files kept in ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
process.on("exit", () => {
  if (!stopping) for (const { child } of children) if (windows && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
});

// ── Database ────────────────────────────────────────────────────────────────
if (process.env.STACK_FRESH === "1") {
  const pg = createRequire(path.join(root, "lib/db/package.json"))("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("drop schema if exists public cascade; create schema public;");
  await client.end();
  console.log("stack: database emptied");
}
run(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/migrate.mjs"], { cwd: path.join(root, "lib/db"), env: childEnv({ DATABASE_URL: databaseUrl }) });

// ── Build outputs ───────────────────────────────────────────────────────────
// Always built from the current source, so a test never runs against an old copy. STACK_SKIP_BUILD=1 reuses
// what is already built (quicker when only tests changed).
const apiBundle = path.join(root, "backend/api/dist/index.mjs");
const siteDir = path.join(root, "frontend/dist/public");
if (process.env.STACK_SKIP_BUILD !== "1" || !fs.existsSync(apiBundle)) {
  console.log("stack: building the API");
  run(process.execPath, ["build.mjs"], { cwd: path.join(root, "backend/api") });
}
if (process.env.STACK_SKIP_BUILD !== "1" || !fs.existsSync(path.join(siteDir, "index.html"))) {
  console.log("stack: building the website");
  run("pnpm", ["--filter", "@workspace/finverify-os", "run", "build"], { cwd: root, shell: windows });
}
const gatewayBinary = path.join(work, windows ? "gateway.exe" : "gateway");
console.log("stack: building the gateway");
run("go", ["build", "-o", gatewayBinary, "./cmd/api"], { cwd: path.join(root, "backend/gateway") });

// ── Services ────────────────────────────────────────────────────────────────
const python = process.env.STACK_PYTHON || (windows ? "python" : "python3");
start("worker", python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(ports.worker)], {
  cwd: path.join(root, "backend/worker"),
  env: childEnv({ APP_ENV: "production", WORKER_SERVICE_TOKEN: workerToken }),
});
await waitFor("worker", `http://127.0.0.1:${ports.worker}/health`);

start("api", process.execPath, ["--enable-source-maps", apiBundle], {
  cwd: runDir,
  env: childEnv({
    NODE_ENV: mode, APP_ENV: mode, PORT: String(ports.api), DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret,
    PYTHON_WORKER_URL: `http://127.0.0.1:${ports.worker}`, WORKER_SERVICE_TOKEN: workerToken,
    STORAGE_PROVIDER: "local", LOCAL_UPLOADS_DIR: path.join(work, "uploads"),
    CORS_ORIGIN: webOrigin, APP_URL: webOrigin, HISTORY_MONTHS: "3", MAX_UPLOAD_MB: "60", LOG_LEVEL: "warn",
    PRIVACY_AI_ALLOWED: "false", ALLOW_DEMO_SEED: mode === "development" ? "true" : "false",
  }),
});
await waitFor("api", `http://127.0.0.1:${ports.api}/api/health`);

start("gateway", gatewayBinary, [], {
  cwd: runDir,
  env: childEnv({
    APP_ENV: "production", PORT: String(ports.gateway), GO_API_PORT: String(ports.gateway), DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret,
    TYPESCRIPT_API_URL: `http://127.0.0.1:${ports.api}`, PYTHON_WORKER_URL: `http://127.0.0.1:${ports.worker}`, CORS_ORIGIN: webOrigin,
  }),
});
await waitFor("gateway", `http://127.0.0.1:${ports.gateway}/api/health`);

// ── Website: what Vercel does for this project ──────────────────────────────
// Static files from dist/public, the page rewrites listed in frontend/vercel.mjs, and /api/* passed to the backend.
const vercel = createVercelConfig("https://backend.invalid");
const pageRoutes = vercel.rewrites
  .filter(rule => rule.destination === "/index.html")
  .map(rule => new RegExp(`^${rule.source.replace(":path*", ".*")}$`));
const securityHeaders = Object.fromEntries(vercel.headers.flatMap(rule => rule.headers.map(header => [header.key, header.value])));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".webmanifest": "application/manifest+json" };

function serveFile(res, file) {
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", ...securityHeaders });
  fs.createReadStream(file).pipe(res);
}

webServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", webOrigin);
  if (url.pathname.startsWith("/api/")) {
    const upstream = http.request({ host: "127.0.0.1", port: ports.gateway, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${ports.gateway}` } }, reply => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "The backend did not answer." }));
    });
    req.pipe(upstream);
    return;
  }
  const requested = path.normalize(path.join(siteDir, decodeURIComponent(url.pathname)));
  if (requested.startsWith(siteDir) && fs.existsSync(requested) && fs.statSync(requested).isFile()) return serveFile(res, requested);
  if (url.pathname === "/") return serveFile(res, path.join(siteDir, "index.html"));
  if (pageRoutes.some(pattern => pattern.test(url.pathname))) return serveFile(res, path.join(siteDir, "index.html"));
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders });
  res.end("404: NOT_FOUND");
});
await new Promise(resolve => webServer.listen(ports.web, "127.0.0.1", resolve));
await waitFor("gateway", `${webOrigin}/api/health`, 30);

fs.mkdirSync(path.join(root, ".stack"), { recursive: true });
fs.writeFileSync(path.join(root, ".stack/state.json"), JSON.stringify({ mode, database: databaseUrl, web: webOrigin, gateway: `http://127.0.0.1:${ports.gateway}`, api: `http://127.0.0.1:${ports.api}`, logs: logDir }, null, 2));
console.log(`stack: ready (${mode}) at ${webOrigin}   logs: ${logDir}`);
