# Spec Delta

## Purpose

Defines when each project's daily sweep and weekly review run, and guarantees that each scheduled run
starts exactly once per slot, even across restarts, missed ticks and manual triggers.

## ADDED Requirements

### Requirement: Default schedule
Each new project SHALL have a daily sweep at 06:00 and a weekly review on Sunday at 07:00, in the hub's configured time zone (default UTC).

#### Scenario: New project schedule
- **WHEN** a project is created
- **THEN** its settings show sweep "daily 06:00" and review "Sunday 07:00" with the time zone

### Requirement: Editable schedule
The user SHALL be able to change the sweep time, turn the sweep or review off, and choose the review weekday.

#### Scenario: Turn sweep off
- **WHEN** the user turns the daily sweep off
- **THEN** no sweep is requested for that project until it is turned on again

### Requirement: Exactly once per slot
A scheduled run SHALL start at most once per slot per project, identified by project, kind and slot, regardless of repeated ticks or restarts.

#### Scenario: Restart during a slot
- **WHEN** the hub restarts at 06:02 after the 06:00 sweep was already requested
- **THEN** no second sweep is requested for that slot

#### Scenario: Two ticks
- **WHEN** the scheduler checks twice within the same slot
- **THEN** only one run record exists for that slot

### Requirement: Catch-up after downtime
If the hub was down during a slot, it SHALL run the most recent missed slot once on startup and skip older missed slots.

#### Scenario: Down overnight for two days
- **WHEN** the hub starts at 10:00 after missing the last two 06:00 sweeps
- **THEN** exactly one sweep is requested, for today's slot, and the run log notes one skipped slot

### Requirement: Scheduler resolution
The scheduler SHALL check due slots at least every 5 minutes, so a run starts no later than 5 minutes after its slot time while the hub is up.

#### Scenario: On time
- **WHEN** the hub is running at 06:00
- **THEN** the 06:00 sweep is requested by 06:05

### Requirement: Manual trigger
The user SHALL be able to start a sweep or review immediately; a manual run SHALL NOT consume or block the next scheduled slot.

#### Scenario: Manual then scheduled
- **WHEN** the user triggers a sweep manually at 05:30
- **THEN** the 06:00 scheduled sweep still runs

### Requirement: One active run per kind
A project SHALL have at most one active sweep and one active review; a run requested while one is active SHALL be recorded as skipped with a reason.

#### Scenario: Overlap
- **WHEN** a manual sweep is requested while the scheduled sweep is still running
- **THEN** the manual request is recorded as skipped with reason "sweep already running"

### Requirement: Paused projects
Scheduled runs SHALL NOT start for paused or archived projects.

#### Scenario: Paused at slot time
- **WHEN** a paused project's 06:00 slot passes
- **THEN** no run is requested and none is caught up after resuming
