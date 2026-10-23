// Data-directory ownership: one container owns a data directory at a time. `.owner` holds the project, the
// container's hostname, the pid and a heartbeat renewed every 15 s; a fresh lock (< 60 s) makes a second
// container exit, a stale one is taken over. Process IDs alone cannot decide this across containers.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export const HEARTBEAT_MS = 15_000;
export const STALE_MS = 60_000;

export interface OwnerRecord {
  project: string;
  host: string;
  pid: number;
  startedAt: string;
  heartbeat: number;
}

export class DataDirOwned extends Error {
  constructor(
    readonly dir: string,
    readonly owner: OwnerRecord,
  ) {
    super(
      `Data directory ${dir} is in use by project "${owner.project}" (container ${owner.host}, pid ${owner.pid}, heartbeat ${Math.round((Date.now() - owner.heartbeat) / 1000)}s ago). Use another data directory, or stop that container.`,
    );
    this.name = "DataDirOwned";
  }
}

export interface OwnerLock {
  readonly record: OwnerRecord;
  release(): void;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function read(path: string): OwnerRecord | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OwnerRecord;
  } catch {
    return undefined;
  }
}

/** Take ownership of `dir` or throw DataDirOwned. `now` is injectable for tests. */
export function acquireOwner(
  dir: string,
  project: string,
  options: { now?: () => number; heartbeatMs?: number } = {},
): OwnerLock {
  const now = options.now ?? Date.now;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".owner");
  const mine = (r: OwnerRecord | undefined) => !!r && r.host === hostname() && r.pid === process.pid;
  const existing = read(path);
  // Same host and the owner process is gone (a crash, or a container restart): take over at once. Another host
  // can only be judged by its heartbeat.
  const deadHere = !!existing && existing.host === hostname() && !isAlive(existing.pid);
  if (existing && !mine(existing) && !deadHere && now() - existing.heartbeat < STALE_MS)
    throw new DataDirOwned(dir, existing);
  const record: OwnerRecord = {
    project,
    host: hostname(),
    pid: process.pid,
    startedAt: new Date(now()).toISOString(),
    heartbeat: now(),
  };
  const write = () => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, path);
  };
  write();
  const timer = setInterval(() => {
    const current = read(path);
    if (current && !mine(current)) return; // taken over (we were considered dead): stop writing
    record.heartbeat = now();
    try {
      write();
    } catch {}
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();
  return {
    record,
    release() {
      clearInterval(timer);
      try {
        if (mine(read(path))) unlinkSync(path);
      } catch {}
    },
  };
}
