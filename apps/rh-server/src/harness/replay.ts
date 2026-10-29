// Replays (spec harness; design v1-2 D2, D4): apply a variant of the sweep's settings to past sweeps from their stored
// Jev scores (no new calls), and score the cards it would have shown against labels (the user's verdicts, or the
// calibrated judge). Pure functions: the history is loaded elsewhere (history.ts).
import type { Charter } from "../charter.ts";
import {
  CARDS_PER_SWEEP,
  DEFAULT_RANK_WEIGHTS,
  freshness,
  levelFit,
  type TargetLevel,
  questionWeight,
  rankScore,
  type RankWeights,
} from "../sweep/sweep.ts";

export type Level = "foundational" | "core" | "advanced" | "frontier";

export interface PoolPaper {
  paperId: number;
  relevance: number;
  worth: number;
  importance?: number;
  level?: Level;
  matchedQuestion?: string;
  publishedAt?: string;
}

export interface SweepHistory {
  sweepId: number;
  startedAt: number;
  orientation: boolean;
  charter?: Charter;
  pool: PoolPaper[];
  /** Whole-paper vectors of papers liked before this sweep (for exploration). */
  liked: Float32Array[];
  /** Whole-paper vectors of the pool's papers (for exploration). */
  vectors: Map<number, Float32Array>;
}

export interface SweepSettings {
  relevanceMin: number;
  worthMin: number;
  rankWeights: RankWeights;
  cardsPerSweep: number;
  explorationPicks: number;
  /** The user's level (v1-7): auto keeps the earlier level fit. */
  level: TargetLevel;
}
export type Variant = Partial<SweepSettings>;

export const DEFAULT_SETTINGS: SweepSettings = {
  relevanceMin: 0.45,
  worthMin: 0.35,
  rankWeights: DEFAULT_RANK_WEIGHTS,
  cardsPerSweep: CARDS_PER_SWEEP.default,
  explorationPicks: 1,
  level: "auto",
};

