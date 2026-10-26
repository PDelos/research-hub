// Spec harness: Replay from stored scores, Metrics and intervals, Verdicts (v1-2 task 2.1), on a synthetic history.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bootstrap,
  DEFAULT_SETTINGS,
  replay,
  replayCards,
  type Labels,
  type SweepHistory,
} from "../src/harness/replay.ts";

const DAY = 86_400_000;
const start = Date.parse("2026-10-01T06:00:00Z");

/** Sweeps whose most relevant papers are the user's favourites, while importance points the other way. */
function history(sweeps: number): { history: SweepHistory[]; labels: Labels } {
  const user: Labels["user"] = new Map();
  const history = Array.from({ length: sweeps }, (_, s) => {
    const pool = Array.from({ length: 10 }, (_, i) => {
      const paperId = s * 100 + i;
      const relevance = 0.5 + i * 0.05;
      user.set(paperId, relevance >= 0.85 ? "star" : relevance <= 0.6 ? "down" : "up");
      return { paperId, relevance, worth: 0.8, importance: 1 - relevance, level: "core" as const };
    });
    return { sweepId: s + 1, startedAt: start + s * DAY, orientation: false, pool, liked: [], vectors: new Map() };
  });
  return { history, labels: { user } };
}

const settings = { ...DEFAULT_SETTINGS, cardsPerSweep: 3, explorationPicks: 0 };

test("a variant that ranks by relevance wins on held-out sweeps; one that ranks by importance alone loses", () => {
  const { history: h, labels } = history(10);
  const better = replay(
    h,
    settings,
    { rankWeights: { importance: 0, relevance: 1, question: 0, level: 0, freshness: 0 } },
    labels,
  );
  assert.equal(better.sweeps.labelled, 10);
  assert.equal(better.sweeps.heldOut, 3);
  assert.equal(better.verdict, "better");
  assert.ok(better.heldOut.low > 0 && better.train.diff > 0);
  assert.ok(better.mean.candidate.ndcg! > better.mean.current.ndcg!);
  assert.equal(better.mean.candidate.starRecall, 1);
  assert.equal(
    better.perSweep
      .filter((p) => p.heldOut)
      .map((p) => p.sweepId)
      .join(),
    "8,9,10",
    "the latest sweeps are held out",
  );

  const worse = replay(
    h,
    { ...settings, rankWeights: { importance: 0, relevance: 1, question: 0, level: 0, freshness: 0 } },
    { rankWeights: { importance: 1, relevance: 0, question: 0, level: 0, freshness: 0 } },
    labels,
  );
  assert.equal(worse.verdict, "worse");
  assert.ok(worse.heldOut.high < 0);

  const same = replay(h, settings, {}, labels);
  assert.equal(same.verdict, "inconclusive");
  assert.equal(same.heldOut.diff, 0);
});

test("too few labelled sweeps say so; unlabelled cards lower coverage instead of counting as bad", () => {
  const { history: h, labels } = history(2);
  assert.equal(replay(h, settings, { cardsPerSweep: 5 }, labels).verdict, "not enough data");
  const sparse: Labels = { user: new Map([...labels.user].filter(([id]) => id % 2 === 0)) };
  const r = replay(history(4).history, settings, {}, sparse);
  assert.ok(r.mean.current.coverage > 0 && r.mean.current.coverage < 1);
  assert.ok(r.mean.current.ndcg! >= 0 && r.mean.current.ndcg! <= 1);
});

test("a lower threshold admits rejected papers, which use estimated features and are counted", () => {
  const { history: h, labels } = history(4);
  for (const sweep of h)
    sweep.pool.push(
      { paperId: sweep.sweepId * 100 + 50, relevance: 0.4, worth: 0.8 },
      { paperId: sweep.sweepId * 100 + 51, relevance: 0.2, worth: 0.8 },
    );
  const r = replay(h, settings, { relevanceMin: 0.35 }, labels);
  assert.equal(r.estimated, 4, "one admitted paper per sweep (0.4), not the 0.2 one");
  assert.ok(replayCards(h[0], { ...settings, relevanceMin: 0.1 }).estimated === 2);
});

test("the bootstrap is reproducible and brackets the mean", () => {
  const diffs = [0.1, 0.2, 0.15, 0.05, 0.12];
  assert.deepEqual(bootstrap(diffs), bootstrap(diffs));
  const { low, high } = bootstrap(diffs);
  assert.ok(low <= 0.124 && high >= 0.124 && low > 0);
});
