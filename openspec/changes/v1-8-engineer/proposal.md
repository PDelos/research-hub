## Why

EVOLUTION.md §6 step 9 (decided 2026-10-28): the hub needs an engineer that turns ideas into plugins: the scout's
suggestions, weak slots, or the user's own proposal in plain words. It researches whether an idea is worth it, asks,
builds and tests the plugin, and proposes it with numbers; nothing is installed without approval. Fine-tuning is one
of the things it can build (a fine-tuned embedder trained for free on Kaggle), not a separate feature.

## What Changes

- **The engineer** (new core plugin `rh.engineer`): ideas from a scout suggestion ("Ask the engineer"), from the
  user's text, or from a slot; each goes through research → assessment (worth it or not, expected gain, cost, risk,
  plan, and what kind of plugin) → the user's Build or Reject → build → tests → a proposal with numbers → the user's
  approval. Research uses a web search (`research`) and one review-model call; every stage is recorded.
- **Builder: paper sources.** The engineer writes an external plugin (`rh-plugin.json`, `main.mjs`) contributing a
  `papers.source` for a scholarly API, with the API's host as its only network permission. Its contract test installs
  it in its sandbox (a Node permission process), runs a search, and checks the results (titles, identifiers); a failure
  goes back to the model with the error (at most 3 attempts), then the plugin is removed. A passing plugin stays
  installed **disabled**; approving enables it (undoable), rejecting uninstalls it. Attribution then shows its worth.
- **Builder: fine-tuned embedder.** A Kaggle runner (`KAGGLE_API_TOKEN`; Kaggle's API: SaveKernel,
  GetKernelSessionStatus, ListKernelSessionOutput) pushes a training script with the data inlined (pairs of research
  questions and liked papers, disliked papers as negatives), polls, and downloads the model files. A new Embedder slot
  alternative `rh.embedder-local` runs such a model through sentence-transformers in a supervised Python process (the
  `research-hub:full` image, or `RH_LOCAL_EMBED_URL`). The embedder preset runs on the model; a candidate that beats
  the active embedder by 0.02 is proposed; approving switches the slot (re-embedding in the background).
- **Embedder switching:** `rh.papers` follows a change of the active embedder plugin live.
- **API and UI:** `/v1/engineer/ideas…`; the Upgrades tab gets an Engineer section (propose an idea, stages, Build /
  Reject, the build log, Enable / Remove) and "Ask the engineer" on suggestions.

## Out of scope

Building other kinds of plugins automatically (the assessment says so and stops); prompt optimization; paid GPUs.

## Capabilities

### New Capabilities
- `engineer`: ideas, research, assessment, builders, tests, proposals.

### Modified Capabilities
- `slots`: the local embedder alternative and switching embedder plugins live.

## Impact

New built-ins `rh.engineer`, `rh.embedder-local`; `src/engineer/*` (Kaggle runner, source builder, training
script); `rh.papers` (provider switch); harness (local embedder candidates); Dockerfile `full` (sentence-transformers,
the embedding server); routes, SDK, Upgrades tab; `.env.example` (`KAGGLE_API_TOKEN`, `RH_LOCAL_EMBED*`).
