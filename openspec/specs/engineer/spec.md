# engineer Specification

## Purpose
TBD - created by archiving change v1-8-engineer. Update Purpose after archive.

## Requirements

### Requirement: Ideas and assessment
The engineer SHALL take ideas from scout suggestions, the user's text and slots, research each (web search and the
review model) and record an assessment (worth it, kind, gain, cost, risk, plan) before anything is built; building
SHALL start only when the user presses Build.

#### Scenario: The user proposes fine-tuning
- **WHEN** the user writes "try fine-tuning the embedder on my stars"
- **THEN** the idea is researched and assessed with expected gain, cost and risk, and waits for Build or Reject

### Requirement: Paper-source plugins
For a paper-source idea the engineer SHALL write an external plugin with only the API's host as network permission,
test it in its sandbox with a real search, retry with the error at most 3 times, and leave a passing plugin installed
but disabled with a proposal to enable it; rejecting SHALL uninstall it.

#### Scenario: A suggested source becomes an add-on
- **WHEN** the user asks the engineer about a suggested free paper API and presses Build
- **THEN** a tested plugin appears disabled under Plugins with a proposal to enable it

### Requirement: Fine-tuned embedder on Kaggle
For an embedder fine-tune the engineer SHALL train on Kaggle's free GPUs (the user's Kaggle token), download the model,
benchmark it on the embedder preset through the local embedder, and propose it only when it beats the active embedder
by 0.02; without a Kaggle token it SHALL stop and say so.

#### Scenario: No Kaggle token
- **WHEN** the user approves building a fine-tuned embedder and no KAGGLE_API_TOKEN is set
- **THEN** the idea fails with "set KAGGLE_API_TOKEN" and nothing changes
