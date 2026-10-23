// One process owns a SQLite file at a time. pi-durable has no cross-process locking,
// so every database gets a lock beside it holding "<hostname> <pid>".
// Research Hub change: the hostname is recorded because process IDs repeat across containers (a restarted
// container can reuse the dead owner's PID for another live process). A lock from another host is stale: the
// data-directory ownership lock already guarantees a single owning container.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export function lockFile(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const me = `${hostname()} ${process.pid}`;
  const take = () => writeFileSync(path, me, { flag: "wx", mode: 0o600 });
  try {
    take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const [host, pidText] = parseLock(readFileSync(path, "utf8"));
    const pid = Number(pidText);
    const sameHost = host === undefined || host === hostname();
    if (sameHost && pid !== process.pid && isAlive(pid))
      throw new Error(`Database already owned by process ${pid}: ${path}`);
    unlinkSync(path);
    take();
  }
  return () => {
    try {
      if (readFileSync(path, "utf8") === me) unlinkSync(path);
    } catch {}
  };
}

/** "<hostname> <pid>", or a bare pid from older locks. */
function parseLock(text: string): [string | undefined, string] {
  const parts = text.trim().split(/\s+/);
  return parts.length >= 2 ? [parts[0], parts[1]] : [undefined, parts[0] ?? ""];
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
