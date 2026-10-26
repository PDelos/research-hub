// The history a replay works on (design v1-2 D2): each finished sweep's Jev-scored papers, the charter in force when
// it started, the papers liked before it, and (for exploration) whole-paper vectors; plus the user's verdicts.
import type { Charter } from "../charter.ts";
import type { Db } from "../db.ts";
import type { PaperVectors } from "../representations/vectors.ts";
import type { Labels, Level, SweepHistory } from "./replay.ts";

export function loadHistory(
  db: Db,
  vectors: PaperVectors | undefined,
  options: { sinceDays?: number; now?: number } = {},
): SweepHistory[] {
  const since = new Date((options.now ?? Date.now()) - (options.sinceDays ?? 120) * 86_400_000).toISOString();
  const sweeps = db
    .prepare(
      "SELECT id, started_at, orientation FROM sweeps WHERE status = 'completed' AND started_at >= ? ORDER BY id",
    )
    .all(since) as { id: number; started_at: string; orientation: number }[];
  const charters = (
    db
      .prepare("SELECT body_json, approved_at FROM charters WHERE approved_at IS NOT NULL ORDER BY approved_at")
      .all() as {
      body_json: string;
      approved_at: string;
    }[]
  ).map((c) => ({ at: c.approved_at, charter: JSON.parse(c.body_json) as Charter }));
  const likes = db.prepare("SELECT paper_id, created_at FROM judgments WHERE verdict IN ('up', 'star')").all() as {
    paper_id: number;
    created_at: string;
  }[];
  const pool = db.prepare(
    `SELECT sp.paper_id, sp.relevance, sp.worth, sp.importance, sp.level, sp.matched_question, p.published_at
       FROM sweep_papers sp JOIN papers p ON p.id = sp.paper_id
      WHERE sp.sweep_id = ? AND sp.relevance IS NOT NULL AND sp.worth IS NOT NULL AND sp.status != 'blocked'`,
  );
  return sweeps.map((s) => {
    const charter = charters.filter((c) => c.at <= s.started_at).at(-1)?.charter;
    const papers = (
      pool.all(s.id) as {
        paper_id: number;
        relevance: number;
        worth: number;
        importance: number | null;
        level: string | null;
        matched_question: string | null;
        published_at: string | null;
      }[]
    ).map((r) => ({
      paperId: Number(r.paper_id),
      relevance: r.relevance,
      worth: r.worth,
      ...(r.importance === null ? {} : { importance: r.importance }),
      ...(r.level === null ? {} : { level: r.level as Level }),
      ...(r.matched_question === null ? {} : { matchedQuestion: r.matched_question }),
      ...(r.published_at === null ? {} : { publishedAt: r.published_at }),
    }));
    const likedBefore = likes.filter((l) => l.created_at < s.started_at).map((l) => Number(l.paper_id));
    const vec = (id: number) => vectors?.vector(id, "whole");
    return {
      sweepId: Number(s.id),
      startedAt: Date.parse(s.started_at),
      orientation: !!s.orientation,
      ...(charter ? { charter } : {}),
      pool: papers,
      liked: likedBefore.map(vec).filter((v): v is Float32Array => !!v),
      vectors: new Map(
        papers.map((p) => [p.paperId, vec(p.paperId)] as const).filter((e): e is [number, Float32Array] => !!e[1]),
      ),
    };
  });
}

/** The user's latest verdict per paper. */
export function userLabels(db: Db): Labels["user"] {
  return new Map(
    (
      db.prepare("SELECT paper_id, verdict FROM judgments").all() as {
        paper_id: number;
        verdict: "up" | "down" | "star";
      }[]
    ).map((r) => [Number(r.paper_id), r.verdict]),
  );
}
