// Spec agent-runtime: live event stream, snapshot then deltas, viewers in sync, refresh mid-reply (task 4.3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { say } from "@rh/durable-agent";
import { AgentModel, type Frame, type HubClient } from "@rh/sdk";
import { startTestServer, until } from "./helpers.ts";

/** Follow a project's stream into an AgentModel until stop() is called. */
function follow(client: HubClient) {
  const model = new AgentModel();
  const frames: Frame[] = [];
  const abort = new AbortController();
  const done = (async () => {
    try {
      for await (const frame of client.stream(abort.signal)) {
        frames.push(frame);
        if (frame.type === "hello") model.conversationId = frame.mainConversationId;
        model.apply(frame);
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  return { model, frames, stop: async () => (abort.abort(), done) };
}

const text = (m: AgentModel) => JSON.stringify(m.state.items);

test("a stream starts with hello and a snapshot, then two viewers see the same message and reply", async () => {
  const server = await startTestServer({ hub: { fauxRules: [(t) => say(`echo ${t.lastUser}`)] } });
  const a = follow(server.client);
  const b = follow(server.client);
  try {
    await until(() => a.model.state.ready && b.model.state.ready, 10_000, "snapshots");
    assert.equal(a.frames[0].type, "hello");
    assert.equal(a.frames[1].type, "agent.snapshot");
    await server.client.send("sync me");
    await until(() => text(a.model).includes("echo sync me") && text(b.model).includes("echo sync me"), 10_000, "both replies");
    assert.ok(text(a.model).includes("sync me"));
    assert.ok(a.frames.some((f) => f.type === "agent.state"));
    assert.ok(a.frames.some((f) => f.type === "usage"));
  } finally {
    await a.stop();
    await b.stop();
    await server.stop();
  }
});

test("a viewer that connects mid-reply gets the partial reply in its snapshot, then the rest", async () => {
  const long = "token ".repeat(80).trim();
  const server = await startTestServer({ hub: { fauxTokensPerSecond: 60, fauxRules: [() => say(long)] } });
  const first = follow(server.client);
  try {
    await until(() => first.model.state.ready, 10_000, "first snapshot");
    await server.client.send("talk slowly");
    await until(() => first.model.state.generating, 10_000, "generation started");
    await first.stop();
    // The "refresh": a new viewer while the server keeps generating.
    const second = follow(server.client);
    try {
      await until(() => second.model.state.ready, 10_000, "second snapshot");
      const snapshot = second.frames.find((f) => f.type === "agent.snapshot") as Extract<Frame, { type: "agent.snapshot" }>;
      assert.ok(snapshot.snapshot.run, "the run is still active at reconnect");
      await until(() => text(second.model).includes(long), 30_000, "the full reply");
      assert.equal(second.model.state.generating, false);
    } finally {
      await second.stop();
    }
  } finally {
    await server.stop();
  }
});

test("closing every viewer never aborts the agent's work", async () => {
  const server = await startTestServer({ hub: { fauxTokensPerSecond: 80, fauxRules: [() => say("finished ".repeat(40))] } });
  try {
    const viewer = follow(server.client);
    await until(() => viewer.model.state.ready, 10_000, "snapshot");
    const sent = await server.client.send("keep going");
    await viewer.stop();
    await until(async () => (await server.client.runs())[0]?.status === "done", 30_000, "run done");
    assert.ok(sent.submissionId > 0);
  } finally {
    await server.stop();
  }
});
