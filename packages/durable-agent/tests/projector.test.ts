import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import {
  call,
  defineAppTool,
  observability,
  say,
  startProjector,
  toolText,
  type AgentHookEvent,
} from "../src/index.ts";
import { ask, fauxHarness, memoryTelemetry, tempDir, until } from "./helpers.ts";

const echo = defineAppTool({
  name: "echo",
  description: "Echo",
  parameters: Type.Object({ text: Type.String() }),
  replay: "safe",
  execute: async (args) => {
    await new Promise((r) => setTimeout(r, 30));
    return toolText(args.text);
  },
});

test("1.1.0 timings reach telemetry, hooks report behavior, and a restart writes nothing twice", async () => {
  const t = tempDir();
  try {
    const events: AgentHookEvent[] = [];
    const extensions = [
      defineExtension({ name: "echo", tools: [echo] }),
      observability({ event: (e) => events.push(e) }),
    ];
    const rules = [
      (turn: any) => (turn.results.length === 0 ? call("echo", { text: "ping" }) : say("pong")),
    ];
    const first = await fauxHarness(t.dir, rules, extensions);
    const tel = memoryTelemetry();
    const stop = startProjector(first.harness, tel.store);
    await ask(first.root, first.ctx, "go");
    await until(
      () => tel.rows.tools.size === 1 && tel.rows.generations.size === 2,
      5000,
      "projection",
    );
    const tool = [...tel.rows.tools.values()][0];
    assert.equal(tool.toolName, "echo");
    assert.ok(tool.durationMs >= 25, `durationMs ${tool.durationMs}`);
    for (const g of tel.rows.generations.values()) {
      assert.equal(typeof g.durationMs, "number");
      assert.ok(g.contextTokens > 0);
    }
    const toolTask = [...tel.rows.tasks.values()].find((x) => x.kind === "pi.tool")!;
    assert.ok(toolTask.startedAt && toolTask.endedAt && toolTask.endedAt >= toolTask.startedAt);
    assert.equal(tel.rows.users.size, 1);
    const names = events.map((e) => e.event);
    for (const expected of [
      "generation.request",
      "generation.response",
      "tool.start",
      "tool.end",
      "generation.tools_done",
    ]) {
      assert.ok(names.includes(expected), `${expected} in ${names.join(",")}`);
    }
    stop();
    await first.close();

    const second = await fauxHarness(t.dir, rules, extensions);
    const again = memoryTelemetry();
    const stop2 = startProjector(second.harness, again.store);
    second.harness.resume();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      again.rows.generations.size + again.rows.tools.size,
      0,
      "reopen republishes nothing",
    );
    stop2();
    await second.close();
  } finally {
    t.cleanup();
  }
});
