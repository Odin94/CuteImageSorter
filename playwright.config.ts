import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:1426",
    viewport: { width: 1180, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  webServer: {
    command: "pnpm dev --port 1426",
    url: "http://localhost:1426",
    reuseExistingServer: !process.env.CI,
  },
});
