# Proposal

## Why

Sweeps, scoring, relations, missing links and the vault all need the same foundation: reliable, deduplicated paper
records and representations that capture what a paper *means*, not only what it is about. Research and a live check
(2026-10-23) showed a single vector per paper captures topic but misses a paper's agenda, method and citation
community; multi-vector (facet) representations and citation links are needed for relation-aware discovery. Layer 2
of the v0 pyramid; depends on `project-charter` and `scheduling` (archived v0.1) and the v0.0 baseline.

## What Changes

- **Paper sources**, all keyless: **arXiv**, **OpenAlex** and **Europe PMC**, which also covers bioRxiv and medRxiv
  preprints with keyword search (bioRxiv's own API has no search: verified 2026-10-23). **Semantic Scholar** only
  when `S2_API_KEY` is set (its keyless pool answered HTTP 429 to every request).
- One normalized **paper record** per work, merging versions and sources by DOI, arXiv ID, PMID/PMCID, OpenAlex ID.
- **Metadata enrichment** from OpenAlex (venue, citations, references, citing count, open-access URL, retraction),
  a 7-day **metadata cache**, polite **rate limiting** with a contact email, backoff on HTTP 429 and source failures.
- **Three layers of representation per paper:**
  1. a **whole-paper vector** (title + abstract): topic;
  2. **facet vectors** for **background**, **method** and **result**: Jev labels each abstract sentence with one
     facet (`abstract-facets` command, a bounded choice), and each facet's sentences get their own vector, so the
     hub can find "same method, different problem";
  3. **citation links** from OpenAlex references: lineage, shared references, co-citation.
- Vectors from **one configured OpenRouter embedding model** for all papers (default `qwen/qwen3-embedding-8b` at
  1,024 dimensions, verified live), never mixed across models.
- A **`search_papers` tool for the research desk**, so the user can already ask in chat for papers on a topic and get
  real results with metadata.

Out of scope: full-text extraction (v1), trust scoring, gate and ranking decisions (v0.3), typed relations such as
extends or contradicts (v1), notes on starred papers (v0.5).

Jev commands added: `abstract-facets`. LLM calls added: none beyond the desk's normal chat turns when it uses
`search_papers`. Embedding calls: about 4 per new paper (whole + up to 3 facets).

## Capabilities

### New Capabilities

- `paper-sources`: Finding papers by query across sources, one clean record per work, metadata enrichment, caching,
  politeness and failure isolation, and paper search from chat.
- `paper-representations`: What the hub stores to understand a paper: the whole-paper vector, Jev-labeled facets
  with their vectors, citation links, similarity search by topic or facet, and model changes.

### Modified Capabilities

(none)

## Impact

- `rh-server`: `papers/` module (source clients, normalizer, merger, cache, enrichment), `representations/` module
  (embedding client, facet labeling, vector tables, citation links), the `search_papers` desk tool, a migration for
  papers, identifiers, sources, cache, citation links, facet labels and sqlite-vec tables.
- External: arXiv, OpenAlex, Europe PMC APIs; OpenRouter embeddings and Jev; optional Semantic Scholar.
- Config: `CONTACT_EMAIL` (polite pools), `RH_MODEL_EMBED`, `RH_EMBED_DIMS`, optional `S2_API_KEY`.
- Cost: about $0.0000005 per embedding call and about $0.000014 per Jev facet call, so a few hundredths of a cent
  per new paper. (Measured live on 2026-10-23: a facet call carries one question per sentence, about $0.0001 per
  paper; embeddings about $0.000006 per paper; 8 papers cost $0.00086 in all.)
