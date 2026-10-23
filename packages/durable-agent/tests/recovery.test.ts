import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir, until } from "./helpers.ts";

const HOST = join(import.meta.dirname, "fixtures/host.ts");

function host(dir: string, args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", HOST, dir, ...args], {
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) =>
    child.on("exit", (code) => resolve({ code, out, err })),
  );
  return { child, done };
}

const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];

test("SIGKILL mid-tool: a replay-safe tool reruns once, its memoized effect is not repeated", async () => {
  const t = tempDir();
  try {
    const effects = join(t.dir, "effects.log");
    const first = host(t.dir, ["submit", "r1", "safe"], { SLOW_MS: "4000" });
    await until(() => lines(effects).length === 1, 15000, "effect applied");
    first.child.kill("SIGKILL");
    await first.done;
    const second = await host(t.dir, ["resume"], { SLOW_MS: "200" }).done;
    assert.equal(second.code, 0, second.err);
    const report = JSON.parse(second.out.trim().split("\n").at(-1)!);
    assert.equal(lines(effects).length, 1, "the effect ran once");
    assert.deepEqual(report.results, [
      { name: "slow_safe", isError: false, text: "safe finished" },
    ]);
    assert.match(report.answers.at(-1), /result: safe finished/);
  } finally {
    t.cleanup();
  }
});

test("SIGKILL mid-tool: an unsafe tool comes back interrupted, never rerun", async () => {
  const t = tempDir();
  try {
    const effects = join(t.dir, "effects.log");
    const first = host(t.dir, ["submit", "r1", "unsafe"], { SLOW_MS: "4000" });
    await until(() => lines(effects).length === 1, 15000, "effect applied");
    first.child.kill("SIGKILL");
    await first.done;
    const second = await host(t.dir, ["resume"], { SLOW_MS: "200" }).done;
    assert.equal(second.code, 0, second.err);
    const report = JSON.parse(second.out.trim().split("\n").at(-1)!);
    assert.equal(lines(effects).length, 1);
    assert.equal(report.results[0].isError, true);
    assert.match(report.results[0].text, /interrupted/);
  } finally {
    t.cleanup();
  }
});

test("SIGKILL while subagents run: the replay finds the same two children", async () => {
  const t = tempDir();
  try {
    const effects = join(t.dir, "effects.log");
    const first = host(t.dir, ["submit", "r1", "spawn"], { SLOW_MS: "4000" });
    await until(() => lines(effects).length === 2, 20000, "both children started their tool");
    first.child.kill("SIGKILL");
    await first.done;
    const second = await host(t.dir, ["resume"], { SLOW_MS: "200" }).done;
    assert.equal(second.code, 0, second.err);
    const report = JSON.parse(second.out.trim().split("\n").at(-1)!);
    assert.equal(report.conversations, 3, "root plus the same two children");
    assert.equal(lines(effects).length, 2, "each child's effect ran once");
    assert.match(report.results[0].text, /child task 0 done \| \d+:child task 1 done/);
  } finally {
    t.cleanup();
  }
});
