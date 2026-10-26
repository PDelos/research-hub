## MODIFIED Requirements

### Requirement: Default schedule
The project SHALL have a daily sweep at `RH_SWEEP_TIME` (default 06:00), a nightly run at `RH_NIGHTLY_TIME` (default 02:00) and a weekly digest at `RH_REVIEW_TIME` (default Sunday 07:00), in the time zone `RH_TIMEZONE` (default UTC).

#### Scenario: New project schedule
- **WHEN** a project starts with `RH_SWEEP_TIME=06:20` and no other schedule settings
- **THEN** its settings show sweep "daily 06:20", nightly "daily 02:00" and digest "Sunday 07:00" with the time zone
