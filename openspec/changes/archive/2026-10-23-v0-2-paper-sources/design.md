# Design

## Context

Baseline specs: `deployment`, `agent-runtime`, `jev-client`, `project-charter`, `scheduling`. The server has
`project.sqlite` (migrations 1–2) with sqlite-vec loaded and FTS5 proven, a Jev client with ledger, the research desk
with an allow-list (`DESK_TOOLS`, empty so far), and OpenRouter access for models and Jev. Requirements:
`specs/paper-sources`, `specs/paper-representations`. Motivation: proposal.md.

Verified live on 2026-10-23:
- Europe PMC returns bioRxiv/medRxiv preprints by keyword with abstracts and DOIs (`SRC:PPR`, `resultType=core`).
- bioRxiv's API has no search endpoint (date and DOI listing only).
- OpenAlex search works keyless (`mailto` for the polite pool); abstracts come as an inverted index.
- arXiv `export.arxiv.org/api/query` answers keyless (Atom XML).
- OpenRouter `/api/v1/embeddings` with `qwen/qwen3-embedding-8b` honors `dimensions: 1024` (native 4,096); about
  $0.00000001 per token. A sanity check put two *method* sentences from different fields at cosine 0.83 and a
  method and a background sentence from the same field at 0.54, supporting facet vectors.
- Semantic Scholar's keyless pool answered HTTP 429 to every request.

## Goals / Non-Goals

**Goals:**
- One clean record per work from three keyless sources, enriched by OpenAlex, cached and polite.
- Three representation layers per paper (whole vector, facet vectors, citation links) and similarity search over them.
- Real paper search from chat via `search_papers`.

**Non-Goals:**
- Full texts, trust scores, gate/rank decisions, typed relations, notes (later layers).
- A paper browser UI (results appear in chat in this layer; the Feed arrives with v0.3 cards).

## Decisions

### D1. Module layout
`apps/rh-server/src/papers/`: `sources/{arxiv,openalex,europepmc,semanticscholar}.ts` (each returns normalized
`SourcePaper`s), `http.ts` (fetch with timeout, per-host pacing, retry/backoff, `mailto`), `normalize.ts` (ids,
titles, dates, abstract cleanup, sentence splitting), `store.ts` (records, identifiers, merge, cache, citation
links), `search.ts` (fan-out, merge, enrichment). `apps/rh-server/src/representations/`: `embed.ts` (OpenRouter
embeddings client + offline fake), `facets.ts` (Jev labeling), `vectors.ts` (sqlite-vec tables, similarity),
`citations.ts` (link queries). One `PaperService` facade is exposed on the project runtime.

### D2. Storage (migration 3)
`papers(id, title, title_norm, abstract, authors_json, year, published_at, venue, server, oa_url, citations,
cited_by_count, retracted, enrichment pending|done|missing, title_only, created_at, updated_at)`;
`paper_ids(paper_id, kind doi|arxiv|pmid|pmcid|openalex|s2, value, UNIQUE(kind, value))`;
`paper_sources(paper_id, source, external_id, fetched_at, UNIQUE(paper_id, source))`;
`metadata_cache(key PRIMARY KEY, body_json, expires_at)`; `citation_links(citing_paper_id, cited_kind, cited_value,
cited_paper_id NULL, UNIQUE(citing_paper_id, cited_kind, cited_value))`; `facet_labels(paper_id, sentence_index,
sentence, facet, confidence, command_version)`; `representations(paper_id, kind whole|background|method|result,
model, dims, created_at)`; one sqlite-vec table per kind: `vec_whole`, `vec_background`, `vec_method`,
`vec_result` (`float[RH_EMBED_DIMS]`, rowid = paper id). The vector tables are created for the configured
dimension; a model or dimension change records the new model in settings and drops and refills them in the
background (spec: Model change).

### D3. Identity and merging
Identifiers are normalized (DOI lowercased without `https://doi.org/`, arXiv ID without version, `PMC` prefix kept).
A result merges into the existing record that owns any of its identifiers; if its identifiers point to two different
records, they merge into the older one. Titles are normalized (lowercase, alphanumerics) only to *flag*
`possible_duplicate_of`, never to merge.

