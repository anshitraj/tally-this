import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e config for FinVerify OS.
 * Requires the dev server running at http://localhost:5173 (or the port set by BASE_URL env).
 * Run: pnpm exec playwright test
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
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
