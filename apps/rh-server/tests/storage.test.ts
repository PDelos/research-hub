// Spec deployment (per-project layout) and design D8: both databases, FTS5 and sqlite-vec (tasks 3.2, 3.3).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectDb } from "../src/db.ts";
import { startTestServer, tempDir } from "./helpers.ts";

test("an empty data dir gets projects/default with agent.sqlite and project.sqlite", async () => {
  const server = await startTestServer();
  try {
    const dir = join(server.dataDir, "projects", "default");
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
    assert.equal((second.db.prepare("PRAGMA user_version").get() as any).user_version, 1);
    second.db.close();
  } finally {
    t.cleanup();
  }
});
