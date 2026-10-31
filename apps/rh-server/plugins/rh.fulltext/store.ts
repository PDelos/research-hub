// The full texts this plugin fetched: one row per paper with its sections and the notes on what was tried.
import type { Section } from "../../src/fulltext/parse.ts";
import type { RhApi } from "../../src/kernel/api.ts";
import type { Db } from "../../src/db.ts";
import type { Logger } from "../../src/logger.ts";
import type { FullText } from "./main.ts";

interface Row {
  paper_id: number;
  status: FullText["status"];
  source: string | null;
  sections_json: string;
  chars: number;
  notes_json: string;
  fetched_at: string;
}

const toText = (r: Row): FullText => ({
  paperId: Number(r.paper_id),
  status: r.status,
  source: r.source,
  sections: JSON.parse(r.sections_json),
  chars: Number(r.chars),
  notes: JSON.parse(r.notes_json),
  fetchedAt: r.fetched_at,
});

export class FullTextStore {
  private readonly table: string;

  constructor(
    rh: RhApi,
    private readonly db: Db,
    private readonly log: Logger,
  ) {
    this.table = rh.db.table("texts");
    rh.db.migrate([
      {
        version: 1,
        sql: `CREATE TABLE ${this.table} (paper_id INTEGER PRIMARY KEY, status TEXT NOT NULL, source TEXT, sections_json TEXT NOT NULL,
              chars INTEGER NOT NULL, notes_json TEXT NOT NULL, fetched_at TEXT NOT NULL)`,
      },
    ]);
  }

  get(paperId: number): FullText | undefined {
    const row = this.db.prepare(`SELECT * FROM ${this.table} WHERE paper_id = ?`).get(paperId) as Row | undefined;
    return row ? toText(row) : undefined;
  }

  /** Record what was found (or that nothing was), replacing an earlier attempt. */
  save(paperId: number, found: { source: string; sections: Section[] } | undefined, notes: string[]): void {
    const sections = found?.sections ?? [];
    const chars = sections.reduce((n, s) => n + s.text.length, 0);
    this.db
      .prepare(
        `INSERT INTO ${this.table} (paper_id, status, source, sections_json, chars, notes_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (paper_id) DO UPDATE SET status = excluded.status, source = excluded.source, sections_json = excluded.sections_json,
           chars = excluded.chars, notes_json = excluded.notes_json, fetched_at = excluded.fetched_at`,
      )
      .run(
        paperId,
        found ? "ok" : "missing",
        found?.source ?? null,
        JSON.stringify(sections),
        chars,
        JSON.stringify(notes),
        new Date().toISOString(),
      );
    this.log.info("fulltext.fetched", { paperId, source: found?.source ?? null, sections: sections.length, chars });
  }
}
