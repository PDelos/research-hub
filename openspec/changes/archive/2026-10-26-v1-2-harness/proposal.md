## Why

The cycle (v1-1) runs, but nothing can yet tell whether a change to the finding loop (a gate threshold, the rank
weights, the number of cards) would give the user better cards. Self-improvement (v1-3) needs a referee that
measures that on the user's own judgments, cheaply, without experimenting on the live feed, and that admits when
it does not know.

## What Changes

- **The sweep's knobs become settings** of `rh.sweep`: `relevanceMin` and `worthMin` (gate thresholds, default the
  Jev commands' policy values 0.45 and 0.35) and `rankWeights` (importance, relevance, question, level, freshness;
  default 0.4, 0.2, 0.15, 0.15, 0.1). Same behavior by default; every change is a plugin-state commit with undo.
- **Replays** (new capability `harness`, plugin `rh.harness`): a variant (any of those settings plus
  `cardsPerSweep` and `explorationPicks`) is applied to past sweeps from their stored Jev scores (no new Jev calls,
  no search): re-gate, re-rank, pick cards. The result is scored against labels and compared with the current
  settings replayed the same way.
- **Labels:** the user's verdict where the paper was judged; otherwise the **judge**, a new Jev command
  `would-like` (taste examples from the user's judgments + the paper's title and abstract → probability the user
  would mark it 👍/⭐), used only while it is **calibrated**: on the user's judged papers (each judged without itself
  among the examples) it must agree in at least 70 % of at least 20 cases.
- **Metrics:** nDCG@n (⭐ 2, 👍 1, 👎 0), precision@5, recall of ⭐, label coverage, cost; per sweep, averaged, with a
  **paired bootstrap** 95 % interval of the difference to the current settings; sweeps split by time into train
  (older) and **held-out** (the latest 30 %, at least one). Verdict: better (held-out lower bound > 0 and train
  difference > 0), worse (upper bound < 0) or inconclusive; "not enough data" under 3 labelled sweeps.
- **Nightly labelling:** the nightly run labels unlabelled papers of recent sweeps within a daily budget
  (`rh.harness` budget $0.20/day) and recalibrates the judge.
- **Quality in the digest and a Quality tab:** the judge's agreement with the user, nDCG and precision of the
  current settings over time, and every replay with its numbers and verdict. The desk gets a `replay_variant`
  chat tool so the user can ask "would 10 cards a day be better?".

Jev: one new command `would-like` (bounded probability; policy `trust_min_agreement` 0.7, `trust_min_cases` 20).
No LLM calls.

## Out of scope

Proposing and applying fixes (v1-3); variants that need new Jev calls or re-embedding (prompt wording, another
embedder); online experiments of any kind.

## Capabilities

### New Capabilities
- `harness`: variants, replays, labels and the calibrated judge, metrics with intervals, verdicts, nightly
  labelling, Quality view, the `replay_variant` tool.

### Modified Capabilities
- `paper-sweep`: gate thresholds and rank weights come from `rh.sweep` settings.
- `daily-cycle`: the digest gains a Quality section.

## Impact

`rh.sweep` (settings, sweep reads them), new built-in `rh.harness` (tables `p_rh_harness__*`, Jev command
`would-like`, nightly hook, routes `/v1/harness/*`, tab Quality, chat tool), `rh.digest` (Quality section, a
`cycle.nightly` event), SDK types and methods, UI (Quality tab, digest section).
