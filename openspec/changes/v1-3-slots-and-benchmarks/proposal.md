## Why

Decided 2026-10-26 (EVOLUTION.md §0.1): improvement must not be open-ended. Every part of the hub is core, a slot
(one active plugin, judged on a fixed benchmark preset), an add-on (judged by usage) or a preference; the Plugins tab
must make that obvious, and the slots need their presets before the weekly upgrade (v1-4) can use them.

## What Changes

- **Classification in every manifest:** `kind` (core, slot, add-on, preference), `topic` (finding papers,
  understanding papers, ranking, knowledge base, agents and models, integrations, interface) and, for a slot plugin,
  `slot`. Installed plugins are add-ons or slot candidates, never core.
- **The slot catalog** (core): Ranking and gating (preset: replays, v1-2), Embedder (preset: SCIDOCS and LitSearch
  samples plus "your stars"), Facet labeler (preset: PubMed 20k RCT sample), Judge (preset: agreement with you),
  Knowledge-base search and Models per job (presets later). Each slot shows its active implementation, alternatives
  and last benchmark result.
- **Benchmark presets and runner** (core, in `rh.harness`): public datasets are downloaded once per project from
  Hugging Face through `rh.http`, sampled with a fixed seed (100 queries or abstracts each) and cached; a run scores
  the active implementation or a candidate (an embedding model; later others) with the preset's metric (nDCG@10,
  macro-F1, agreement) and its cost, and stores the result.
- **Usage attribution for add-ons:** per paper source over 30 days, the cards it brought and how many you liked; in
  the Plugins tab and a new digest section "Sources".
- **The Plugins tab grouped:** Core (collapsed, cannot be changed), Slots by topic (active, alternatives, last
  benchmark, "run benchmark"), Add-ons by topic (on/off, attribution), Preferences.

Jev: no new command (the facet preset runs the existing `abstract-facets`). LLM calls: none.

## Out of scope

Searching the internet for candidates and adopting them (v1-4); presets for knowledge-base search and models per job;
facet-labeler alternatives (the preset measures the active labeler as the baseline).

## Capabilities

### New Capabilities
- `slots`: classification, the slot catalog, benchmark presets, datasets and samples, the runner, results, usage
  attribution.

### Modified Capabilities
- `plugin-system`: manifests declare kind and topic; the Plugins view is grouped.
- `daily-cycle`: the digest gains a Sources section.

## Impact

Manifest schema, all built-in manifests, the installer, `src/harness/slots.ts` and `benchmarks/`, `rh.harness`
(downloads, samples, runner, table `p_rh_harness__benchmarks`, network permission for huggingface.co), a new
dependency `hyparquet` (+ `hyparquet-compressors`), routes `/v1/slots`, `/v1/attribution`, the digest, the SDK and the
Plugins tab.
