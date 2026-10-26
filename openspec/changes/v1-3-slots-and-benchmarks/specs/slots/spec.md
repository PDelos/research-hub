## ADDED Requirements

### Requirement: Kinds and topics
Every plugin manifest SHALL declare `kind` (core, slot, add-on or preference) and `topic`, and a slot plugin its
`slot`; built-in plugins SHALL all be classified, and installing a plugin of kind core SHALL be refused.

#### Scenario: Core cannot be installed
- **WHEN** a plugin with `"kind": "core"` is installed
- **THEN** it is refused with "kind: only the hub's own plugins are core"

### Requirement: Slot catalog
The hub SHALL list its slots (Ranking and gating, Embedder, Facet labeler, Judge, Knowledge-base search, Models per
job), each with its topic, the active implementation, the alternatives installed for it, its benchmark preset (or
"preset planned") and the last benchmark result.

#### Scenario: Embedder slot
- **WHEN** the slots are listed
- **THEN** the Embedder slot shows the active model, its preset "SCIDOCS, LitSearch, your stars" and the last result with its date

### Requirement: Datasets and fixed samples
A preset's public datasets SHALL be downloaded once per project from their source, sampled with a fixed seed into
at most 100 queries or abstracts with the documents they need, cached with a sample version, and reused by every
later run; in offline mode no download is attempted and a missing sample is reported.

#### Scenario: Same sample every week
- **WHEN** the embedder preset runs twice a week apart
- **THEN** both runs use the same cached sample (same version and seed) and nothing is downloaded the second time

### Requirement: Benchmark runs
Running a preset on the active implementation or a candidate SHALL report each task's metric (nDCG@10 for
retrieval, macro-F1 over background, method and result for facets, agreement for the judge, the replay verdict for
ranking), the number of items and the cost, and store the result.

#### Scenario: Candidate embedder
- **WHEN** the embedder preset runs for the candidate model "google/gemini-embedding-2"
- **THEN** the result lists nDCG@10 for SCIDOCS, LitSearch and your stars, the items embedded and the cost, next to the active model's last result

### Requirement: Usage attribution
For every paper source, the hub SHALL report over the last 30 days the cards it brought and how many of them the
user liked (👍 or ⭐).

#### Scenario: A source's worth
- **WHEN** a source brought 14 cards in 30 days and the user liked 6
- **THEN** its add-on row and the digest show "14 cards, 6 liked"
