# Proposal

## Why

The hub is organized around projects: one theme each, with its own agent, data, settings and schedule.
Before any paper can be found, a project must exist, know what it is about (an approved charter derived
from the user's brief) and know when to run. This is layer 1 of the v0 pyramid and depends on
`v0-0-skeleton` (`deployment`, `agent-runtime`, `jev-client`).

## What Changes

- Create, list, pause, resume and archive projects from the UI and API; each project fully isolated.
- Upload a project brief (markdown); the project agent drafts a **charter** (research questions with
  weights, concepts, sub-areas, search queries, out-of-scope) that the user edits and approves.
- The agent asks up to 5 scoping questions before the charter is final (two-way prompting).
- A per-project **schedule**: daily sweep slot and weekly review slot, with idempotent triggering that
  survives restarts. In this layer a due sweep only records a "sweep requested" run; the sweep itself
  arrives in `v0-3-daily-sweep`.
- A hub page listing projects with status, next scheduled run and cost to date.

Out of scope: paper search, sweeps, cards, vault, the weekly review's content.

Jev commands added: none. LLM calls added: charter draft and scoping questions (once per project, the
`review` model), revisions on request.

Design and tasks are written when this layer is next to implement.

## Capabilities

### New Capabilities

- `project-lifecycle`: Creating and managing projects, the brief, the charter and its approval, and the
  isolation between projects.
- `scheduling`: When each project's sweep and review run, how runs are triggered exactly once per slot,
  and how users pause, change or manually trigger them.

### Modified Capabilities

(none)

## Impact

- `rh-server`: project registry in `hub.sqlite`, project routes, ticker; `rh-client-browser`: hub page,
  project settings, charter editor.
- Builds on `agent-runtime` (one root agent per project) and `deployment` (data layout).
