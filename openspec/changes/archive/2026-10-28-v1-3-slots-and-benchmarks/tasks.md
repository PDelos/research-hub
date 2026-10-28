## 1. Classification

- [x] 1.1 Manifest `kind`, `topic`, `slot`; classify all built-ins; refuse installing core; expose in the plugins API and SDK; verify tests

## 2. Slots and benchmarks

- [x] 2.1 The slot catalog and `GET /v1/slots` (active, alternatives, preset, last result); verify tests
- [x] 2.2 Datasets and fixed samples (downloads through `rh.http`, Parquet and JSONL, seeded, cached, offline handling); verify tests with fixture files served by a fake fetch
- [x] 2.3 The runner and presets (embedder, facets, judge, ranking), results stored, `POST /v1/slots/:id/benchmark`; verify offline tests with fixture samples, including a candidate embedder

## 3. Attribution

- [x] 3.1 Per-source attribution, `GET /v1/attribution`, the digest's Sources section; verify tests

## 4. UI

- [x] 4.1 The grouped Plugins tab (core collapsed, slot cards, add-ons with attribution, preferences) and the digest's Sources section; verify build and Playwright tests with screenshots

## 5. Integration

- [x] 5.1 All tests, checks, audit, offline e2e, UI tests, bundle and light image; one live run of the embedder and facets presets (with the user's key, a few cents) recorded
  - Verified 2026-10-28: server 240/240, jev 34 (+1 live, skipped), durable-agent 24/24, UI 19/19; check 0 errors;
    audit 0; offline e2e PASS (tsx, bundle, light image 232 MB; now with the slot catalog and attribution).
  - Live run (bundled server, throwaway project, the user's key; samples downloaded once, ~60 MB): embedder preset
    for the active `qwen/qwen3-embedding-8b` (1024 d): SCIDOCS nDCG@10 0.555, LitSearch 0.795, $0.009; candidate
    `google/gemini-embedding-2` (1024 d): SCIDOCS 0.489, LitSearch 0.877, $0.174 (mixed: "your stars" decides once
    the project has liked papers). Facet preset (Jev abstract-facets) on 1,174 PubMed sentences: macro-F1 0.908,
    $0.013. The first live run exposed 210 empty LitSearch documents that the embeddings API refused; they are now
    left out (sample version 2).
- [x] 5.2 README, PLAN/EVOLUTION status; archive
