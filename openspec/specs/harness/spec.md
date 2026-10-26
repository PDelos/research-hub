# harness Specification

## Purpose
TBD - created by archiving change v1-2-harness. Update Purpose after archive.

## Requirements

### Requirement: Variants
A variant SHALL be a partial set of `rh.sweep` settings among `relevanceMin`, `worthMin`, `rankWeights`,
`cardsPerSweep` and `explorationPicks`; an invalid variant SHALL be refused with the setting and the rule.

#### Scenario: Invalid variant
- **WHEN** a replay is requested with `cardsPerSweep` 40
- **THEN** it is refused with "cardsPerSweep: must be an integer from 1 to 15"

### Requirement: Replay from stored scores
A replay SHALL re-gate, re-rank and pick cards for each past sweep from the Jev scores stored for that sweep's
papers, without new Jev calls, searches or embeddings; papers admitted by a lower threshold that were never leveled
or scored for importance SHALL use the sweep's median values and be counted as estimated.

#### Scenario: No new calls
- **WHEN** a variant with `relevanceMin` 0.35 is replayed over 10 sweeps
- **THEN** no Jev, model, search or embedding call is made, and papers rejected only for relevance between 0.35 and 0.45 take part

### Requirement: Labels and the calibrated judge
A replayed card SHALL be labelled with the user's verdict when the paper was judged, otherwise with the
`would-like` judge's probability, but only while the judge is calibrated: judged papers re-judged without
themselves among the taste examples agree with the user (probability ≥ 0.5 ⇔ 👍/⭐) in at least 70 % of at least
20 cases; otherwise unjudged cards stay unlabelled and coverage drops.

#### Scenario: Uncalibrated judge
- **WHEN** the judge agrees in 12 of 20 cases (60 %)
- **THEN** replays use only the user's verdicts and the Quality view says the judge is not trusted yet

### Requirement: Metrics and intervals
Each replay SHALL report per sweep and on average nDCG@n (⭐ 2, 👍 1, 👎 0), precision@5, recall of ⭐ and label
coverage for the variant and for the current settings, and the paired bootstrap 95 % interval (1,000 resamples of
sweeps) of the nDCG difference on the held-out sweeps (the latest 30 %, at least one) and on the others.

#### Scenario: Interval reported
- **WHEN** a variant is replayed over 10 labelled sweeps
- **THEN** the report shows 3 held-out sweeps, the nDCG difference with its 95 % interval, and the train difference

### Requirement: Verdicts
A replay SHALL conclude "better" when the held-out interval's lower bound is above 0 and the train difference is
above 0, "worse" when the held-out upper bound is below 0, "not enough data" with fewer than 3 labelled sweeps,
and "inconclusive" otherwise.

#### Scenario: Clear win
- **WHEN** a variant raises held-out nDCG with the interval [0.04, 0.12] and train by 0.05
- **THEN** the verdict is "better"

### Requirement: Nightly labelling within budget
The nightly run SHALL recalibrate the judge and label unlabelled papers of the last 30 days' sweeps, newest first,
until `rh.harness`'s daily budget (default $0.20) is used; labels are cached per paper and command version.

#### Scenario: Budget reached
- **WHEN** labelling reaches the daily budget
- **THEN** it stops, the remaining papers wait for the next night, and nothing else is affected

### Requirement: Quality view
The UI SHALL show the judge's agreement with the user (with the number of cases), the current settings' nDCG and
precision@5 per sweep over time, and every replay with its variant, numbers, interval and verdict.

#### Scenario: Reading the Quality tab
- **WHEN** the user opens the Quality tab after two replays
- **THEN** both replays are listed with their verdicts, and the judge's agreement is shown

### Requirement: Ask in chat
The research desk SHALL have a `replay_variant` tool that replays a variant and answers with the verdict and the
main numbers.

#### Scenario: Question in chat
- **WHEN** the user asks the desk "would 10 cards a day be better?"
- **THEN** the desk replays `cardsPerSweep` 10 and answers with the verdict, the nDCG difference and its interval
