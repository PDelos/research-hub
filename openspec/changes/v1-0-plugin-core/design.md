# Design

## Context

v0 is complete: one server (`apps/rh-server`) whose features are wired together in `project.ts` and `app.ts`
(papers, representations, sweep and cards, feedback, charter and schedule, knowledge base with ingest, search and the
Ignis viewer, the research desk, OpenRouter models, Jev), and a Vue UI with fixed tabs. EVOLUTION.md §2 defines the
target: a small kernel and VS Code-style plugins for everything else. Requirements: `specs/plugin-system`,
`specs/knowledge-viewer` (modified). This change moves code; it must not change v0 behavior.

## Goals / Non-Goals

**Goals:**
- A kernel with a versioned `rh` API; plugins with manifests, lazy activation, declarative contributions, extension
  points, dependencies, settings, permissions; a plugin host for external code; per-project state with history.
- Every v0 feature as a built-in plugin; all v0 tests pass unchanged.
- Real swappability shown twice: a second `kb.viewer`, and installing an external plugin that adds a chat tool and
  a paper source.

**Non-Goals:** the harness (v1-1); the Upgrades tab, scout, tests and proof reports (v1-4); the engineer agent; a
public catalog; MCP exposure; any new paper-pipeline behavior. The kernel's `proposals` API and the plugin history
are what the Upgrades tab will build on.

## Decisions

### D1. Manifest (`rh-plugin.json`), modeled on VS Code's `package.json`
Fields: `id` (`publisher.name`), `version`, `displayName`, `description`, `engines.research-hub` (semver range),
`main` (server entry, ESM, exports `activate(context)` and optional `deactivate()`), `browser` (UI entry),
`activationEvents` (`onStartup`, `onView:<tab>`, `onCommand:<id>`, `onChatTool:<name>`,
`onExtensionPoint:<point>`, `onSchedule:<kind>`, `*` only for built-ins), `contributes`, `dependencies` (plugin ids
with version ranges), `permissions` (`network` hosts, `files` scopes, `secrets` names, `budgetUsdPerDay`),
`builtin` (set only by the kernel). Validated with a JSON schema (ajv); errors name the field.

