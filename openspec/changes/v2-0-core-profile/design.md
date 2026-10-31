# Design

## Context

- A built-in plugin gets its lockfile entry when a project first sees it (`builtinEntry`, `initialPlugins` in
  `kernel/registry.ts`; `lifecycle.ts` adds built-ins that appear later). Its initial `enabled` comes from
  `initiallyEnabled(manifest, env)`, driven by the declarative `contributes.enablement.env` (used by the Obsidian
  viewer with `RH_KB_VIEWER`). After that, the lockfile is the truth; a setting read only at first start would
  never reach an existing project such as `proteins`.
- `rh.engineer`, `rh.upgrades`, `rh.knowledge`, `rh.harness` are `"required": true`; the engineer and the upgrade
  depend on the harness. The finders, Docling and the local embedder are already optional.
- Their routes call `plugins.exportsOf(id)`, which throws `PluginUnavailable` when the plugin is off; only
  `routes-plugins.ts` maps that error today. The digest already reads harness and upgrade data through a
  try/catch (`optional`) and runs the knowledge review in a try/catch that logs a warning. The harness and the
  upgrade do their nightly work by listening to `cycle.nightly`, so a disabled plugin simply does nothing.
- Tabs come from active plugins' `contributes.tabs`; Digest, Runs and Plugins belong to core plugins that stay on.
- Undo (`PluginState.revert`) reverses only the per-plugin fields a commit changed.

## Goals / Non-Goals

**Goals:** one setting chooses the profile; `full` is byte-for-byte today's behavior; switching an existing
project is one undoable commit; every gated feature can come back alone without a restart; nothing that uses a gated
plugin errors when it is off.

**Non-Goals:** removing code, plugins, specs or tests; changing what a feature does when on; profiles for external
plugins; style or lint work; new images.

## Decisions

### D1 The profile is declared by the plugins, not listed in the kernel
`contributes.enablement` gains an optional `profile: "full"` (the schema allows `env`, `profile` or both). A
plugin with `profile: "full"` starts disabled unless `RH_PROFILE=full` (inside the kernel an unset
`RH_PROFILE` means `full`, the behavior before profiles; the configuration always sets it, default `core`). The nine plugins declare it; the kernel
knows no plugin ids. Alternative considered: a hard-coded list in `config.ts` — rejected, it puts plugin knowledge in
the kernel and would miss a future advanced plugin.

### D2 `RH_PROFILE` in config, passed to the plugin host's environment
`loadConfig` reads `RH_PROFILE` (`core` default, `full`; anything else is a `ConfigError`). `openProject` already
builds the plugin host's `env`; it adds `RH_PROFILE`, so `initiallyEnabled` sees it like `RH_KB_VIEWER`. `/v1/info`
reports `profile`.

### D3 One-time profile commit for existing projects
The lockfile gains two optional top-level fields: `profile` (the profile last applied) and `profileDisabled` (the
plugins that profile turned off). At start, after the lockfile is opened:
- missing `profile` means the project predates profiles and is treated as `full`;
- if `profile` differs from `RH_PROFILE`: going to core, every plugin declaring `profile: "full"` that is enabled
  is disabled and listed in `profileDisabled`; going to full, every plugin in `profileDisabled` that is still
  disabled is enabled and the list is cleared. Both are one commit `profile: core` / `profile: full`, actor `kernel`;
- a new project's first lockfile gets `profile` set and the plugins already disabled (no extra commit).
Because Undo reverses only per-plugin fields, undoing the profile commit re-enables the plugins while `profile`
stays `core`, so the next restart does not apply the profile again: the user's choice stands. Alternative
considered: re-applying the profile on every start — rejected, it would fight the user's switches.

### D4 The four plugins become non-required
Their manifests drop `"required": true` and keep their `kind`. Nothing else in the kernel changes: disabling an
optional built-in is already supported, and the engineer/upgrade dependency on the harness already blocks them
with a readable reason when the harness is off.

### D5 "Feature off" answers
A new API error code `feature_off` (HTTP 409, `details: { plugin }`) in the server's `ApiFault` and the SDK's
`ErrorCode`. The four route files map `PluginUnavailable` from `exportsOf` to it through one shared helper. The
digest treats `PluginUnavailable` from the knowledge review as "off" (no warning); other errors still warn.

### D6 UI
- `Info.profile` and `PluginSummary.advanced` (true for plugins declaring `profile: "full"`) in the SDK, both
  additive.
- Core tab bar: the plugins store filters tabs to `feed`, `library`, `charter`, `settings` when `profile` is core;
  the other active tabs are listed in Settings under "Under the hood" and their routes still work.
- Settings "Advanced features": the advanced plugins with description, state and a switch calling the existing
  enable/disable endpoint; a blocked plugin shows its dependency and a button that enables the dependency first.
- Charter, Digest and Plugins views catch `feature_off` and hide the part that needs the feature. In core the
  Digest view hides sections with nothing to report.

### D7 Tests run in either profile
`tests/test-server.ts` passes `process.env.RH_PROFILE` through; tests that exercise the gated plugins pin
`profile: "full"` in their configuration (no assertion changes), so `npm test` passes with `RH_PROFILE=full` and
with `RH_PROFILE=core`. New tests: core start-up state, the one-time switch and Undo, enabling each of the nine
live, digest and simulated week with them off, `feature_off` routes, invalid profile. The UI tests and
`scripts/e2e-offline.sh` take the profile from the environment; steps that use a gated feature run only in full
and check `feature_off` in core.

Deviation from the vendored news-agent patterns: none; this change touches only the hub's plugin layer.

## Risks / Trade-offs

- **Default is core** → an existing project (e.g. `proteins`) loses its advanced features at its next start until
  the user switches them on or sets `RH_PROFILE=full`; the switch is one commit with Undo and the digest/Changes feed
  shows it. Mitigation: `.env.example`, `new-project.sh` and the README say so.
- **Project context says the harness is core** (never changeable by upgrades). Making it optional does not let
  upgrades change it; it only lets the user turn it off. Recorded here so the next review does not read it as drift.
- **Two new lockfile fields** → older hubs ignore unknown top-level fields (the lockfile is read as JSON); checked by
  a test that opens a lockfile with them.
