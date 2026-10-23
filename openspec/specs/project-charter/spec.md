# project-charter Specification

## Purpose

Defines how the container's single research project gets its direction: the user's brief, the agent-drafted
charter refined through scoping questions and approved by the user, charter versions, pausing, and the overview.

## Requirements

### Requirement: Brief
The user SHALL be able to provide the project brief as UTF-8 markdown of at most 50,000 characters, by pasting or uploading a file, and to replace it later; anything else SHALL be rejected with a reason.

#### Scenario: First start
- **WHEN** the UI is opened for a project without a brief
- **THEN** it shows a brief screen and the project status is `needs-brief`

#### Scenario: Oversized brief
- **WHEN** a 60,000-character brief is submitted
- **THEN** it is rejected with a message stating the 50,000-character limit and nothing is stored

### Requirement: Charter draft
After a brief is saved, the agent SHALL draft a charter with 3 to 7 research questions (each weight 0.1 to 2, default 1), key concepts, sub-areas, 5 to 20 search queries and an out-of-scope list, using the configured `review` model in a conversation separate from chat.

#### Scenario: Draft produced
- **WHEN** a brief is saved
- **THEN** within one agent run a charter draft is shown with every section filled, questions numbered Q1..Qn, and status `charter-review`

#### Scenario: Separate from chat
- **WHEN** the charter is drafted
- **THEN** the chat transcript contains no drafting messages, and the run record shows the `review` model

### Requirement: Invalid drafts are corrected, never stored
A draft violating the charter rules SHALL be rejected back to the agent with the exact violation; only valid drafts SHALL be stored, and after 3 invalid attempts the run SHALL be marked failed with a retry option.

#### Scenario: Too many questions
- **WHEN** the agent submits a draft with 9 research questions
- **THEN** it receives "questions: 9 given, 3 to 7 allowed", the draft is not stored, and a corrected draft is stored afterwards

### Requirement: Scoping questions
Before the charter is approved the agent SHALL ask the user at most 5 scoping questions in total and SHALL fold the answers into a revised draft.

#### Scenario: Answers change the draft
- **WHEN** the user answers that clinical applications are out of scope
- **THEN** the next charter draft lists clinical applications under out-of-scope

#### Scenario: Question cap
- **WHEN** the agent tries to ask a sixth question
- **THEN** the question is rejected and not shown to the user

### Requirement: Charter approval gate and versions
The project SHALL NOT run sweeps until the user approves a charter; approval SHALL record a numbered version, and later edits or a new brief SHALL create a new draft while the approved version stays in force until the next approval.

#### Scenario: Not approved
- **WHEN** a sweep slot becomes due while the charter is still a draft
- **THEN** no sweep is requested and the run log shows "charter not approved"

#### Scenario: Edit after approval
- **WHEN** the user edits question Q2 of approved version 1 and approves
- **THEN** version 2 is in force and version 1 remains readable

### Requirement: Pause and resume
The user SHALL be able to pause the project (no scheduled runs start; chat and reading still work) and resume it.

#### Scenario: Paused
- **WHEN** the project is paused
- **THEN** none of its scheduled runs start until it is resumed, and chat still works

### Requirement: Project overview
The UI SHALL show the project's name, status (`needs-brief`, `charter-review`, `active`, `paused`), charter version, next scheduled sweep and review, and cost this month.

#### Scenario: Overview
- **WHEN** the project is active with charter version 2
- **THEN** the overview shows `active`, version 2, the next sweep and review times with the time zone, and the month's cost
