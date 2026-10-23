// Spec agent-runtime: one root agent per project, chat, restricted tools, configurable models, run telemetry
// (tasks 3.4, 3.5, 3.6, 2.6).
import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import { call, defineAppTool, say, toolText } from "@rh/durable-agent";
import { startTestServer, tempDir } from "./helpers.ts";

test("a faux chat round trip answers and the root conversation is reused after restart", async () => {
  const t = tempDir();
  try {
    const first = await startTestServer({ dataDir: t.dir, hub: { fauxRules: [(turn) => say(`hello ${turn.lastUser}`)] } });
    const sent = await first.client.send("world", { waitMs: 10_000 });
    assert.equal(sent.status, "done");
    assert.equal(sent.answer?.text, "hello world");
    const before = (await first.client.agent()).conversationId;
    await first.stop();
    const second = await startTestServer({ dataDir: t.dir });
    try {
      const after = await second.client.agent();
      assert.equal(after.conversationId, before);
      const transcript = (await fetch(`${second.url}/v1/transcript`, {
        headers: { authorization: "Bearer test-api-token-0123456789" },
      }).then((r) => r.json())) as { items: { kind: string; text?: string }[] };
      assert.ok(JSON.stringify(transcript.items).includes("hello world"), "history kept");
    } finally {
      await second.stop();
    }
  } finally {
    t.cleanup();
  }
});

test("a tool outside the allow-list is rejected and never executed", async () => {
  const t = tempDir();
  const marker = join(t.dir, "executed.log");
  const forbidden = defineAppTool({
    name: "forbidden_tool",
    description: "Must never run",
    parameters: Type.Object({}),
    execute: async () => {
      appendFileSync(marker, "ran\n");
      return toolText("ran");
    },
  });
  const server = await startTestServer({
    dataDir: t.dir,
    hub: {
      extensions: [defineExtension({ name: "test-tools", tools: [forbidden] })],
      fauxRules: [
        (turn) => (turn.results.length === 0 ? call("forbidden_tool", {}) : undefined),
        (turn) => say(`result: ${turn.results[0]?.text} error=${turn.results[0]?.isError}`),
      ],
    },
  });
  try {
    const sent = await server.client.send("use the tool", { waitMs: 10_000 });
    assert.equal(sent.status, "done");
    assert.match(sent.answer!.text, /not allowed for research-desk/);
    assert.match(sent.answer!.text, /error=true/);
    assert.equal(existsSync(marker), false, "the tool body never ran");
  } finally {
    await server.stop();
    t.cleanup();
  }
});

test("changing RH_MODEL_CHAT changes the model recorded on the next run", async () => {
  const t = tempDir();
  try {
    const first = await startTestServer({ dataDir: t.dir });
    await first.client.send("one", { waitMs: 10_000 });
    assert.deepEqual((await first.client.runs())[0].models, ["anthropic/claude-haiku-5.5"]);
    await first.stop();
    const second = await startTestServer({ dataDir: t.dir, env: { RH_MODEL_CHAT: "anthropic/claude-sonnet-5.5" } });
    try {
      assert.equal((await second.client.agent()).model, "anthropic/claude-sonnet-5.5");
      await second.client.send("two", { waitMs: 10_000 });
      const [latest] = await second.client.runs();
      assert.equal(latest.text, "two");
      assert.deepEqual(latest.models, ["anthropic/claude-sonnet-5.5"]);
    } finally {
      await second.stop();
    }
  } finally {
    t.cleanup();
  }
});

test("a chat turn produces one run record with tokens, model and cost, and the project total", async () => {
  const server = await startTestServer();
  try {
    await server.client.send("count me", { waitMs: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    const runs = await server.client.runs();
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.equal(run.text, "count me");
    assert.equal(run.status, "done");
    assert.ok(run.inputTokens > 0 && run.outputTokens > 0);
    assert.equal(typeof run.costUsd, "number");
    const detail = await server.client.run(run.id);
    assert.equal(detail.generationList.length, 1);
    const totals = await server.client.usage();
    assert.equal(totals.runs, 1);
    assert.equal(totals.totalUsd, totals.modelUsd + totals.jevUsd + totals.embeddingUsd);
  } finally {
    await server.stop();
  }
});

test("tool results are recorded on their tool call, including errors", async () => {
  const server = await startTestServer({
    hub: { fauxRules: [(t) => (t.results.length ? say("done") : call("missing_tool", {}))] },
  });
  try {
    await server.client.send("call a missing tool", { waitMs: 10_000 });
    await new Promise((r) => setTimeout(r, 200));
    const [run] = await server.client.runs();
    const detail = await server.client.run(run.id);
    assert.equal(detail.toolCallList.length, 1);
    const [c] = detail.toolCallList;
    assert.equal(c.toolName, "missing_tool");
    assert.equal(c.isError, true);
    assert.equal(c.status, "error");
    assert.match(c.result ?? "", /not available/);
    assert.ok(!server.logs.some((l) => l.includes("telemetry.project_failed")), "no projection errors");
  } finally {
    await server.stop();
  }
});
