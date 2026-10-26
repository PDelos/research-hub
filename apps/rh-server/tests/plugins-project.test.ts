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
