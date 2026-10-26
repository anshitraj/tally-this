import assert from "node:assert/strict";
import test from "node:test";
import { SECURITY_HEADERS, createVercelConfig } from "../vercel.mjs";

test("landing-only configuration never rewrites API requests to HTML", () => {
  const config = createVercelConfig("");
  assert.equal(config.outputDirectory, "dist/public");
  assert.equal(config.framework, "vite");
  assert.ok(config.rewrites.every((rule) => !rule.source.startsWith("/api")));
  for (const path of ["/login", "/onboarding", "/app", "/app/:path*"]) {
    assert.ok(config.rewrites.some((rule) => rule.source === path && rule.destination === "/index.html"));
  }
});

test("API proxy preserves the API prefix and is before application routes", () => {
  const config = createVercelConfig(" https://gateway.example.test/ ");
  assert.deepEqual(config.rewrites[0], {
    source: "/api/:path*", destination: "https://gateway.example.test/api/:path*",
  });
});

test("every page and file carries the basic security headers", () => {
  for (const origin of ["", "https://gateway.example.test"]) {
    const config = createVercelConfig(origin);
    const rule = config.headers.find(item => item.source === "/(.*)");
    assert.ok(rule, "a rule for every path");
    const sent = Object.fromEntries(rule.headers.map(header => [header.key, header.value]));
    assert.equal(sent["X-Content-Type-Options"], "nosniff");
    assert.equal(sent["X-Frame-Options"], "SAMEORIGIN");
    assert.match(sent["Referrer-Policy"], /strict-origin/);
    assert.match(sent["Permissions-Policy"], /camera=\(\)/);
  }
  // Nothing in them can break a script, a style or the sign-in redirect.
  assert.ok(SECURITY_HEADERS.every(header => !/content-security-policy/i.test(header.key)));
});

test("reject unsafe or malformed backend origins", () => {
  for (const origin of ["http://gateway.example.test", "https://user:password@example.test", "https://example.test/api", "https://example.test/?key=secret", "https://example.test/#fragment", "not-a-url"]) {
    assert.throws(() => createVercelConfig(origin));
  }
});