### D2. Kernel and the `rh` API (version 1.0.0)
The kernel owns: plugin discovery and the lockfile, the project databases, the durable agent runtime, HTTP with the
UI guard, secrets, budgets, logging and the proposals inbox (empty until v1-4). Plugins get a `context`:
`context.rh` (the API), `context.settings` (their own, typed by their schema), `context.storage` (their own folder
under `data/plugins/data/<id>/`), `context.subscriptions` (disposed on deactivate, like VS Code), `context.exports`
of dependencies, and `context.log`. API namespaces: `db` (own tables with namespaced migrations recorded in
`plugin_migrations`; the v0 tables stay in the kernel's core schema so no data moves), `files`, `http` (host
allowlist, pacing, budgets; built on v0's `PoliteHttp`), `models` and `embeddings` (through the active provider
plugin), `decisions` (through the active decision engine), `agents` (register agents, sections, chat tools with
the desk allow-list), `scheduler`, `events` (typed bus: `paper.stored`, `card.created`, `judgment.changed`,
`kb.noteWritten`, `sweep.finished`…), `processes` (supervised children, from v0's viewer supervisor), `ui`,
`proposals`.

### D3. Activation and lifecycle
At start the kernel reads all manifests (no code), resolves dependencies (topological order; cycles rejected),
registers every contribution, and activates only plugins whose events fired (`onStartup` at start). Activation is
awaited with a 10 s timeout; failures mark the plugin `failed` with the error. Enabling or disabling at runtime
activates or deactivates without a restart; contributions update and the UI is told through an SSE `plugins` frame.
A settings change restarts the plugin unless it handles changes live through `context.onSettingsChange` (like VS
Code's configuration events); `rh.kb` does, so switching the viewer never replaces the vault and index objects.

### D4. Contributions
Kernel contribution points: `tabs` (id, title, order, view component), `settings` (JSON schema properties, defaults
from environment variables through an `env` mapping), `commands`, `chatTools` (registered on the desk when the
plugin is active; added to its allow-list), `jevCommands` (folders of `command.json`; the lock covers all
enabled plugins), `prompts` (agent prompt folders), `processes`. Plugin-offered points are declared by the
offering plugin under `contributes.extensionPoints` with a JSON schema and `cardinality: one | many`; for `one`,
the active contribution is a setting of the offering plugin.

### D5. UI contributions
The UI stays Vue 3 + Vite and gains **Vue Router** (each contributed tab is a route; replaces the hand-made hash
router) and **Pinia** (shared stores that plugin views read). The client asks `/v1/plugins/contributions` and
builds the tab bar and Settings from it. Built-in tabs map to Vue
components bundled with the UI (by view id). External plugin views are ES modules served from the plugin's
`browser` entry under `/plugins/<id>/…` and mounted as custom elements, with a small `rhClient` passed in (the
same SDK the UI uses, through the UI proxy). The hub's design tokens are CSS variables they inherit.

### D6. Where plugins run
Built-in plugins run in the kernel's process (trusted, like VS Code's built-in extensions). External code plugins
run in one **plugin host** child process per plugin, started with Node's permission model
(`--permission --allow-fs-read/--allow-fs-write` limited to the plugin's folder and declared scopes, no child
processes, no addons, no worker threads) and a clean environment (no secrets); the `rh` API is a JSON-RPC proxy over
stdio to the kernel, which enforces the declared network hosts, secrets and budgets on every call. Process plugins
(`contributes.processes`) are supervised by the kernel (restart with backoff, loopback only).
The plugin process gets no network at all (`--permission` without `--allow-net`): its requests go through
`rh.http`, where the kernel checks the declared hosts. Kernel and plugin call each other over Node's IPC channel and
functions cross as handles, so handlers, paper sources and disposables work both ways; every `rh` call is
asynchronous on that side. A crash, or a call unanswered for 30 s, marks only that plugin failed (enabling it again
starts a fresh process). The desk sees an external plugin's chat tools from the next start after installation
(the agent runtime fixes its tools when it opens); enabling and disabling take effect at once. An installed
plugin whose files no longer match the hash recorded at approval does not run.

### D7. Per-project plugin state
`data/plugins/` is a git repository (isomorphic-git, no git binary needed in the image): `plugins.lock.json` (id,
version, source, content hash, enabled, settings), `installed/<id>/` (external plugins' files) and `data/<id>/`
(their storage, ignored by git). Every change is a commit with a message ("enable rh.viewer-obsidian", "install
acme.source-pubmed 0.1.0"); rollback checks out an earlier lockfile and re-applies it (deactivate, activate,
background re-computation for data-bearing slots as in v0's model change). Built-ins are pinned to the kernel's
version and cannot be uninstalled, only disabled (unless required).

### D8. Refactor map (v0 → built-in plugins)
| Plugin | From | Offers | Contributes |
|---|---|---|---|
| `rh.provider-openrouter` | model catalog, faux | `models.provider` | settings: models per job |
| `rh.decision-jev` | Jev client, ledger, mock | `decision.engine` | settings: Jev model |
| `rh.papers` | papers/ (store, search, cache, http) and representations/ (facets, vectors, citations) | `papers.source`, `papers.enricher`, `papers.embedder` | chat tool `search_papers`, Jev `abstract-facets` |
| `rh.source-arxiv`, `-openalex`, `-europepmc`, `-semanticscholar` | sources/ | | `papers.source` (+ `papers.enricher` for OpenAlex); declarative, no code |
| `rh.embedder-openrouter` | embed.ts | | `papers.embedder` (creates the embedder rh.papers uses) |
| `rh.charter` | charter, charter writer | | tab Charter, agent, prompts |
| `rh.schedule` | scheduler | | settings, Settings section |
| `rh.sweep` | sweep, cards, card writer, scores | `sweep.phase` | tab Feed, Runs section, Jev commands, agent, prompts |
| `rh.feedback` | feedback, reasons, tools | | chat tools `recent_cards`, `judge_card`, Jev `reason-parse` |
| `rh.kb` | vault, ingest, search, KB tools | `kb.viewer` (`kb.store` later, when a second store exists) | tabs Library and Knowledge base, chat tools `search_kb`, `query_kb`, librarian |
| `rh.viewer-obsidian` | viewer supervisor (pause/resume), loopback | | `kb.viewer` (obsidian), process `ignis`, enablement `RH_KB_VIEWER` |
| `rh.viewer-library` | new (reuses the Library view) | | `kb.viewer` (library) |
| `rh.desk` | agents, desk prompt | | the root agent and chat |
| `rh.settings-ui`, `rh.runs-ui` | Settings and Runs tabs | | tabs |
Representations stay inside `rh.papers` in v1-0 because the paper service ties search, storage and vectors
together; v1-2 (full text and facets) splits them into `rh.representations`. A search queries the built-in source
clients whose `papers.source` contributions are enabled plus any client a plugin exports as `sources[id]`, and
enriches only while an enabled plugin contributes the `openalex` enricher. Core built-ins (provider, decision
engine, papers, the embedder until a second one exists, charter, schedule, sweep, feedback, desk, knowledge base)
are `required`: they can be configured but not disabled.
Each built-in plugin is a folder `apps/rh-server/plugins/<id>/` with its `rh-plugin.json` and an activation module
that wraps the existing v0 modules, which stay in `src/` for now (so every v0 test keeps its imports and assertions;
moving the files physically is a later cleanup and changes nothing for plugins). Chat tools of lazily activated
plugins are declared in the manifest with a JSON schema, so the desk offers them before the plugin's code is loaded;
the first call activates the plugin (`onChatTool:<name>`) and runs its registered handler.

### D9. Compatibility
Environment variables keep working (`RH_KB_VIEWER`, `RH_MODEL_*`, `CONTACT_EMAIL`, …) as defaults of the matching
plugin settings; the HTTP API keeps its routes; the data folder layout is unchanged except for `data/plugins/`.
Existing projects (the running `proteins` project) start with every built-in plugin enabled.

### D10. API routes
`GET /v1/plugins` (list with state), `GET /v1/plugins/:id` (manifest, contributions, permissions, settings,
history), `POST /v1/plugins/install` (`{ source }`, returns what needs approval), `POST /v1/plugins/:id/approve`,
`POST /v1/plugins/:id/enable|disable`, `PUT /v1/plugins/:id/settings`, `DELETE /v1/plugins/:id`
(`?deleteData=true`), `GET /v1/plugins/history`, `POST /v1/plugins/rollback` (`{ commit }`),
`GET /v1/plugins/contributions`; SSE `plugins` frame on change.

### D11. Stack upgrade (task group 0, before the refactor)
- **Node 26 LTS** (LTS from 2026-10-28) in the image and `engines`; Node 24 is in maintenance.
- **Vite+ 1.x** replaces the separate `vite`, `oxlint` and `oxfmt` dev dependencies: one `vite.config.ts` with
  `lint`, `fmt` and `test` sections; `vp check` runs formatting, linting and type checks and must pass; the whole
  codebase is formatted once in its own commit (v0 never enforced formatting). Server tests stay on `node:test`
  (run as a `vp` task); new UI unit tests use Vitest; Playwright covers the UI end to end.
- **TypeScript 6.0.3**, not 7.0: TypeScript 7's native compiler has no API for Volar/vue-tsc yet (expected with
  7.1). The 7.1 move is recorded as the first Upgrades-tab idea for v1-4.
- **pi-durable, pi-ai, chord 1.1.0 → 1.4.0**: all usage is inside `packages/durable-agent`; the upgrade lands
  only if the recovery (SIGKILL) tests, the agent tests and the offline end to end pass unchanged; otherwise
  stay on 1.1.0 and record why.
- Minor upgrades: Vue 3.5.44, Express 5.3.x, Oxlint 1.89, Oxfmt 0.74 (through Vite+), @types/node 26.

## Risks / Trade-offs

- [A big refactor can change behavior] → move code without rewriting it; the v0 suite must pass unchanged at every
  task group; an offline end-to-end and a live check at the end.
- [Node's permission model is not a full sandbox] → it limits files, child processes and addons; network and
  secrets are enforced by the kernel because plugin hosts get no keys and reach the network only through the
  kernel's `http`; agent-written code still needs human approval (EVOLUTION.md §3.6).
- [Over-generalizing too early] → only the extension points v0 needs plus `kb.viewer` swapping and an external
  source; new points are added by the changes that need them.

## Migration Plan

On first start with this change, the kernel creates `data/plugins/` with a lockfile enabling every built-in plugin
(settings from the current environment) and commits it; no database data moves. Rollback of the change: the v0
image ignores `data/plugins/`.
