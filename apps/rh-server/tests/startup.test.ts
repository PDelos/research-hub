// Spec deployment: fail closed in live mode, offline mode needs no keys (task 3.1).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { startTestServer, tempDir } from "./helpers.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");

test("live mode without OPENROUTER_API_KEY fails with the variable named", () => {
  assert.throws(
    () => loadConfig({ RH_MODE: "live" } as NodeJS.ProcessEnv),
    (e: unknown) => e instanceof ConfigError && e.variable === "OPENROUTER_API_KEY",
  );
});

test("the server process exits non-zero and logs OPENROUTER_API_KEY when it is missing in live mode", () => {
  const t = tempDir();
  try {
    const env = { ...process.env, RH_ENV_FILE: "none", RH_MODE: "live", RH_DATA_DIR: t.dir, NODE_NO_WARNINGS: "1" };
    delete (env as Record<string, unknown>).OPENROUTER_API_KEY;
    const run = spawnSync(process.execPath, ["--import", "tsx", MAIN], { env, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(run.status, 0);
    const line = run.stdout.split("\n").find((l) => l.includes("config.invalid"));
    assert.ok(line, `no config.invalid line in: ${run.stdout}${run.stderr}`);
    assert.equal(JSON.parse(line).variable, "OPENROUTER_API_KEY");
  } finally {
    t.cleanup();
  }
});

test("offline mode starts with no keys and reports faux model and mock Jev", async () => {
  const server = await startTestServer();
  try {
    const health = await server.client.health();
    assert.deepEqual(health.providers, { models: "faux", jev: "mock" });
    assert.equal(health.mode, "offline");
  } finally {
    await server.stop();
  }
});

test("invalid RH_MODE and RH_PORT are rejected with the variable named", () => {
  assert.throws(() => loadConfig({ RH_MODE: "turbo" } as NodeJS.ProcessEnv), (e: any) => e.variable === "RH_MODE");
  assert.throws(
    () => loadConfig({ RH_MODE: "offline", RH_PORT: "99999" } as NodeJS.ProcessEnv),
    (e: any) => e.variable === "RH_PORT",
  );
});

test("relative data and UI paths resolve against the repository root", () => {
  const root = join(import.meta.dirname, "../../..");
  const config = loadConfig({ RH_MODE: "offline", RH_DATA_DIR: "./data" } as NodeJS.ProcessEnv);
  assert.equal(config.dataDir, join(root, "data"));
  assert.equal(config.uiDir, join(root, "apps/rh-client-browser/dist"));
  assert.equal(loadConfig({ RH_MODE: "offline", RH_DATA_DIR: "/data" } as NodeJS.ProcessEnv).dataDir, "/data");
});
