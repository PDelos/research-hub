# Proposal

## Why

Sweeps, scoring, relations and the vault all need the same thing underneath: reliable, deduplicated
paper records with metadata and a vector for similarity. Building this as its own layer lets it be
tested against live APIs and fixtures before any agent or Jev logic depends on it. Layer 2 of the v0
pyramid; depends on `v0-1-projects` (charter queries) and `v0-0-skeleton`.

## What Changes

- Paper search and fetch from **arXiv**, **OpenAlex**, **Europe PMC** and **bioRxiv/medRxiv**, all
  keyless. **Semantic Scholar** is optional (used only when `S2_API_KEY` is set): live testing on
  2026-10-22 showed the unauthenticated pool returns HTTP 429 on every request.
- One normalized **paper record** per work, merging versions and sources by DOI, arXiv ID, PMID/PMCID,
  OpenAlex ID.
- **Metadata enrichment** from OpenAlex: venue, year, authors, citation count, references, citing works,
  open-access PDF URL, retraction flag.
- A shared **metadata cache** across projects with time-to-live, plus polite rate limiting per source.
- **Embeddings** for every paper (title + abstract) from **one configured OpenRouter embedding model**
  (default `qwen/qwen3-embedding-8b`), stored per project and searchable by similarity. One model for all
  papers keeps every vector comparable; SPECTER2 via Semantic Scholar was dropped because it requires the
  S2 key and does not cover new preprints from every source.

Out of scope: full-text extraction (v1), trust scoring, Jev decisions, sweeps.

Jev commands added: none. LLM calls added: none (embedding calls only).

Design and tasks are written when this layer is next to implement.

## Capabilities

### New Capabilities

- `paper-sources`: Finding papers by query across sources, normalizing and deduplicating them into one
  record per work, enriching metadata, caching, and isolating source failures.
- `paper-embeddings`: Computing, storing and searching one vector per paper with a single configured
  model, and re-embedding when that model changes.

### Modified Capabilities

(none)

## Impact

- New `paper-sources` module in `rh-server`, `cache.sqlite` at hub level, `papers` and vector tables in
  `project.sqlite` (sqlite-vec).
- External: arXiv, OpenAlex, Europe PMC, bioRxiv APIs; OpenRouter embeddings; optional Semantic Scholar.
- Config: `CONTACT_EMAIL` (OpenAlex/Crossref polite pool), `RH_MODEL_EMBED`, optional `S2_API_KEY`.
