// Spec deployment (health, authenticated API) and agent-runtime (chat, queueing) (tasks 4.1, 4.2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { say } from "@rh/durable-agent";
import { startTestServer, TOKEN } from "./test-server.ts";

test("/v1/health is open and carries version, mode and providers but no secrets", async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.url}/v1/health`);
    assert.equal(response.status, 200);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), ["mode", "ok", "project", "providers", "version"]);
    assert.equal(body.project, "research");
    assert.ok(!text.includes(TOKEN));
  } finally {
    await server.stop();
  }
});

test("every other route needs a valid token", async () => {
  const server = await startTestServer();
  try {
    for (const path of ["/v1/info", "/v1/agent", "/v1/runs", "/v1/stream"]) {
      assert.equal((await fetch(`${server.url}${path}`)).status, 401, path);
      const wrong = await fetch(`${server.url}${path}`, { headers: { authorization: "Bearer nope" } });
      assert.equal(wrong.status, 401, `${path} with a wrong token`);
    }
    const chat = await fetch(`${server.url}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    assert.equal(chat.status, 401);
    assert.equal((await server.client.info()).project, "research");
  } finally {
    await server.stop();
  }
});

test("an unknown route is a 404 and the old project-scoped routes are gone", async () => {
  const server = await startTestServer();
  try {
    for (const path of ["/v1/nope", "/v1/p/default/agent"]) {
      const response = await fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(response.status, 404, path);
    }
  } finally {
    await server.stop();
  }
});

test("chat is accepted with 202; a message sent while busy is queued, never dropped, and answered after", async () => {
  const server = await startTestServer({
    hub: { fauxTokensPerSecond: 40, fauxRules: [(turn) => say(`answer to ${turn.lastUser} ${"word ".repeat(30)}`)] },
  });
  try {
    const raw = await fetch(`${server.url}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ content: "first" }),
    });
    assert.equal(raw.status, 202);
    const first = (await raw.json()) as { submissionId: number };
    const second = await server.client.send("second");
    assert.equal(second.status, "queued");
    const done = await server.client.send("third", { waitMs: 60_000 });
    assert.equal(done.status, "done");
    const runs = (await server.client.runs()).reverse();
    assert.deepEqual(
      runs.map((r) => r.text),
      ["first", "second", "third"],
    );
    assert.ok(
      runs.every((r) => r.status === "done"),
      JSON.stringify(runs.map((r) => r.status)),
    );
    assert.ok(first.submissionId < second.submissionId);
  } finally {
    await server.stop();
  }
});

test("bad chat bodies are 400s", async () => {
  const server = await startTestServer();
  try {
    for (const body of [{}, { content: "" }, { content: 5 }, { content: "x", waitMs: -1 }]) {
      const response = await fetch(`${server.url}/v1/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  } finally {
    await server.stop();
  }
});
