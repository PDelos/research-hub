## Why

EVOLUTION.md §0.2: once a week the hub improves one slot on its fixed preset, or scouts add-ons, and reports in the
digest; the user only reads and approves. v1-2 and v1-3 built the referee (replays, presets); this change runs the
loop.

## What Changes

- **The weekly upgrade run** (new core plugin `rh.upgrades`): triggered by the nightly run when the last upgrade is at
  least 6.5 days old (setting `everyDays`, default 7; `enabled`, default true), or on request.
- **Choosing the focus:** a new Jev command `upgrade-focus` picks ranking, embedder or scout-addons from the slots'
  last results and ages, the user's digest comments since the last upgrade, the failure modes, and the recent
  focuses; below confidence 0.4 the focus rotates.
- **Ranking:** error analysis (👎 reason kinds, liked cards ranked low, liked and disliked exploration picks, cards left
  unjudged) orders a grid of at most 12 setting variants; each is replayed (no paid calls); the variant with the
  "better" verdict and the highest held-out lower bound is **applied** to `rh.sweep` as a change by
  `proposal:upgrade-<id>`, with undo.
- **Embedder:** OpenRouter's embedding catalog is filtered (price ≤ `maxEmbedPricePerMillion`, default $0.25; context ≥
  512; not the active model); a web-search-backed model (OpenRouter's web plugin, about $0.02) shortlists at most 2
  candidates for scientific-paper retrieval with its sources, falling back to the newest cheap models; each is
  benchmarked on the embedder preset (estimated cost capped by `maxRunUsd`, default $0.50); a candidate whose mean
  nDCG@10 beats the active model's by at least 0.02, and is not worse on "your stars" when available, is
  **proposed**. Approving it sets `rh.embedder-openrouter`'s `model` and `dims` (settings that default to
  `RH_MODEL_EMBED`, `RH_EMBED_DIMS`); the papers are re-embedded in the background without a restart.
- **Scout add-ons:** a web search lists up to 5 free scholarly sources or integrations not already present, each with
  a link and a reason; the user can dismiss them (installing needs a plugin, which a later change builds).
- **Reports and proposals:** every run stores its report (focus and why, analysis, everything tried with numbers,
  what was applied or proposed, cost); the digest gains an Upgrade section; the new Upgrades tab shows runs, pending
  proposals (approve, reject) and suggestions.

Jev: one new command `upgrade-focus` (choice). LLM calls: one web-search completion per embedder or scout run.

## Out of scope

Building plugins for suggested add-ons (the engineer, later); upgrades of the facet labeler, judge, knowledge-base
search and models slots (no candidates yet); changing the core.

## Capabilities

### New Capabilities
- `weekly-upgrade`: the run, focus choice, the three procedures, proposals, reports, the Upgrades view.

### Modified Capabilities
- `daily-cycle`: the digest gains an Upgrade section.

## Impact

New built-in `rh.upgrades` (tables `p_rh_upgrades__*`, Jev command, tab, routes `/v1/upgrades*`, `/v1/proposals/*`),
`rh.provider-openrouter` (`research`: a web-search completion), `rh.embedder-openrouter` (settings, live change),
`rh.papers` (follows the embedder live: vector tables, re-sync, catch-up), `OpenRouterEmbedder` (native size),
the digest, SDK, UI.
