## ADDED Requirements

### Requirement: Level and taste-rule settings
The sweep SHALL have a `level` setting (auto by default, keeping the earlier level fit) that makes papers at that
level fit best, and a `tasteRules` setting whose rules go with every paper decision; both SHALL be undoable plugin
settings and replays SHALL use the level.

#### Scenario: Level set to advanced
- **WHEN** the level is advanced
- **THEN** an advanced paper gets level fit 1 and a foundational one 0.5
