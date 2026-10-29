// Spec deployment + design D4/D11: one project per container, and containers never interfere
// (tasks 8.1, 8.3, 8.4, 8.5, 8.6).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import { acquireOwner, DataDirOwned, STALE_MS } from "../src/owner.ts";
import { PortInUse, startServer } from "../src/server.ts";
import { startTestServer, tempDir, TOKEN } from "./helpers.ts";

const HOST = join(import.meta.dirname, "fixtures/server-host.ts");

test("8.1 an existing projects/default folder moves to the data root with its conversation and runs", async () => {
  const t = tempDir();
  try {
    const first = await startTestServer({ dataDir: t.dir });
    await first.client.send("from the old layout", { waitMs: 10_000 });
    const conversation = (await first.client.agent()).conversationId;
    await first.stop();
    // Recreate the v0.0 layout: everything under projects/default/.
    const legacy = join(t.dir, "projects", "default");
    mkdirSync(legacy, { recursive: true });
    for (const f of readdirSync(t.dir)) if (f !== "projects") renameSync(join(t.dir, f), join(legacy, f));
    const second = await startTestServer({ dataDir: t.dir });
    try {
      assert.ok(existsSync(join(t.dir, "agent.sqlite")) && existsSync(join(t.dir, "project.sqlite")));
      assert.equal(existsSync(join(t.dir, "projects")), false, "the legacy folder is gone");
      assert.equal((await second.client.agent()).conversationId, conversation);
      assert.equal((await second.client.runs())[0].text, "from the old layout");
    } finally {
      await second.stop();
    }
  } finally {
    t.cleanup();
  }
});

test("8.3 RH_PROJECT_NAME is validated and appears in health, info, the page title and every log line", async () => {
  for (const bad of ["Proteins", "-x", "x-", "a".repeat(41), "has space"])
    assert.throws(
      () => loadConfig({ RH_MODE: "offline", RH_PROJECT_NAME: bad } as NodeJS.ProcessEnv),
      (e: unknown) => e instanceof ConfigError && e.variable === "RH_PROJECT_NAME",
      bad,
    );
  const server = await startTestServer({
    env: { RH_PROJECT_NAME: "proteins", RH_UI_DIR: join(import.meta.dirname, "../../rh-client-browser/dist") },
  });
  try {
    assert.equal((await server.client.health()).project, "proteins");
    assert.equal((await server.client.info()).project, "proteins");
    assert.match(await (await fetch(`${server.url}/`)).text(), /<title>proteins · Research Hub<\/title>/);
    await server.client.send("log me", { waitMs: 10_000 });
    assert.ok(server.logs.length > 3);
    for (const line of server.logs) assert.equal(JSON.parse(line).project, "proteins", line);
  } finally {
    await server.stop();
  }
});

test("8.4 a second server on an owned data directory exits naming the owner", { timeout: 60_000 }, async () => {
  const t = tempDir();
  const port = 5000 + Math.floor(Math.random() * 400);
  const owner = spawn(process.execPath, ["--import", "tsx", HOST, t.dir, String(port)], {
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((r) => owner.on("exit", () => r()));
  try {
    await new Promise<void>((resolve, reject) => {
      owner.stdout.once("data", () => resolve());
      owner.once("exit", (c) => reject(new Error(`owner exited ${c}`)));
    });
    await assert.rejects(
      startTestServer({ dataDir: t.dir }),
      (e: unknown) =>
        e instanceof DataDirOwned && e.owner.pid === owner.pid && /in use by project "research"/.test(e.message),
    );
  } finally {
    owner.kill("SIGTERM");
    await exited;
    t.cleanup();
  }
});

test("8.4 lock rules: fresh foreign lock refuses, stale or dead-on-this-host lock is taken over", () => {
  const t = tempDir();
  try {
    const write = (record: object) => writeFileSync(join(t.dir, ".owner"), JSON.stringify(record));
    const base = { project: "other", pid: 4242, startedAt: new Date().toISOString() };
    write({ ...base, host: "another-container", heartbeat: Date.now() });
    assert.throws(() => acquireOwner(t.dir, "research"), DataDirOwned);
    write({ ...base, host: "another-container", heartbeat: Date.now() - STALE_MS - 1000 });
    acquireOwner(t.dir, "research").release();
    write({ ...base, host: hostname(), pid: 2 ** 22 + 7, heartbeat: Date.now() });
    const lock = acquireOwner(t.dir, "research");
    assert.equal(lock.record.pid, process.pid, "a dead process on this host does not block");
    lock.release();
    assert.equal(existsSync(join(t.dir, ".owner")), false, "released on clean shutdown");
  } finally {
    t.cleanup();
  }
});

test("8.4 the heartbeat renews the lock", async () => {
  const t = tempDir();
  try {
    const lock = acquireOwner(t.dir, "research", { heartbeatMs: 30 });
    const first = lock.record.heartbeat;
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(lock.record.heartbeat > first);
    lock.release();
  } finally {
    t.cleanup();
  }
});

test("8.5 a taken port gives the one-line message and releases the data directory", async () => {
  const first = await startTestServer();
  const t = tempDir();
  try {
    const config = loadConfig({
      RH_MODE: "offline",
      RH_DATA_DIR: t.dir,
      RH_API_TOKEN: TOKEN,
      RH_PORT: String(first.port),
    } as NodeJS.ProcessEnv);
    await assert.rejects(
      startServer(config, createLogger({ write: () => {} })),
      (e: unknown) =>
        e instanceof PortInUse &&
        e.message === `port ${first.port} is in use; set RH_PUBLISH_PORT (compose) or RH_PORT to a free port`,
    );
    assert.equal(existsSync(join(t.dir, ".owner")), false, "the failed start released its lock");
  } finally {
    await first.stop();
    t.cleanup();
  }
});

test("8.6 the UI proxy answers <name>.localhost and refuses other projects' host names", async () => {
  const server = await startTestServer({ env: { RH_PROJECT_NAME: "proteins" } });
  try {
    const url = new URL(`${server.url}/ui/v1/info`);
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const request = http.get(
          { host: url.hostname, port: url.port, path: url.pathname, headers: { host } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
      });
    assert.equal(await status("proteins.localhost:4850"), 200);
    assert.equal(await status("genomics.localhost:4860"), 421);
  } finally {
    await server.stop();
  }
});

test("8.5 the entry point exits with one startup.port_in_use log line, not a stack trace", async () => {
  const first = await startTestServer();
  const t = tempDir();
  try {
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../src/main.ts")], {
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        RH_ENV_FILE: "none",
        RH_MODE: "offline",
        RH_DATA_DIR: t.dir,
        RH_PORT: String(first.port),
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(run.status, 1);
    assert.equal(run.stderr.trim(), "", `no stack trace: ${run.stderr}`);
    const line = run.stdout.split("\n").find((l) => l.includes("startup.port_in_use"));
    assert.ok(line, run.stdout);
    assert.match(JSON.parse(line).message, /^port \d+ is in use; set RH_PUBLISH_PORT/);
  } finally {
    await first.stop();
    t.cleanup();
  }
});
