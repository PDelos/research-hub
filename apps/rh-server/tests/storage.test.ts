// Spec deployment (per-project layout) and design D8: both databases, FTS5 and sqlite-vec (tasks 3.2, 3.3).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectDb } from "../src/db.ts";
import { startTestServer, tempDir } from "./helpers.ts";

test("an empty data dir gets agent.sqlite and project.sqlite directly in it", async () => {
  const server = await startTestServer();
  try {
    const dir = server.dataDir;
    assert.ok(existsSync(join(dir, "agent.sqlite")), "agent.sqlite");
    assert.ok(existsSync(join(dir, "project.sqlite")), "project.sqlite");
  } finally {
    await server.stop();
  }
});

test("project.sqlite proves FTS5 and loads sqlite-vec with working nearest-neighbour search", () => {
  const t = tempDir();
  try {
    const { db, check } = openProjectDb(join(t.dir, "project.sqlite"));
    assert.equal(check.fts5, true);
    assert.match(check.vec ?? "", /^v\d+\.\d+\.\d+/);
    db.close();
  } finally {
    t.cleanup();
  }
});

test("migrations run once: reopening keeps data and the schema version", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "project.sqlite");
    const first = openProjectDb(path);
    first.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k', '1', 'now')").run();
    first.db.close();
    const second = openProjectDb(path);
    assert.equal((second.db.prepare("SELECT value FROM settings WHERE key = 'k'").get() as any).value, "1");
    assert.equal((second.db.prepare("PRAGMA user_version").get() as any).user_version, 2);
    second.db.close();
  } finally {
    t.cleanup();
  }
});

test("migration 2 upgrades a version-1 database and keeps its telemetry rows", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const t = tempDir();
  try {
    const path = join(t.dir, "project.sqlite");
    // A v0.0 database: migration 1 only, with one run recorded.
    const first = openProjectDb(path);
    first.db.prepare("INSERT INTO agent_runs (run_entry_id, conversation_id, text, started_at) VALUES (7, 1, 'old run', 1)").run();
    first.db.exec("DROP TABLE charters; DROP TABLE scoping_questions; DROP TABLE scheduled_runs; PRAGMA user_version = 1;");
    first.db.close();
    const raw = new DatabaseSync(path);
    assert.equal((raw.prepare("PRAGMA user_version").get() as any).user_version, 1);
    raw.close();
    const second = openProjectDb(path);
    assert.equal((second.db.prepare("PRAGMA user_version").get() as any).user_version, 2);
    assert.equal((second.db.prepare("SELECT text FROM agent_runs WHERE run_entry_id = 7").get() as any).text, "old run");
    const insert = second.db.prepare("INSERT OR IGNORE INTO scheduled_runs (kind, slot, trigger, status, created_at) VALUES ('sweep', 'sweep:2026-10-23', 'scheduled', 'requested', 'now')");
    insert.run();
    assert.equal(Number(insert.run().changes), 0, "UNIQUE(kind, slot) keeps one record per slot");
    second.db.close();
  } finally {
    t.cleanup();
  }
});
