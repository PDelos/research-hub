# Spec Delta

## Purpose

Defines how research projects are created from a brief, how their charter is drafted and approved, how
they are paused or archived, and how each project stays isolated from the others.

## ADDED Requirements

### Requirement: Create a project
The user SHALL be able to create a project with a name and a markdown brief; the hub SHALL derive a unique URL-safe slug and create the project's own storage and root agent.

#### Scenario: New project
- **WHEN** the user creates a project named "Protein LMs" with a brief
- **THEN** a project with slug `protein-lms` appears on the hub page with status `drafting-charter`

#### Scenario: Duplicate name
- **WHEN** a second project with the same name is created
- **THEN** it receives a distinct slug such as `protein-lms-2`

### Requirement: Brief size and format
A brief SHALL be UTF-8 markdown of at most 50,000 characters; anything else SHALL be rejected with a reason.

#### Scenario: Oversized brief
- **WHEN** a 60,000-character brief is uploaded
- **THEN** the upload is rejected with a message stating the 50,000-character limit

### Requirement: Charter draft
After a brief is saved, the project agent SHALL draft a charter containing 3 to 7 research questions (each with a weight from 0.1 to 2, default 1), key concepts, sub-areas, 5 to 20 search queries and an out-of-scope list.

#### Scenario: Draft produced
- **WHEN** a brief is saved
- **THEN** within one agent run a charter draft is shown with every listed section filled and the questions numbered Q1..Qn

### Requirement: Scoping questions
Before finalizing the charter the agent SHALL ask the user at most 5 scoping questions, and SHALL fold the answers into the draft.

#### Scenario: Answers change the draft
- **WHEN** the user answers that clinical applications are out of scope
- **THEN** the next charter draft lists clinical applications under out-of-scope

### Requirement: Charter approval gate
A project SHALL NOT run sweeps until the user approves a charter; approval SHALL record a charter version, and later edits SHALL create a new version.

#### Scenario: Not approved
- **WHEN** a sweep slot becomes due for a project whose charter is still a draft
- **THEN** no sweep is requested and the run log shows "charter not approved"

#### Scenario: Edit after approval
- **WHEN** the user edits question Q2 of an approved charter and saves
- **THEN** charter version 2 is stored and version 1 remains readable

### Requirement: Pause, resume, archive
The user SHALL be able to pause a project (no scheduled runs), resume it, and archive it (hidden from the hub page, data kept, read-only).

#### Scenario: Paused
- **WHEN** a project is paused
- **THEN** none of its scheduled runs start until it is resumed, and chat still works

#### Scenario: Archived
- **WHEN** a project is archived
- **THEN** it disappears from the default hub list, its data remains on disk, and its agent rejects new messages

### Requirement: Project isolation
No project SHALL read or write another project's conversations, settings, papers, judgments or vault.

#### Scenario: Separate data
- **WHEN** a message is sent to project A
- **THEN** project B's conversation, run list and cost total are unchanged

### Requirement: Hub overview
The hub page SHALL list every non-archived project with its name, status, charter state, next scheduled run and cost this month.

#### Scenario: Overview
- **WHEN** two projects exist and one is paused
- **THEN** the hub page shows both, marks one as paused, and shows a next-run time only for the active one
