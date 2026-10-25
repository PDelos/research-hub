// Spec plugin-system: Per-project plugin state with history (task 1.2): the lockfile in a git repository, history
// with actors, rollback as a new commit, and the first start of an existing v0 project.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hashFolder, LOCK_FILE, PluginState, type LockEntry } from "../src/kernel/state.ts";
import { tempDir } from "./helpers.ts";

const builtin = (settings: Record<string, unknown> = {}): LockEntry => ({
  version: "1.0.0",
  source: { kind: "builtin" },
  enabled: true,
  settings,
});

function clock() {
  let t = Date.parse("2026-10-26T09:00:00Z");
  return () => new Date((t += 60_000));
}

test("the first start of an existing v0 project enables every built-in and touches nothing else", async () => {
  const t = tempDir();
  try {
    writeFileSync(join(t.dir, "agent.sqlite"), "v0 data");
    mkdirSync(join(t.dir, "vault"));
    writeFileSync(join(t.dir, "vault", "index.md"), "# Index");
    const state = new PluginState(t.dir, clock());
    const lock = await state.open(() => ({ "rh.kb": builtin(), "rh.desk": builtin({ model: "from-env" }) }));
    assert.deepEqual(Object.keys(lock.plugins), ["rh.desk", "rh.kb"]);
    assert.equal(lock.plugins["rh.desk"].settings.model, "from-env");
    assert.deepEqual(readdirSync(t.dir).toSorted(), ["agent.sqlite", "plugins", "vault"]);
    assert.equal(readFileSync(join(t.dir, "agent.sqlite"), "utf8"), "v0 data");
    const history = await state.history();
    assert.equal(history.length, 1);
    assert.equal(history[0].message, "initialize plugins from the environment");
    assert.equal(history[0].actor, "kernel");

    // A second start reads the lockfile and does not re-initialize.
    const again = new PluginState(t.dir, clock());
    const reopened = await again.open(() => assert.fail("initial() must not run again"));
    assert.deepEqual(reopened, lock);
    assert.equal((await again.history()).length, 1);
  } finally {
    t.cleanup();
  }
});

test("each change is a commit with its time, message and actor; no-op changes are not recorded", async () => {
  const t = tempDir();
  try {
    const state = new PluginState(t.dir, clock());
    await state.open(() => ({ "rh.viewer-obsidian": builtin() }));
    await state.update((l) => (l.plugins["rh.viewer-obsidian"].enabled = false), "disable rh.viewer-obsidian");
    assert.equal(
      await state.update((l) => (l.plugins["rh.viewer-obsidian"].enabled = false), "disable again"),
      undefined,
    );
    await state.update(
      (l) =>
        (l.plugins["acme.source-pubmed"] = { ...builtin(), source: { kind: "folder", path: "/x" }, version: "0.1.0" }),
      "install acme.source-pubmed 0.1.0",
      "proposal:42",
    );
    const history = await state.history();
    assert.deepEqual(
      history.map((h) => [h.message, h.actor]),
      [
        ["install acme.source-pubmed 0.1.0", "proposal:42"],
        ["disable rh.viewer-obsidian", "user"],
        ["initialize plugins from the environment", "kernel"],
      ],
    );
    assert.equal(history[0].time, "2026-10-26T09:03:00.000Z");
    assert.equal(
      JSON.parse(readFileSync(join(state.dir, LOCK_FILE), "utf8")).plugins["acme.source-pubmed"].version,
      "0.1.0",
    );
  } finally {
    t.cleanup();
  }
});

test("rollback restores an earlier lockfile as a new commit", async () => {
  const t = tempDir();
  try {
    const state = new PluginState(t.dir, clock());
    await state.open(() => ({ "rh.embedder-openrouter": builtin({ model: "qwen/qwen3-embedding-8b" }) }));
    const before = (await state.history())[0].id;
    await state.update(
      (l) => (l.plugins["rh.embedder-openrouter"].settings.model = "google/gemini-embedding-2"),
      "replace the embedder model",
    );
    const { lock } = await state.rollback(before.slice(0, 7));
    assert.equal(lock.plugins["rh.embedder-openrouter"].settings.model, "qwen/qwen3-embedding-8b");
    const history = await state.history();
    assert.equal(history.length, 3);
    assert.equal(history[0].message, `roll back to ${before.slice(0, 7)} (initialize plugins from the environment)`);
    // The replaced state is still in the history and can be restored too.
    assert.equal(
      (await state.at(history[1].id)).plugins["rh.embedder-openrouter"].settings.model,
      "google/gemini-embedding-2",
    );
  } finally {
    t.cleanup();
  }
});

test("concurrent changes are serialized and none is lost", async () => {
  const t = tempDir();
  try {
    const state = new PluginState(t.dir, clock());
    await state.open(() => ({ "a.one": builtin(), "a.two": builtin(), "a.three": builtin() }));
    await Promise.all(
      ["a.one", "a.two", "a.three"].map((id) => state.update((l) => (l.plugins[id].enabled = false), `disable ${id}`)),
    );
    assert.ok(Object.values(state.current().plugins).every((p) => !p.enabled));
    assert.equal((await state.history()).length, 4);
  } finally {
    t.cleanup();
  }
});

test("plugin storage is not committed and the folder hash is stable", async () => {
  const t = tempDir();
  try {
    const state = new PluginState(t.dir, clock());
    await state.open(() => ({}));
    writeFileSync(join(state.dir, "data", "cache.bin"), "x");
    assert.equal(readFileSync(join(state.dir, ".gitignore"), "utf8"), "data/\n");
    const plugin = join(t.dir, "p");
    mkdirSync(join(plugin, "src"), { recursive: true });
    writeFileSync(join(plugin, "rh-plugin.json"), "{}");
    writeFileSync(join(plugin, "src", "main.js"), "export {}");
    const first = hashFolder(plugin);
    assert.match(first, /^sha256-[0-9a-f]{64}$/);
    assert.equal(hashFolder(plugin), first);
    writeFileSync(join(plugin, "src", "main.js"), "export const x = 1");
    assert.notEqual(hashFolder(plugin), first);
  } finally {
    t.cleanup();
  }
});
