import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  reporter: "list",
  outputDir: "../test-results",
  use: {
    baseURL: "http://127.0.0.1:8773",
    browserName: "chromium",
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "narrow", use: { viewport: { width: 320, height: 844 } } },
  ],
  webServer: [
    {
      command: "bun run scripts/preview-ui.ts",
      cwd: "..",
      env: { AFTERCLASS_PREVIEW_PORT: "8773" },
      url: "http://127.0.0.1:8773",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "bun run scripts/hosted-preview.ts",
      cwd: "..",
      env: { AFTERCLASS_HOSTED_PREVIEW_PORT: "8774", AFTERCLASS_FAKE_CLERK_PORT: "8775" },
      url: "http://127.0.0.1:8774/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
