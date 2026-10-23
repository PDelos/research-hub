# jev-client Specification

## Purpose

Defines how the hub asks Jev for bounded decisions (yes/no, choice, score), so that every judgment is
versioned, reproducible, costed and safe to run offline, before any paper decisions are built on it.

## Requirements

### Requirement: Commands as versioned files
Every Jev decision SHALL be defined as a command file holding its state template, questions, policy thresholds and a version number; a decision SHALL be recorded with the command name and version that produced it.

#### Scenario: Version recorded
- **WHEN** a command runs
- **THEN** its ledger entry contains the command name, the command version and the resolved model ID

#### Scenario: Changed question
- **WHEN** a question's wording in a command changes without its version changing
- **THEN** the command check fails and reports the command name

### Requirement: Question types
Commands SHALL use only three Jev question types: yes/no (`noul`), choice among at most 255 options, and score with 2 to 10 ordered levels (image `box` questions are not used).

#### Scenario: Too many choices
- **WHEN** a command defines a choice question with 256 options
- **THEN** it is rejected before any request is sent

### Requirement: Provider selection
In live mode the client SHALL send every Jev request through OpenRouter, report the provider and resolved model at startup, and never fall back to another provider or the mock after a failed request.

#### Scenario: Provider reported
- **WHEN** the hub starts in live mode with `OPENROUTER_API_KEY`
- **THEN** `/v1/info` reports the Jev provider as `openrouter` and the resolved Jev model ID

#### Scenario: Provider failure
- **WHEN** a Jev request fails after its retries
- **THEN** the caller receives an error and no mock or other-provider answer is substituted

### Requirement: Pinned Jev model
The Jev model ID SHALL come from configuration (default `typesafe/jev-1.14`), and a moving alias such as `~typesafe/jev-latest` SHALL be used only when configured explicitly.

#### Scenario: Default model
- **WHEN** no Jev model is configured
- **THEN** requests use `typesafe/jev-1.14` and the ledger records that ID

### Requirement: Input size limit
A command's rendered input SHALL be at most 30,000 bytes of text; larger input SHALL be rejected before sending, because Jev switches to a slower, less accurate long-context mode above about 32,000 bytes.

#### Scenario: Oversized input
- **WHEN** a command is rendered with 40,000 bytes of text
- **THEN** it fails with an input-too-large error naming the command, and no request is sent

### Requirement: Retries and timeouts
Each Jev request SHALL time out after 30 seconds and retry at most 3 attempts in total on rate-limit or server-overload responses.

#### Scenario: Rate limited once
- **WHEN** the first attempt returns HTTP 429 and the second succeeds
- **THEN** the caller receives the second answer and the ledger records 2 attempts

### Requirement: Mock backend for tests
With `JEV_BACKEND=mock` or in offline mode, the client SHALL return deterministic answers without network access; live mode SHALL never fall back to the mock silently.

#### Scenario: Offline decision
- **WHEN** a command runs in offline mode
- **THEN** it returns the same answer for the same input every time and no network request is made

#### Scenario: Live without key
- **WHEN** a command runs in live mode and no Jev credential is configured
- **THEN** it fails with an error naming the missing variable instead of returning a mock answer

### Requirement: Cost ledger
Every Jev call SHALL be recorded with its cost (marked reported, estimated or unknown), latency, attempts and answers; unknown cost SHALL never be counted as zero.

#### Scenario: Cost totals
- **WHEN** 10 commands have run
- **THEN** the Runs view shows 10 Jev calls and their summed cost, with any unknown-cost calls listed separately

### Requirement: Smoke command
The hub SHALL ship a `ping` command that can be run on demand to verify Jev connectivity and report provider, model and cost.

#### Scenario: Smoke test
- **WHEN** the user triggers the Jev smoke test in live mode
- **THEN** the result shows the provider, the resolved model ID, the latency and the cost of the call
