// The ranking procedure (spec weekly-upgrade: Ranking upgrade applied with undo; design v1-4 D3): what went wrong
// lately, and the setting variants worth replaying first.
import type { Db } from "../../src/db.ts";
import type { SweepSettings, Variant } from "../../src/harness/replay.ts";
import type { RankWeights } from "../../src/sweep/sweep.ts";

export interface Analysis {
  judged: number;
  disliked: Record<string, number>;
  likedRankedLow: number;
  explorationLiked: number;
  explorationDisliked: number;
  unjudgedShare: number;
}

export function analyze(db: Db, sinceDays = 60, now = Date.now()): Analysis {
  const since = new Date(now - sinceDays * 86_400_000).toISOString();
  const disliked = Object.fromEntries(
    (
      db
        .prepare(
          "SELECT COALESCE(reason_kind, 'no reason') k, COUNT(*) n FROM judgments WHERE verdict = 'down' AND updated_at >= ? GROUP BY k",
        )
        .all(since) as { k: string; n: number }[]
    ).map((r) => [r.k, Number(r.n)]),
  );
  const cards = db
    .prepare(
      `SELECT c.sweep_id, c.rank, j.verdict, (SELECT COUNT(*) FROM cards c2 WHERE c2.sweep_id = c.sweep_id) n
         FROM cards c LEFT JOIN judgments j ON j.card_id = c.id WHERE c.created_at >= ?`,
    )
    .all(since) as { sweep_id: number; rank: number | null; verdict: string | null; n: number }[];
  const liked = (v: string | null) => v === "up" || v === "star";
  let explorationLiked = 0;
  let explorationDisliked = 0;
  try {
    const rows = db
      .prepare(
        "SELECT j.verdict FROM p_rh_sweep__exploration e JOIN cards c ON c.paper_id = e.paper_id LEFT JOIN judgments j ON j.card_id = c.id WHERE e.created_at >= ?",
      )
      .all(since) as { verdict: string | null }[];
    explorationLiked = rows.filter((r) => liked(r.verdict)).length;
    explorationDisliked = rows.filter((r) => r.verdict === "down").length;
  } catch {
    // No exploration table yet.
  }
  return {
    judged: cards.filter((c) => c.verdict).length,
    disliked,
    likedRankedLow: cards.filter((c) => liked(c.verdict) && c.rank !== null && c.rank > Number(c.n) / 2).length,
    explorationLiked,
    explorationDisliked,
    unjudgedShare: cards.length ? cards.filter((c) => !c.verdict).length / cards.length : 0,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Move `amount` of weight to `key`, taken from the others in proportion; still summing to the same total. */
export function shiftWeights(w: RankWeights, key: keyof RankWeights, amount = 0.1): RankWeights {
  const others = (Object.keys(w) as (keyof RankWeights)[]).filter((k) => k !== key);
  const pool = others.reduce((s, k) => s + w[k], 0);
  if (pool <= 0) return w;
  const take = Math.min(amount, pool);
  const out = { ...w, [key]: round(Math.min(1, w[key] + take)) } as RankWeights;
  for (const k of others) out[k] = round(Math.max(0, w[k] - (take * w[k]) / pool));
  return out;
}

export interface CandidateVariant {
  variant: Variant;
  why: string;
  score: number;
}

/** At most 12 variants around the current settings, the ones the analysis points at first. */
export function rankingGrid(current: SweepSettings, a: Analysis): CandidateVariant[] {
  const d = a.disliked;
  const off = d["off-topic"] ?? 0;
  const level = (d["too-basic"] ?? 0) + (d["too-advanced"] ?? 0);
  const trust = d["low-trust"] ?? 0;
  const out: CandidateVariant[] = [];
  const add = (variant: Variant, why: string, score: number) => out.push({ variant, why, score });
  const clamp = (x: number) => round(Math.min(1, Math.max(0, x)));
  add({ relevanceMin: clamp(current.relevanceMin + 0.05) }, `stricter relevance gate (${off} off-topic 👎)`, 1 + off);
  add({ relevanceMin: clamp(current.relevanceMin - 0.05) }, "looser relevance gate (more candidates)", 0.5);
  add({ worthMin: clamp(current.worthMin + 0.05) }, `stricter worth gate (${trust} low-trust 👎)`, 0.8 + trust);
  add({ worthMin: clamp(current.worthMin - 0.05) }, "looser worth gate", 0.4);
  add(
    { rankWeights: shiftWeights(current.rankWeights, "relevance") },
    `more weight on relevance (${a.likedRankedLow} liked cards ranked low)`,
    0.9 + off + a.likedRankedLow,
  );
  add({ rankWeights: shiftWeights(current.rankWeights, "importance") }, "more weight on importance", 0.6);
  add(
    { rankWeights: shiftWeights(current.rankWeights, "level") },
    `more weight on level fit (${level} too basic/advanced 👎)`,
    0.7 + level,
  );
  add(
    { rankWeights: shiftWeights(current.rankWeights, "question") },
    "more weight on the matched research question",
    0.6,
  );
  if (current.cardsPerSweep > 3)
    add(
      { cardsPerSweep: current.cardsPerSweep - 2 },
      `fewer cards (${Math.round(a.unjudgedShare * 100)} % left unjudged)`,
      0.5 + 3 * a.unjudgedShare,
    );
  if (current.cardsPerSweep < 14)
    add({ cardsPerSweep: current.cardsPerSweep + 2 }, "more cards", 0.5 + (a.unjudgedShare < 0.2 ? 0.5 : 0));
  if (current.explorationPicks < 2)
    add(
      { explorationPicks: current.explorationPicks + 1 },
      `more exploration (${a.explorationLiked} exploration picks liked)`,
      0.5 + a.explorationLiked,
    );
  if (current.explorationPicks > 0)
    add(
      { explorationPicks: current.explorationPicks - 1 },
      `less exploration (${a.explorationDisliked} disliked)`,
      0.5 + a.explorationDisliked,
    );
  return out.toSorted((x, y) => y.score - x.score).slice(0, 12);
}
