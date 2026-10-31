// The digest plugin's tables: the weekly digests, the user's comments on their sections, and each night's figures.
import type { DigestBody, DigestComment, DigestSection, DigestSummary, DigestView } from "@rh/sdk";
import type { Db } from "../../src/db.ts";
import type { RhApi } from "../../src/kernel/api.ts";

export class DigestStore {
  private readonly tables: { digests: string; comments: string; nights: string };

  constructor(
    rh: RhApi,
    private readonly db: Db,
  ) {
    this.tables = { digests: rh.db.table("digests"), comments: rh.db.table("comments"), nights: rh.db.table("nights") };
    const { digests, comments, nights } = this.tables;
    rh.db.migrate([
      {
        version: 1,
        sql: `CREATE TABLE ${digests} (id INTEGER PRIMARY KEY, week TEXT NOT NULL, period_from TEXT NOT NULL,
              period_to TEXT NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE ${comments} (id INTEGER PRIMARY KEY, digest_id INTEGER NOT NULL, section TEXT NOT NULL,
              text TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE ${nights} (day TEXT PRIMARY KEY, figures_json TEXT NOT NULL, created_at TEXT NOT NULL);`,
      },
    ]);
  }

  comments(digestId: number): DigestComment[] {
    const rows = this.db
      .prepare(`SELECT id, section, text, created_at FROM ${this.tables.comments} WHERE digest_id = ? ORDER BY id`)
      .all(digestId) as { id: number; section: DigestSection; text: string; created_at: string }[];
    return rows.map((c) => ({ id: Number(c.id), section: c.section, text: c.text, createdAt: c.created_at }));
  }

  latest() {
    return this.db
      .prepare(`SELECT id, week, period_to, created_at FROM ${this.tables.digests} ORDER BY id DESC LIMIT 1`)
      .get() as { id: number; week: string; period_to: string; created_at: string } | undefined;
  }

  list(limit: number): DigestSummary[] {
    const { digests, comments } = this.tables;
    const rows = this.db
      .prepare(
        `SELECT d.id, d.week, d.period_from, d.period_to, d.created_at, (SELECT COUNT(*) FROM ${comments} c WHERE c.digest_id = d.id) comments FROM ${digests} d ORDER BY d.id DESC LIMIT ?`,
      )
      .all(limit) as {
      id: number;
      week: string;
      period_from: string;
      period_to: string;
      created_at: string;
      comments: number;
    }[];
    return rows.map((d) => ({
      id: Number(d.id),
      week: d.week,
      from: d.period_from,
      to: d.period_to,
      createdAt: d.created_at,
      comments: Number(d.comments),
    }));
  }

  get(id: number): DigestView | undefined {
    const row = this.db.prepare(`SELECT id, body_json, created_at FROM ${this.tables.digests} WHERE id = ?`).get(id) as
      | { id: number; body_json: string; created_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      ...(JSON.parse(row.body_json) as DigestBody),
      id: Number(row.id),
      createdAt: row.created_at,
      comments: this.comments(Number(row.id)),
    };
  }

  /** Store a digest; returns its id. */
  add(week: string, period: { from: string; to: string }, body: DigestBody): number {
    const written = this.db
      .prepare(
        `INSERT INTO ${this.tables.digests} (week, period_from, period_to, body_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(week, period.from, period.to, JSON.stringify(body), period.to);
    return Number(written.lastInsertRowid);
  }

  addComment(digestId: number, section: DigestSection, text: string): DigestComment {
    const createdAt = new Date().toISOString();
    const written = this.db
      .prepare(`INSERT INTO ${this.tables.comments} (digest_id, section, text, created_at) VALUES (?, ?, ?, ?)`)
      .run(digestId, section, text, createdAt);
    return { id: Number(written.lastInsertRowid), section, text, createdAt };
  }

  nightsBetween(from: string, to: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) n FROM ${this.tables.nights} WHERE created_at >= ? AND created_at < ?`)
      .get(from, to) as { n: number };
    return Number(row.n);
  }

  lastNight(): { created_at: string } | undefined {
    return this.db.prepare(`SELECT created_at FROM ${this.tables.nights} ORDER BY day DESC LIMIT 1`).get() as
      | { created_at: string }
      | undefined;
  }

  recordNight(day: string, figures: Record<string, number>, at: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO ${this.tables.nights} (day, figures_json, created_at) VALUES (?, ?, ?)`)
      .run(day, JSON.stringify(figures), at);
  }
}
