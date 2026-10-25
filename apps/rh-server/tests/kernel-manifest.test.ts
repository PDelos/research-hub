// Spec plugin-system: Plugin manifest, Dependencies (task 1.1): validation with field-level errors, the engines
// check, discovery, and dependency resolution (missing, disabled, incompatible, cyclic).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { dependents, resolve, type GraphNode } from "../src/kernel/graph.ts";
import { engineProblem, ManifestInvalid, parseManifest, type PluginManifest } from "../src/kernel/manifest.ts";
import { discover } from "../src/kernel/registry.ts";
import { tempDir } from "./helpers.ts";

const base = {
  id: "rh.example",
  version: "1.0.0",
  displayName: "Example",
  engines: { "research-hub": "^1.0.0" },
  activationEvents: ["onStartup"],
};

function problems(raw: unknown): string[] {
  try {
    parseManifest(raw);
  } catch (error) {
    assert.ok(error instanceof ManifestInvalid);
    return error.problems;
  }
  assert.fail("expected the manifest to be rejected");
}

test("a valid manifest gets defaults for contributes, dependencies and permissions", () => {
  const m = parseManifest(base);
  assert.deepEqual(m.contributes, {});
  assert.deepEqual(m.dependencies, {});
  assert.deepEqual(m.permissions, {});
});

test("a manifest without engines.research-hub is rejected naming the field", () => {
  const { engines: _engines, ...rest } = base;
  assert.deepEqual(problems(rest), ["engines.research-hub: required"]);
  assert.deepEqual(problems({ ...base, engines: {} }), ["engines.research-hub: required"]);
});

test("every problem is reported with its field", () => {
  const found = problems({
    ...base,
    id: "Example",
    version: "one",
    activationEvents: ["onBoot"],
    dependencies: { "rh.kb": "not a range" },
    permissions: { files: ["/etc"], secrets: ["lowercase"] },
    colour: "red",
  });
  assert.ok(found.some((p) => p.startsWith("id: ")));
  assert.ok(found.includes('version: "one" is not a semantic version'));
  assert.ok(found.some((p) => p.startsWith("activationEvents.0: not a known activation event")));
  assert.ok(found.includes('dependencies.rh.kb: "not a range" is not a version range'));
  assert.ok(found.some((p) => p.startsWith("permissions.files.0: ")));
  assert.ok(found.some((p) => p.startsWith("permissions.secrets.0: ")));
  assert.ok(found.includes("colour: not a known field"));
});

test("an incompatible engines range names both versions", () => {
  const m = parseManifest({ ...base, engines: { "research-hub": "^2.0.0" } });
  assert.equal(engineProblem(m, "1.0.0"), "needs kernel API ^2.0.0, this hub has 1.0.0");
  assert.equal(engineProblem(parseManifest(base), "1.0.0"), undefined);
});

function write(root: string, name: string, manifest: unknown) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "rh-plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
}

test("discovery loads built-in and installed plugins and reports invalid ones without stopping", () => {
  const t = tempDir();
  try {
    const builtin = join(t.dir, "builtin");
    const installed = join(t.dir, "installed");
    write(builtin, "kb", { ...base, id: "rh.kb" });
    write(installed, "reader", { ...base, id: "acme.reader", engines: { "research-hub": "^2.0.0" } });
    write(installed, "broken", "{ not json");
    write(installed, "shadow", { ...base, id: "rh.kb" });
    mkdirSync(join(installed, "empty"));
    const found = discover({ builtinDir: builtin, installedDir: installed, kernel: "1.0.0" });
    assert.deepEqual([...found.plugins.keys()], ["rh.kb", "acme.reader"]);
    assert.equal(found.plugins.get("rh.kb")!.builtin, true);
    assert.equal(found.plugins.get("acme.reader")!.incompatible, "needs kernel API ^2.0.0, this hub has 1.0.0");
    const byDir = Object.fromEntries(found.invalid.map((i) => [i.dir.split("/").at(-1), i.problems[0]]));
    assert.match(byDir.broken, /^not valid JSON/);
    assert.match(byDir.shadow, /^id: rh\.kb is already provided by/);
    assert.equal(byDir.empty, "rh-plugin.json: missing");
  } finally {
    t.cleanup();
  }
});

function nodes(
  spec: Record<string, { deps?: Record<string, string>; version?: string; enabled?: boolean; problem?: string }>,
) {
  return new Map<string, GraphNode>(
    Object.entries(spec).map(([id, s]) => [
      id,
      {
        manifest: parseManifest({
          ...base,
          id,
          version: s.version ?? "1.0.0",
          dependencies: s.deps ?? {},
        }) as PluginManifest,
        enabled: s.enabled ?? true,
        ...(s.problem ? { problem: s.problem } : {}),
      },
    ]),
  );
}

test("dependencies are activated first, in a stable order", () => {
  const { order, blocked } = resolve(
    nodes({
      "rh.sweep": { deps: { "rh.papers": "^1.0.0", "rh.decision": "^1.0.0" } },
      "rh.papers": { deps: { "rh.provider": "^1.0.0" } },
      "rh.decision": {},
      "rh.provider": {},
    }),
  );
  assert.equal(blocked.size, 0);
  assert.deepEqual(order, ["rh.decision", "rh.provider", "rh.papers", "rh.sweep"]);
});

test("missing, disabled, wrong-version and blocked dependencies keep a plugin inactive with the reason", () => {
  const { order, blocked } = resolve(
    nodes({
      "rh.kb": { enabled: false },
      "acme.graph": { deps: { "rh.kb": "^1.0.0" } },
      "acme.notes": { deps: { "acme.missing": "^1.0.0" } },
      "acme.old": { deps: { "rh.papers": "^2.0.0" } },
      "rh.papers": { version: "1.3.0" },
      "acme.chain": { deps: { "acme.graph": "*" } },
      "acme.future": { problem: "needs kernel API ^2.0.0, this hub has 1.0.0" },
    }),
  );
  assert.deepEqual(order, ["rh.papers"]);
  assert.equal(blocked.get("rh.kb"), "disabled");
  assert.equal(blocked.get("acme.graph"), "needs rh.kb (disabled)");
  assert.equal(blocked.get("acme.notes"), "needs acme.missing (not installed)");
  assert.equal(blocked.get("acme.old"), "needs rh.papers ^2.0.0 (installed 1.3.0)");
  assert.equal(blocked.get("acme.chain"), "needs acme.graph (not active)");
  assert.equal(blocked.get("acme.future"), "needs kernel API ^2.0.0, this hub has 1.0.0");
});

test("a dependency cycle blocks exactly the plugins in it", () => {
  const { order, blocked } = resolve(
    nodes({
      "a.one": { deps: { "a.two": "*" } },
      "a.two": { deps: { "a.three": "*" } },
      "a.three": { deps: { "a.one": "*" } },
      "a.free": {},
    }),
  );
  assert.deepEqual(order, ["a.free"]);
  assert.equal(blocked.get("a.one"), "dependency cycle: a.one → a.three → a.two");
  assert.equal(blocked.size, 3);
});

test("dependents lists direct and indirect dependents before a disable", () => {
  const graph = nodes({
    "rh.kb": {},
    "rh.viewer-obsidian": { deps: { "rh.kb": "*" } },
    "acme.graph": { deps: { "rh.viewer-obsidian": "*" } },
    "rh.papers": {},
  });
  assert.deepEqual(dependents(graph, "rh.kb"), ["acme.graph", "rh.viewer-obsidian"]);
});
