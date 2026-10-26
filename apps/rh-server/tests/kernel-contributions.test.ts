// Spec plugin-system: Declarative contributions, Extension points owned by plugins, Plugin settings (task 1.4):
// each kernel contribution point, plugin-offered points with cardinality, the unknown-point report, settings with
// environment defaults, and the Jev lock check across plugins.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { writeLock } from "@rh/jev";
import { checkJevAcrossPlugins, ContributionError, ContributionRegistry } from "../src/kernel/contributions.ts";
import { PluginKernel, SettingsInvalid, type PluginContext, type PluginModule } from "../src/kernel/lifecycle.ts";
import { discover, initialPlugins } from "../src/kernel/registry.ts";
import { PluginState } from "../src/kernel/state.ts";
import { createLogger } from "../src/logger.ts";
import { tempDir } from "./helpers.ts";

const log = createLogger({ write: () => {} });

function plugin(root: string, folder: string, manifest: Record<string, unknown>) {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(
    join(root, folder, "rh-plugin.json"),
    JSON.stringify({
      version: "1.0.0",
      displayName: folder,
      engines: { "research-hub": "^1.0.0" },
      activationEvents: ["onStartup"],
      ...manifest,
    }),
  );
}

function jevCommand(dir: string, name: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "command.json"),
    JSON.stringify({
      name,
      version: 1,
      state: { title: "{{title}}" },
      questions: { ok: { type: "boolean", text: "Is it ok?" } },
    }),
  );
}

async function boot(root: string, data: string, modules: Record<string, PluginModule>, env: NodeJS.ProcessEnv = {}) {
  const discovery = discover({ builtinDir: root });
  assert.deepEqual(discovery.invalid, []);
  const state = new PluginState(data);
  await state.open(() => initialPlugins(discovery, env));
  const kernel = new PluginKernel({ discovery, state, log, env, load: async (p) => modules[p.manifest.id] ?? {} });
  const registry = new ContributionRegistry(kernel, discovery);
  await kernel.start();
  return { kernel, registry, discovery, state };
}

test("contribution shapes are validated with the field, and kernel points need their activation events", () => {
  const t = tempDir();
  try {
    plugin(t.dir, "bad", {
      id: "acme.bad",
      activationEvents: [],
      contributes: {
        tabs: [{ id: "Reading", view: "x" }],
        commands: [{ id: "bad.run", title: "Run" }],
        chatTools: [{ name: "find_things", description: "Find", parameters: {} }],
        jevCommands: ["jev/missing"],
        colours: ["red"],
      },
    });
    const { invalid } = discover({ builtinDir: t.dir });
    const problems = invalid[0].problems;
    assert.ok(problems.includes("contributes.tabs.0.title: required"), problems.join("\n"));
    assert.ok(problems.some((p) => p.startsWith("contributes.tabs.0.id: ")));
    assert.ok(
      problems.includes(
        "contributes.colours: not a known contribution point (extension points are named like papers.source)",
      ),
    );
    assert.ok(problems.includes('contributes.commands: "bad.run" needs the activation event onCommand:bad.run'));
    assert.ok(
      problems.includes('contributes.chatTools: "find_things" needs the activation event onChatTool:find_things'),
    );
    assert.ok(problems.includes("contributes.jevCommands: jev/missing has no command.json"));
  } finally {
    t.cleanup();
  }
});

