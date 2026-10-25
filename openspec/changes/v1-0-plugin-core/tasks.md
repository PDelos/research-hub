# Tasks

## 0. Stack upgrade (before the refactor)

- [x] 0.1 Move to Node 26 LTS (image, `engines`, @types/node) and TypeScript 6.0.3; verify `npm run check` and all tests pass
- [ ] 0.2 Adopt Vite+ 1.x (`vp`): one config with lint, fmt and test sections, replace the separate Vite, Oxlint and Oxfmt setup, format the whole codebase once (its own commit), make `vp check` (format, lint, types) an enforced check; verify `vp check`, `vp build` and all tests pass
- [ ] 0.3 Upgrade pi-durable, pi-ai and chord to 1.4.0 behind `packages/durable-agent`; verify the recovery (SIGKILL) tests, the agent tests and an offline end to end pass unchanged (otherwise stay on 1.1.0 and record why)
- [ ] 0.4 Upgrade Vue, Express and the remaining dependencies to current versions and rebuild the Docker image on `node:26-slim`; verify `npm audit`, the image build and a container start

## 1. Kernel

- [ ] 1.1 Define the manifest schema and loader (validation with field-level errors, engines check, dependency graph with cycle detection); verify tests for invalid manifests, incompatible engines, missing and cyclic dependencies
- [ ] 1.2 Implement the plugin state repository (`data/plugins`, lockfile, isomorphic-git commits, history, rollback, first-start lockfile from the environment); verify tests for history, rollback and the first start of an existing v0 project
- [ ] 1.3 Implement activation and lifecycle (activation events, context with subscriptions and dependency exports, 10 s timeout, failed state, runtime enable/disable, SSE `plugins` frame); verify tests for lazy activation, disable, failure isolation and dependency ordering
- [ ] 1.4 Implement kernel contribution points (tabs, settings with JSON schema and environment defaults, commands, chat tools on the desk allow-list, Jev commands in the lock, prompts, processes) and plugin-offered extension points with cardinality; verify tests for each, the unknown-point report and `check:jev` across plugins
- [ ] 1.5 Implement the `rh` API v1.0.0 (db with namespaced migrations, files, http with host allowlist and budgets, models, embeddings, decisions, agents, scheduler, events, processes, ui, proposals stub) and permission enforcement with logging; verify tests for an undeclared host, a budget limit and a forbidden file

## 2. Built-in plugins (v0 moved, behavior unchanged)

- [ ] 2.1 Move models and Jev into `rh.provider-openrouter` and `rh.decision-jev`; verify the v0 agent, Jev and startup tests pass unchanged
- [ ] 2.2 Move papers, sources and representations into `rh.papers`, `rh.source-*`, `rh.representations`, `rh.embedder-openrouter`; verify the v0 paper and representation tests pass unchanged and a disabled Semantic Scholar plugin sends no request
- [ ] 2.3 Move charter, schedule, sweep, cards, feedback and the desk into their plugins; verify the v0 charter, schedule, sweep, card and feedback tests pass unchanged
- [ ] 2.4 Move the knowledge base into `rh.kb` (offers `kb.store`, `kb.viewer`), the viewer into `rh.viewer-obsidian`, and add `rh.viewer-library`; verify the v0 vault, ingest, search and viewer tests pass unchanged and the swap scenario (Obsidian ↔ Library, process stops and restarts)

## 3. External plugins

- [ ] 3.1 Implement the plugin host (child process with Node's permission model, clean environment, JSON-RPC `rh` proxy, crash and hang handling) and install from a folder or git URL with permission approval, uninstall with or without data; verify tests with a sample external plugin that adds a chat tool and a paper source, a crashing plugin, an undeclared host and no visible secrets
- [ ] 3.2 Serve external UI entries and mount them as custom elements with the hub's tokens; verify a sample plugin tab renders and disappears when disabled

## 4. API and UI

- [ ] 4.1 Add the `/v1/plugins` routes, `/v1/info` kernel and plugin versions, and SDK methods; verify API tests (list, details, install with approval, enable, disable, settings validation, history, rollback)
- [ ] 4.2 Add Vue Router and Pinia, build the tab bar and Settings from contributions, and add the Plugins tab (state, contributions, permissions, settings, history, actions); verify `npm run build`, the UI test, and screenshots of the Plugins tab in light and dark
- [ ] 4.3 Add Playwright UI tests (tab bar follows enable/disable, viewer swap, Plugins tab actions, light and dark screenshots) and run them offline; verify they pass and replace `scripts/screenshot.mjs` in the docs

## 5. Integration

- [ ] 5.1 Run all tests, check, check:jev, check:env, lint, audit; offline end to end: disable and enable the viewer, swap to the Library viewer, install the sample external plugin and use its chat tool, roll back
- [ ] 5.2 Docker: rebuild the image, start the existing `proteins` project on it (first-start lockfile, nothing lost), and repeat the swap and rollback in the container; record the results
- [ ] 5.3 Update `README.md` (plugins, the Plugins tab, writing a plugin with a minimal example manifest) and EVOLUTION.md if decisions changed