### D4. Sources
- **arXiv:** `search_query=all:<terms>` with `sortBy=submittedDate` and the date window applied client-side; Atom XML
  parsed with `fast-xml-parser` (small, pure JS; added as a dependency). Paced at 1 request per 3 s per process.
- **OpenAlex:** `/works?search=…&filter=from_publication_date:…&mailto=…`; abstract rebuilt from
  `abstract_inverted_index`; also the enrichment source by DOI/OpenAlex ID, with `referenced_works` for citation
  links.
- **Europe PMC:** `/search?query=(<terms>) AND FIRST_PDATE:[…]&resultType=core&format=json&email=…`; preprints
  (`SRC:PPR`) map `bookOrReportDetails.publisher` to the server name (bioRxiv/medRxiv); HTML in `abstractText`
  stripped.
- **Semantic Scholar:** only with `S2_API_KEY` (`x-api-key` header).
Interactive searches (from chat) use a 60 s budget per source with up to 3 attempts; the sweep (v0.3) will use the
longer 30 s / 2 min / 8 min schedule from the spec through its own durable retries.

### D5. Facet labeling with Jev
Command `abstract-facets` (versioned JSON) uses `each` over the paper's sentences: per sentence one `choice` question
with criteria `background` (problem, context, motivation), `method` (approach, model, data, experiment), `result`
(findings, numbers, conclusions) and `other`. State: title plus all sentences, so each choice sees context; one
`systemOne` call per paper. Inputs above the 30,000-byte cap are truncated at sentence boundaries (only extremely
long abstracts). Policy: `min_confidence: 0.5`; below it the sentence counts as `other`. Sentences are split by a
rule-based splitter that keeps decimals, "e.g.", "et al." and similar intact.

### D6. Embeddings
`EmbeddingClient.embed(texts)` posts to OpenRouter `/api/v1/embeddings` with `model` and `dimensions`, batching up
to 32 inputs per call, recording tokens and cost (reported by OpenRouter) in a new `embedding_calls` table included
in cost totals. A paper's whole vector and facet vectors are requested in one call. Offline mode uses a
deterministic fake (hash-seeded unit vectors with shared-word overlap) so tests can assert similarity ordering
without network access. Config: `RH_MODEL_EMBED` (default `qwen/qwen3-embedding-8b`), `RH_EMBED_DIMS` (default
1024).

### D7. Similarity
`similar({paperId | text}, {by: "whole" | "background" | "method" | "result", k})` runs a sqlite-vec KNN on the
matching table. For a facet search each result also carries its whole-vector and background distance, so callers
can rank "same method, different problem" (spec scenario). Distances are cosine (vectors are L2-normalized before
storage).

### D8. `search_papers` desk tool
Parameters: `query` (≤ 200 chars), optional `since` (YYYY-MM-DD), `limit` (1–10, default 5). It runs the search,
stores and represents results (in the tool's execution, memoized with `once` so a replay does not search twice),
and returns a compact list (title, year, venue/server, citations, sources, link). Added to `DESK_TOOLS`; the desk's
system prompt gets two lines on when to use it. Representation happens before returning so later similarity works
on what was found.

## Risks / Trade-offs

- [Jev facet labels are imperfect on unusual abstracts] → confidence floor 0.5, `other` excluded, the command is
  versioned so improvements re-label; whole vector still works.
- [Sources change response formats] → each client has recorded-fixture tests; a failing source degrades to "failed"
  in results, never a crash.
- [OpenAlex adds keys or limits] → mailto now; a key slot can be added like `S2_API_KEY`.
- [Model or dimension change] → explicit re-embed; never mixed comparisons.
- [arXiv pacing slows interactive search] → arXiv runs in parallel with the others; results are returned when all
  sources finish or hit their budget.

## Migration Plan

Migration 3 adds the tables in D2; vector tables are created at startup for the configured dimension. Rollback:
earlier code ignores the new tables.
