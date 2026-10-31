# feature-profiles Specification

## Purpose
How much of the hub is on: the everyday core profile (sweep, cards, judgments, weights, notes on ⭐, a weekly
digest) or the full one, which advanced features the core profile leaves off, how a project switches between them,
how each feature comes back on its own, and how everything that uses a feature behaves while it is off.

## Requirements

### Requirement: Profile setting
The hub SHALL read `RH_PROFILE` from the environment with the values `core` and `full` (default `core`); any other
value SHALL stop start-up with a configuration error naming `RH_PROFILE`. The active profile SHALL be reported by
`GET /v1/info` as `profile`. The `full` profile SHALL behave exactly as the hub did before profiles existed.

#### Scenario: Default profile
- **WHEN** the hub starts without `RH_PROFILE`
- **THEN** `GET /v1/info` reports `profile: "core"`

#### Scenario: Invalid profile
- **WHEN** the hub starts with `RH_PROFILE=lite`
- **THEN** start-up fails with an error naming `RH_PROFILE` and the allowed values `core` and `full`

#### Scenario: Full is unchanged
- **WHEN** the existing test suites run with `RH_PROFILE=full`
- **THEN** every test passes without changing its assertions

### Requirement: Advanced features off in core
In the core profile these nine built-in plugins SHALL be disabled: `rh.engineer`, `rh.upgrades`, `rh.knowledge`,
`rh.harness`, `rh.finder-method-transfer`, `rh.finder-missing-links`, `rh.finder-rising-topics`,
`rh.converter-docling`, `rh.embedder-local`. A new project SHALL start with them disabled. No plugin, file or data
SHALL be deleted.

#### Scenario: New project in core
- **WHEN** a new project starts with `RH_PROFILE=core`
- **THEN** the nine plugins are listed as disabled and every other built-in plugin is enabled

### Requirement: Switching an existing project's profile
An existing project SHALL have the nine plugins disabled once, when it first starts under the core profile after
running under another profile (or before profiles existed), as one plugin-state commit that can be undone; after
that the user's own choices SHALL stand across restarts. Starting under `full` after `core` SHALL re-enable, in one
commit, the plugins the core profile disabled that are still disabled.

#### Scenario: Existing project switches to core
- **WHEN** a project that ran under `full` restarts with `RH_PROFILE=core`
- **THEN** the nine plugins are disabled in one commit named for the core profile, and Undo on that commit enables
  them again

#### Scenario: User choice survives a restart
- **WHEN** in core the user enables `rh.knowledge` and the hub restarts with `RH_PROFILE=core`
- **THEN** `rh.knowledge` is still enabled

#### Scenario: Back to full
- **WHEN** a project that ran under `core` restarts with `RH_PROFILE=full`
- **THEN** the nine plugins are enabled again and the hub behaves as under `full` before

### Requirement: Advanced features switches
Settings SHALL list the nine plugins under "Advanced features", each with its name, one line on what it adds, its
state and a switch. Switching one SHALL enable or disable it at once, without a restart, as an undoable
plugin-state commit; a plugin whose dependency is off SHALL say which dependency it needs (the engineer and the
weekly upgrade need the harness).

#### Scenario: Enable one feature live
- **WHEN** in core the user switches on `rh.harness`
- **THEN** within the same run the Quality data is served (`GET /v1/harness/quality` answers 200) and no restart happened

#### Scenario: Dependency explained
- **WHEN** in core the user switches on `rh.upgrades` while `rh.harness` is off
- **THEN** the switch reports that the weekly upgrade needs the harness, and the hub offers to enable both

### Requirement: Feature off is not an error
When one of the nine plugins is disabled, everything that uses it SHALL leave it out instead of failing: its API
routes SHALL answer 409 with code `feature_off` and the plugin id, the digest and nightly run SHALL skip its part,
and the UI SHALL hide the tab, section or button that needs it without showing an error.

#### Scenario: Route of a disabled feature
- **WHEN** `rh.upgrades` is disabled and a client calls `GET /v1/upgrades`
- **THEN** the answer is 409 with code `feature_off` and plugin `rh.upgrades`

#### Scenario: Charter tab without the knowledge review
- **WHEN** `rh.knowledge` is disabled and the user opens the Charter tab
- **THEN** the charter shows without a Proposals section and without an error message

### Requirement: Core tab bar
In the core profile the tab bar SHALL show only Feed, Digest, Library, Charter and Settings (five tabs), in that
order. Runs, Quality, Upgrades, Plugins and the Obsidian knowledge-base view SHALL be listed under "Under the hood" in Settings
(each only when its plugin is enabled) and SHALL stay reachable by their URLs. In the full profile the tab bar SHALL
show every contributed tab as before.

#### Scenario: Core tabs
- **WHEN** the browser opens a core project
- **THEN** the tab bar has exactly Feed, Digest, Library, Charter, Settings, and Settings has an "Under the hood"
  list with Runs and Plugins

#### Scenario: Under the hood by URL
- **WHEN** in core the user opens `/runs`
- **THEN** the Runs view opens

### Requirement: Rule candidates in the core digest
In the core profile, while the knowledge review (`rh.knowledge`) is off, the weekly digest's judgments section SHALL list
the open rule candidates (reasons the reason classifier found general): each reason once (wording compared without case
or extra spaces), how many judgments gave it, and the cards it came from, the most frequent first, at most 10. The list
SHALL be read-only (no approve or reject). With the knowledge review on, or in the full profile, the digest SHALL be as
before.

#### Scenario: Grouped candidates
- **WHEN** in core with the knowledge review off two cards have the reason "No clinical trials" (in different case or
  spacing), one has "Too basic for me", and one accepted candidate exists
- **THEN** the digest lists "No clinical trials" 2× with both cards, then "Too basic for me" 1×, and not the accepted one

#### Scenario: Knowledge review on
- **WHEN** the user switches the knowledge review on and a digest is built
- **THEN** the digest has its Charter section and no rule-candidate list
