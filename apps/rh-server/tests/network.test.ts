// Spec deployment: offline mode makes no outbound requests during startup, chat and a Jev ping (task 4.6).
// Node's diagnostics channels report every fetch connection and every http.request; only loopback (our own test
// server) is allowed.
import assert from "node:assert/strict";
import dc from "node:diagnostics_channel";
import http from "node:http";
import { test } from "node:test";
import { startTestServer } from "./helpers.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function guard() {
  const outbound: string[] = [];
  const onConnect = ({ connectParams }: any) => {
    if (!LOOPBACK.has(String(connectParams?.hostname))) outbound.push(`fetch ${connectParams?.hostname}`);
  };
  const onHttp = ({ request }: any) => {
    const host = String(request?.host ?? "").split(":")[0];
    if (!LOOPBACK.has(host)) outbound.push(`http ${host}`);
  };
  dc.subscribe("undici:client:beforeConnect", onConnect);
  dc.subscribe("http.client.request.start", onHttp);
  return {
    outbound,
    stop() {
      dc.unsubscribe("undici:client:beforeConnect", onConnect);
      dc.unsubscribe("http.client.request.start", onHttp);
    },
  };
}

test("the guard sees outbound fetch and http.request attempts", async () => {
  const g = guard();
  try {
    await fetch("https://example.invalid/", { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    await new Promise<void>((resolve) => {
      const req = http.get("http://example.invalid/", () => resolve());
      req.on("error", () => resolve());
    });
  } finally {
    g.stop();
  }
  assert.deepEqual(g.outbound.sort(), ["fetch example.invalid", "http example.invalid"]);
});

test("offline mode with no keys makes zero outbound connections", async () => {
  const g = guard();
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const server = await startTestServer();
    try {
      const sent = await server.client.send("default", "hello offline", { waitMs: 10_000 });
      assert.equal(sent.status, "done");
      const ping = await server.client.jevPing("default");
      assert.equal(ping.provider, "mock");
      assert.equal(typeof ping.model, "string");
      assert.equal(ping.cost.source, "mock");
      assert.ok(ping.greeting >= 0 && ping.greeting <= 1);
      assert.deepEqual((await server.client.info()).providers, { models: "faux", jev: "mock" });
    } finally {
      await server.stop();
    }
  } finally {
    g.stop();
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
  }
  assert.deepEqual(g.outbound, [], `outbound connections: ${g.outbound.join(", ")}`);
});
