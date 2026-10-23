/**
 * commands.lock.json pins each Jev command's wording: a change to its questions, policy or state
 * template must come with a version bump, so every recorded decision can be traced to the exact
 * command text that produced it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listCommands, loadCommand, type JevCommand } from "./command.ts";

export interface LockEntry {
  version: number;
  sha256: string;
}
export type CommandsLock = Record<string, LockEntry>;

/** Stable JSON: object keys sorted, so formatting and key order never change the hash. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function commandHash(cmd: JevCommand): string {
  return createHash("sha256")
    .update(stable({ state: cmd.state, questions: cmd.questions, policy: cmd.policy, each: cmd.each }))
    .digest("hex");
}

export function buildLock(dir: string): CommandsLock {
  const lock: CommandsLock = {};
  for (const name of listCommands(dir)) {
    const cmd = loadCommand(name, dir);
    lock[name] = { version: cmd.version, sha256: commandHash(cmd) };
  }
  return lock;
}

/** Problems between the commands on disk and the lock; empty means the lock is current. */
export function checkLock(dir: string, lock: CommandsLock): string[] {
  const problems: string[] = [];
  const current = buildLock(dir);
  for (const [name, entry] of Object.entries(current)) {
    const locked = lock[name];
    if (!locked) problems.push(`${name}: new command not in the lock; run with --update`);
    else if (locked.sha256 !== entry.sha256 && locked.version === entry.version)
      problems.push(`${name}: wording changed without a version bump (still v${entry.version})`);
    else if (locked.sha256 !== entry.sha256 || locked.version !== entry.version)
      problems.push(`${name}: v${locked.version} → v${entry.version} not recorded; run with --update`);
  }
  for (const name of Object.keys(lock))
    if (!current[name]) problems.push(`${name}: in the lock but no longer on disk; run with --update`);
  return problems;
}

export function lockPath(dir: string): string {
  return join(dir, "commands.lock.json");
}

export function readLock(dir: string): CommandsLock {
  const path = lockPath(dir);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as CommandsLock) : {};
}

export function writeLock(dir: string): CommandsLock {
  const lock = buildLock(dir);
  writeFileSync(lockPath(dir), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}
