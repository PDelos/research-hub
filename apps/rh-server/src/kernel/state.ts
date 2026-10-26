// Per-project plugin state (spec plugin-system: Per-project plugin state with history; design D7): $RH_DATA_DIR/plugins
// is a git repository (isomorphic-git, no git binary needed) holding plugins.lock.json. Every change is a commit
// whose author is who made it (user, kernel, or an approved proposal); rollback restores an earlier lockfile as a
// new commit, so history is never rewritten. Plugin storage (data/<id>/) is ignored by git.
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import git from "isomorphic-git";

export const LOCK_FILE = "plugins.lock.json";

export type PluginSource =
  | { kind: "builtin" }
  | { kind: "folder"; path: string }
  | { kind: "git"; url: string; ref?: string };

export interface LockEntry {
  version: string;
  source: PluginSource;
  /** Content hash of an installed plugin's files (sha256 over paths and contents); built-ins have none. */
  hash?: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

export interface Lockfile {
  lockfileVersion: 1;
  plugins: Record<string, LockEntry>;
}

/** Who changed the plugin state: shown in the history. */
export type Actor = "user" | "kernel" | `proposal:${string}`;

export interface HistoryEntry {
  id: string;
  time: string;
  message: string;
  actor: Actor;
}

/** An undo that would overwrite a later change (or has nothing to restore). */
export class UndoRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndoRefused";
  }
}

/** A lockfile as flat paths: "<id>" (presence), "<id>.enabled|version|source|hash", "<id>.settings.<key>". */
function flatten(lock: Lockfile): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, e] of Object.entries(lock.plugins)) {
    out.set(id, "present");
    out.set(`${id}.enabled`, JSON.stringify(e.enabled));
    out.set(`${id}.version`, JSON.stringify(e.version));
    out.set(`${id}.source`, JSON.stringify(e.source));
    if (e.hash !== undefined) out.set(`${id}.hash`, JSON.stringify(e.hash));
    for (const [k, v] of Object.entries(e.settings)) out.set(`${id}.settings.${k}`, JSON.stringify(v));
  }
  return out;
}

