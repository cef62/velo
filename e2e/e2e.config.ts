// Browser checks of the demo (`pnpm e2e`): behaviour Vitest cannot see without a DOM, in Chromium and WebKit (the macOS
// app's engine). Needs Playwright's browsers: `pnpm exec playwright install chromium webkit`.
import { defineConfig, devices } from "@playwright/test";

const PORT = 4791;

export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  outputDir: "../test-results/e2e",
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}`, actionTimeout: 10_000 },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: `pnpm exec panda codegen && pnpm exec vite --config vite.demo.config.ts --port ${PORT} --strictPort`,
    cwd: "..",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
