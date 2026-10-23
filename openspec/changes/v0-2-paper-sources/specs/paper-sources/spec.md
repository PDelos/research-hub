# Spec Delta

## Purpose

Defines how the hub finds papers across scholarly sources and turns them into one clean, deduplicated,
enriched record per work that every later feature can rely on.

## ADDED Requirements

### Requirement: Search by query
Given a query, an optional date window and a result limit (default 25, maximum 100), the hub SHALL return matching papers from each enabled source: arXiv, OpenAlex, Europe PMC and bioRxiv/medRxiv.

#### Scenario: Query across sources
- **WHEN** the query "protein language model" runs with all sources enabled
- **THEN** results from every source that answered are returned, each tagged with its source

#### Scenario: Date window
- **WHEN** a query runs with "since 2026-10-01"
- **THEN** no returned paper has a publication date before 2026-10-01

### Requirement: Optional Semantic Scholar
Semantic Scholar SHALL be used only when `S2_API_KEY` is configured; without it the hub SHALL work fully with the other sources.

#### Scenario: No key
- **WHEN** no `S2_API_KEY` is set
- **THEN** no request is sent to Semantic Scholar and searches still return results from the other sources

### Requirement: Normalized paper record
Every paper SHALL be stored as one record with title, abstract, authors, year, publication date, venue, identifiers (DOI, arXiv ID, PMID, PMCID, OpenAlex ID, when known), source list and open-access PDF URL when known.

#### Scenario: Record fields
- **WHEN** an arXiv result is stored
- **THEN** its record has the arXiv ID, title, abstract, authors and date, and lists `arxiv` among its sources

### Requirement: One record per work
Results for the same work from different sources or versions SHALL merge into one record when any strong identifier matches (DOI, arXiv ID, PMID, OpenAlex ID), keeping all identifiers and sources.

#### Scenario: Preprint and journal version
- **WHEN** a paper is found on arXiv and, with the same DOI, on OpenAlex as a journal article
- **THEN** one record exists with both identifiers, both sources, and the journal venue

#### Scenario: Title-only match
- **WHEN** two results share a normalized title but no identifier
- **THEN** they are kept as two records and flagged as possible duplicates for later review

### Requirement: Metadata enrichment
For each record the hub SHALL fetch from OpenAlex, when the work is found there: venue, citation count, referenced works, citing-work count, open-access URL and retraction status.

#### Scenario: Retracted paper
- **WHEN** OpenAlex marks a work as retracted
- **THEN** the record's retraction flag is true

#### Scenario: Not in OpenAlex
- **WHEN** a fresh bioRxiv preprint is not yet in OpenAlex
- **THEN** the record is kept with enrichment marked "pending" and is retried on a later sweep

### Requirement: Shared cache
Fetched metadata SHALL be cached at hub level for 7 days and reused across projects, so the same work is not fetched twice within that time.

#### Scenario: Two projects
- **WHEN** two projects find the same DOI on the same day
- **THEN** OpenAlex is queried for it once

### Requirement: Polite rate limiting
Requests SHALL respect each source's limits: at most 1 request per 3 seconds to arXiv, and OpenAlex/Crossref calls SHALL carry the configured contact email.

#### Scenario: arXiv pacing
- **WHEN** 10 arXiv queries are issued at once
- **THEN** they are sent at least 3 seconds apart

### Requirement: Source failure isolation
A failing or rate-limited source SHALL NOT fail the whole search; it SHALL be retried with backoff (30 s, 2 min, 8 min) and reported in the run log.

#### Scenario: One source down
- **WHEN** Europe PMC returns HTTP 503 during a search
- **THEN** results from the other sources are returned and the run log shows Europe PMC as failed