export class PluginState {
  readonly dir: string;
  private lock?: Lockfile;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dir = join(dataDir, "plugins");
  }

  /** Open the repository, creating it with `initial()` on first start (an existing v0 project gets all built-ins). */
  async open(initial: () => Lockfile["plugins"]): Promise<Lockfile> {
    mkdirSync(join(this.dir, "installed"), { recursive: true });
    mkdirSync(join(this.dir, "data"), { recursive: true });
    if (!existsSync(join(this.dir, ".git"))) await git.init({ fs, dir: this.dir, defaultBranch: "main" });
    if (!existsSync(join(this.dir, ".gitignore"))) writeFileSync(join(this.dir, ".gitignore"), "data/\n");
    if (existsSync(join(this.dir, LOCK_FILE))) {
      this.lock = JSON.parse(readFileSync(join(this.dir, LOCK_FILE), "utf8")) as Lockfile;
      return this.current();
    }
    this.lock = { lockfileVersion: 1, plugins: sortKeys(initial()) };
    await this.commit("initialize plugins from the environment", "kernel", [".gitignore"]);
    return this.current();
  }

  current(): Lockfile {
    if (!this.lock) throw new Error("plugin state is not open");
    return structuredClone(this.lock);
  }

  /**
   * Change the lockfile and record it as one commit. Returns the commit id, or undefined when nothing changed.
   * Changes are serialized, so concurrent callers never lose each other's edits.
   */
  update(
    change: (lock: Lockfile) => void,
    message: string,
    actor: Actor = "user",
    files: string[] = [],
  ): Promise<string | undefined> {
    const run = this.queue.then(async () => {
      const next = this.current();
      change(next);
      next.plugins = sortKeys(next.plugins);
      if (JSON.stringify(next) === JSON.stringify(this.lock) && !files.length) return undefined;
      this.lock = next;
      return this.commit(message, actor, files);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async history(limit = 100): Promise<HistoryEntry[]> {
    const log = await git.log({ fs, dir: this.dir, depth: limit });
    return log.map((c) => ({
      id: c.oid,
      time: new Date(c.commit.author.timestamp * 1000).toISOString(),
      message: c.commit.message.trim(),
      actor: c.commit.author.name as Actor,
    }));
  }

  /** The lockfile as it was after commit `id`. */
  async at(id: string): Promise<Lockfile> {
    const { blob } = await git.readBlob({
      fs,
      dir: this.dir,
      oid: await git.expandOid({ fs, dir: this.dir, oid: id }),
      filepath: LOCK_FILE,
    });
    return JSON.parse(Buffer.from(blob).toString("utf8")) as Lockfile;
  }

  /** Restore the lockfile of commit `id` as a new commit; the caller re-applies it (deactivate, activate). */
  async rollback(id: string, actor: Actor = "user"): Promise<{ id: string | undefined; lock: Lockfile }> {
    const target = await this.at(id);
    const [entry] = await git.log({
      fs,
      dir: this.dir,
      ref: await git.expandOid({ fs, dir: this.dir, oid: id }),
      depth: 1,
    });
    const commit = await this.update(
      (lock) => {
        lock.plugins = target.plugins;
      },
      `roll back to ${entry.oid.slice(0, 7)} (${entry.commit.message.trim()})`,
      actor,
    );
    return { id: commit, lock: this.current() };
  }

  /**
   * Reverse only what commit `id` changed (design v1-1 D6), as a new commit "undo: <message>". Refused with
   * UndoRefused when a later change touched the same thing, or for the first state.
   */
  async revert(
    id: string,
    actor: Actor = "user",
    /** Called with the state the undo would produce; throw to refuse it before anything is written. */
    guard?: (next: Lockfile) => void,
  ): Promise<{ id: string | undefined; lock: Lockfile; plugins: string[] }> {
    const oid = await git.expandOid({ fs, dir: this.dir, oid: id });
    const [entry] = await git.log({ fs, dir: this.dir, ref: oid, depth: 1 });
    const parent = entry.commit.parent[0];
    if (!parent) throw new UndoRefused("the first state has nothing before it to go back to");
    const before = flatten(await this.at(parent));
    const after = flatten(await this.at(oid));
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
    if (!changed.length) throw new UndoRefused("this change did not change the plugins");
    const message = entry.commit.message.trim();
    const commit = await this.update(
      (lock) => {
        const now = flatten(lock);
        const touched = changed.filter((k) => now.get(k) !== after.get(k));
        if (touched.length)
          throw new UndoRefused(
            `a later change touched the same setting (${touched.slice(0, 3).join(", ")}); undo that first`,
          );
        const beforeLock = new Map(Object.entries(this.snapshotOf(before)));
        for (const key of changed) {
          const [pluginId, field, ...rest] = key.split(".");
          // Plugin ids contain a dot (publisher.name): re-join the id.
          const pid = `${pluginId}.${field}`;
          const sub = rest[0];
          if (sub === undefined) {
            // Presence: the plugin was added or removed by the change.
            if (before.has(pid)) lock.plugins[pid] = structuredClone(beforeLock.get(pid)!);
            else delete lock.plugins[pid];
            continue;
          }
          const entryNow = lock.plugins[pid];
          if (!entryNow) continue;
          const old = before.get(key);
          if (sub === "settings") {
            const name = rest.slice(1).join(".");
            if (old === undefined) delete entryNow.settings[name];
            else entryNow.settings[name] = JSON.parse(old);
          } else if (old === undefined) delete (entryNow as unknown as Record<string, unknown>)[sub];
          else (entryNow as unknown as Record<string, unknown>)[sub] = JSON.parse(old);
        }
        guard?.(lock);
      },
      `undo: ${message}`,
      actor,
    );
    const plugins = [...new Set(changed.map((k) => k.split(".").slice(0, 2).join(".")))];
    return { id: commit, lock: this.current(), plugins };
  }

  /** Rebuild lock entries from flat paths (for restoring a removed plugin). */
  private snapshotOf(flat: Map<string, string>): Record<string, LockEntry> {
    const out: Record<string, LockEntry> = {};
    for (const [key, value] of flat) {
      const parts = key.split(".");
      const pid = `${parts[0]}.${parts[1]}`;
      if (parts.length === 2) {
        out[pid] ??= { version: "", source: { kind: "builtin" }, enabled: false, settings: {} };
        continue;
      }
      const entry = (out[pid] ??= { version: "", source: { kind: "builtin" }, enabled: false, settings: {} });
      if (parts[2] === "settings") entry.settings[parts.slice(3).join(".")] = JSON.parse(value);
      else (entry as unknown as Record<string, unknown>)[parts[2]] = JSON.parse(value);
    }
    return out;
  }

  private async commit(message: string, actor: Actor, files: string[]): Promise<string> {
    writeFileSync(join(this.dir, LOCK_FILE), `${JSON.stringify(this.lock, null, 2)}\n`);
    for (const filepath of [LOCK_FILE, ...files]) {
      if (existsSync(join(this.dir, filepath))) await git.add({ fs, dir: this.dir, filepath });
      else await git.remove({ fs, dir: this.dir, filepath });
    }
    const timestamp = Math.floor(this.now().getTime() / 1000);
    return git.commit({
      fs,
      dir: this.dir,
      message,
      author: { name: actor, email: "plugins@research-hub.local", timestamp, timezoneOffset: 0 },
    });
  }
}

/** A stable content hash of a plugin folder: every file's relative path and bytes, in sorted order. */
export function hashFolder(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(relative(dir, path)).update("\0").update(readFileSync(path)).update("\0");
    }
  };
  walk(dir);
  return `sha256-${hash.digest("hex")}`;
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b)));
}