test("tabs, commands, chat tools, Jev commands, prompts and processes follow the plugin's enablement", async () => {
  const t = tempDir();
  try {
    const root = join(t.dir, "plugins");
    plugin(root, "desk", {
      id: "rh.desk",
      contributes: { tabs: [{ id: "chat", title: "Chat", view: "chat", order: 10 }] },
    });
    jevCommand(join(root, "kb", "jev"), "kb-tag");
    writeLock(join(root, "kb", "jev"));
    mkdirSync(join(root, "kb", "prompts", "librarian"), { recursive: true });
    plugin(root, "kb", {
      id: "rh.kb",
      activationEvents: ["onChatTool:search_kb", "onChatTool:kb_internal", "onCommand:kb.reindex", "onView:library"],
      contributes: {
        tabs: [{ id: "library", title: "Library", view: "library", order: 30 }],
        commands: [{ id: "kb.reindex", title: "Rebuild the index" }],
        chatTools: [
          { name: "search_kb", description: "Search the knowledge base", parameters: { type: "object" } },
          { name: "kb_internal", description: "For the librarian only", parameters: {}, desk: false },
        ],
        jevCommands: ["jev/kb-tag"],
        prompts: [{ agent: "librarian", path: "prompts/librarian" }],
        processes: [{ id: "indexer", entry: "indexer.js" }],
      },
    });
    const activated: string[] = [];
    const modules: Record<string, PluginModule> = {
      "rh.kb": {
        activate(ctx: PluginContext) {
          activated.push(ctx.id);
          ctx.subscriptions.push(
            registry.registerChatTool(ctx.id, "search_kb", (args) => ({ hits: [(args as { q: string }).q] })),
            registry.registerCommand(ctx.id, "kb.reindex", () => "reindexed"),
          );
        },
      },
    };
    const { kernel, registry, discovery } = await boot(root, join(t.dir, "data"), modules);
    // Nothing of rh.kb has run, yet everything it contributes is known.
    assert.deepEqual(activated, []);
    assert.deepEqual(
      registry.tabs().map((x) => x.id),
      ["chat", "library"],
    );
    assert.deepEqual(
      registry.chatTools({ desk: true }).map((x) => x.name),
      ["search_kb"],
    );
    assert.deepEqual(
      registry.chatTools().map((x) => x.name),
      ["search_kb", "kb_internal"],
    );
    assert.equal(registry.jevCommands().get("kb-tag"), join(root, "kb", "jev", "kb-tag"));
    assert.equal(registry.promptDir("librarian"), join(root, "kb", "prompts", "librarian"));
    assert.deepEqual(
      registry.processes("rh.kb").map((p) => p.id),
      ["indexer"],
    );
    assert.deepEqual(checkJevAcrossPlugins(discovery), []);

    // The first call activates the plugin (onChatTool), then runs the handler it registered.
    assert.deepEqual(await registry.callChatTool("search_kb", { q: "proteins" }), { hits: ["proteins"] });
    assert.equal(await registry.executeCommand("kb.reindex"), "reindexed");
    assert.deepEqual(activated, ["rh.kb"]);
    await assert.rejects(registry.callChatTool("kb_internal"), /rh\.kb did not register the chat tool kb_internal/);
    assert.throws(() => registry.registerCommand("rh.kb", "kb.other", () => 1), ContributionError);

    // Disabled: its tab, tools, Jev commands and prompts are gone.
    await kernel.setEnabled("rh.kb", false);
    assert.deepEqual(
      registry.tabs().map((x) => x.id),
      ["chat"],
    );
    assert.deepEqual(registry.chatTools(), []);
    assert.equal(registry.jevCommands().size, 0);
    assert.equal(registry.promptDir("librarian"), undefined);
    await assert.rejects(
      registry.callChatTool("search_kb", { q: "x" }),
      /no enabled plugin offers the chat tool search_kb/,
    );
    await kernel.stop();
  } finally {
    t.cleanup();
  }
});

test("a one-cardinality point has one active contribution (a setting); many collects all; unknown points are reported", async () => {
  const t = tempDir();
  try {
    const root = join(t.dir, "plugins");
    plugin(root, "kb", {
      id: "rh.kb",
      contributes: {
        extensionPoints: {
          "kb.viewer": {
            cardinality: "one",
            default: "obsidian",
            schema: { required: ["id", "title"], properties: { title: { type: "string" } } },
          },
          "papers.source": { cardinality: "many" },
        },
      },
    });
    plugin(root, "obsidian", {
      id: "rh.viewer-obsidian",
      contributes: { "kb.viewer": [{ id: "obsidian", title: "Obsidian" }] },
    });
    plugin(root, "library", {
      id: "rh.viewer-library",
      contributes: { "kb.viewer": [{ id: "library", title: "Library" }, { id: "untitled" }] },
    });
    plugin(root, "arxiv", {
      id: "rh.source-arxiv",
      activationEvents: ["onExtensionPoint:papers.source"],
      contributes: { "papers.source": [{ id: "arxiv" }] },
    });
    plugin(root, "openalex", { id: "rh.source-openalex", contributes: { "papers.source": [{ id: "openalex" }] } });
    plugin(root, "ranker", { id: "acme.ranker", contributes: { "papers.ranker": [{ id: "bm25" }] } });
    const { kernel, registry } = await boot(root, join(t.dir, "data"), {});

    assert.equal(registry.activeContribution("kb.viewer", kernel.settings("rh.kb"))?.id, "obsidian");
    await kernel.configure("rh.kb", { "kb.viewer": "library" });
    assert.deepEqual(registry.activeContribution("kb.viewer", kernel.settings("rh.kb")), {
      id: "library",
      title: "Library",
      pluginId: "rh.viewer-library",
    });
    assert.deepEqual(registry.problems("rh.viewer-library"), [
      "contribution kb.viewer/untitled: kb.viewer.title: required",
    ]);

    assert.equal(kernel.get("rh.source-arxiv")!.state, "inactive");
    const sources = await registry.contributionsTo("papers.source", { activate: true });
    assert.deepEqual(
      sources.map((s) => s.id),
      ["arxiv", "openalex"],
    );
    assert.equal(kernel.get("rh.source-arxiv")!.state, "active");
    await kernel.setEnabled("rh.source-openalex", false);
    assert.deepEqual(
      (await registry.contributionsTo("papers.source")).map((s) => s.id),
      ["arxiv"],
    );

    // A contribution to a point nobody offers is reported; the plugin still activates.
    assert.equal(kernel.get("acme.ranker")!.state, "active");
    assert.deepEqual(registry.problems("acme.ranker"), [
      "contributes to papers.ranker, which no enabled plugin offers",
    ]);
    await kernel.stop();
  } finally {
    t.cleanup();
  }
});

