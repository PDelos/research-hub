# Spec Delta

## Purpose

Defines how every paper gets one comparable vector so the hub can find similar papers, shortlist
relations to the knowledge base and spot missing links, using a single configurable model.

## ADDED Requirements

### Requirement: One model for all papers
All paper vectors in a project SHALL come from one configured embedding model (default `qwen/qwen3-embedding-8b` via OpenRouter), and each vector SHALL record the model ID that produced it.

#### Scenario: Model recorded
- **WHEN** a paper is embedded
- **THEN** its vector is stored with the model ID and the vector dimension

### Requirement: Embedding input
A paper's vector SHALL be computed from its title and abstract only, truncated to the model's input limit; papers without an abstract SHALL be embedded from the title and flagged.

#### Scenario: No abstract
- **WHEN** a paper has no abstract
- **THEN** it is embedded from its title and marked `title-only`

### Requirement: Embed once
A paper's vector SHALL be computed at most once per model; repeated sweeps SHALL reuse it.

#### Scenario: Seen again
- **WHEN** a paper already embedded with the current model appears in a later sweep
- **THEN** no embedding request is sent for it

### Requirement: Similarity search
The hub SHALL return the k most similar papers to a given paper or text within a project (k default 8), with a distance per result.

#### Scenario: Nearest papers
- **WHEN** similarity search runs for a paper with k = 8 in a project with 50 embedded papers
- **THEN** 8 papers are returned ordered by increasing distance, excluding the query paper

### Requirement: Model change
When the configured embedding model changes, the hub SHALL re-embed the project's papers in the background and SHALL NOT compare vectors from different models.

#### Scenario: Switch model
- **WHEN** the embedding model is changed
- **THEN** similarity search uses only vectors from the new model and reports how many papers are still pending re-embedding

### Requirement: Embedding cost visible
Embedding calls SHALL be recorded with token count and cost and included in the project's cost totals.

#### Scenario: Cost recorded
- **WHEN** 100 papers are embedded
- **THEN** the run log shows the embedding calls, their tokens and their cost
