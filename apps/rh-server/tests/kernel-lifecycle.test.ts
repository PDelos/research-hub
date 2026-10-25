// Spec plugin-system: Lazy activation, Dependencies and exported APIs (task 1.3): activation on events, dependency
// order and exports, disable (with dependents), failure and timeout isolation, rollback and change notifications.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginSummary } from "@rh/sdk";
import {
  HasDependents,
  PluginKernel,
  PluginUnavailable,
  type PluginContext,
  type PluginModule,
} from "../src/kernel/lifecycle.ts";
import { parseManifest } from "../src/kernel/manifest.ts";
import { discover, type Discovery } from "../src/kernel/registry.ts";
import { PluginState } from "../src/kernel/state.ts";
import { createLogger } from "../src/logger.ts";
import { tempDir } from "./helpers.ts";

const log = createLogger({ write: () => {} });

interface Spec {
  events?: string[];
  deps?: Record<string, string>;
  enabled?: boolean;
  engines?: string;
  module?: (calls: string[]) => PluginModule;
}

async function setup(dir: string, specs: Record<string, Spec>, options: { timeoutMs?: number } = {}) {
  const calls: string[] = [];
  const discovery: Discovery = { plugins: new Map(), invalid: [] };
  for (const [id, s] of Object.entries(specs)) {
    const manifest = parseManifest({
      id,
      version: "1.0.0",
      displayName: id,
      engines: { "research-hub": s.engines ?? "^1.0.0" },
      activationEvents: s.events ?? ["onStartup"],
      dependencies: s.deps ?? {},
    });
    discovery.plugins.set(id, {
      manifest,
      dir: join(dir, id),
      builtin: true,
      ...(s.engines === "^2.0.0" ? { incompatible: "needs kernel API ^2.0.0, this hub has 1.0.0" } : {}),
    });
  }
  const modules = Object.fromEntries(
    Object.entries(specs).map(([id, s]) => [
      id,
      s.module?.(calls) ?? {
        activate: (ctx: PluginContext) => {
          calls.push(`activate ${id}`);
          ctx.subscriptions.push({ dispose: () => void calls.push(`dispose ${id}`) });
          return { from: id, deps: Object.keys(ctx.exports) };
        },
        deactivate: () => void calls.push(`deactivate ${id}`),
      },
    ]),
  );
  const loaded: string[] = [];
  const state = new PluginState(dir);
  await state.open(() =>
    Object.fromEntries(
      Object.entries(specs).map(([id, s]) => [
        id,
        { version: "1.0.0", source: { kind: "builtin" as const }, enabled: s.enabled ?? true, settings: {} },
      ]),
    ),
  );
  const kernel = new PluginKernel({
    discovery,
    state,
    log,
    activationTimeoutMs: options.timeoutMs ?? 10_000,
    load: async (p) => {
      loaded.push(p.manifest.id);
      return modules[p.manifest.id];
    },
  });
  const frames: PluginSummary[][] = [];
  kernel.onChange((plugins) => frames.push(plugins));
  await kernel.start();
  const stateOf = (id: string) => kernel.get(id)?.state;
  return { kernel, state, calls, loaded, frames, stateOf };
}

test("a plugin listening only for its view is activated once, when the view opens", async () => {
  const t = tempDir();
  try {
    const { kernel, calls, loaded, stateOf } = await setup(t.dir, {
      "rh.desk": {},
      "acme.reading-list": { events: ["onView:reading-list"] },
    });
    assert.equal(stateOf("rh.desk"), "active");
    assert.equal(stateOf("acme.reading-list"), "inactive");
    assert.deepEqual(loaded, ["rh.desk"]);
    await kernel.fire("onView:reading-list");
    await kernel.fire("onView:reading-list");
    assert.equal(stateOf("acme.reading-list"), "active");
    assert.deepEqual(
      calls.filter((c) => c.startsWith("activate")),
      ["activate rh.desk", "activate acme.reading-list"],
    );
    await kernel.stop();
  } finally {
    t.cleanup();
  }
});

