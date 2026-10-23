# Proposal

## Why

Every Research Hub feature (sweeps, cards, feedback, vault, reviews) runs on the same foundation: a
durable agent that survives crashes, a Jev client for cheap bounded decisions, a live event stream to
the browser, and a container that keeps data safe. This change builds only that foundation, with no paper
logic, so every later layer of v0 stands on tested ground. It is the base of the v0 pyramid (see
PLAN.md §17).

## What Changes

- New repository skeleton under `research-hub/` (npm workspaces, Node 24, TypeScript).
- **Vendor two proven packages** from `disler/pi-durable-news-agent` (MIT, provenance in `NOTICE.md`)
  with their tests: `durable-agent` (pi-durable harness, compaction, subagents, idempotent tools,
  observability, faux model) and `jev` (client, versioned commands, policy, ledger, mock).
  Remove the Jev client's TypeSafe-direct provider: OpenRouter only.
- **Write our own** server (`rh-server`, Express 5) and browser client (`rh-client-browser`, Vue 3) for
  **one research project per container**: a new theme is a new container, never a second project inside one.
  Individual infra files
  from the news agent (SSE stream, auth, idempotency, telemetry projector, crash-recovery test) are
  copied as starting points where they fit, never as a whole app.
- **Projects never interfere:** a data-directory ownership lock, clear port-conflict errors, a project name in
  UI, health, logs and compose name, per-project host names (`<name>.localhost`) for separate browser state,
  resource limits, and a `new-project` script that sets all of this up with a staggered sweep time.
- A placeholder **research-desk** agent that can chat (no paper tools yet), with run
  telemetry, cost, compaction and a Runs view.
- **All models and Jev through OpenRouter** (`OPENROUTER_API_KEY`), model IDs per job from configuration
  (`desk`, `reader`, `review`, `chat`, `jev`), pinned IDs rather than moving aliases.
- **Offline mode** (`RH_MODE=offline`): faux model + mock Jev, no network, used by all tests.
- **Docker**: one container (API + UI on port 4850), `/data` volume, health endpoint, restart policy.

Out of scope: paper sources, embeddings, sweeps, cards, feedback, vault,
weekly review, TUI/CLI clients.

Jev commands added: `ping` (smoke test only). LLM calls added: chat turns of the placeholder agent.

## Capabilities

### New Capabilities

- `deployment`: How the hub is packaged and run: one container per project, configuration through
  environment, persistent data volume, health reporting, restart behavior, credential handling, offline mode,
  and the guarantees that keep several project containers on one machine from interfering.
- `agent-runtime`: The durable project agent: chat over the API with a live event stream, survival of
  restarts without losing or duplicating work, restricted tools, configurable models, telemetry and cost,
  compaction.
- `jev-client`: How bounded decisions are requested from Jev: versioned commands, OpenRouter-only
  provider rules, input size limit, retries, mock backend, cost ledger.

### Modified Capabilities

(none, first change)

## Impact

- New code: `apps/rh-server`, `apps/rh-client-browser`, `packages/{durable-agent,jev,rh-sdk}`.
- Dependencies: `@earendil-works/pi-durable`, `pi-ai`, `chord` 1.1.0 (pinned exactly), Express 5,
  Vue 3, Vite; Node's built-in `node:sqlite` (no native build).
- External services: OpenRouter in live mode; none offline.
- Host: Docker daemon for the container path; the npm path works without Docker.
