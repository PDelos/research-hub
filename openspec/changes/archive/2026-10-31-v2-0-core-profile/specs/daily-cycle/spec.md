## MODIFIED Requirements

### Requirement: One orchestrated daily cycle
Each project SHALL run one cycle without user action: the daily sweep at its sweep time, a nightly slot at
`RH_NIGHTLY_TIME` (default 02:00), and a weekly digest at the digest time (default Sunday 07:00), each requested
exactly once per slot; the user's only required actions are reading and judging. The cycle SHALL run the same way
when the optional self-improvement plugins (harness, weekly upgrade, knowledge review, engineer) are disabled; the
nightly run and the digest then skip their parts.

#### Scenario: A simulated week
- **WHEN** an offline project with an approved charter runs for 7 simulated days with no user action
- **THEN** 7 sweeps, 7 nightly runs and 1 digest are recorded, each exactly once

#### Scenario: A simulated week in the core profile
- **WHEN** the same week runs with the harness, weekly upgrade, knowledge review and engineer plugins disabled
- **THEN** 7 sweeps, 7 nightly runs and 1 digest are recorded, each exactly once and none failed

### Requirement: Weekly digest
The weekly digest SHALL summarize the week: sweeps and cards, judgments and precision@5 per sweep, exploration
picks and their judgments, knowledge-base additions, cost, every change with Undo, the previous digest's
comments, quality (the judge's agreement with the user and the replays of the week with their verdicts), sources
(the cards each paper source brought and how many were liked), the week's upgrade (its focus, what was tried,
what was applied or proposed), and the charter proposals of the knowledge review with Approve / Reject; it SHALL be
computed from the project's records without an LLM call (the knowledge review runs before it). A section whose
plugin is disabled (quality and sources: the harness; upgrade: the weekly upgrade; charter: the knowledge review)
SHALL be left out. In the core profile the digest view SHALL also leave out every section with nothing to report.

#### Scenario: Digest contents
- **WHEN** the digest runs after a week with 7 sweeps, 12 judgments, 2 knowledge-base notes and one plugin change
- **THEN** it lists those figures, the precision@5 of each sweep, the change with Undo, and costs $0 to produce

#### Scenario: Quality section
- **WHEN** two replays ran during the week and the judge agrees in 31 of 40 cases
- **THEN** the digest's Quality section shows "judge agrees in 78 % (40 cases)" and both replays with their verdicts

#### Scenario: Sources section
- **WHEN** arXiv brought 5 cards this week, 3 liked, and Europe PMC 2, none liked
- **THEN** the Sources section lists both with those numbers

#### Scenario: Upgrade section
- **WHEN** this week's upgrade applied `relevanceMin` 0.5
- **THEN** the Upgrade section shows the focus, the variants tried and the applied change with Undo

#### Scenario: Charter and questions section
- **WHEN** the knowledge review proposed retiring Q3 and adding a new question
- **THEN** the section lists both with their evidence and Approve / Reject

#### Scenario: Digest with the self-improvement plugins off
- **WHEN** the digest runs while the harness, weekly upgrade and knowledge review plugins are disabled
- **THEN** the digest is built without error and has no Quality, Sources, Upgrade or Charter section

#### Scenario: Only non-empty sections in core
- **WHEN** in the core profile a week had sweeps and judgments but no exploration picks and no plugin changes
- **THEN** the digest view shows the cycle and judgments sections and no Exploration or Changes section
