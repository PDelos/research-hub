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
| `rh.papers` | papers/ (store, search, cache, http) | `papers.source`, `papers.enricher` | chat tool `search_papers` |
| `rh.source-arxiv`, `-openalex`, `-europepmc`, `-semanticscholar` | sources/ | | `papers.source` (+ enricher for OpenAlex) |
| `rh.representations` | representations/ | `papers.embedder` | |
| `rh.embedder-openrouter` | embed.ts | | `papers.embedder` |
| `rh.charter` | charter, charter writer | | tab Charter, agent, prompts |
| `rh.schedule` | scheduler | | settings, Settings section |
| `rh.sweep` | sweep, cards, card writer, scores | `sweep.phase` | tab Feed, Runs section, Jev commands, agent, prompts |
| `rh.feedback` | feedback, reasons, tools | | chat tools `recent_cards`, `judge_card`, Jev `reason-parse` |
| `rh.kb` | vault, ingest, search, KB tools | `kb.store`, `kb.viewer` | tab Library, chat tools `search_kb`, `query_kb`, librarian |
| `rh.viewer-obsidian` | viewer, proxy, loopback, Knowledge tab | | `kb.viewer` (obsidian), tab Knowledge base, process `ignis` |
| `rh.viewer-library` | new (reuses the Library view) | | `kb.viewer` (library) |
| `rh.desk` | agents, desk prompt | | the root agent and chat |
| `rh.settings-ui`, `rh.runs-ui` | Settings and Runs tabs | | tabs |
Files move under `apps/rh-server/plugins/<id>/` with their tests; the v0 tests run unchanged against the kernel.

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
