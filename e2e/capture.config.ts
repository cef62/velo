// Docs media capture (`pnpm docs:capture`): screenshots and clips of the browser demo into docs/media/. Not a test suite.
// Re-runs write byte-identical PNGs on the same machine and browser build; another OS, Chrome version or font
// rendering changes pixels, so commit media from one machine (or the docs-media workflow) at a time.
import { defineConfig } from "@playwright/test";
import process from "node:process";

export const PORT = 4790;

export default defineConfig({
  testDir: ".",
  testMatch: "capture.spec.ts",
  outputDir: "../test-results/capture",
  timeout: 180_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // locally the installed Google Chrome (no browser download); CI installs Playwright's Chromium
    channel: process.env.CI ? undefined : "chrome",
    // seed times are local: pin zone and locale with the clock so every machine renders the same text
    timezoneId: "UTC",
    locale: "en-US",
    colorScheme: "light",
    actionTimeout: 10_000,
    // software raster and a fixed colour profile: GPU raster left stray antialiasing differences between runs
    launchOptions: { args: ["--disable-gpu", "--force-color-profile=srgb"] },
  },
  webServer: {
    command: `pnpm demo:build && pnpm exec vite preview --config vite.demo.config.ts --port ${PORT} --strictPort`,
    cwd: "..",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false, // a server left running may serve a stale demo build
    timeout: 300_000,
  },
});
