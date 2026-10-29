// Spec plugin-system: Plugins view, Install and uninstall, Plugin settings, Kernel API versioning (task 4.1): the
// /v1/plugins API through the SDK.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { RhError } from "@rh/sdk";
import { startTestServer } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/plugins");

const rejects = async (p: Promise<unknown>, code: string, message: RegExp, details?: unknown) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RhError);
    assert.equal(e.code, code);
    assert.match(e.message, message);
    if (details !== undefined) assert.deepEqual(e.details, details);
    return true;
  });

test("the API lists plugins and their contributions, and /v1/info reports the kernel API and plugin versions", async () => {
  const server = await startTestServer();
  try {
    const { client } = server;
    const list = await client.plugins();
    assert.equal(list.kernelApi, "1.0.0");
    assert.ok(list.plugins.some((p) => p.id === "rh.kb" && p.state === "active" && p.builtin));
    assert.deepEqual(list.invalid, []);
    const info = await client.info();
    assert.equal(info.kernelApi, "1.0.0");
    assert.ok(info.plugins.some((p) => p.id === "rh.papers" && p.version === "1.0.0" && p.state === "active"));

    const kb = await client.plugin("rh.kb");
    assert.equal(kb.required, true);
    assert.deepEqual(
      kb.contributions.tabs.map((t) => t.id),
      ["library", "kb"],
    );
    assert.deepEqual(
      kb.contributions.chatTools.map((t) => t.name),
      ["search_kb", "query_kb"],
    );
    assert.equal(kb.contributions.extensionPoints["kb.viewer"].cardinality, "one");
    // No viewer chosen: automatic (Obsidian only where Ignis is installed; not in this test environment).
    assert.equal(kb.settings.values["kb.viewer"], undefined);
    assert.ok(kb.dependents.includes("rh.viewer-obsidian"));
    // Never activated, yet fully described.
    const s2 = await client.plugin("rh.source-semanticscholar");
    assert.deepEqual(s2.permissions, { network: ["api.semanticscholar.org"] });
    assert.deepEqual(s2.contributions.points["papers.source"], [{ id: "semanticscholar", title: "Semantic Scholar" }]);

    const pluginContributionsView = await client.contributions();
    assert.deepEqual(
      pluginContributionsView.tabs.map((t) => t.id),
      ["feed", "digest", "quality", "upgrades", "library", "kb", "charter", "runs", "settings", "plugins"],
    );
    assert.equal(pluginContributionsView.viewer.active?.id, "library");
    assert.deepEqual(pluginContributionsView.viewer.options.map((o) => o.id).toSorted(), ["library", "obsidian"]);
    assert.ok(pluginContributionsView.settings.some((g) => g.pluginId === "rh.kb" && "kb.viewer" in g.properties));
    await rejects(client.plugin("acme.nothing"), "not_found", /No plugin acme\.nothing/);
  } finally {
    await server.stop();
  }
});

test("install needs approval; refusals list the problems; uninstall removes the plugin", async () => {
  const server = await startTestServer();
  try {
    const { client } = server;
    await rejects(
      client.prepareInstall({ folder: join(FIXTURES, "acme.unversioned") }),
      "invalid",
      /manifest is invalid/,
      ["engines.research-hub: required"],
    );
    const plan = await client.prepareInstall({ folder: join(FIXTURES, "acme.sample") });
    assert.deepEqual(plan.permissions, { network: ["export.arxiv.org"] });
    assert.ok(!(await client.plugins()).plugins.some((p) => p.id === "acme.sample"));
    const installed = await client.approveInstall(plan.planId);
    assert.equal(installed.state, "active");
    assert.equal(installed.history[0].message, "install acme.sample 0.1.0");
    await client.uninstallPlugin("acme.sample");
    await rejects(client.plugin("acme.sample"), "not_found", /No plugin/);

    const other = await client.prepareInstall({ folder: join(FIXTURES, "acme.sample") });
    await client.cancelInstall(other.planId);
    await rejects(
      client.approveInstall(other.planId),
      "invalid",
      /was not prepared, or was already confirmed or cancelled/,
    );
  } finally {
    await server.stop();
  }
});

test("enable and disable ask before taking dependents along; required plugins stay; settings are validated", async () => {
  const server = await startTestServer();
  try {
    const { client } = server;
    await client.approveInstall((await client.prepareInstall({ folder: join(FIXTURES, "acme.needs-arxiv") })).planId);
    await rejects(
      client.setPluginEnabled("rh.source-arxiv", false),
      "conflict",
      /acme\.needs-arxiv depends on rh\.source-arxiv/,
      ["acme.needs-arxiv"],
    );
    const off = await client.setPluginEnabled("rh.source-arxiv", false, true);
    assert.equal(off.state, "disabled");
    assert.equal((await client.plugin("acme.needs-arxiv")).state, "disabled");
    assert.equal((await client.setPluginEnabled("rh.source-arxiv", true)).state, "inactive");
    await rejects(client.setPluginEnabled("rh.kb", false), "conflict", /the hub needs it, so it cannot be disabled/);

    await rejects(client.setPluginSettings("rh.kb", { "kb.viewer": 5 }), "invalid", /kb\.viewer: must be string/);
    await rejects(client.setPluginSettings("rh.kb", { colour: "red" }), "invalid", /colour: not a known setting/);
    const library = await client.setPluginSettings("rh.kb", { "kb.viewer": "library" });
    assert.equal(library.settings.values["kb.viewer"], "library");
    assert.equal((await client.contributions()).viewer.active?.id, "library");
    const reset = await client.setPluginSettings("rh.kb", { "kb.viewer": null });
    assert.equal(reset.settings.values["kb.viewer"], undefined);
    assert.equal((await client.contributions()).viewer.active?.id, "library");
  } finally {
    await server.stop();
  }
});

