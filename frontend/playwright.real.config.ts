import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests against the real backend (worker, API, gateway, a Postgres on this computer), not pretended answers.
 * scripts/stack/stack.mjs starts all of it, builds the website and serves it the way Vercel does.
 *
 *   STACK_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/tallythis_stack pnpm --filter @workspace/finverify-os run test:real
 *
 * The database must be on this computer; the runner refuses any other. The default config (playwright.config.ts) is the
 * quick one with every answer pretended.
 */
const WEB_PORT = process.env.STACK_WEB_PORT || "14173";
const WEB = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: "./e2e-real",
  // One database, one set of accounts: run the files one after another.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "./test-results-real",
  webServer: {
    command: "node --experimental-strip-types --no-warnings ../scripts/stack/stack.mjs",
    url: `${WEB}/api/health`,
    reuseExistingServer: true,
    timeout: 600_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  use: {
    baseURL: WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    acceptDownloads: true,
    // The result counts animate from 0; with reduced motion they show their final value at once.
    reducedMotion: "reduce",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] }, grep: /@phone/ },
  ],
});
