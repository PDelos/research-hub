# Proposal

## Why

The user wants the whole Research Hub to be plug and play: any part (paper sources, embedders, agents, UI tabs, the
knowledge-base viewer) installable, swappable and removable per project, so that alternatives can be compared and
adopted, by the user or later by the hub's own agents. v0 is a single server with fixed features. This change
turns it into a small kernel plus plugins modeled on VS Code extensions (EVOLUTION.md §2). It is the first v1
change; every later v1 change (harness, full text, knowledge loop, comparisons, scout, engineer, MCP) adds
plugins on top of it.

## What Changes

- **Kernel:** plugin loading, a versioned `rh` API (db, files, settings, secrets, http, models, decisions, agents,
  scheduler, events, processes, ui, proposals), the HTTP server and its guard, the durable agent runtime, and the
  project state. Nothing else.
- **Plugins, VS Code style:** an `rh-plugin.json` manifest per plugin (id, version, `engines.research-hub`,
  `main` and `browser` entries, `activationEvents`, declarative `contributes`, `dependencies`, `permissions`),
  `activate(context)` / `deactivate()`, optional exported APIs, lazy activation.
- **Extension points owned by plugins** (Backstage style): e.g. `papers.source`, `papers.embedder`, `sweep.phase`,
  `kb.viewer`, `kb.store`; plus kernel contribution points: `tabs`, `settings`, `commands`, `chatTools`,
  `jevCommands`, `prompts`, `processes`.
- **Per-project plugin state** in `data/plugins/` (a git repository with `plugins.lock.json`): install from a
  folder or git URL, enable, disable, configure, uninstall, and roll back to any earlier lockfile.
- **A plugin host** for third-party and agent-written code: a separate process with Node's permission model and
  only the declared files, hosts and secrets; crashes do not affect the kernel.
- **All of v0 refactored into built-in plugins** without behavior change (all v0 tests keep passing), including
  the Obsidian viewer, and a second built-in `kb.viewer` (the Library) to prove swapping.
- **A Plugins tab:** every plugin with its state, version, contributions, permissions, settings and history;
  enable, disable, install, uninstall, roll back.
- **Stack upgrade first** (before the refactor, verified by the full v0 test suite): Node 26 LTS, **Vite+ 1.x** as
  the single toolchain (build, dev server, Vitest, Oxlint, Oxfmt, task caching; formatting and linting enforced,
  the codebase formatted once), TypeScript 6.0, Vue 3.5.44, pi-durable / pi-ai / chord 1.4.0, current Express,
  Oxlint and Oxfmt; then Vue Router 5, Pinia 4 and Playwright 1.64 with the UI work.
- **Knowledge base tab** opens on Obsidian's graph view (already shipped on the v0.5 branch; recorded here).

Out of scope: the evaluation harness (v1-1), the Upgrades tab with its scout, tests and proof reports (v1-4), the
engineer agent (v1-5), fine-tuning (v1-6), a public plugin catalog, MCP exposure (v1-7), changing any v0 behavior beyond moving it.

Jev commands added: none (the existing commands move into plugins as `jevCommands` contributions). LLM calls
added: none.

## Capabilities

### New Capabilities

- `plugin-system`: The kernel and plugins: manifests, activation, contributions, extension points, dependencies,
  settings, permissions, isolation, per-project plugin state with history and rollback, and the Plugins view.

### Modified Capabilities

- `knowledge-viewer`: the viewer becomes a plugin contributing to `kb.viewer` (disable or swap it like any
  plugin), and the tab opens on the graph view instead of the index.

## Impact

- `rh-server`: new `kernel/` and `plugins/` folders; v0 modules move into built-in plugins; routes `/v1/plugins…`.
- `rh-client-browser`: the tab bar and Settings are built from contributions; a Plugins tab; plugin UI loading.
- Data: `data/plugins/` (git repo, lockfile, plugin data folders); a `plugin_migrations` table.
- Dependencies: `isomorphic-git` (pure JS, MIT) for the plugin repository, `ajv` for manifest and settings schemas;
  `vite-plus`, `vue-router`, `pinia`, `@playwright/test`; upgrades listed above. The Docker image moves to
  `node:26-slim`.
- Configuration: existing environment variables keep working and map onto plugin settings.
