// Exploration picks (spec daily-cycle: Exploration pick; design v1-1 D8): the last card slots go to gated papers
// outside the top ones that are least like what the user liked (lowest highest cosine similarity of whole-paper
// vectors to the papers judged 👍 or ⭐), so the feed does not narrow into a bubble and drifting interests show.
import type { Db } from "../../src/db.ts";
import type { RhApi } from "../../src/kernel/api.ts";
import type { PaperVectors } from "../../src/representations/vectors.ts";

export const EXPLORATION_TABLE = "p_rh_sweep__exploration";

export function migrateExploration(rh: RhApi): void {
  rh.db.migrate([
    {
      version: 1,
      sql: `CREATE TABLE ${EXPLORATION_TABLE} (
        sweep_id INTEGER NOT NULL, paper_id INTEGER NOT NULL, similarity REAL NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (sweep_id, paper_id))`,
    },
  ]);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function pickExploration(x: {
  db: Db;
  vectors: PaperVectors;
  sweepId: number;
  ranked: number[];
  slots: number;
  picks: number;
}): number[] {
  if (x.picks < 1 || x.slots <= x.picks) return [];
  const liked = (
    x.db.prepare("SELECT DISTINCT paper_id FROM judgments WHERE verdict IN ('up', 'star')").all() as {
      paper_id: number;
    }[]
  )
    .map((r) => x.vectors.vector(Number(r.paper_id), "whole"))
    .filter((v): v is Float32Array => !!v);
  if (!liked.length) return [];
  // Outside the top ones: these would not have become cards.
  const pool = x.ranked.slice(x.slots - x.picks);
  const scored = pool
    .map((paperId, i) => {
      const v = x.vectors.vector(paperId, "whole");
      return v ? { paperId, i, similarity: Math.max(...liked.map((l) => cosine(v, l))) } : undefined;
    })
    .filter((s): s is { paperId: number; i: number; similarity: number } => !!s)
    .toSorted((a, b) => a.similarity - b.similarity || a.i - b.i)
    .slice(0, x.picks);
  const insert = x.db.prepare(
    `INSERT OR REPLACE INTO ${EXPLORATION_TABLE} (sweep_id, paper_id, similarity, created_at) VALUES (?, ?, ?, ?)`,
  );
  for (const s of scored) insert.run(x.sweepId, s.paperId, s.similarity, new Date().toISOString());
  return scored.map((s) => s.paperId);
}

/** Whether a card's paper was an exploration pick of its sweep. */
export function isExploration(db: Db, sweepId: number, paperId: number): boolean {
  try {
    return !!db.prepare(`SELECT 1 FROM ${EXPLORATION_TABLE} WHERE sweep_id = ? AND paper_id = ?`).get(sweepId, paperId);
  } catch {
    return false;
  }
}
