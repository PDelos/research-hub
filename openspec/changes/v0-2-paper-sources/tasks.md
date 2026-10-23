# Tasks

## 1. Storage and configuration

- [x] 1.1 Add migration 3 (papers, paper_ids, paper_sources, metadata_cache, citation_links, facet_labels, representations, embedding_calls) and create the sqlite-vec tables for `RH_EMBED_DIMS`; verify a migration test from version 2 and a startup test that the four vector tables exist
- [x] 1.2 Add `CONTACT_EMAIL`, `RH_MODEL_EMBED`, `RH_EMBED_DIMS`, `S2_API_KEY` to config (validated) and `.env.example`, with a single startup warning when `CONTACT_EMAIL` is missing; verify config tests and `npm run check:env`

## 2. Records, identity and cache (spec: paper-sources)

- [x] 2.1 Implement identifier and title normalization and the sentence splitter; verify unit tests (DOI forms, arXiv versions, PMC ids, decimals, "e.g.", "et al.")
- [x] 2.2 Implement the paper store: insert, merge by any strong identifier (including two-record merges), title-only duplicate flag, sources list; verify tests for the preprint + journal merge and the title-only scenario
- [x] 2.3 Implement the 7-day metadata cache; verify a test that the same DOI on the same day hits the network once

## 3. Source clients (spec: paper-sources)

- [x] 3.1 Implement the HTTP helper (timeout, per-host pacing, retry on 429/5xx honoring Retry-After, mailto/email); verify tests for arXiv pacing (≥ 3 s apart, fake clock) and a 429 then success
- [x] 3.2 Implement the arXiv client (Atom via fast-xml-parser) with a recorded fixture; verify parsing of id, title, abstract, authors, date and the date window
- [x] 3.3 Implement the OpenAlex client (search, lookup by DOI/OpenAlex id, abstract from inverted index, references, retraction) with fixtures; verify fields and the retracted flag
- [x] 3.4 Implement the Europe PMC client (preprints with server name, HTML stripped) with fixtures; verify a bioRxiv preprint maps to server `bioRxiv` with DOI and abstract
- [x] 3.5 Implement the optional Semantic Scholar client used only with `S2_API_KEY`; verify a test that no request is made without the key
- [x] 3.6 Implement search fan-out, merge and enrichment (pending when not in OpenAlex, retried later) with failure isolation; verify tests for one source down (results plus the failure listed) and enrichment pending → done

## 4. Representations (spec: paper-representations)

- [x] 4.1 Implement the embedding client (OpenRouter, batching, cost recording) and the offline fake; verify tests for batching, recorded cost and deterministic fake vectors
- [x] 4.2 Add the `abstract-facets` Jev command (versioned, in the lock) and facet labeling with the 0.5 confidence floor; verify tests with the mock Jev and `npm run check:jev`
- [x] 4.3 Store whole and facet vectors (L2-normalized) once per model and command version; verify tests for three facets, a missing facet, a title-only paper, and no second request when seen again
- [x] 4.4 Implement similarity by whole vector or facet with background distance for facet searches; verify tests for k ordering, self-exclusion and the "same method, different problem" scenario with the fake embeddings
- [x] 4.5 Store citation links from OpenAlex references and implement the pair report (cites, shared references, co-cited by); verify tests for shared references and direct citation
- [x] 4.6 Implement model-change detection and background re-embedding without mixing models; verify a test that switches the model and reports pending papers

## 5. Search from chat (spec: paper-sources)

- [x] 5.1 Add the `search_papers` desk tool (limit 1–10, memoized execution), add it to `DESK_TOOLS` and two lines to the desk prompt; verify a faux-agent test that a chat request calls the tool, stores and represents papers, and answers with metadata, and that `limit: 50` is rejected
- [x] 5.2 Include embedding and Jev facet costs in the cost totals and the Runs view; verify a test that totals rise after a search and `npm run build`

## 6. Integration

- [x] 6.1 Run all offline tests, `npm run check`, `npm run check:jev`, `npm run check:env`, lint and `npm audit`; verify all pass
- [x] 6.2 Live check (keyless sources, Jev and embeddings cost a few hundredths of a cent; chat on a free model): ask the desk for papers on a real topic; record sources answering, merged duplicates, facet labels on 3 abstracts, a "same method, different problem" query, and the cost
- [x] 6.3 Update `README.md` (paper search in chat, sources, representations, new variables); verify the documented commands work

## Verification notes

- 6.1 (2026-10-23): 110 server tests, 35 durable-agent tests (1 skipped), 24 SDK tests pass; `npm run check`,
  `check:jev`, `check:env`, lint (only pre-existing warnings) and `npm audit` (0 vulnerabilities) pass. `fmt:check`
  was already failing before v0.2 (51 files at the v0.1 commit) and is not part of this check.
- 6.2 live check (2026-10-23), live mode, chat on `nvidia/nemotron-3.5-lightning:free`, no `CONTACT_EMAIL` (the
  startup warning appeared once): "Find recent papers (since 2026-09-01) on protein language models for contact
  prediction", limit 8. The desk called `search_papers` and listed 8 papers with metadata.
  - Sources: arXiv, OpenAlex and Europe PMC all answered; Semantic Scholar skipped (no key).
  - 15 records stored; 11 merged across two sources (4 arXiv + OpenAlex via the arXiv DOI, 7 Europe PMC + OpenAlex
    by DOI); enrichment done 14, pending 1; 1 title-only; no possible duplicates.
  - Facets: 66 sentences labeled in 8 calls (background 15, method 21, result 25, other 5); e.g. recAMPLIFY's
    10 sentences split into 2 background, 5 method and 3 result. One sentence fell below 0.5 (0.48) and counted as
    other. A stray footnote "1" was labeled as a sentence, so the splitter now drops fragments without letters.
  - "Same method, different problem" by the method facet from AtlasFold: nearest is the ESM-2 pretraining-filtering
    paper (method distance 0.309, background distance 0.597), ahead of papers closer in background.
  - Cost: Jev $0.00081 (8 `abstract-facets` calls, reported), embeddings $0.000047 (one call, 32 texts, 4,677
    tokens), chat $0; total $0.00086, matching `/v1/usage`.
- 6.3: README "Finding papers" section and offline note; the documented offline quick start answers a search.

## Workflow follow-up

- Run `openspec validate v0-2-paper-sources --strict` before applying.
- After implementation and review, archive the change so `openspec/specs/` gains `paper-sources` and `paper-representations`.
