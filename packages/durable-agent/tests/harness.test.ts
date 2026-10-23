import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createModelCatalog,
  DEFAULT_JOB_MODELS,
  DEFAULT_MODEL,
  installScriptedFaux,
  jobModelsFromEnv,
  say,
} from "../src/index.ts";
import { ask, fauxHarness, tempDir } from "./helpers.ts";

test("job defaults resolve in pi-ai 1.1.0's OpenRouter list with window and price", () => {
  assert.equal(DEFAULT_MODEL, "anthropic/claude-haiku-5.5");
  assert.equal(DEFAULT_JOB_MODELS.review, "anthropic/claude-sonnet-5.5");
  const catalog = createModelCatalog({ provider: "openrouter" });
  assert.deepEqual(catalog.defaultModel, {
    provider: "openrouter",
    modelId: "anthropic/claude-haiku-5.5",
  });
  assert.deepEqual(catalog.forJob("review"), {
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-5.5",
  });
  const list = catalog.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].contextWindow, 1_000_000);
  assert.throws(() => catalog.ref("made/up-model"), /Unknown model/);
});

test("RH_MODEL_* configure each job; an unknown OpenRouter ID fails at startup", () => {
  const jobs = jobModelsFromEnv({ RH_MODEL_CHAT: "anthropic/claude-sonnet-5.5" });
  assert.equal(jobs.chat, "anthropic/claude-sonnet-5.5");
  assert.equal(jobs.desk, DEFAULT_JOB_MODELS.desk);
  const catalog = createModelCatalog({ provider: "openrouter", jobs });
  assert.equal(catalog.forJob("chat").modelId, "anthropic/claude-sonnet-5.5");
  assert.throws(
    () => createModelCatalog({ provider: "openrouter", jobs: { chat: "made/up-model" } }),
    /not in pi-ai's OpenRouter list: made\/up-model/,
  );
});

test("the faux catalog mirrors the configured IDs", () => {
  const catalog = createModelCatalog({
    provider: "faux",
    jobs: { chat: "x/custom-chat" },
    installFaux: (models, modelIds) => installScriptedFaux(models, [], { modelIds }),
  });
  assert.deepEqual(catalog.forJob("chat"), { provider: "faux", modelId: "x/custom-chat" });
  assert.ok(catalog.list().some((m) => m.id === "x/custom-chat"));
});

test("the harness stores in WAL, answers on the faux model, and offers no bash or file tools", async () => {
  const t = tempDir();
  try {
    const { ctx, root, close } = await fauxHarness(
      t.dir,
      [(turn) => say(`hello ${turn.lastUser}`)],
      [],
    );
    const settled = await ask(root, ctx, "world");
    assert.equal(settled.status, "done");
    const agent = await root.agent(ctx);
    assert.deepEqual(
      agent.tools.map((x) => x.name),
      [],
    );
    const db = new DatabaseSync(join(t.dir, "agent.sqlite"));
    assert.equal((db.prepare("PRAGMA journal_mode").get() as any).journal_mode, "wal");
    db.close();
    await close();
  } finally {
    t.cleanup();
  }
});

test("a second process cannot open the same agent database", async () => {
  const t = tempDir();
  try {
    const first = await fauxHarness(t.dir, [], []);
    const other = spawnSync(
      process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "fixtures/host.ts"), t.dir, "resume"],
      { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /already owned by process/);
    await first.close();
  } finally {
    t.cleanup();
  }
});