test("dependencies activate first and their exports reach the dependent", async () => {
  const t = tempDir();
  try {
    let seen: Readonly<Record<string, unknown>> = {};
    const { kernel, calls } = await setup(t.dir, {
      "rh.sweep": {
        deps: { "rh.papers": "^1.0.0" },
        module: (c) => ({
          activate: (ctx) => {
            c.push("activate rh.sweep");
            seen = ctx.exports;
          },
        }),
      },
      "rh.papers": { events: ["onCommand:papers.search"], deps: { "rh.provider": "^1.0.0" } },
      "rh.provider": { events: [] },
    });
    assert.deepEqual(calls, ["activate rh.provider", "activate rh.papers", "activate rh.sweep"]);
    assert.deepEqual(seen, { "rh.papers": { from: "rh.papers", deps: ["rh.provider"] } });
    await kernel.stop();
    assert.deepEqual(calls.slice(3), [
      "deactivate rh.papers",
      "dispose rh.papers",
      "deactivate rh.provider",
      "dispose rh.provider",
    ]);
  } finally {
    t.cleanup();
  }
});

test("a disabled plugin's code is never loaded and its dependents say why they are inactive", async () => {
  const t = tempDir();
  try {
    const { kernel, loaded, stateOf } = await setup(t.dir, {
      "rh.kb": { enabled: false },
      "acme.graph": { deps: { "rh.kb": "^1.0.0" } },
      "acme.future": { engines: "^2.0.0" },
    });
    assert.deepEqual(loaded, []);
    assert.equal(stateOf("rh.kb"), "disabled");
    assert.equal(stateOf("acme.graph"), "blocked");
    assert.equal(kernel.get("acme.graph")!.reason, "needs rh.kb (disabled)");
    assert.equal(stateOf("acme.future"), "incompatible");
    assert.equal(kernel.get("acme.future")!.reason, "needs kernel API ^2.0.0, this hub has 1.0.0");
    await assert.rejects(kernel.activate("acme.graph"), PluginUnavailable);
  } finally {
    t.cleanup();
  }
});

test("disabling at runtime deactivates, asks before taking dependents along, and enabling restores", async () => {
  const t = tempDir();
  try {
    const { kernel, state, calls, frames, stateOf } = await setup(t.dir, {
      "rh.kb": {},
      "rh.viewer-obsidian": { deps: { "rh.kb": "^1.0.0" } },
    });
    await assert.rejects(kernel.setEnabled("rh.kb", false), (e: unknown) => {
      assert.ok(e instanceof HasDependents);
      assert.deepEqual(e.dependents, ["rh.viewer-obsidian"]);
      return true;
    });
    assert.equal(stateOf("rh.kb"), "active");
    calls.length = 0;
    frames.length = 0;
    await kernel.setEnabled("rh.kb", false, { cascade: true });
    assert.deepEqual(calls, [
      "deactivate rh.viewer-obsidian",
      "dispose rh.viewer-obsidian",
      "deactivate rh.kb",
      "dispose rh.kb",
    ]);
    assert.equal(stateOf("rh.kb"), "disabled");
    assert.equal(stateOf("rh.viewer-obsidian"), "disabled");
    assert.equal(frames.at(-1)!.find((p) => p.id === "rh.kb")!.state, "disabled");
    assert.equal((await state.history())[0].message, "disable rh.kb, rh.viewer-obsidian");

    await kernel.setEnabled("rh.kb", true);
    assert.equal(stateOf("rh.kb"), "active");
    assert.equal(stateOf("rh.viewer-obsidian"), "disabled");
    await kernel.setEnabled("rh.viewer-obsidian", true);
    assert.equal(stateOf("rh.viewer-obsidian"), "active");
    await kernel.stop();
  } finally {
    t.cleanup();
  }
});