/** Gain per paper: ⭐ 2, 👍 1, 👎 0 from the user; the trusted judge's probability × 1.5 otherwise. */
export interface Labels {
  user: Map<number, "up" | "down" | "star">;
  judge?: Map<number, number>;
}
const VERDICT_GAIN = { star: 2, up: 1, down: 0 } as const;
export function gainOf(labels: Labels, paperId: number): number | undefined {
  const verdict = labels.user.get(paperId);
  if (verdict) return VERDICT_GAIN[verdict];
  const probability = labels.judge?.get(paperId);
  return probability === undefined ? undefined : probability * 1.5;
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    na += left[i] * left[i];
    nb += right[i] * right[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0.5;
  const sorted = xs.toSorted((a, b) => a - b);
  return sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

/** The cards a sweep would have shown with these settings, best first, and how many used estimated features. */
export function replayCards(
  sweepHistory: SweepHistory,
  settings: SweepSettings,
): { cards: number[]; estimated: number } {
  const passed = sweepHistory.pool.filter((p) => p.relevance >= settings.relevanceMin && p.worth >= settings.worthMin);
  const known = sweepHistory.pool.filter((p) => p.importance !== undefined).map((p) => p.importance!);
  const fallback = median(known);
  let estimated = 0;
  const scored = passed
    .map((poolPaper) => {
      if (poolPaper.importance === undefined || poolPaper.level === undefined) estimated++;
      return {
        id: poolPaper.paperId,
        score: rankScore(
          {
            importance: poolPaper.importance ?? fallback,
            relevance: poolPaper.relevance,
            questionWeight: sweepHistory.charter
              ? questionWeight(sweepHistory.charter, poolPaper.matchedQuestion)
              : 0.5,
            levelFit: levelFit(poolPaper.level ?? "core", sweepHistory.orientation, settings.level ?? "auto"),
            freshness: sweepHistory.orientation ? 0.5 : freshness(poolPaper.publishedAt, sweepHistory.startedAt),
          },
          settings.rankWeights,
        ),
      };
    })
    .toSorted((a, b) => b.score - a.score || a.id - b.id);
  const cards = settings.cardsPerSweep;
  const picks = Math.min(settings.explorationPicks, cards - 1);
  let explore: number[] = [];
  if (picks > 0 && sweepHistory.liked.length) {
    explore = scored
      .slice(cards - picks)
      .map((sweep, i) => {
        const vector = sweepHistory.vectors.get(sweep.id);
        return vector
          ? { id: sweep.id, i, sim: Math.max(...sweepHistory.liked.map((l) => cosine(vector, l))) }
          : undefined;
      })
      .filter((x): x is { id: number; i: number; sim: number } => !!x)
      .toSorted((a, b) => a.sim - b.sim || a.i - b.i)
      .slice(0, picks)
      .map((x) => x.id);
  }
  const chosen = new Set(explore);
  const top = scored.filter((s) => !chosen.has(s.id)).slice(0, cards - explore.length);
  return { cards: [...top.map((s) => s.id), ...explore], estimated };
}

export interface SweepMetrics {
  /** Condensed nDCG@n: unlabelled cards are left out (incomplete judgments), the ideal is the pool's best labels. */
  ndcg?: number;
  precision5?: number;
  starRecall?: number;
  coverage: number;
}

export function sweepMetrics(sweepHistory: SweepHistory, cards: number[], labels: Labels): SweepMetrics {
  const gains = cards.map((id) => gainOf(labels, id)).filter((g): g is number => g !== undefined);
  const coverage = cards.length ? gains.length / cards.length : 0;
  const dcg = gains.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  const ideal = sweepHistory.pool
    .map((p) => gainOf(labels, p.paperId))
    .filter((g): g is number => g !== undefined)
    .toSorted((a, b) => b - a)
    .slice(0, cards.length || 1);
  const idcg = ideal.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  const first5 = gains.slice(0, 5);
  const stars = sweepHistory.pool.filter((p) => labels.user.get(p.paperId) === "star").map((p) => p.paperId);
  return {
    ...(idcg > 0 ? { ndcg: dcg / idcg } : {}),
    ...(first5.length ? { precision5: first5.filter((g) => g > 0.75).length / first5.length } : {}),
    ...(stars.length ? { starRecall: stars.filter((s) => cards.includes(s)).length / stars.length } : {}),
    coverage,
  };
}

/** A seeded generator (mulberry32), so a replay's interval is reproducible. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paired bootstrap of the mean difference: 2.5 % and 97.5 % quantiles over `resamples` resamples. */
export function bootstrap(diffs: number[], resamples = 1000, seed = 42): { low: number; high: number } {
  if (!diffs.length) return { low: 0, high: 0 };
  const random = seeded(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(random() * diffs.length)];
    means.push(sum / diffs.length);
  }
  means.sort((a, b) => a - b);
  return { low: means[Math.floor(0.025 * (resamples - 1))], high: means[Math.ceil(0.975 * (resamples - 1))] };
}

export type Verdict = "better" | "worse" | "inconclusive" | "not enough data";

export interface ReplayReport {
  variant: Variant;
  current: SweepSettings;
  candidate: SweepSettings;
  sweeps: { total: number; labelled: number; heldOut: number };
  perSweep: {
    sweepId: number;
    startedAt: string;
    heldOut: boolean;
    current: SweepMetrics;
    candidate: SweepMetrics;
  }[];
  mean: { current: SweepMetrics; candidate: SweepMetrics };
  train: { diff: number; n: number };
  heldOut: { diff: number; low: number; high: number; n: number };
  /** Papers whose importance or level was never computed (admitted by a lower threshold). */
  estimated: number;
  judgeUsed: boolean;
  verdict: Verdict;
}

const avg = (xs: (number | undefined)[]) => {
  const defined = xs.filter((x): x is number => x !== undefined);
  return defined.length ? defined.reduce((a, b) => a + b, 0) / defined.length : undefined;
};

export function replay(
  history: SweepHistory[],
  current: SweepSettings,
  variant: Variant,
  labels: Labels,
): ReplayReport {
  const candidate: SweepSettings = { ...current, ...variant };
  let estimated = 0;
  const rows = history
    .toSorted((a, b) => a.startedAt - b.startedAt)
    .map((sweepHistory) => {
      const base = replayCards(sweepHistory, current);
      const next = replayCards(sweepHistory, candidate);
      estimated += next.estimated;
      return {
        h: sweepHistory,
        current: sweepMetrics(sweepHistory, base.cards, labels),
        candidate: sweepMetrics(sweepHistory, next.cards, labels),
      };
    });
  const labelled = rows.filter((r) => r.current.ndcg !== undefined && r.candidate.ndcg !== undefined);
  const heldN = labelled.length ? Math.max(1, Math.ceil(0.3 * labelled.length)) : 0;
  const held = labelled.slice(labelled.length - heldN);
  const train = labelled.slice(0, labelled.length - heldN);
  const diff = (r: (typeof rows)[number]) => r.candidate.ndcg! - r.current.ndcg!;
  const heldDiffs = held.map(diff);
  const trainDiff = avg(train.map(diff)) ?? 0;
  const heldDiff = avg(heldDiffs) ?? 0;
  const { low, high } = bootstrap(heldDiffs);
  const verdict = verdictOf({ labelled: labelled.length, low, high, trainDiff });
  const meanOf = (k: "current" | "candidate"): SweepMetrics => ({
    ...(avg(labelled.map((r) => r[k].ndcg)) !== undefined ? { ndcg: avg(labelled.map((r) => r[k].ndcg)) } : {}),
    ...(avg(labelled.map((r) => r[k].precision5)) !== undefined
      ? { precision5: avg(labelled.map((r) => r[k].precision5)) }
      : {}),
    ...(avg(labelled.map((r) => r[k].starRecall)) !== undefined
      ? { starRecall: avg(labelled.map((r) => r[k].starRecall)) }
      : {}),
    coverage: avg(rows.map((r) => r[k].coverage)) ?? 0,
  });
  const heldIds = new Set(held.map((r) => r.h.sweepId));
  return {
    variant,
    current,
    candidate,
    sweeps: { total: history.length, labelled: labelled.length, heldOut: held.length },
    perSweep: rows.map((r) => ({
      sweepId: r.h.sweepId,
      startedAt: new Date(r.h.startedAt).toISOString(),
      heldOut: heldIds.has(r.h.sweepId),
      current: r.current,
      candidate: r.candidate,
    })),
    mean: { current: meanOf("current"), candidate: meanOf("candidate") },
    train: { diff: trainDiff, n: train.length },
    heldOut: { diff: heldDiff, low, high, n: held.length },
    estimated,
    judgeUsed: !!labels.judge,
    verdict,
  };
}

/** Better only when the held-out interval is above zero and the earlier sweeps agree; worse when it is below. */
function verdictOf(x: { labelled: number; low: number; high: number; trainDiff: number }): Verdict {
  if (x.labelled < 3) return "not enough data";
  if (x.low > 0 && x.trainDiff > 0) return "better";
  if (x.high < 0) return "worse";
  return "inconclusive";
}
