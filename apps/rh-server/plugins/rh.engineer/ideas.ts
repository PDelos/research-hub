// The engineer's ideas: what was proposed, how far it got (stage), the assessment, a log of what the engineer did,
// the numbers of a build and what it cost.
import type { Db } from "../../src/db.ts";
import type { RhApi } from "../../src/kernel/api.ts";
import type { Logger } from "../../src/logger.ts";
import type { Idea, Stage } from "./main.ts";

export class EngineerInvalid extends Error {}

interface Row {
  id: number;
  source: Idea["source"];
  text: string;
  stage: Stage;
  assessment_json: string | null;
  plugin_id: string | null;
  log_json: string;
  numbers_json: string | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

const now = () => new Date().toISOString();

const toIdea = (r: Row): Idea => ({
  id: Number(r.id),
  source: r.source,
  text: r.text,
  stage: r.stage,
  assessment: r.assessment_json ? JSON.parse(r.assessment_json) : null,
  pluginId: r.plugin_id,
  log: JSON.parse(r.log_json),
  numbers: r.numbers_json ? JSON.parse(r.numbers_json) : null,
  costUsd: r.cost_usd,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class IdeaStore {
  private readonly table: string;

  constructor(
    rh: RhApi,
    private readonly db: Db,
    private readonly log: Logger,
  ) {
    this.table = rh.db.table("ideas");
    rh.db.migrate([
      {
        version: 1,
        sql: `CREATE TABLE ${this.table} (id INTEGER PRIMARY KEY, source TEXT NOT NULL, text TEXT NOT NULL, stage TEXT NOT NULL,
              assessment_json TEXT, plugin_id TEXT, log_json TEXT NOT NULL DEFAULT '[]', numbers_json TEXT,
              cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      },
    ]);
    // Work interrupted by a restart did not finish.
    db.prepare(
      `UPDATE ${this.table} SET stage = 'failed', updated_at = ? WHERE stage IN ('researching', 'building')`,
    ).run(now());
  }

  get(id: number): Idea {
    const row = this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw new EngineerInvalid(`no idea ${id}`);
    return toIdea(row);
  }

  list(limit: number): Idea[] {
    return (this.db.prepare(`SELECT * FROM ${this.table} ORDER BY id DESC LIMIT ?`).all(limit) as unknown as Row[]).map(
      toIdea,
    );
  }

  /** A new idea, being researched; returns its id. */
  add(source: Idea["source"], text: string): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO ${this.table} (source, text, stage, created_at, updated_at) VALUES (?, ?, 'researching', ?, ?)`,
        )
        .run(source, text, now(), now()).lastInsertRowid,
    );
  }

  update(
    id: number,
    fields: Partial<Record<"stage" | "assessment_json" | "plugin_id" | "numbers_json", string | null>>,
  ): void {
    const keys = Object.keys(fields);
    this.db
      .prepare(`UPDATE ${this.table} SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k as keyof typeof fields] ?? null), now(), id);
  }

  /** Add a line to the idea's log (the last 200 are kept). */
  say(id: number, text: string): void {
    const log = this.get(id).log;
    log.push({ at: now(), text: text.slice(0, 2_000) });
    this.db
      .prepare(`UPDATE ${this.table} SET log_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(log.slice(-200)), now(), id);
    this.log.info("engineer.log", { idea: id, text: text.slice(0, 200) });
  }

  charge(id: number, usd: number): void {
    if (usd) this.db.prepare(`UPDATE ${this.table} SET cost_usd = cost_usd + ? WHERE id = ?`).run(usd, id);
  }
}
