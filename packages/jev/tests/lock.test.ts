// A command's wording cannot change without a version bump; the lock records every command.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkLock, commandHash, JevClient, loadCommand, readLock, writeLock } from "../src/index.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/commands");

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), "rh-jev-lock-"));
  cpSync(FIXTURES, dir, { recursive: true });
  writeLock(dir);
  return dir;
}
function mutate(dir: string, name: string, change: (cmd: any) => void) {
  const file = join(dir, name, "command.json");
  const cmd = JSON.parse(readFileSync(file, "utf8"));
  change(cmd);
  writeFileSync(file, JSON.stringify(cmd, null, 2));
}

test("a fresh lock is current", () => {
  const dir = copy();
  assert.deepEqual(checkLock(dir, readLock(dir)), []);
});

test("changing a question's wording without a version bump fails and names the command", () => {
  const dir = copy();
  mutate(dir, "relevance", (c) => (c.questions.relevance.instructions += " Be strict."));
  const problems = checkLock(dir, readLock(dir));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^relevance: wording changed without a version bump/);
});

test("a policy change counts as a wording change", () => {
  const dir = copy();
  mutate(dir, "relevance", (c) => (c.policy.relevance_min = 0.6));
  assert.match(checkLock(dir, readLock(dir))[0], /without a version bump/);
});

test("a bumped version asks for a lock update, then passes", () => {
  const dir = copy();
  mutate(dir, "relevance", (c) => {
    c.questions.relevance.instructions += " Be strict.";
    c.version += 1;
  });
  assert.match(checkLock(dir, readLock(dir))[0], /not recorded; run with --update/);
  writeLock(dir);
  assert.deepEqual(checkLock(dir, readLock(dir)), []);
});

test("key order and formatting do not change the hash", () => {
  const cmd = loadCommand("relevance", FIXTURES);
  const reordered = JSON.parse(JSON.stringify({ ...cmd, policy: { ...cmd.policy }, questions: Object.fromEntries(Object.entries(cmd.questions).reverse()) }));
  assert.equal(commandHash(reordered), commandHash(cmd));
});

test("a choice question with 256 options is rejected before sending", async () => {
  const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
  const client = new JevClient({ provider: "mock" });
  await assert.rejects(
    client.systemOne({ text: "x" }, { pick: { type: "choice", instructions: "Pick one", criteria } } as any),
    /255/,
  );
});
