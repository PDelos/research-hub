// Spec agent-runtime: context compaction. Lowered points so a few faux turns cross them (task 4.5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { say } from "@rh/durable-agent";
import type { Frame, WireAgentEvent } from "@rh/sdk";
import { startTestServer, until, type TestServer } from "./test-server.ts";

function watch(server: TestServer) {
  const events: WireAgentEvent[] = [];
  const abort = new AbortController();
  const done = (async () => {
    try {
      for await (const f of server.client.stream(abort.signal) as AsyncGenerator<Frame>)
        if (f.type === "agent.batch") events.push(...f.events);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  return { events, stop: async () => (abort.abort(), done) };
}

const filler = (n: number) => `${"protein language models embed sequences ".repeat(n)}`.trim();

test("crossing the background point compacts without blocking the next message", { timeout: 120_000 }, async () => {
  const server = await startTestServer({ hub: { fauxRules: [(t) => say(`noted ${t.lastUser.length}`)] } });
  const watcher = watch(server);
  try {
    const project = server.hub.project;
    project.setCompaction({ points: { background: 4096, force: 60_000 } });
    for (let i = 0; i < 6; i++) await server.client.send(filler(120), { waitMs: 30_000 });
    await until(() => watcher.events.some((e) => e.type === "compaction_start"), 30_000, "a compaction started");
    const start = watcher.events.find((e) => e.type === "compaction_start") as Extract<
      WireAgentEvent,
      { type: "compaction_start" }
    >;
    assert.equal(start.blocking, false, "background compaction");
    const next = await server.client.send("still there?", { waitMs: 30_000 });
    assert.equal(next.status, "done");
    await until(() => watcher.events.some((e) => e.type === "compaction_end"), 30_000, "compaction finished");
    const after = await server.client.send("and now?", { waitMs: 30_000 });
    assert.equal(after.status, "done");
    const runs = await server.client.runs(20);
    const peak = Math.max(...runs.filter((r) => r.text.startsWith("protein")).map((r) => r.inputTokens));
    assert.ok(
      runs[0].inputTokens < peak,
      `after compaction a turn reads less context (${runs[0].inputTokens} < ${peak})`,
    );
  } finally {
    await watcher.stop();
    await server.stop();
  }
});

test("at the force point the next turn waits for compaction, then proceeds", { timeout: 120_000 }, async () => {
  const server = await startTestServer({ hub: { fauxRules: [(t) => say(`noted ${t.lastUser.length}`)] } });
  const watcher = watch(server);
  try {
    const project = server.hub.project;
    project.setCompaction({ points: { background: 4096, force: 5120 } });
    for (let i = 0; i < 4; i++) await server.client.send(filler(150), { waitMs: 30_000 });
    const sent = await server.client.send("after the force point", { waitMs: 60_000 });
    assert.equal(sent.status, "done");
    const starts = watcher.events.filter((e) => e.type === "compaction_start") as Extract<
      WireAgentEvent,
      { type: "compaction_start" }
    >[];
    assert.ok(
      starts.some((s) => s.blocking),
      `a blocking compaction ran: ${JSON.stringify(starts)}`,
    );
  } finally {
    await watcher.stop();
    await server.stop();
  }
});
