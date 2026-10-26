## Context

v1-1 runs the daily cycle. The finding loop's behavior is set by the gate thresholds (in the Jev commands'
policies), the rank formula (fixed weights in code), the number of cards and exploration picks. v1-3 will change
these automatically; v1-2 builds the referee.

## Goals / Non-Goals

**Goals:** the knobs as undoable settings; replays of past sweeps with no new paid calls; labels from the user,
extended by a judge only when it has proven to agree with the user; honest statistics (held-out split, paired
bootstrap, explicit "not enough data"); visible results.

**Non-Goals:** variants that need new Jev or LLM calls (prompt wording) or re-embedding; producing fixes (v1-3).

## Decisions

### D1. Knobs as settings
`rh.sweep` declares `relevanceMin` (0–1), `worthMin` (0–1) and `rankWeights` (object of five numbers ≥ 0, summing
to more than 0), without saved values by default; the sweep reads a setting when present and the command policy or
the built-in weights otherwise, so behavior is unchanged until something is set. Like v1-1's settings, they apply
live (no restart).

### D2. Replays
`src/harness` (pure functions): `replaySweep(sweep, variant, features, labels)` returns the replayed cards and the
metrics. Features per sweep come from `sweep_papers` (relevance, worth, importance, level, matched question,
borderline) and the papers (publication date); the question weight comes from the charter version the sweep used
(`charters` by date); level fit uses the sweep's orientation flag; freshness is measured from the sweep's start.
Papers rejected by a lower threshold lack importance and level: they get the sweep's median importance and the
"core" level, and are counted as estimated. Exploration picks are replayed with whole-paper vectors and the papers
liked before that sweep. Sweeps without cards or labels are skipped (counted).

### D3. Labels and the judge
Label gain: ⭐ 2, 👍 1, 👎 0 from the user's verdict on that paper (any card); else, while the judge is trusted, the
judge's probability × 1.5 (between 👍 and ⭐ at certainty, 0 at 0). The `would-like` Jev command (one noul
question) gets the charter's questions, up to 12 taste examples (title, verdict, reason; the paper itself never
among them) and the paper's title and abstract. Calibration re-judges up to the 60 most recent judged papers;
agreement = share with (probability ≥ 0.5) = (verdict is 👍 or ⭐); Cohen's kappa is reported too. Labels are
cached in `p_rh_harness__labels` (paper, command version, probability) and calibrations in
`p_rh_harness__calibrations`.

### D4. Statistics
nDCG@n with the replayed n (ideal: the best ordering of all labelled papers in that sweep's pool); precision@5
counts gain > 0.75 as good among labelled cards; recall of ⭐: starred papers of the sweep's pool that are cards.
Held-out: the latest ⌈30 %⌉ of the labelled sweeps (at least one). Paired bootstrap: 1,000 resamples of sweeps
with a seeded generator (reproducible), 2.5 % and 97.5 % quantiles of the mean nDCG difference.

### D5. `rh.harness`
A required built-in plugin with its tables (`p_rh_harness__labels`, `__calibrations`, `__replays`), the Jev
command `would-like` (folder `plugins/rh.harness/jev/would-like`, its own lock), permission budget $0.20/day for
labelling through `rh.decisions`, a listener on the `cycle.nightly` event that `rh.digest` emits after recording a
night, routes `/v1/harness/{quality,replays,replay}`, the Quality tab (order 16) and the desk tool
`replay_variant` (a pi-durable tool with `once`).

## Risks / Trade-offs

- Replays only see papers that were found: a variant cannot be credited for papers no sweep gathered → stated in
  the report; query variants come with v1-3's live checks.
- The judge can share the user's blind spots → it is only trusted with measured agreement, and user verdicts always
  win.
- Few judgments early → "not enough data" rather than a guess.
