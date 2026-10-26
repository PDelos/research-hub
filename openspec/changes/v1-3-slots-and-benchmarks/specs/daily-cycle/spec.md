## MODIFIED Requirements

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
