## ADDED Requirements

### Requirement: Question finders
New research questions SHALL come from pluggable finders (method transfer, missing links, rising topics built in)
whose leads the review model receives with the evidence; each add-question proposal SHALL name its finder, and the hub
SHALL show per finder the proposals, approvals, rejections and the liked cards of its approved questions.

#### Scenario: A method-transfer lead becomes a question
- **WHEN** two liked papers share a method but study different problems and the review model turns the lead into a direction
- **THEN** the proposal names the finder method-transfer, and the Charter tab counts it under that finder

### Requirement: Level-up proposals
The review SHALL propose the next level when most liked cards in the window are above the current level or "too
basic" reasons dominate; approving SHALL set the sweep's level as one undoable change used by sweeps and replays.

#### Scenario: Ready for advanced papers
- **WHEN** 9 of the 12 cards the user liked this month are advanced or frontier while the level is core
- **THEN** a proposal to set the level to advanced lists those cards

### Requirement: Taste-rule proposals
The review SHALL be able to turn generalizable reasons into at most 2 taste rules; an approved rule SHALL go with every
Jev paper decision.

#### Scenario: A rule from repeated reasons
- **WHEN** the user wrote "no clinical trials" on three cards and approves the proposed rule
- **THEN** the next sweep's paper decisions carry the rule
