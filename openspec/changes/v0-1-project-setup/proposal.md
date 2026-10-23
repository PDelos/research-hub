# Proposal

## Why

A Research Hub container serves exactly one research project. Before any paper can be found, that project must
know what it is about (an approved charter derived from the user's brief) and when to run. This is layer 1 of
the v0 pyramid and depends on `v0-0-skeleton` (`deployment`, `agent-runtime`, `jev-client`).

## What Changes

- On first start the project has no brief; the UI asks for one (paste or upload markdown). The brief can be
  replaced later.
- The project agent drafts a **charter** (research questions with weights, concepts, sub-areas, search queries,
  out-of-scope) in a separate conversation on the `review` model; the user edits and approves it. Approved
  charters are versioned.
- The agent asks up to 5 **scoping questions** (two-way prompting) and folds the answers into the draft.
- The project can be **paused** (no scheduled runs, chat still works) and resumed. Stopping or removing a project
  is stopping or removing its container.
- A **schedule**: daily sweep and weekly review slots, requested exactly once per slot across restarts. The
  default sweep time comes from `RH_SWEEP_TIME`, which `new-project.sh` staggers between projects so several
  containers on one machine do not hit the paper APIs at the same moment. In this layer a due sweep only records a
  "sweep requested" run; the sweep itself arrives in `v0-3-daily-sweep`.
- A **project overview** in the UI: name, status, charter version, next sweep and review, cost this month.

Out of scope: several projects per container (a new theme is a new container), paper search, sweeps, cards,
vault, the weekly review's content.

Jev commands added: none. LLM calls added: charter draft and revisions (the `review` model, a few runs per
project).

## Capabilities

### New Capabilities

- `project-charter`: The project's brief, the drafting, revision and approval of its charter with scoping
  questions, charter versions, pausing, and the project overview.
- `scheduling`: When the project's sweep and review run, how runs are triggered exactly once per slot, and how
  the user pauses, changes or manually triggers them.

### Modified Capabilities

(none)

## Impact

- `rh-server`: brief storage, charter-writer conversation and tools, charter and schedule routes, ticker, new
  tables in `project.sqlite`; `rh-client-browser`: brief screen, Charter and Settings tabs, overview.
- Config: `RH_TIMEZONE`, `RH_SWEEP_TIME`, `RH_REVIEW_TIME`.
- Builds on `agent-runtime` (conversations, models per job) and `deployment` (data directory, project name).