test("the history lists every change with its actor, and rollback restores an earlier state", async () => {
  const server = await startTestServer();
  try {
    const { client } = server;
    const start = (await client.pluginHistory())[0];
    await client.setPluginEnabled("rh.viewer-library", false);
    await client.setPluginEnabled("rh.source-europepmc", false);
    const history = await client.pluginHistory();
    assert.deepEqual(
      history.slice(0, 2).map((h) => [h.message, h.actor]),
      [
        ["disable rh.source-europepmc", "user"],
        ["disable rh.viewer-library", "user"],
      ],
    );
    const after = await client.rollbackPlugins(start.id);
    for (const id of ["rh.viewer-library", "rh.source-europepmc"])
      assert.ok(["active", "inactive"].includes(after.plugins.find((p) => p.id === id)!.state), id);
    assert.match((await client.pluginHistory())[0].message, /^roll back to [0-9a-f]{7} /);
    await rejects(client.rollbackPlugins("deadbeef"), "not_found", /No commit deadbeef/);
    await rejects(client.rollbackPlugins("not-a-commit"), "invalid", /commit must be/);
  } finally {
    await server.stop();
  }
});

test("a plugin waiting for its view starts when the UI opens the tab, and its UI module is served", async () => {
  const server = await startTestServer();
  try {
    const { client } = server;
    await client.approveInstall((await client.prepareInstall({ folder: join(FIXTURES, "acme.reading-list") })).planId);
    assert.equal((await client.plugin("acme.reading-list")).state, "inactive");
    const tab = (await client.contributions()).tabs.find((t) => t.id === "reading-list")!;
    assert.deepEqual(tab, {
      id: "reading-list",
      title: "Reading list",
      view: "acme-reading-list",
      order: 35,
      pluginId: "acme.reading-list",
      builtin: false,
      script: "/plugins/acme.reading-list/reading-list.js",
    });
    await client.openView("reading-list");
    assert.equal((await client.plugin("acme.reading-list")).state, "active");

    const script = await fetch(`${server.url}${tab.script}`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /customElements\.define\("acme-reading-list"/);
    assert.equal((await fetch(`${server.url}/plugins/acme.reading-list/../rh-plugin.json`)).status, 404);
    await client.setPluginEnabled("acme.reading-list", false);
    assert.equal((await fetch(`${server.url}${tab.script}`)).status, 404);
    assert.ok(!(await client.contributions()).tabs.some((t) => t.id === "reading-list"));
  } finally {
    await server.stop();
  }
});

test("undo reverses one change and keeps later ones; a later change to the same setting blocks it", async () => {
  const server = await startTestServer();
  try {
    const { client } = server;
    await client.setSweepSettings({ cardsPerSweep: 9 });
    const first = (await client.pluginHistory())[0];
    assert.equal(first.message, "configure rh.sweep: cardsPerSweep");
    await client.setPluginEnabled("rh.source-europepmc", false);

    const undone = await client.undoPluginChange(first.id);
    assert.deepEqual(undone.plugins, ["rh.sweep"]);
    assert.equal(undone.history[0].message, "undo: configure rh.sweep: cardsPerSweep");
    assert.equal((await client.sweepSettings()).cardsPerSweep, 7);
    assert.equal((await client.plugin("rh.source-europepmc")).state, "disabled", "the later change stays");

    await client.setSweepSettings({ cardsPerSweep: 4 });
    const pluginHistoryEntry = (await client.pluginHistory())[0];
    await client.setSweepSettings({ cardsPerSweep: 5 });
    await rejects(
      client.undoPluginChange(pluginHistoryEntry.id),
      "conflict",
      /a later change touched the same setting \(rh\.sweep\.settings\.cardsPerSweep\)/,
    );
    assert.equal((await client.sweepSettings()).cardsPerSweep, 5, "nothing changed");

    // Undoing an uninstall is refused without a trace (its files are gone); undoing an install disables the plugin.
    await client.approveInstall((await client.prepareInstall({ folder: join(FIXTURES, "acme.needs-arxiv") })).planId);
    await client.uninstallPlugin("acme.needs-arxiv");
    const uninstall = (await client.pluginHistory())[0];
    assert.equal(uninstall.message, "uninstall acme.needs-arxiv");
    await rejects(client.undoPluginChange(uninstall.id), "conflict", /no longer installed; install it again/);
    assert.equal((await client.pluginHistory())[0].id, uninstall.id, "a refused undo writes nothing");
    await client.approveInstall((await client.prepareInstall({ folder: join(FIXTURES, "acme.needs-arxiv") })).planId);
    await client.undoPluginChange((await client.pluginHistory())[0].id);
    assert.equal((await client.plugin("acme.needs-arxiv")).state, "disabled");
    const init = (await client.pluginHistory(500)).at(-1)!;
    await rejects(client.undoPluginChange(init.id), "conflict", /the first state has nothing before it/);
  } finally {
    await server.stop();
  }
});
