# daily-cycle Specification

## Purpose
TBD - created by archiving change v1-1-lite-daily-cycle. Update Purpose after archive.

## Requirements

### Requirement: One orchestrated daily cycle
Each project SHALL run one cycle without user action: the daily sweep at its sweep time, a nightly slot at
`RH_NIGHTLY_TIME` (default 02:00), and a weekly digest at the digest time (default Sunday 07:00), each requested
exactly once per slot; the user's only required actions are reading and judging.

#### Scenario: A simulated week
- **WHEN** an offline project with an approved charter runs for 7 simulated days with no user action
- **THEN** 7 sweeps, 7 nightly runs and 1 digest are recorded, each exactly once

### Requirement: Cycle status
The UI SHALL show where the cycle stands: the last sweep and its card count, how many cards wait for a judgment,
and the next sweep, nightly run and digest times.

#### Scenario: Cards waiting
- **WHEN** the last sweep produced 7 cards and the user judged 3
- **THEN** the status shows "4 cards waiting" with the next nightly and digest times

### Requirement: Exploration pick
Each sweep with at least one 👍 or ⭐ in the project SHALL make its last card slot an exploration pick: among the
gated papers outside the top `n-1`, the one with the lowest highest cosine similarity (whole-paper vectors) to the
papers the user judged 👍 or ⭐; the card SHALL be marked "Exploration". The number of picks is the `rh.sweep`
setting `explorationPicks` (default 1, 0 to 2).

#### Scenario: Pick marked
- **WHEN** a sweep runs after the user starred papers about contact prediction and a gated paper about protein design ranks 9th
- **THEN** that paper takes the 7th card slot and its card shows "Exploration"

#### Scenario: No judgments yet
- **WHEN** a sweep runs before any 👍 or ⭐
- **THEN** no exploration pick is made and the top 7 by rank become cards

### Requirement: What changed, with undo
The hub SHALL list every change to the plugin state with its time, who made it (user, kernel, an automatic fix),
its message and an Undo that reverses only that change, leaving later changes in place; an undo SHALL itself be a
listed change.

#### Scenario: Undo one change
- **WHEN** the user changed cards per sweep and later disabled the Europe PMC source, then undoes the first change
- **THEN** cards per sweep returns to its earlier value, Europe PMC stays disabled, and "undo: …" is listed

#### Scenario: Conflicting undo
- **WHEN** a change is undone whose setting was changed again later
- **THEN** the undo is refused with "a later change touched the same setting" and nothing changes

### Requirement: Weekly digest
The weekly digest SHALL summarize the week: sweeps and cards, judgments and precision@5 per sweep, exploration
picks and their judgments, knowledge-base additions, cost, every change with Undo, the previous digest's
comments, quality (the judge's agreement with the user and the replays of the week with their verdicts), and
sources (the cards each paper source brought and how many were liked); it SHALL be computed from the project's
records without an LLM call.

#### Scenario: Digest contents
- **WHEN** the digest runs after a week with 7 sweeps, 12 judgments, 2 knowledge-base notes and one plugin change
- **THEN** it lists those figures, the precision@5 of each sweep, the change with Undo, and costs $0 to produce

#### Scenario: Quality section
- **WHEN** two replays ran during the week and the judge agrees in 31 of 40 cases
- **THEN** the digest's Quality section shows "judge agrees in 78 % (40 cases)" and both replays with their verdicts

#### Scenario: Sources section
- **WHEN** arXiv brought 5 cards this week, 3 liked, and Europe PMC 2, none liked
- **THEN** the Sources section lists both with those numbers

### Requirement: Comments on the digest
The user SHALL be able to comment on each section of a digest; comments SHALL be stored with the digest and
section, shown in the next digest, and emitted as `digest.comment` events for later plugins.

#### Scenario: Comment carried forward
- **WHEN** the user comments "too many reviews, more methods papers" on the cards section
- **THEN** the comment is stored, and the next digest shows it under "Your comments last week"
