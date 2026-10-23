# Proposal

## Why

This is the product's core loop: every day, without the user, the project agent finds new papers,
lets Jev throw out what does not fit, ranks the rest, and presents a handful of explained paper cards.
Jev makes the bulk decisions so the main model only writes the few cards that survive. Layer 3 of the
v0 pyramid; depends on `v0-2-paper-sources` (records, embeddings), `v0-1-projects` (charter, schedule)
and `v0-0-skeleton` (durable runtime, Jev client).

## What Changes

- A durable, checkpointed **sweep** per project with phases plan → gather → dedupe → gate → enrich →
  level → rank, resuming after crashes without paying Jev twice for the same paper.
- **Orientation mode** for new projects (until 10 papers are judged): queries favor surveys, reviews,
  tutorials and highly cited foundational work, so a user new to the field starts with foundations.
- **Jev at every gate**: `on-theme`, `paper-kind`, `worth-reading`, `level`, `importance`, each a
  versioned command with thresholds and a review band.
- **Paper cards** written by the agent for the top N (default 7, range 1–15): Relevance, Trust and
  Value scores with one-line reasons, a level tag, a short summary, the matched research question.
- The Feed view shows cards newest sweep first; the Runs view shows each sweep's phases, counts, Jev
  calls and cost.

Out of scope: user feedback and learning (v0.4), the vault (v0.5), full-text reading, relations to the
knowledge base, Jev trust reading of abstracts, curriculum level-ups (all v1).

Jev commands added: `on-theme`, `paper-kind`, `worth-reading`, `level`, `importance`.
LLM calls added: one `desk` agent run per sweep that writes the cards (Haiku-class model).

Design and tasks are written when this layer is next to implement.

## Capabilities

### New Capabilities

- `paper-sweep`: The scheduled, durable pipeline that turns charter queries into a short, ranked list of
  candidate papers using Jev decisions, and its guarantees under failure.
- `paper-cards`: How candidates are presented to the user: scores and reasons, level, summary, and the
  rules that keep cards honest and consistent with the underlying decisions.

### Modified Capabilities

(none)

## Impact

- `rh-server`: sweep task, Jev commands under `prompt_engineering/jev/`, desk agent tools
  (`run_paper_sweep`, `list_candidates`, `present_paper`, `complete_sweep`), candidates/cards tables.
- `rh-client-browser`: Feed view with cards; sweep detail in Runs.
- Cost: ~1,000 Jev calls per sweep (~$0.04) and one Haiku 5.5 agent run (~$0.03).
