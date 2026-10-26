## 1. Classification

- [x] 1.1 Manifest `kind`, `topic`, `slot`; classify all built-ins; refuse installing core; expose in the plugins API and SDK; verify tests

## 2. Slots and benchmarks

- [x] 2.1 The slot catalog and `GET /v1/slots` (active, alternatives, preset, last result); verify tests
- [x] 2.2 Datasets and fixed samples (downloads through `rh.http`, Parquet and JSONL, seeded, cached, offline handling); verify tests with fixture files served by a fake fetch
- [x] 2.3 The runner and presets (embedder, facets, judge, ranking), results stored, `POST /v1/slots/:id/benchmark`; verify offline tests with fixture samples, including a candidate embedder

## 3. Attribution

- [ ] 3.1 Per-source attribution, `GET /v1/attribution`, the digest's Sources section; verify tests

## 4. UI

- [ ] 4.1 The grouped Plugins tab (core collapsed, slot cards, add-ons with attribution, preferences) and the digest's Sources section; verify build and Playwright tests with screenshots

## 5. Integration

- [ ] 5.1 All tests, checks, audit, offline e2e, UI tests, bundle and light image; one live run of the embedder and facets presets (with the user's key, a few cents) recorded
- [ ] 5.2 README, PLAN/EVOLUTION status; archive