test("a failing or hanging plugin fails alone; its dependents are blocked and the rest runs", async () => {
  const t = tempDir();
  try {
    const { kernel, stateOf } = await setup(
      t.dir,
      {
        "acme.broken": {
          module: () => ({
            activate: () => {
              throw new Error("boom");
            },
          }),
        },
        "acme.needs-broken": { deps: { "acme.broken": "*" } },
        "acme.slow": { module: () => ({ activate: () => new Promise(() => {}) }) },
        "rh.desk": {},
      },
      { timeoutMs: 200 },
    );
    assert.equal(stateOf("acme.broken"), "failed");
    assert.equal(kernel.get("acme.broken")!.reason, "boom");
    assert.equal(stateOf("acme.needs-broken"), "blocked");
    assert.equal(kernel.get("acme.needs-broken")!.reason, "needs acme.broken (failed)");
    assert.equal(stateOf("acme.slow"), "failed");
    assert.equal(kernel.get("acme.slow")!.reason, "activation timed out after 0.2 s");
    assert.equal(stateOf("rh.desk"), "active");
    await kernel.stop();
  } finally {
    t.cleanup();
  }
});

test("rollback re-applies an earlier state and built-ins new to the image are added", async () => {
  const t = tempDir();
  try {
    const first = await setup(t.dir, { "rh.kb": {}, "rh.viewer-obsidian": {} });
    const initial = (await first.state.history())[0].id;
    await first.kernel.setEnabled("rh.viewer-obsidian", false);
    assert.equal(first.stateOf("rh.viewer-obsidian"), "disabled");
    await first.kernel.rollback(initial);
    assert.equal(first.stateOf("rh.viewer-obsidian"), "active");
    await first.kernel.stop();

    // A newer image ships rh.viewer-library: it is added to the existing project's lockfile, enabled.
    const state = new PluginState(t.dir);
    await state.open(() => assert.fail("already initialized"));
    const second = new PluginKernel({
      discovery: {
        plugins: new Map(
          ["rh.kb", "rh.viewer-obsidian", "rh.viewer-library"].map((id) => [
            id,
            {
              manifest: parseManifest({
                id,
                version: "1.0.0",
                displayName: id,
                engines: { "research-hub": "^1.0.0" },
                activationEvents: [],
              }),
              dir: t.dir,
              builtin: true,
            },
          ]),
        ),
        invalid: [],
      },
      state,
      log,
      load: async () => ({}),
    });
    await second.start();
    assert.equal(second.get("rh.viewer-library")!.state, "inactive");
    const history = await state.history();
    assert.equal(history[0].message, "add built-in rh.viewer-library");
    assert.equal(history[0].actor, "kernel");
  } finally {
    t.cleanup();
  }
});

test("the default loader imports the manifest's main module from the plugin folder", async () => {
  const t = tempDir();
  try {
    const root = join(t.dir, "builtin");
    mkdirSync(join(root, "hello"), { recursive: true });
    writeFileSync(
      join(root, "hello", "rh-plugin.json"),
      JSON.stringify({
        id: "acme.hello",
        version: "1.0.0",
        displayName: "Hello",
        engines: { "research-hub": "^1.0.0" },
        main: "main.mjs",
        activationEvents: ["onStartup"],
      }),
    );
    writeFileSync(
      join(root, "hello", "main.mjs"),
      "export function activate(ctx) { return { greeting: `hello from ${ctx.id}` }; }",
    );
    const state = new PluginState(join(t.dir, "data"));
    await state.open(() => ({
      "acme.hello": { version: "1.0.0", source: { kind: "builtin" }, enabled: true, settings: {} },
    }));
    const kernel = new PluginKernel({ discovery: discover({ builtinDir: root }), state, log });
    await kernel.start();
    assert.deepEqual(await kernel.activate("acme.hello"), { greeting: "hello from acme.hello" });
  } finally {
    t.cleanup();
  }
});
