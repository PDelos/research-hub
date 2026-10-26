// An offline hub for the UI tests (Playwright's webServer): a fresh project with an approved charter, the fake
// Obsidian viewer of the server tests, and the sample reading-list plugin installed. No keys, no network.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCharter } from "../../rh-server/src/charter.ts";
import { loadConfig } from "../../rh-server/src/config.ts";
import { createLogger } from "../../rh-server/src/logger.ts";
import { startServer } from "../../rh-server/src/server.ts";
import { sampleCharter } from "../../rh-server/tests/fixtures/charter.ts";
import type { DigestExports } from "../../rh-server/plugins/rh.digest/main.ts";

const server = join(import.meta.dirname, "../../rh-server");
const FIXTURE_PLUGINS = join(server, "tests/fixtures/plugins");
const dir = mkdtempSync(join(tmpdir(), "rh-ui-e2e-"));
const app = join(dir, "kb-viewer", "obsidian-app");
mkdirSync(app, { recursive: true });
writeFileSync(join(app, "index.html"), "<html></html>");
writeFileSync(join(app, ".obsidian-version"), "1.14.4");

const config = loadConfig({
  RH_MODE: "offline",
  RH_PORT: process.env.E2E_PORT ?? "4897",
  RH_DATA_DIR: dir,
  RH_API_TOKEN: "ui-e2e-api-token-0123456789",
  RH_UI_DIR: join(import.meta.dirname, "../dist"),
  RH_KB_VIEWER_DIR: join(server, "tests/fixtures/fake-ignis"),
  RH_PROJECT_NAME: "ui-tests",
} as NodeJS.ProcessEnv);
const running = await startServer(config, createLogger({ level: "warn" }));
const p = running.hub.project;
p.brief.write("# UI tests\n\nProtein language models.");
p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
p.charters.approve();
p.syncVault();
const { installer } = p.plugins;
await installer.confirm((await installer.prepare({ folder: join(FIXTURE_PLUGINS, "acme.reading-list") })).planId);
// One change and a digest, so the Digest tab has something to show (and to undo).
await p.plugins.kernel.configure("rh.sweep", { cardsPerSweep: 5 });
await (await p.plugins.exportsOf<DigestExports>("rh.digest")).buildDigest();
console.log(`ui test hub on ${running.url} (data ${dir})`);

const stop = async () => {
  await running.stop();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
