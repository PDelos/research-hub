# paper-cards Specification

## Purpose
Defines the paper cards a sweep presents: what each card shows, how its scores are derived from
recorded decisions, and the rules that keep cards honest, consistent and never duplicated.

## Requirements

### Requirement: Card content
Every card SHALL show the title, authors, year, venue or preprint server, a link, a summary of at most 80 words, the matched research question, the level, and Relevance, Trust and Value scores from 0 to 100, each with a reason of at most 120 characters.

#### Scenario: Complete card
- **WHEN** a candidate is presented
- **THEN** its card contains every listed field and no score lacks a reason

### Requirement: Scores come from recorded signals
Relevance SHALL derive from Jev `on-theme` and question weight; Trust from recorded metadata (peer-reviewed venue, citations per year, open-access PDF, retraction); Value from Jev `worth-reading` novelty and paper kind. The agent SHALL NOT invent score values.

#### Scenario: Score traceability
- **WHEN** the user opens a card's details
- **THEN** each score shows the decisions and metadata it was computed from, with Jev command versions

### Requirement: Retracted papers blocked
A paper flagged as retracted SHALL NOT be presented as a card.

#### Scenario: Retraction
- **WHEN** a ranked candidate is marked retracted
- **THEN** no card is created and the run log records it as blocked

### Requirement: Field-aware peer review
In Trust, a preprint SHALL lower the score less in fields where preprints are the norm (arXiv cs.*, q-bio.*) than elsewhere.

#### Scenario: AI preprint
- **WHEN** two otherwise identical papers are scored, one an arXiv cs.LG preprint and one a bioRxiv preprint
- **THEN** the trust reason for each names its preprint status and the cs.LG paper is penalized less

### Requirement: Summary grounded in the abstract
A card's summary SHALL be written from the paper's title and abstract only and SHALL NOT state results that are not in them.

#### Scenario: No invented results
- **WHEN** an abstract reports no numbers
- **THEN** the card summary contains no numeric results

### Requirement: One card per paper
A paper SHALL have at most one card per project, even if the presenting tool call is replayed after a crash.

#### Scenario: Replay
- **WHEN** the process dies after a card was created and the agent turn is replayed
- **THEN** the replay returns the existing card and the feed shows it once

### Requirement: Borderline flag
A card for a paper that passed the gate in the review band SHALL be visibly flagged as borderline.

#### Scenario: Borderline shown
- **WHEN** a borderline paper becomes a card
- **THEN** the card shows a borderline badge with the relevance value

### Requirement: Feed
The Feed view SHALL list cards grouped by sweep, newest first, and update live when a sweep presents new cards.

#### Scenario: Live feed
- **WHEN** a sweep presents a card while the Feed is open
- **THEN** the card appears without a page reload

### Requirement: Sweep completion
Every sweep that produced candidates SHALL end with a completion record listing the cards presented; candidates the agent did not present SHALL be listed with a reason.

#### Scenario: Skipped candidate
- **WHEN** the agent presents 6 of 7 candidates
- **THEN** the completion record lists the 7th with the agent's reason
