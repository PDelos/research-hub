// Spec plugin-system: Extension points owned by plugins (Swap the viewer), Plugin settings (Environment default),
// v0 as built-in plugins (Disable an optional feature) (task 2.4), with the fake Ignis of the v0 viewer tests.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { validateCharter } from "../src/charter.ts";
import type { ProjectRuntime } from "../src/project.ts";
import type { KbExports } from "../plugins/rh.kb/main.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { startTestServer, tempDir, until } from "./helpers.ts";

const FAKE = join(import.meta.dirname, "fixtures/fake-ignis");

async function project(kbViewer: Record<string, unknown>) {
  const t = tempDir();
  const app = join(t.dir, "kb-viewer", "obsidian-app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "index.html"), "<html></html>");
  writeFileSync(join(app, ".obsidian-version"), "1.14.4");
  const server = await startTestServer({
    dataDir: t.dir,
    hub: { ticker: false, kbViewer: { dir: FAKE, restartDelays: [200], ...kbViewer } },
  });
  const projectRuntime = server.hub.project;
  projectRuntime.brief.write("# x");
  projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  projectRuntime.charters.approve();
  projectRuntime.syncVault();
  return { server, p: projectRuntime, dir: t.dir, done: async () => (await server.stop(), t.cleanup()) };
}

const state = (p: ProjectRuntime) => p.kbViewer.status().state;
const kbOf = (p: ProjectRuntime) => p.plugins.exportsOf<KbExports>("rh.kb");
const answers = async (port: number) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`)).ok;
  } catch {
    return false;
  }
};

test("switching the viewer to Library stops the Obsidian process, switching back starts it again", async () => {
  const s = await project({ enabled: true });
  try {
    const { kernel } = s.p.plugins;
    await until(() => state(s.p) === "running", 15_000, "obsidian running");
    const port = s.p.kbViewer.target()!.port;
    assert.equal((await kbOf(s.p)).activeViewer()?.id, "obsidian");

    await kernel.configure("rh.kb", { "kb.viewer": "library" });
    await until(() => state(s.p) === "disabled", 10_000, "obsidian paused");
    assert.equal(s.p.kbViewer.status().reason, "the Library viewer is active");
    assert.equal(await answers(port), false);
    assert.equal((await kbOf(s.p)).activeViewer()?.view, "library");
    // rh.kb kept running (it handles the setting live): the project's objects are the same.
    assert.equal(kernel.get("rh.kb")?.state, "active");
    assert.equal(s.p.vault, (await s.p.plugins.exportsOf<{ vault: unknown }>("rh.kb")).vault);

    await kernel.configure("rh.kb", { "kb.viewer": "obsidian" });
    await until(() => state(s.p) === "running", 15_000, "obsidian back");
    assert.equal((await fetch(`http://127.0.0.1:${s.p.kbViewer.target()!.port}/`)).ok, true);
  } finally {
    await s.done();
  }
});

test("disabling the Obsidian viewer plugin stops it and the Library takes over; chat and the vault keep working", async () => {
  const s = await project({ enabled: true });
  try {
    const { kernel } = s.p.plugins;
    await until(() => state(s.p) === "running", 15_000, "obsidian running");
    await kernel.setEnabled("rh.viewer-obsidian", false);
    assert.equal(state(s.p), "disabled");
    assert.equal(s.p.kbViewer.status().reason, "the Obsidian viewer plugin is disabled");
    assert.equal((await kbOf(s.p)).activeViewer()?.id, "library");
    assert.equal((await s.server.client.send("hello", { waitMs: 10_000 })).status, "done");
    assert.ok(existsSync(join(s.p.vault.dir, "charter.md")));

    await kernel.setEnabled("rh.viewer-obsidian", true);
    await until(() => state(s.p) === "running", 15_000, "obsidian back");
  } finally {
    await s.done();
  }
});

test("RH_KB_VIEWER=off at the first start leaves the Obsidian viewer plugin disabled", async () => {
  const s = await project({ enabled: false });
  try {
    const lock = JSON.parse(readFileSync(join(s.dir, "plugins", "plugins.lock.json"), "utf8"));
    assert.equal(lock.plugins["rh.viewer-obsidian"].enabled, false);
    assert.equal(lock.plugins["rh.viewer-library"].enabled, true);
    assert.equal(s.p.plugins.kernel.get("rh.viewer-obsidian")?.state, "disabled");
    assert.equal(s.p.kbViewer.status().reason, "RH_KB_VIEWER=off");
  } finally {
    await s.done();
  }
});

test("without Ignis in the image the Library is active, Obsidian says why, and an explicit choice still wins", async () => {
  const s = await project({ enabled: true, dir: join(tempDir().dir, "no-ignis") });
  try {
    const kb = await kbOf(s.p);
    await until(() => /Ignis is not installed in this image/.test(s.p.kbViewer.status().reason ?? ""), 5_000, "reason");
    assert.equal(kb.activeViewer()?.id, "library");
    assert.equal(s.p.kbViewer.status().state, "unavailable");
    // Choosing Obsidian explicitly is respected (it then reports why it cannot run).
    await s.p.plugins.kernel.configure("rh.kb", { "kb.viewer": "obsidian" });
    assert.equal(kb.activeViewer()?.id, "obsidian");
    await s.p.plugins.kernel.configure("rh.kb", { "kb.viewer": undefined });
    assert.equal(kb.activeViewer()?.id, "library");
  } finally {
    await s.done();
  }
});
