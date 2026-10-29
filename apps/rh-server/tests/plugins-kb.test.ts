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
import { startTestServer, tempDir, until } from "./test-server.ts";

const FAKE = join(import.meta.dirname, "fixtures/fake-ignis");

async function project(kbViewer: Record<string, unknown>) {
  const temp = tempDir();
  const app = join(temp.dir, "kb-viewer", "obsidian-app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "index.html"), "<html></html>");
  writeFileSync(join(app, ".obsidian-version"), "1.14.4");
  const server = await startTestServer({
    dataDir: temp.dir,
    hub: { ticker: false, kbViewer: { dir: FAKE, restartDelays: [200], ...kbViewer } },
  });
  const projectRuntime = server.hub.project;
  projectRuntime.brief.write("# x");
  projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  projectRuntime.charters.approve();
  projectRuntime.syncVault();
  return { server, p: projectRuntime, dir: temp.dir, done: async () => (await server.stop(), temp.cleanup()) };
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
  const env = await project({ enabled: true });
  try {
    const { kernel } = env.p.plugins;
    await until(() => state(env.p) === "running", 15_000, "obsidian running");
    const port = env.p.kbViewer.target()!.port;
    assert.equal((await kbOf(env.p)).activeViewer()?.id, "obsidian");

    await kernel.configure("rh.kb", { "kb.viewer": "library" });
    await until(() => state(env.p) === "disabled", 10_000, "obsidian paused");
    assert.equal(env.p.kbViewer.status().reason, "the Library viewer is active");
    assert.equal(await answers(port), false);
    assert.equal((await kbOf(env.p)).activeViewer()?.view, "library");
    // rh.kb kept running (it handles the setting live): the project's objects are the same.
    assert.equal(kernel.get("rh.kb")?.state, "active");
    assert.equal(env.p.vault, (await env.p.plugins.exportsOf<{ vault: unknown }>("rh.kb")).vault);

    await kernel.configure("rh.kb", { "kb.viewer": "obsidian" });
    await until(() => state(env.p) === "running", 15_000, "obsidian back");
    assert.equal((await fetch(`http://127.0.0.1:${env.p.kbViewer.target()!.port}/`)).ok, true);
  } finally {
    await env.done();
  }
});

test("disabling the Obsidian viewer plugin stops it and the Library takes over; chat and the vault keep working", async () => {
  const env = await project({ enabled: true });
  try {
    const { kernel } = env.p.plugins;
    await until(() => state(env.p) === "running", 15_000, "obsidian running");
    await kernel.setEnabled("rh.viewer-obsidian", false);
    assert.equal(state(env.p), "disabled");
    assert.equal(env.p.kbViewer.status().reason, "the Obsidian viewer plugin is disabled");
    assert.equal((await kbOf(env.p)).activeViewer()?.id, "library");
    assert.equal((await env.server.client.send("hello", { waitMs: 10_000 })).status, "done");
    assert.ok(existsSync(join(env.p.vault.dir, "charter.md")));

    await kernel.setEnabled("rh.viewer-obsidian", true);
    await until(() => state(env.p) === "running", 15_000, "obsidian back");
  } finally {
    await env.done();
  }
});

test("RH_KB_VIEWER=off at the first start leaves the Obsidian viewer plugin disabled", async () => {
  const env = await project({ enabled: false });
  try {
    const lock = JSON.parse(readFileSync(join(env.dir, "plugins", "plugins.lock.json"), "utf8"));
    assert.equal(lock.plugins["rh.viewer-obsidian"].enabled, false);
    assert.equal(lock.plugins["rh.viewer-library"].enabled, true);
    assert.equal(env.p.plugins.kernel.get("rh.viewer-obsidian")?.state, "disabled");
    assert.equal(env.p.kbViewer.status().reason, "RH_KB_VIEWER=off");
  } finally {
    await env.done();
  }
});

test("without Ignis in the image the Library is active, Obsidian says why, and an explicit choice still wins", async () => {
  const env = await project({ enabled: true, dir: join(tempDir().dir, "no-ignis") });
  try {
    const kb = await kbOf(env.p);
    await until(
      () => /Ignis is not installed in this image/.test(env.p.kbViewer.status().reason ?? ""),
      5_000,
      "reason",
    );
    assert.equal(kb.activeViewer()?.id, "library");
    assert.equal(env.p.kbViewer.status().state, "unavailable");
    // Choosing Obsidian explicitly is respected (it then reports why it cannot run).
    await env.p.plugins.kernel.configure("rh.kb", { "kb.viewer": "obsidian" });
    assert.equal(kb.activeViewer()?.id, "obsidian");
    await env.p.plugins.kernel.configure("rh.kb", { "kb.viewer": undefined });
    assert.equal(kb.activeViewer()?.id, "library");
  } finally {
    await env.done();
  }
});
