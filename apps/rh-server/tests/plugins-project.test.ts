// Spec plugin-system: v0 as built-in plugins, Per-project plugin state, Declarative contributions (task 2.1): every
// project starts its plugin kernel; models and Jev come from rh.provider-openrouter and rh.decision-jev; required
// built-ins cannot be disabled; other plugins reach models and Jev through rh; the stream reports plugin states.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { say } from "@rh/durable-agent";
import type { Frame, PluginSummary } from "@rh/sdk";
import { createRhApi } from "../src/kernel/api.ts";
import { PluginUnavailable } from "../src/kernel/lifecycle.ts";
import { parseManifest } from "../src/kernel/manifest.ts";
import { startTestServer, until } from "./helpers.ts";

test("a project starts its plugins from a committed lockfile with the provider and Jev plugins active", async () => {
  const server = await startTestServer({ hub: { fauxRules: [(t) => say(`echo ${t.lastUser}`)] } });
  try {
    const { plugins } = server.hub.project;
    const lock = JSON.parse(readFileSync(join(server.dataDir, "plugins", "plugins.lock.json"), "utf8"));
    assert.equal(lock.plugins["rh.provider-openrouter"].enabled, true);
    assert.equal(lock.plugins["rh.decision-jev"].enabled, true);
    assert.ok(existsSync(join(server.dataDir, "plugins", ".git")));
    assert.equal(plugins.kernel.get("rh.provider-openrouter")?.state, "active");
    assert.equal(plugins.kernel.get("rh.decision-jev")?.state, "active");
    assert.equal((await plugins.state.history()).at(-1)?.message, "initialize plugins from the environment");

    await assert.rejects(plugins.kernel.setEnabled("rh.decision-jev", false), (e: unknown) => {
      assert.ok(e instanceof PluginUnavailable);
      assert.match(e.message, /the hub needs it, so it cannot be disabled/);
      return true;
    });

    // Chat and the Jev ping still work through the plugins.
    assert.equal((await server.client.send("hello", { waitMs: 10_000 })).status, "done");
    assert.equal(typeof (await server.hub.project.jevPing()).greeting, "number");
  } finally {
    await server.stop();
  }
});

test("other plugins reach models and Jev commands through rh, charged to their budget", async () => {
  const server = await startTestServer({ hub: { fauxRules: [() => say("a short answer")] } });
  try {
    const { services } = server.hub.project.plugins;
    const manifest = parseManifest({
      id: "acme.helper",
      version: "0.1.0",
      displayName: "Helper",
      engines: { "research-hub": "^1.0.0" },
      activationEvents: [],
      permissions: { budgetUsdPerDay: 1 },
    });
    const rh = createRhApi({ manifest, dir: server.dataDir, builtin: false }, services, []);
    const reply = await rh.models.complete({ prompt: "Say something short." });
    assert.equal(reply.text, "a short answer");
    const decision = await rh.decisions.decide("ping", { text: "hello" });
    assert.ok("greeting" in decision.answers);
    await assert.rejects(
      rh.decisions.decide("no-such-command", {}),
      /no enabled plugin contributes the Jev command no-such-command/,
    );
    const ledger = server.hub.project.db.prepare("SELECT command FROM jev_calls ORDER BY id DESC LIMIT 1").get() as {
      command: string;
    };
    assert.equal(ledger.command, "ping");
  } finally {
    await server.stop();
  }
});

