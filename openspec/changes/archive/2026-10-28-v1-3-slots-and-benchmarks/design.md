## Context

EVOLUTION.md §0.1 fixes what may change. v1-2 built the Ranking slot's preset (replays). This change classifies
everything, gives the other slots presets on public benchmarks, measures add-ons by usage, and regroups the UI.

## Decisions

### D1. Classification
Manifest fields: `kind` (`core` | `slot` | `addon` | `preference`, default `addon` for installed plugins), `topic`
(`finding` | `understanding` | `ranking` | `knowledge` | `agents` | `integrations` | `interface`), `slot` (for
kind slot). Built-ins: core = decision-jev, papers, charter, schedule, sweep, feedback, desk, kb, digest, harness,
settings-ui, plugins-ui; slot = provider-openrouter (models), embedder-openrouter (embedder); add-on = the four
sources, runs-ui; preference = viewer-obsidian, viewer-library. A core plugin is `required`. Slots implemented
inside a core plugin (ranking: rh.sweep settings; facets: rh.papers; judge: rh.harness; knowledge-base search: rh.kb)
appear in the catalog with that implementation named.

### D2. Slot catalog (core, `src/harness/slots.ts`)
Static: id, title, topic, how the active implementation is found (an extension point's active contribution, a
plugin, or a core part), the preset id or none.

### D3. Datasets and samples (`src/harness/benchmarks/datasets.ts`)
| Dataset | Source (Hugging Face) | Sample (seed 7, version 1) |
|---|---|---|
| SCIDOCS (BEIR) | `BeIR/scidocs` corpus and queries (Parquet), `BeIR/scidocs-qrels` test.tsv | 100 queries with ≥1 relevant document; their relevant documents + 1,900 other documents |
| LitSearch | `mteb/LitSearchRetrieval` corpus, queries, qrels (Parquet) | 100 queries; their relevant papers + 1,900 others |
| PubMed 20k RCT | `armanc/pubmed-rct20k` test.jsonl | 100 abstracts with their labelled sentences |
Downloads go through `rh.http` (hosts huggingface.co and its file CDN), are parsed (Parquet with `hyparquet`),
sampled, written to the plugin's storage (`benchmarks/<dataset>-v1.json`) and the raw files discarded. Licenses stay
with the datasets; nothing is redistributed. Offline: no download; tests place fixture samples in storage.

### D4. Presets and runner
| Preset | Tasks | Metric |
|---|---|---|
| ranking | the replay of v1-2 for a variant | verdict and held-out nDCG difference |
| embedder | SCIDOCS, LitSearch: embed queries and documents (title + text), rank by cosine; your stars: each research question ranks the user's liked papers among up to 200 other project papers | nDCG@10 per task, mean |
| facets | label every sentence of the sample with the active labeler (Jev `abstract-facets`); gold: objective/background → background, methods → method, results/conclusions → result | macro-F1 over background, method, result |
| judge | the latest calibration | agreement (cases, kappa) |
Candidates in v1-3: embedder `{ model, dims }` through OpenRouter (offline: the deterministic fake). Cost from the
embedding and Jev ledgers before and after. Results: `p_rh_harness__benchmarks` (slot, preset, candidate, metrics,
items, cost, created).

### D5. Attribution
From `paper_sources` and `cards` / `judgments`: per source, cards created in the window whose paper that source
returned, and of those the liked ones. `GET /v1/attribution?days=30`; the digest's Sources section uses the
digest's period.

### D6. UI
The Plugins tab: four groups; Slots by topic as cards (active, alternatives, preset, last result with date, "Run
benchmark" with the expected cost); Add-ons by topic with on/off and attribution; Core collapsed; Preferences as
pickers. Plugin details stay as they are.

## Risks / Trade-offs

- Public samples are small → stable comparisons over time, not leaderboard numbers; the report says sample sizes.
- Hugging Face file layouts can change → the sample version pins what was used; a failed download is reported and
  retried at the next run.
