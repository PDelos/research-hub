# scheduling Specification

## Purpose

Defines when the project's daily sweep and weekly review run, and guarantees that each scheduled run starts
exactly once per slot, even across restarts, missed ticks and manual triggers.

## Requirements

### Requirement: Default schedule
The project SHALL have a daily sweep at `RH_SWEEP_TIME` (default 06:00) and a weekly review at `RH_REVIEW_TIME` (default Sunday 07:00), in the time zone `RH_TIMEZONE` (default UTC).

#### Scenario: New project schedule
- **WHEN** a project starts with `RH_SWEEP_TIME=06:20` and no other schedule settings
- **THEN** its settings show sweep "daily 06:20" and review "Sunday 07:00" with the time zone

### Requirement: Editable schedule
The user SHALL be able to change the sweep time, turn the sweep or review off, and choose the review weekday and time; saved settings SHALL take precedence over the environment defaults.

#### Scenario: Turn sweep off
- **WHEN** the user turns the daily sweep off
- **THEN** no sweep is requested until it is turned on again, including after a restart

### Requirement: Exactly once per slot
A scheduled run SHALL start at most once per slot, identified by kind and slot, regardless of repeated ticks or restarts.

#### Scenario: Restart during a slot
- **WHEN** the hub restarts at 06:02 after the 06:00 sweep was already requested
- **THEN** no second sweep is requested for that slot

#### Scenario: Two ticks
- **WHEN** the scheduler checks twice within the same slot
- **THEN** only one run record exists for that slot

### Requirement: Catch-up after downtime
If the hub was down during slots, it SHALL request the most recent missed slot once on startup and record older missed slots as skipped.

#### Scenario: Down for two days
- **WHEN** the hub starts at 10:00 after missing the last two 06:00 sweeps
- **THEN** exactly one sweep is requested, for today's slot, and the run log records yesterday's slot as skipped

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
The project SHALL have at most one active sweep and one active review; a run requested while one is active SHALL be recorded as skipped with a reason.

#### Scenario: Overlap
- **WHEN** a manual sweep is requested while the scheduled sweep is still running
- **THEN** the manual request is recorded as skipped with reason "sweep already running"

### Requirement: Paused project
Scheduled runs SHALL NOT start while the project is paused, and slots that passed while paused SHALL NOT be caught up after resuming.

#### Scenario: Paused at slot time
- **WHEN** the project is paused when its 06:00 slot passes
- **THEN** no run is requested, the slot is recorded skipped with "project paused", and nothing is caught up after resuming