test("the stream sends plugin states", async () => {
  const server = await startTestServer();
  const frames: Frame[] = [];
  const abort = new AbortController();
  const done = (async () => {
    try {
      for await (const frame of server.client.stream(abort.signal)) frames.push(frame);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  try {
    const latest = () =>
      frames.filter((f): f is Extract<Frame, { type: "plugins" }> => f.type === "plugins").at(-1)?.plugins;
    await until(() => latest() !== undefined, 10_000, "plugins frame");
    const byId = (list: PluginSummary[] | undefined, id: string) => list?.find((p) => p.id === id);
    assert.equal(byId(latest(), "rh.decision-jev")?.state, "active");
    assert.equal(byId(latest(), "rh.decision-jev")?.builtin, true);
  } finally {
    abort.abort();
    await done;
    await server.stop();
  }
});

test("the v0 tabs come from built-in plugins and follow their enablement", async () => {
  const server = await startTestServer();
  try {
    const { contributions, kernel } = server.hub.project.plugins;
    const tabs = () => contributions.tabs().map((t) => `${t.id}:${t.pluginId}`);
    assert.deepEqual(tabs(), [
      "feed:rh.sweep",
      "digest:rh.digest",
      "quality:rh.harness",
      "upgrades:rh.upgrades",
      "library:rh.kb",
      "kb:rh.kb",
      "charter:rh.charter",
      "runs:rh.runs-ui",
      "settings:rh.settings-ui",
      "plugins:rh.plugins-ui",
    ]);
    await kernel.setEnabled("rh.runs-ui", false);
    assert.ok(!tabs().some((t) => t.startsWith("runs:")));
    await kernel.setEnabled("rh.runs-ui", true);
    assert.ok(tabs().includes("runs:rh.runs-ui"));
    await assert.rejects(kernel.setEnabled("rh.settings-ui", false), /cannot be disabled/);
  } finally {
    await server.stop();
  }
});

test("the desk may call a declared tool only while its plugin is available; undeclared tools keep v0 behavior", async () => {
  const { activate } = await import("../plugins/rh.desk/main.ts");
  let available = true;
  const host = {
    name: "p",
    options: { promptsDir: "" },
    services: {
      contributions: {
        declaredChatTools: () => new Set(["search_papers", "recent_cards"]),
        chatTools: () =>
          (available ? [{ name: "search_papers" }, { name: "recent_cards" }] : [{ name: "recent_cards" }]).map((t) => ({
            ...t,
            builtin: true,
          })),
      },
    },
  };
  const desk = activate({ id: "rh.desk", host } as never);
  assert.deepEqual(desk.deskTools(), ["search_papers", "recent_cards", "judge_card", "search_kb", "query_kb"]);
  available = false;
  assert.deepEqual(desk.deskTools(), ["recent_cards", "judge_card", "search_kb", "query_kb"]);
});

test("every built-in plugin with code is in the static module map the bundle uses", async () => {
  const { readdirSync, existsSync } = await import("node:fs");
  const { BUILTIN_MODULES } = await import("../src/kernel/builtins.ts");
  const { BUILTIN_PLUGINS_DIR } = await import("../src/kernel/registry.ts");
  const withCode = readdirSync(BUILTIN_PLUGINS_DIR).filter((id) =>
    existsSync(join(BUILTIN_PLUGINS_DIR, id, "main.ts")),
  );
  assert.deepEqual(Object.keys(BUILTIN_MODULES).toSorted(), withCode.toSorted());
});

test("cards per sweep is an rh.sweep setting: a v0 value carries over, and changes apply live with a history entry", async () => {
  const server = await startTestServer();
  try {
    const p = server.hub.project;
    const sweepsBefore = p.sweeps;
    const activatedAt = p.plugins.kernel.get("rh.sweep")?.activatedAt;
    p.settings.set("cards_per_sweep", 5);
    assert.equal(p.sweeps.cardsPerSweep(), 5, "a value saved by v0 counts");
    assert.deepEqual(await server.client.setSweepSettings({ cardsPerSweep: 9 }), { cardsPerSweep: 9 });
    assert.equal(p.sweeps.cardsPerSweep(), 9);
    assert.equal((await p.plugins.state.history())[0].message, "configure rh.sweep: cardsPerSweep");
    assert.equal(p.plugins.kernel.get("rh.sweep")?.activatedAt, activatedAt, "no restart");
    assert.equal(p.sweeps, sweepsBefore);
    assert.equal(p.plugins.kernel.settings("rh.sweep").explorationPicks, 1);
    await assert.rejects(
      server.client.setSweepSettings({ cardsPerSweep: 40 }),
      /cardsPerSweep: must be an integer from 1 to 15/,
    );
  } finally {
    await server.stop();
  }
});
