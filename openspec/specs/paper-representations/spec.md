# paper-representations Specification

## Purpose
Defines how the hub represents what a paper means in three layers (a whole-paper vector for topic, Jev-labeled
facet vectors for background, method and result, and citation links for lineage) and how it searches by them.

## Requirements

### Requirement: Whole-paper vector
Every paper with a title SHALL get one vector computed from its title and abstract by the single configured embedding model (default `qwen/qwen3-embedding-8b`, 1,024 dimensions), and each vector SHALL record the model ID and dimension.

#### Scenario: Vector recorded
- **WHEN** a paper is stored
- **THEN** it has a whole-paper vector with 1,024 dimensions and the model ID `qwen/qwen3-embedding-8b`

#### Scenario: No abstract
- **WHEN** a paper has no abstract
- **THEN** its whole-paper vector is computed from the title alone and the paper is marked `title-only`

### Requirement: Facet labels by Jev
Each abstract sentence SHALL be labeled `background`, `method`, `result` or `other` by the versioned Jev command `abstract-facets`, in one Jev call per paper, with the command version recorded; a label below 0.5 confidence SHALL count as `other`.

#### Scenario: Labeled abstract
- **WHEN** an abstract with 6 sentences is stored
- **THEN** each sentence has one facet label, the labels come from one `abstract-facets` call, and the command version is recorded

#### Scenario: Uncertain sentence
- **WHEN** Jev labels a sentence `method` with confidence 0.4
- **THEN** the sentence counts as `other` and is left out of every facet vector

### Requirement: Facet vectors
For each of `background`, `method` and `result` that has at least one sentence, the paper SHALL get a facet vector computed from that facet's sentences with the same embedding model; papers without an abstract SHALL have no facet vectors.

#### Scenario: Three facets
- **WHEN** an abstract has background, method and result sentences
- **THEN** the paper has three facet vectors in addition to its whole-paper vector

#### Scenario: Missing facet
- **WHEN** an abstract has no result sentence
- **THEN** the paper has background and method vectors only

### Requirement: Compute once
A paper's vectors and facet labels SHALL be computed at most once per embedding model and per `abstract-facets` version; repeated searches SHALL reuse them.

#### Scenario: Seen again
- **WHEN** a paper already represented with the current model and command version is found again
- **THEN** no embedding or Jev request is sent for it

### Requirement: Similarity by topic or facet
The hub SHALL return the k most similar papers (default 8) to a given paper or text, by whole-paper vector or by a chosen facet, with a distance per result.

#### Scenario: Nearest by topic
- **WHEN** similarity search runs by whole-paper vector for a paper with k = 8 in a project with 50 papers
- **THEN** 8 papers are returned ordered by increasing distance, excluding the paper itself

#### Scenario: Same method, different problem
- **WHEN** similarity search runs by the `method` facet for a paper
- **THEN** results are ranked by method similarity and each result also reports its background similarity, so papers using a similar method on a different problem can be told apart

### Requirement: Citation links
The hub SHALL store each paper's referenced works from OpenAlex as citation links and SHALL report, for two papers, whether one cites the other, how many references they share, and how many known papers cite both.

#### Scenario: Shared references
- **WHEN** two stored papers both reference the same 3 works
- **THEN** the citation report for the pair shows 3 shared references

#### Scenario: Direct citation
- **WHEN** paper A's references include paper B
- **THEN** the citation report shows that A cites B

### Requirement: Model change
When the configured embedding model or dimension changes, the hub SHALL re-embed the project's papers in the background and SHALL NOT compare vectors from different models.

#### Scenario: Switch model
- **WHEN** the embedding model is changed
- **THEN** similarity search uses only vectors from the new model and reports how many papers are still pending re-embedding

### Requirement: Representation cost visible
Embedding and facet-labeling calls SHALL be recorded with tokens and cost and included in the project's cost totals.

#### Scenario: Cost recorded
- **WHEN** 20 papers are represented
- **THEN** the cost totals include their embedding and Jev calls, with counts and amounts
