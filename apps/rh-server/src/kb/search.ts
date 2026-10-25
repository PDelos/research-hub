// Vault search (spec knowledge-vault: Vault is the source of truth, Keyword search; design D4): an FTS5 (BM25)
// index built only from the vault's markdown files. A recursive watcher (debounced) and a 5 s rescan by
// modification time keep it current, so external edits are searchable within 10 seconds; `rebuild()` recreates it
// from disk in sorted path order, giving the same results as the incremental index.
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.ts";
import type { Logger } from "../logger.ts";
import type { Vault } from "./vault.ts";

export interface KbHit {
  path: string;
  stem: string;
  title: string;
  excerpt: string;
  score: number;
}

/** Title from the frontmatter `title:`, else the first heading, else the file name. */
export function noteTitle(path: string, text: string): string {
  const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  const prop = front?.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  if (prop) {
    try {
      return String(JSON.parse(prop));
    } catch {
      return prop.replace(/^["']|["']$/g, "");
    }
  }
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.split("/").pop()!.replace(/\.md$/, "");
}

/** Plain words joined as an AND query of quoted terms (FTS5 syntax characters are never passed through). */
export function ftsQuery(query: string): string {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .slice(0, 12)
    .map((t) => `"${t}"`)
    .join(" ");
}

export class KbIndex {
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: { db: Db; vault: Vault; log: Logger }) {}

  /** Drop and recreate the index from the files alone. */
  rebuild(): number {
    const { db } = this.deps;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM kb_fts; DELETE FROM kb_files;");
      for (const path of this.deps.vault.markdownFiles()) this.put(path);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return this.deps.vault.markdownFiles().length;
  }

  /** Re-index files whose modification time or size changed, add new ones, drop deleted ones. */
  sync(): { changed: number; removed: number } {
    const { db, vault } = this.deps;
    const known = new Map(
      (
        db.prepare("SELECT path, mtime_ms, size FROM kb_files").all() as {
          path: string;
          mtime_ms: number;
          size: number;
        }[]
      ).map((r) => [r.path, r]),
    );
    let changed = 0;
    const present = new Set(vault.markdownFiles());
    for (const path of present) {
      let st;
      try {
        st = statSync(join(vault.dir, path));
      } catch {
        continue;
      }
      const k = known.get(path);
      if (k && Number(k.mtime_ms) === st.mtimeMs && Number(k.size) === st.size) continue;
      this.put(path);
      changed++;
    }
    let removed = 0;
    for (const path of known.keys())
      if (!present.has(path)) {
        db.prepare("DELETE FROM kb_fts WHERE path = ?").run(path);
        db.prepare("DELETE FROM kb_files WHERE path = ?").run(path);
        removed++;
      }
    return { changed, removed };
  }

  search(query: string, k = 8): KbHit[] {
    const q = ftsQuery(query);
    if (!q) return [];
    return (
      this.deps.db
        .prepare(
          `SELECT path, title, snippet(kb_fts, 2, '**', '**', '…', 14) AS excerpt, bm25(kb_fts) AS score
           FROM kb_fts WHERE kb_fts MATCH ? ORDER BY score, path LIMIT ?`,
        )
        .all(q, k) as { path: string; title: string; excerpt: string; score: number }[]
    ).map((r) => ({
      path: r.path,
      stem: r.path.split("/").pop()!.replace(/\.md$/, ""),
      title: r.title,
      excerpt: r.excerpt,
      score: r.score,
    }));
  }

  /** Watch the vault (debounced 500 ms) and rescan every 5 s as a backstop. */
  start(): void {
    if (this.interval || !this.deps.vault.exists()) return;
    this.sync();
    try {
      this.watcher = watch(this.deps.vault.dir, { recursive: true }, (_e, name) => {
        if (name && String(name).includes(".obsidian")) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.safeSync(), 500);
      });
    } catch (error) {
      this.deps.log.warn("kb.watch_unavailable", { error: String(error), note: "falling back to the 5 s rescan" });
    }
    this.interval = setInterval(() => this.safeSync(), 5_000);
    this.interval.unref?.();
  }

  stop(): void {
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.watcher = undefined;
    this.interval = undefined;
  }

  private safeSync(): void {
    try {
      this.sync();
    } catch (error) {
      this.deps.log.warn("kb.index_failed", { error: String(error) });
    }
  }

  private put(path: string): void {
    const { db, vault } = this.deps;
    const full = join(vault.dir, path);
    let text: string;
    let st;
    try {
      text = readFileSync(full, "utf8");
      st = statSync(full);
    } catch {
      return;
    }
    db.prepare("DELETE FROM kb_fts WHERE path = ?").run(path);
    db.prepare("INSERT INTO kb_fts (path, title, body) VALUES (?, ?, ?)").run(path, noteTitle(path, text), text);
    db.prepare(
      "INSERT INTO kb_files (path, mtime_ms, size) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size",
    ).run(path, st.mtimeMs, st.size);
  }
}
