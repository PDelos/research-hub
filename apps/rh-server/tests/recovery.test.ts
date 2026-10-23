// Spec agent-runtime: durable turns. SIGKILL the server mid-turn, restart it on the same data, and the turn
// completes once: one user message, one reply, no duplicated messages or tool results (task 4.4).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { HubClient } from "@rh/sdk";
import { TOKEN, tempDir, until } from "./helpers.ts";

const HOST = join(import.meta.dirname, "fixtures/server-host.ts");

function host(dataDir: string, port: number, tps: number) {
  const child = spawn(process.execPath, ["--import", "tsx", HOST, dataDir, String(port)], {
    env: { ...process.env, NODE_NO_WARNINGS: "1", FAUX_TPS: String(tps) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const url = new Promise<string>((resolve, reject) => {
    child.stdout.once("data", (d) => resolve(String(d).trim()));
    child.once("exit", (code) => reject(new Error(`host exited ${code}: ${err}`)));
  });
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return { child, url, exited, err: () => err };
}

test("SIGKILL mid-turn: after restart the turn completes once with no duplicates", { timeout: 120_000 }, async () => {
  const t = tempDir();
  const port = 4900 + Math.floor(Math.random() * 500);
  try {
    // Slow faux model: the echo reply streams for several seconds, so the kill lands mid-generation.
    const first = host(t.dir, port, 3);
    const client = new HubClient({ base: `${await first.url}/v1`, token: TOKEN });
    const sent = await client.send("survive this crash please, it is a long message to echo back");
    assert.notEqual(sent.status, "done");
    await until(async () => (await client.agent()).busy, 10_000, "turn running");
    await new Promise((r) => setTimeout(r, 500));
    first.child.kill("SIGKILL");
    await first.exited;

    const second = host(t.dir, port, 2000);
    try {
      const client2 = new HubClient({ base: `${await second.url}/v1`, token: TOKEN });
      await until(async () => (await client2.runs())[0]?.status === "done", 60_000, "turn completed after restart");
      const res = await fetch(`${await second.url}/v1/transcript`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const { items } = (await res.json()) as {
        items: { kind: string; text?: string; blocks?: { text?: string }[]; error?: string }[];
      };
      const all = JSON.stringify(items, null, 1);
      const users = items.filter((i) => i.kind === "user");
      const assistants = items.filter((i) => i.kind === "assistant");
      const complete = assistants.filter((i) => (i.blocks ?? []).some((b) => b.text?.startsWith("Echo: survive")));
      const interrupted = assistants.filter((i) => /Interrupted/.test(i.error ?? ""));
      assert.equal(users.length, 1, `one user message: ${all}`);
      assert.equal(complete.length, 1, `exactly one complete reply: ${all}`);
      assert.ok(interrupted.length <= 1, `at most one interrupted marker: ${all}`);
      assert.equal(assistants.length, complete.length + interrupted.length, `nothing else: ${all}`);
      for (const i of interrupted) assert.equal((i.blocks ?? []).length, 0, "the marker carries no duplicated text");
      const runs = await client2.runs();
      assert.equal(runs.length, 1, "one run");
      assert.equal(runs[0].status, "done");
    } finally {
      second.child.kill("SIGTERM");
      await second.exited;
    }
  } finally {
    t.cleanup();
  }
});
