import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e config for FinVerify OS.
 * Starts the dev server itself at http://localhost:5173 (or the port in BASE_URL) unless one is already running.
 * Run: pnpm exec playwright test
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const PORT = new URL(BASE_URL).port || "5173";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  // Starts the dev server when nothing is listening yet (CI); reuses one that already is (local work).
  webServer: {
    command: `pnpm exec vite --config vite.config.ts --host localhost --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
