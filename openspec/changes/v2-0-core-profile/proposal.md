# Proposal

## Why

The hub now carries every step-7 feature (engineer, weekly upgrade, knowledge loop, harness, question finders,
Docling, local embedder). Before shipping, the user wants to use it daily for two or three weeks on the plain
loop only: sweep, cards, judgments, weights, notes on ⭐ and a weekly digest. That needs a small, quiet
"core" profile that hides the rest without deleting any of it, so each advanced feature can come back with one
setting.

## What Changes

- New setting `RH_PROFILE` = `core` | `full` (default `core`), read in `config.ts`, documented in `.env.example`.
  `full` behaves exactly like today.
- In the core profile nine built-in plugins are disabled: `rh.engineer`, `rh.upgrades`, `rh.knowledge`,
  `rh.harness`, `rh.finder-method-transfer`, `rh.finder-missing-links`, `rh.finder-rising-topics`,
  `rh.converter-docling`, `rh.embedder-local`. The profile applies to new projects and, once when the profile
  changes, to existing ones (one undoable plugin-state commit); after that the user's own enable/disable choices
  stand.
- `rh.engineer`, `rh.upgrades`, `rh.knowledge` and `rh.harness` stop being `required` (their kind stays as it
  is), so they can be disabled. **BREAKING** for nobody in practice: `full` still enables them.
- Everything that uses them degrades gracefully: the digest leaves out their sections, the nightly run skips their
  work, their routes answer "feature off" (409 with the plugin id) instead of failing, and the UI leaves out what
  depends on them (Charter proposals, Quality and Upgrades tabs, the engineer section, source attribution).
- Settings gets "Advanced features": the nine plugins with a switch each, enabling one at a time without a
  restart (through the existing plugin enable/disable, so every switch is an undoable commit).
- In core the tab bar shows only Feed, Library, Charter and Settings; Runs, Digest, Quality, Upgrades, Plugins
  (and the Obsidian view) move under an "Under the hood" link in Settings and stay reachable by URL.
- In core the weekly digest shows only sections that have content (in `full` it shows every section, as today).

Out of scope: deleting or renaming any file, plugin, spec or test; style refactors or lint-rule work; changing what
any advanced feature does when it is enabled; a profile for external plugins; new images.

Jev commands and LLM calls: none added or changed. In core, fewer calls run (no knowledge review, harness
labelling, weekly upgrade or engineer research), because their plugins are off.

## Capabilities

### New Capabilities
- `feature-profiles`: the `RH_PROFILE` setting, which plugins each profile turns off and when, the Advanced
  features switches, and which tabs the core profile shows.

### Modified Capabilities
- `plugin-system`: "v0 as built-in plugins" — the engineer, upgrade, knowledge and harness plugins become optional
  built-ins; disabling any optional built-in leaves the rest working.
- `daily-cycle`: "One orchestrated daily cycle" runs without the optional plugins, and "Weekly digest" leaves out
  sections whose plugin is off and, in core, empty sections.

## Impact

- Server: `src/config.ts` (profile), `src/kernel/registry.ts` / `lifecycle.ts` / `host.ts` (initial enablement and
  the one-time profile commit), four `rh-plugin.json` files (`required`), `routes-{engineer,upgrades,harness,knowledge}.ts`
  (feature-off answer), `plugins/rh.digest` (non-empty sections), `/v1/info` (profile).
- SDK: `Info.profile`; the client keeps its calls.
- UI: tab filtering by profile, Settings "Advanced features" and "Under the hood", Charter/Digest/Plugins views
  tolerate missing features.
- Docs: `.env.example`, README profile section.
- Tests: existing suites run with `RH_PROFILE=full`; new tests for core start-up, enabling each plugin live,
  digest and nightly run with the plugins off.
