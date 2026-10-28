## MODIFIED Requirements

### Requirement: Charter approval gate and versions
The project SHALL NOT run sweeps until the user approves a charter; approval SHALL record a numbered version, and later edits or a new brief SHALL create a new draft while the approved version stays in force until the next approval. An approved knowledge proposal SHALL also create the next version directly; question ids SHALL stay stable across such versions (a retired question's id is not reused by shifting, a new question gets the next free id).

#### Scenario: Not approved
- **WHEN** a sweep slot becomes due while the charter is still a draft
- **THEN** no sweep is requested and the run log shows "charter not approved"

#### Scenario: Edit after approval
- **WHEN** the user edits question Q2 of approved version 1 and approves
- **THEN** version 2 is in force and version 1 remains readable

#### Scenario: Retire keeps ids
- **WHEN** a proposal retiring Q2 of Q1–Q4 is approved
- **THEN** the new version has Q1, Q3 and Q4
