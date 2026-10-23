# paper-sources Specification

## Purpose
Defines how the hub finds papers across scholarly sources and turns them into one clean, deduplicated, enriched
record per work that every later feature can rely on, including searching for papers from chat.

## Requirements

### Requirement: Search by query
Given a query, an optional date window and a result limit (default 25, maximum 100), the hub SHALL return matching papers from each enabled source: arXiv, OpenAlex and Europe PMC, where Europe PMC also supplies bioRxiv and medRxiv preprints.

#### Scenario: Query across sources
- **WHEN** the query "protein language model" runs with all sources enabled
- **THEN** results from every source that answered are returned, each tagged with the sources it came from

#### Scenario: Preprints through Europe PMC
- **WHEN** a query matches a recent bioRxiv preprint
- **THEN** the preprint is returned through Europe PMC with its DOI, abstract and server name `bioRxiv`

#### Scenario: Date window
- **WHEN** a query runs with "since 2026-10-01"
- **THEN** no returned paper has a publication date before 2026-10-01

### Requirement: Optional Semantic Scholar
Semantic Scholar SHALL be used only when `S2_API_KEY` is configured; without it the hub SHALL work fully with the other sources.

#### Scenario: No key
- **WHEN** no `S2_API_KEY` is set
- **THEN** no request is sent to Semantic Scholar and searches still return results from the other sources

### Requirement: Normalized paper record
Every paper SHALL be stored as one record with title, abstract, authors, year, publication date, venue or preprint server, identifiers (DOI, arXiv ID, PMID, PMCID, OpenAlex ID when known), source list and open-access URL when known.

#### Scenario: Record fields
- **WHEN** an arXiv result is stored
- **THEN** its record has the arXiv ID, title, abstract, authors and date, and lists `arxiv` among its sources

### Requirement: One record per work
Results for the same work from different sources or versions SHALL merge into one record when any strong identifier matches (DOI, arXiv ID, PMID, PMCID, OpenAlex ID), keeping all identifiers and sources.

#### Scenario: Preprint and journal version
- **WHEN** a paper is found on arXiv and, with the same DOI, on OpenAlex as a journal article
- **THEN** one record exists with both identifiers, both sources, and the journal venue

#### Scenario: Title-only match
- **WHEN** two results share a normalized title but no identifier
- **THEN** they are kept as two records and flagged as possible duplicates

### Requirement: Metadata enrichment
For each record the hub SHALL fetch from OpenAlex, when the work is found there: venue, citation count, referenced works, citing-work count, open-access URL and retraction status; a work not yet in OpenAlex SHALL be kept with enrichment marked pending and retried later.

#### Scenario: Retracted paper
- **WHEN** OpenAlex marks a work as retracted
- **THEN** the record's retraction flag is true

#### Scenario: Not in OpenAlex yet
- **WHEN** a fresh bioRxiv preprint is not yet in OpenAlex
- **THEN** the record is kept with enrichment `pending` and enrichment is retried on a later request

### Requirement: Metadata cache
Fetched metadata SHALL be cached in the project's database for 7 days, so the same work is not fetched twice within that time.

#### Scenario: Found twice
- **WHEN** the same DOI is found by two queries on the same day
- **THEN** OpenAlex is queried for it once

### Requirement: Polite rate limiting
Requests SHALL respect each source's limits: at most 1 request per 3 seconds to arXiv, and OpenAlex and Europe PMC calls SHALL carry the configured `CONTACT_EMAIL`; without one the hub SHALL warn once at startup and continue.

#### Scenario: arXiv pacing
- **WHEN** 10 arXiv queries are issued at once
- **THEN** they are sent at least 3 seconds apart

#### Scenario: Rate limited by the source
- **WHEN** a source answers HTTP 429 (for example because another project on the same machine was querying it)
- **THEN** the request is retried after the source's Retry-After or the backoff, and the other sources' results are returned meanwhile

### Requirement: Source failure isolation
A failing or rate-limited source SHALL NOT fail the whole search; it SHALL be retried with backoff (up to 3 attempts within 60 seconds for an interactive search) and reported with the results.

#### Scenario: One source down
- **WHEN** Europe PMC returns HTTP 503 during a search
- **THEN** results from the other sources are returned and the response lists Europe PMC as failed with the reason

### Requirement: Paper search from chat
The research desk SHALL have a `search_papers` tool that runs a search, stores the records, and returns the top results (at most 10) with title, year, venue or server, citation count, sources and a link.

#### Scenario: Ask in chat
- **WHEN** the user asks the research desk to find recent papers on ESM contact prediction
- **THEN** the desk calls `search_papers`, the answer lists matching papers with their metadata, and the records are stored in the project

#### Scenario: Search tool limits
- **WHEN** `search_papers` is called with a limit of 50
- **THEN** the call is rejected with a message stating the maximum of 10 results per call
