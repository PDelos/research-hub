// The database lock records "<hostname> <pid>": a lock from another host (container) is stale, a live process on
// this host still blocks, and bare-pid locks from older versions are read.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lockFile } from "../src/lock.ts";
import { tempDir } from "./helpers.ts";

test("locks record host and pid, and release removes them", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "db.lock");
    const release = lockFile(path);
    release();
    lockFile(path)();
  } finally {
    t.cleanup();
  }
});

test("a lock from another host is taken over even if that pid is alive here", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "db.lock");
    writeFileSync(path, `some-other-container ${process.ppid}`);
    lockFile(path)();
  } finally {
    t.cleanup();
  }
});

test("a live process on this host blocks; a legacy bare pid is still understood", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "db.lock");
    writeFileSync(path, `${hostname()} ${process.ppid}`);
    assert.throws(() => lockFile(path), /already owned by process/);
    writeFileSync(path, String(process.ppid));
    assert.throws(() => lockFile(path), /already owned by process/);
    writeFileSync(path, `${hostname()} ${2 ** 22 + 7}`);
    lockFile(path)();
  } finally {
    t.cleanup();
  }
});
