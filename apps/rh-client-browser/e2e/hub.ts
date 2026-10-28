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
// Two charter proposals of the knowledge review, so the Digest and Charter tabs show them.
await p.plugins.exportsOf("rh.knowledge");
const seededAt = new Date().toISOString();
const propose = p.db.prepare(
  "INSERT INTO p_rh_knowledge__proposals (review_id, kind, change_key, change_json, evidence_json, status, base_version, created_at) VALUES (0, ?, ?, ?, ?, 'proposed', 1, ?)",
);
propose.run(
  "add-question",
  "add-question||ui",
  JSON.stringify({
    kind: "add-question",
    text: "Do protein language models transfer to RNA?",
    queries: ["RNA language model", "RNA structure transfer"],
  }),
  JSON.stringify({
    summary: "Three papers you starred apply protein models to RNA.",
    papers: [{ id: 1, title: "RNA-FM", verdict: "star" }],
    score: 0.8,
  }),
  seededAt,
);
propose.run(
  "add-out-of-scope",
  "add-out-of-scope||clinical trials",
  JSON.stringify({ kind: "add-out-of-scope", topic: "clinical trials" }),
  JSON.stringify({ summary: "You marked 3 clinical papers off topic.", papers: [] }),
  seededAt,
);
// One change and a digest, so the Digest tab has something to show (and to undo).
await p.plugins.kernel.configure("rh.sweep", { cardsPerSweep: 5 });
await (await p.plugins.exportsOf<DigestExports>("rh.digest")).buildDigest();
// A finished upgrade run with an embedder proposal and an add-on suggestion, so the Upgrades tab has them.
await p.plugins.exportsOf("rh.upgrades");
const at = new Date().toISOString();
p.db
  .prepare(
    "INSERT INTO p_rh_upgrades__runs (focus, reason, status, report_json, cost_usd, requested_by, started_at, finished_at) VALUES ('embedder', 'Seeded for the UI tests.', 'done', ?, 0.01, 'test', ?, ?)",
  )
  .run(
    JSON.stringify({
      focus: "embedder",
      reason: "Seeded for the UI tests.",
      tried: [{ what: "acme/embed-native", verdict: "better", numbers: { mean: 0.7 } }],
      result: "Proposed acme/embed-native.",
    }),
    at,
    at,
  );
p.db
  .prepare(
    "INSERT INTO p_rh_upgrades__proposals (run_id, kind, payload_json, status, created_at) VALUES (1, 'embedder', ?, 'proposed', ?)",
  )
  .run(JSON.stringify({ model: "acme/embed-native", dims: 0, mean: 0.7, activeMean: 0.6, activeModel: "offline" }), at);
p.db
  .prepare(
    "INSERT INTO p_rh_upgrades__suggestions (run_id, name, url, reason, created_at) VALUES (1, 'bioRxiv API', 'https://api.biorxiv.org', 'biology preprints', ?)",
  )
  .run(at);
console.log(`ui test hub on ${running.url} (data ${dir})`);

const stop = async () => {
  await running.stop();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
