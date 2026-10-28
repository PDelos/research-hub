# knowledge-loop Specification

## Purpose
TBD - created by archiving change v1-5-knowledge-loop. Update Purpose after archive.

## Requirements

### Requirement: Knowledge review
The hub SHALL run a knowledge review before each weekly digest and on request; it SHALL produce charter proposals
from the evidence rules and from one review-model call, store a report with its cost, and never change the charter
without the user's approval.

#### Scenario: Review before the digest
- **WHEN** the weekly digest runs
- **THEN** a knowledge review runs first and the digest lists its proposals

### Requirement: Charter changes from evidence
The review SHALL propose, without a model call: a question or query weight at its learned value when it moved at
least 0.25 from the charter's weight; retiring a question with at least 8 judged cards and none liked in the window
(while more than 3 remain); dropping a query whose at least 10 carded papers had none liked (while more than 5
remain); each with its evidence.

#### Scenario: An unproductive question
- **WHEN** Q3 matched 9 judged cards in the last 28 days and the user liked none
- **THEN** a proposal to retire Q3 lists the 9 judgments as evidence

### Requirement: New research questions
The review SHALL ask the review model for at most 3 research directions (question, why, motivating papers, 2 queries)
and at most 2 out-of-scope topics from the user's judgments, reasons, comments, desk questions, unmatched liked papers
and the knowledge base's open questions; the Jev command `question-promise` SHALL score each direction and those
under 0.5 SHALL be dropped; out-of-scope topics SHALL need at least 2 "off topic" 👎 papers.

#### Scenario: A promising direction
- **WHEN** the model proposes "Do protein language models transfer to RNA structure?" motivated by 3 liked papers and Jev scores it 0.8
- **THEN** a proposal to add it as a question with its 2 queries lists the 3 papers

### Requirement: Approve, reject, undo
Approving a proposal SHALL create a new approved charter version with exactly that change (an open draft stays
untouched), replay the weights and update the vault's charter note, so the next sweep uses it; rejecting SHALL record
an optional reason; undo SHALL restore the previous charter as a new version while no later version exists; a
proposal whose target no longer exists SHALL become stale.

#### Scenario: Approve a new question
- **WHEN** the user approves adding a question to a charter of version 3 with Q1–Q5
- **THEN** version 4 has Q6 with the proposed text and queries, and the next sweep searches them