test("settings: schema and environment defaults, saved values, validation with the allowed range", async () => {
  const t = tempDir();
  try {
    const root = join(t.dir, "plugins");
    plugin(root, "sweep", {
      id: "rh.sweep",
      contributes: {
        settings: {
          properties: {
            maxCards: { type: "integer", minimum: 1, maximum: 15, default: 7, env: "RH_MAX_CARDS" },
            model: { type: "string", default: "free" },
            sources: { type: "array", items: { type: "string" }, env: "RH_SOURCES" },
          },
        },
      },
    });
    plugin(root, "obsidian", { id: "rh.viewer-obsidian", contributes: { enablement: { env: "RH_KB_VIEWER" } } });
    let seen: Readonly<Record<string, unknown>> = {};
    const env = { RH_MAX_CARDS: "9", RH_SOURCES: "arxiv, openalex", RH_KB_VIEWER: "off" };
    const { kernel, state } = await boot(
      root,
      join(t.dir, "data"),
      { "rh.sweep": { activate: (ctx) => void (seen = ctx.settings) } },
      env,
    );

    assert.deepEqual(seen, { maxCards: 9, model: "free", sources: ["arxiv", "openalex"] });
    assert.equal(kernel.get("rh.viewer-obsidian")!.state, "disabled");

    await assert.rejects(kernel.configure("rh.sweep", { maxCards: 40 }), (e: unknown) => {
      assert.ok(e instanceof SettingsInvalid);
      assert.deepEqual(e.problems, ["maxCards: must be an integer from 1 to 15"]);
      return true;
    });
    await assert.rejects(kernel.configure("rh.sweep", { colour: "red" }), /colour: not a known setting/);
    const commits = (await state.history()).length;
    await kernel.configure("rh.sweep", { maxCards: 12 });
    assert.equal(seen.maxCards, 12); // restarted with the new value
    assert.equal((await state.history()).length, commits + 1);
    assert.equal((await state.history())[0].message, "configure rh.sweep: maxCards");
    await kernel.configure("rh.sweep", { maxCards: undefined });
    assert.equal(seen.maxCards, 9); // back to the environment default
    await kernel.stop();
  } finally {
    t.cleanup();
  }
});

test("the Jev lock check across plugins reports unlocked and duplicate commands", () => {
  const t = tempDir();
  try {
    const root = join(t.dir, "plugins");
    for (const [folder, id] of [
      ["a", "acme.a"],
      ["b", "acme.b"],
    ]) {
      jevCommand(join(root, folder, "jev"), "tagger");
      plugin(root, folder, { id, contributes: { jevCommands: ["jev/tagger"] } });
    }
    writeLock(join(root, "a", "jev"));
    const problems = checkJevAcrossPlugins(discover({ builtinDir: root }));
    assert.ok(problems.some((p) => p.startsWith("tagger: contributed twice")));
    assert.ok(problems.includes(`${join(root, "b", "jev")}: tagger: new command not in the lock; run with --update`));
  } finally {
    t.cleanup();
  }
});
