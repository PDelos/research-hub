# Spec Delta

## Purpose

Defines how the user's judgments on paper cards are recorded and how they teach the system: weights,
few-shot examples for Jev, reason classification, quality metrics, and the hand-off of starred papers.

## ADDED Requirements

### Requirement: Judge a card
The user SHALL be able to judge any card as `down` (👎), `up` (👍) or `star` (⭐), optionally with a reason of at most 1,000 characters, from the UI, the API or by telling the agent in chat.

#### Scenario: Star with reason
- **WHEN** the user stars a card with the reason "Clear baseline for Q2, code available"
- **THEN** the judgment and reason are stored with the card and the card shows ⭐

#### Scenario: Via chat
- **WHEN** the user tells the agent "star the second card, great foundation"
- **THEN** the agent records a `star` judgment with that reason on the second card of the latest sweep

### Requirement: Change a judgment
A later judgment on the same card SHALL replace the earlier one, and its weight effects SHALL be recomputed so they are applied only once.

#### Scenario: Up then down
- **WHEN** the user changes a card from 👍 to 👎
- **THEN** the net weight change equals that of a single 👎

### Requirement: Weight nudges
A judgment SHALL change the weights of the card's matched research question, the queries that found it and its source: +0.10 for 👍, +0.15 for ⭐, −0.15 for 👎, with every weight clamped to the range 0.1 to 2.

#### Scenario: Clamp
- **WHEN** a query already at weight 2.0 receives a ⭐
- **THEN** its weight stays 2.0

#### Scenario: Visible change
- **WHEN** a judgment changes weights
- **THEN** the changed weights with before and after values are shown in the card's detail and in Settings

### Requirement: Never resurface rejected papers
A paper judged 👎 SHALL never be presented again in that project.

#### Scenario: Found again
- **WHEN** a 👎 paper is gathered by a later sweep
- **THEN** it is dropped in dedupe

### Requirement: Taste examples for Jev
Every Jev command that judges papers for the user (`on-theme`, `paper-kind`, `worth-reading`, `level`, `importance`) SHALL receive the 8 most recent judgments as taste examples (title, verdict, reason truncated to 200 characters); commands that do not depend on taste (`abstract-facets`, `ping`, `reason-parse`) do not.

#### Scenario: Example included
- **WHEN** the user judges a card and the next sweep's gate runs
- **THEN** the gate's recorded Jev input contains that judgment among its taste examples

### Requirement: Reason classification
Each non-empty reason SHALL be classified by Jev `reason-parse` into one of: off-topic, too-basic, too-advanced, low-trust, already-known, great-method, great-foundation, opens-direction, other, plus a yes/no "states a general rule".

#### Scenario: Rule candidate
- **WHEN** Jev judges a reason as stating a general rule with probability of at least 0.7
- **THEN** the reason is queued as a rule candidate for the weekly review and no LLM call is made

#### Scenario: Unclear reason
- **WHEN** the rule probability falls between 0.4 and 0.7
- **THEN** the reason is stored as `unclassified-rule` and not queued

### Requirement: Star hands off to the knowledge base
A ⭐ judgment SHALL create exactly one request to add the paper to the project's knowledge base, and un-starring before ingestion SHALL cancel it.

#### Scenario: Star twice
- **WHEN** the same card is starred twice
- **THEN** only one add-to-knowledge-base request exists

### Requirement: Precision metric
For each sweep the hub SHALL compute precision@5, the share of the top 5 cards judged 👍 or ⭐ among those judged, and show it as a trend per project.

#### Scenario: Precision
- **WHEN** of a sweep's top 5 cards 2 are starred, 1 is 👎 and 2 are not judged
- **THEN** that sweep's precision@5 is 2 of 3 judged, about 67%, with "3 of 5 judged" shown
