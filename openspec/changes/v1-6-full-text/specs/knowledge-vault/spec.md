## ADDED Requirements

### Requirement: Notes from the full text
The librarian SHALL receive a starred paper's full text, when the hub has it, in addition to the abstract, and its
groundedness check SHALL accept numbers found in the full text.

#### Scenario: A number from the results section
- **WHEN** the note cites "0.87 AUROC" that appears only in the full text's results section
- **THEN** the note is accepted
