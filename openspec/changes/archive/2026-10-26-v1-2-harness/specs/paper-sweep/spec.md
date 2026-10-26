## MODIFIED Requirements

### Requirement: Jev gate
Every new paper SHALL be judged by Jev on title and abstract with `on-theme` (relevance score, matched research question), `paper-kind` and `worth-reading`; papers below `relevanceMin` (an `rh.sweep` setting, default the command's `relevance_min` 0.45) or `worthMin` (default the command's `worth_min` 0.35) SHALL be rejected with the reason stored.

#### Scenario: Off-topic paper
- **WHEN** Jev scores a paper's relevance at 0.2
- **THEN** the paper is rejected with reason "below relevance_min 0.45" and never reaches the agent

#### Scenario: Review band
- **WHEN** a paper's relevance falls within the review band (0.45 to 0.55)
- **THEN** it passes the gate flagged `borderline`, and the flag is shown if it becomes a card

#### Scenario: Threshold setting
- **WHEN** `relevanceMin` is set to 0.5
- **THEN** the next sweep rejects a paper with relevance 0.48 with reason "below relevance_min 0.5"

### Requirement: Ranking
Survivors SHALL be ranked by Jev `importance` combined with Jev relevance, question weight, level fit (orientation favors foundational and core) and freshness, weighted by the `rh.sweep` setting `rankWeights` (default importance 0.4, relevance 0.2, question 0.15, level 0.15, freshness 0.1), and the top N (default 7, range 1 to 15) SHALL become candidates.

#### Scenario: Card cap
- **WHEN** 30 papers survive the gate and N is 7
- **THEN** exactly 7 candidates are returned in rank order and the other 23 are stored as ranked out
