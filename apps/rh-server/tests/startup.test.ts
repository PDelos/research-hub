// Spec deployment: fail closed in live mode, offline mode needs no keys (task 3.1).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { startTestServer, tempDir } from "./test-server.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");

test("live mode without OPENROUTER_API_KEY fails with the variable named", () => {
  assert.throws(
    () => loadConfig({ RH_MODE: "live" } as NodeJS.ProcessEnv),
    (e: unknown) => e instanceof ConfigError && e.variable === "OPENROUTER_API_KEY",
  );
});

test("the server process exits non-zero and logs OPENROUTER_API_KEY when it is missing in live mode", () => {
  const temp = tempDir();
  try {
    const env = { ...process.env, RH_ENV_FILE: "none", RH_MODE: "live", RH_DATA_DIR: temp.dir, NODE_NO_WARNINGS: "1" };
    delete (env as Record<string, unknown>).OPENROUTER_API_KEY;
    const run = spawnSync(process.execPath, ["--import", "tsx", MAIN], { env, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(run.status, 0);
    const line = run.stdout.split("\n").find((l) => l.includes("config.invalid"));
    assert.ok(line, `no config.invalid line in: ${run.stdout}${run.stderr}`);
    assert.equal(JSON.parse(line).variable, "OPENROUTER_API_KEY");
  } finally {
    temp.cleanup();
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
  assert.throws(
    () => loadConfig({ RH_MODE: "turbo" } as NodeJS.ProcessEnv),
    (e: any) => e.variable === "RH_MODE",
  );
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

test("paper settings: defaults, validation, and the S2 key counted as a secret", async () => {
  const { secretsOf } = await import("../src/config.ts");
  const config = loadConfig({ RH_MODE: "offline" } as NodeJS.ProcessEnv);
  assert.deepEqual(config.papers, {
    contactEmail: undefined,
    embedModel: "qwen/qwen3-embedding-8b",
    embedDims: 1024,
    s2ApiKey: undefined,
  });
  assert.throws(
    () => loadConfig({ RH_MODE: "offline", RH_EMBED_DIMS: "10" } as NodeJS.ProcessEnv),
    (e: any) => e.variable === "RH_EMBED_DIMS",
  );
  assert.throws(
    () => loadConfig({ RH_MODE: "offline", RH_EMBED_DIMS: "1024.5" } as NodeJS.ProcessEnv),
    (e: any) => e.variable === "RH_EMBED_DIMS",
  );
  assert.throws(
    () => loadConfig({ RH_MODE: "offline", CONTACT_EMAIL: "nobody" } as NodeJS.ProcessEnv),
    (e: any) => e.variable === "CONTACT_EMAIL",
  );
  const set = loadConfig({
    RH_MODE: "offline",
    CONTACT_EMAIL: "me@example.org",
    RH_MODEL_EMBED: "openai/text-embedding-3-small",
    RH_EMBED_DIMS: "512",
    S2_API_KEY: "s2-secret-key-123",
  } as NodeJS.ProcessEnv);
  assert.equal(set.papers.contactEmail, "me@example.org");
  assert.equal(set.papers.embedModel, "openai/text-embedding-3-small");
  assert.equal(set.papers.embedDims, 512);
  assert.ok(secretsOf(set).includes("s2-secret-key-123"));
});

test("without CONTACT_EMAIL the server warns once at startup and continues", async () => {
  const { createServer } = await import("node:net");
  const { spawn } = await import("node:child_process");
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
  const port = (blocker.address() as { port: number }).port;
  const temp = tempDir();
  try {
    // The port is taken, so the process gets past the warning and stops at the port check without serving.
    const env = {
      ...process.env,
      RH_ENV_FILE: "none",
      RH_MODE: "offline",
      RH_DATA_DIR: temp.dir,
      RH_PORT: String(port),
      NODE_NO_WARNINGS: "1",
    };
    delete (env as Record<string, unknown>).CONTACT_EMAIL;
    const child = spawn(process.execPath, ["--import", "tsx", MAIN], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    await new Promise((r) => child.on("exit", r));
    const warnings = out.split("\n").filter((l) => l.includes("config.contact_email_missing"));
    assert.equal(warnings.length, 1, out);
    assert.ok(out.includes("startup.port_in_use") || out.includes("is in use"), out);
  } finally {
    blocker.close();
    temp.cleanup();
  }
});
