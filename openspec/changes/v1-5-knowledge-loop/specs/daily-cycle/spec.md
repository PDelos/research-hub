## MODIFIED Requirements

### Requirement: Weekly digest
The weekly digest SHALL summarize the week: sweeps and cards, judgments and precision@5 per sweep, exploration
picks and their judgments, knowledge-base additions, cost, every change with Undo, the previous digest's
comments, quality (the judge's agreement with the user and the replays of the week with their verdicts), sources
(the cards each paper source brought and how many were liked), the week's upgrade (its focus, what was tried,
what was applied or proposed), and the charter proposals of the knowledge review with Approve / Reject; it SHALL be
computed from the project's records without an LLM call (the knowledge review runs before it).

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
