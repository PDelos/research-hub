## Decisions

### D1. `rh.upgrades` (core)
Depends on rh.harness, rh.sweep, rh.papers, rh.feedback, rh.decision-jev, rh.provider-openrouter. Tables:
`p_rh_upgrades__runs` (focus, reason, report JSON, cost, started, finished), `__proposals` (run, kind, payload, status
proposed/approved/rejected, decided). Settings: `enabled` (true), `everyDays` (7), `maxEmbedPricePerMillion` (0.25),
`maxRunUsd` (0.5). It listens for `cycle.nightly` and runs when due; work in progress finishes before it stops.

### D2. Focus
Jev `upgrade-focus` (choice ranking | embedder | scout-addons, `min_confidence` 0.4) with state: each slot's last
result and age in days, comments since the last run (text, section), failure-mode counts, the last three focuses. Below
the confidence floor: the next focus after the last one in the rotation.

### D3. Ranking procedure
Analysis from the last 60 days: 👎 counts by `reason_kind`, liked cards in the lower half of their sweep, exploration
picks liked vs disliked, the share of cards left unjudged. Grid (current settings as the base): relevanceMin ±0.05,
worthMin ±0.05, rank weights shifted toward relevance / importance / level (0.1 moved), cardsPerSweep ±2,
explorationPicks ±1 (within bounds); ordered by the analysis (off-topic → relevance first; too basic/advanced → level;
liked exploration → more picks; many unjudged → fewer cards); at most 12. Best = verdict "better" with the highest
held-out lower bound. Applied with `kernel.configure("rh.sweep", variant, "proposal:upgrade-<id>")`.

### D4. Embedder procedure
Catalog `GET https://openrouter.ai/api/v1/embeddings/models` through `rh.http`. Shortlist by
`rh.provider-openrouter`'s `research(prompt)`: an OpenRouter chat completion with `plugins: [{ id: "web",
max_results: 5 }]` on the desk model, asked for a JSON array of catalog ids with reasons; ids not in the filtered
catalog are dropped; without research (offline, error) the two newest by `created`. Size: the active dims when the
model lists `dimensions` among `supported_parameters`, otherwise its native size (the embedder accepts any size when
dims is 0, for benchmarks). Estimated cost = sample tokens (~1.2 M) × price; candidates over `maxRunUsd` are skipped.
The active model is re-benchmarked if its last result is older than 30 days. Proposal payload: model, dims, numbers.

### D5. Live embedder change
`rh.embedder-openrouter` gets settings `model` and `dims` (env defaults `RH_MODEL_EMBED`, `RH_EMBED_DIMS`), handled
live; on change it emits `embedder.changed`. `rh.papers` gives the paper service a delegating embedder (model, dims and
embed read the current settings), and on `embedder.changed` recreates the vector tables for the new size if needed,
re-syncs the model (old vectors are dropped as in v0's model change) and starts the background catch-up. `openProject`
sizes the vector tables from the plugin setting.

### D6. Scout procedure
`research` asked for up to 5 free scholarly sources or integrations relevant to the charter's questions and concepts,
not among the installed sources, as JSON (name, url, reason); stored as suggestions; dismissable.

### D7. UI and digest
Upgrades tab (order 17): the latest run's report, pending proposals with Approve / Reject, suggestions with Dismiss,
earlier runs. Digest section "upgrade": the period's runs (focus, reason, result) with links to the tab.
