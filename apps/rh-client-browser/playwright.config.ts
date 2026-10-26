// UI tests against an offline hub (e2e/hub.ts). Uses the system Chromium when there is one (no browser download);
// otherwise run `npx playwright install chromium` once.
import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4897);
const chromium = process.env.CHROMIUM ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => existsSync(p));

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}/`,
    viewport: { width: 1280, height: 860 },
    ...(chromium ? { launchOptions: { executablePath: chromium } } : {}),
  },
  webServer: {
    command: "node --import tsx e2e/hub.ts",
    url: `http://127.0.0.1:${port}/v1/health`,
    env: { E2E_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
