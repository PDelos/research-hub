# plugin-system Specification

## Purpose
Defines how the Research Hub is built from a small kernel and plugins modeled on VS Code extensions: how plugins
declare themselves, when they run, what they contribute, how they depend on each other, what they may access, and
how the user installs, swaps, configures and rolls them back per project.

## Requirements

### Requirement: Plugin manifest
Every plugin SHALL have an `rh-plugin.json` manifest with `id` (`publisher.name`, lowercase), `version` (semver), `displayName`, `engines.research-hub` (a semver range of kernel API versions), optional `main` and `browser` entries, `activationEvents`, `contributes`, `dependencies` and `permissions`; a manifest that fails validation SHALL be rejected with the field and the reason.

#### Scenario: Invalid manifest
- **WHEN** a plugin is installed whose manifest has no `engines.research-hub`
- **THEN** installation is refused with "engines.research-hub: required" and nothing is changed

#### Scenario: Incompatible kernel
- **WHEN** a plugin requires `engines.research-hub` "^2.0.0" and the kernel API is 1.0.0
- **THEN** the plugin is listed as incompatible with both versions and is not activated

### Requirement: Lazy activation
A plugin's code SHALL run only after one of its activation events fires (`onStartup`, `onView:<tab>`, `onCommand:<id>`, `onChatTool:<name>`, `onExtensionPoint:<point>`, `onSchedule:<kind>`), through `activate(context)`, and SHALL be stopped through `deactivate()` when disabled, uninstalled or at shutdown; a disabled plugin's code SHALL never be loaded.

#### Scenario: Activated on demand
- **WHEN** a plugin declares only `onView:reading-list` and the user opens that tab for the first time
- **THEN** the plugin's `activate` runs once at that moment and not at startup

#### Scenario: Disabled plugin
- **WHEN** a plugin is disabled
- **THEN** its `deactivate` runs, its code is not loaded on the next start, and its contributions disappear

### Requirement: Declarative contributions
Plugins SHALL add tabs, settings, commands, chat tools, Jev commands, prompts and supervised processes by declaring them under `contributes`; the hub SHALL show or remove them when the plugin is enabled or disabled, within 2 seconds and without a restart, and SHALL list every plugin's contributions without running its code.

#### Scenario: Tab follows the plugin
- **WHEN** the plugin contributing the Knowledge base tab is disabled while the UI is open
- **THEN** the tab disappears from the tab bar within 2 seconds, and reappears when the plugin is enabled again

#### Scenario: Audit without running code
- **WHEN** the user opens a plugin's details in the Plugins view
- **THEN** its tabs, settings, commands, chat tools, Jev commands, processes and permissions are listed even if it has never been activated

### Requirement: Extension points owned by plugins
A plugin SHALL be able to offer named extension points that other plugins contribute to; an extension point SHALL declare whether it takes one active contribution (for example `kb.viewer`) or many (for example `papers.source`); contributions to an unknown extension point SHALL be reported, not fatal.

#### Scenario: Swap the viewer
- **WHEN** the active `kb.viewer` contribution is switched from Obsidian to the Library viewer
- **THEN** the Knowledge base tab shows the Library viewer, the Obsidian process stops, and switching back restores Obsidian

#### Scenario: Many sources
- **WHEN** a plugin contributing a new `papers.source` is enabled
- **THEN** the next sweep queries it together with the other enabled sources

#### Scenario: Unknown point
- **WHEN** a plugin contributes to an extension point no enabled plugin offers
- **THEN** the plugin still activates and its details show "contributes to papers.ranker, which no enabled plugin offers"

### Requirement: Dependencies and exported APIs
A plugin SHALL be activated only after the plugins it depends on, SHALL receive their exported APIs, and SHALL not be activated (with the reason shown) when a dependency is missing, disabled or incompatible; disabling a plugin that others depend on SHALL warn and list them first.

#### Scenario: Missing dependency
- **WHEN** a plugin depending on `rh.kb` is enabled while `rh.kb` is disabled
- **THEN** it stays inactive with the reason "needs rh.kb (disabled)"

#### Scenario: Disabling a dependency
- **WHEN** the user disables `rh.kb`
- **THEN** the hub first lists the plugins that depend on it and disables them too only after confirmation

### Requirement: Plugin settings
Each plugin's settings SHALL be declared as a JSON schema under `contributes.settings`, validated on every change, shown in Settings grouped by plugin, and stored per project; existing environment variables SHALL keep working as defaults for the corresponding settings.

#### Scenario: Invalid value
- **WHEN** a setting declared as an integer from 1 to 15 is set to 40
- **THEN** the change is refused with the setting name and the allowed range

#### Scenario: Environment default
- **WHEN** the container starts with `RH_KB_VIEWER=off` and no saved setting
- **THEN** the Obsidian viewer plugin starts disabled

### Requirement: Permissions
A plugin SHALL reach only the network hosts, files, secrets and daily budget it declares under `permissions`; any other access SHALL be blocked and logged with the plugin id, and the Plugins view SHALL show each plugin's permissions.

#### Scenario: Undeclared host
- **WHEN** a plugin that declares only `export.arxiv.org` requests `example.com`
- **THEN** the request fails with "rh.source-x may not reach example.com" and the attempt is logged

#### Scenario: Budget
- **WHEN** a plugin's model calls reach its declared budget of $0.10 for the day
- **THEN** further calls fail with a budget error until the next day and the user is notified once

### Requirement: Isolation of external code
Plugins that are not built in SHALL run outside the kernel's process, with only their declared files, hosts and secrets; a crash or hang of such a plugin SHALL NOT stop the kernel, chat or sweeps, and the plugin SHALL be restarted or disabled with the reason shown.

#### Scenario: Plugin crashes
- **WHEN** an installed plugin throws while activating
- **THEN** it is marked failed with the error, the hub keeps serving, and other plugins are unaffected

#### Scenario: No secret access
- **WHEN** an external plugin without declared secrets reads the environment
- **THEN** it sees no API keys or tokens

### Requirement: Per-project plugin state with history
The set of installed plugins, their versions, enabled state and settings SHALL be stored per project in a lockfile inside a version-controlled plugin folder; every change SHALL be recorded with a message, and the user SHALL be able to roll back to any earlier state in one action.

#### Scenario: Rollback
- **WHEN** the user rolls back to the state before they replaced the embedder
- **THEN** the previous embedder is active again, and vectors from the other model are re-computed in the background as for any model change

#### Scenario: History
- **WHEN** the user opens the plugin history
- **THEN** each change is listed with its time, what changed and who changed it (user, or an approved proposal)

### Requirement: Install and uninstall
The user SHALL be able to install a plugin from a folder or a git URL, and to uninstall it; installing SHALL show the plugin's contributions and permissions for approval first; uninstalling SHALL keep the plugin's data unless the user also chooses to delete it.

#### Scenario: Approve permissions
- **WHEN** a plugin requesting network access to two hosts and one secret is installed
- **THEN** the hosts and the secret are shown and the plugin is installed only after the user approves

#### Scenario: Uninstall keeps data
- **WHEN** a plugin with stored data is uninstalled without "delete data"
- **THEN** its data remains and is used again if it is reinstalled

### Requirement: v0 as built-in plugins
All v0 features SHALL be provided by built-in plugins with unchanged behavior: paper sources, representations, sweep and cards, feedback, charter, schedule, knowledge base and its viewers, the research desk, the model provider and the decision engine; disabling an optional built-in plugin SHALL remove its feature without breaking the others.

#### Scenario: Unchanged behavior
- **WHEN** the v0 test suite runs against the plugin-based hub
- **THEN** every v0 test passes without changing its assertions

#### Scenario: Disable an optional feature
- **WHEN** the Semantic Scholar source plugin or the Obsidian viewer plugin is disabled
- **THEN** sweeps, chat and the Library keep working

### Requirement: Kernel API versioning
The kernel API SHALL carry a semantic version reported in `/v1/info`; changes that break plugins SHALL raise the major version, and plugins SHALL be checked against it at install and at every start.

#### Scenario: Version reported
- **WHEN** `/v1/info` is requested
- **THEN** it includes the kernel API version and each active plugin with its version and state

### Requirement: Plugins view
The UI SHALL have a Plugins tab grouping every installed plugin by kind and topic: Core (collapsed, marked as not changeable), Slots (each slot with its active plugin, alternatives and last benchmark), Add-ons (with on/off and usage attribution) and Preferences; each plugin shows its state (active, inactive, disabled, failed, incompatible), version, description, contributions, permissions, settings and history, with actions to enable, disable, configure, install, uninstall and roll back where its kind allows.

#### Scenario: Failed plugin shown
- **WHEN** a plugin failed to activate
- **THEN** the Plugins tab shows it as failed with the error message and a button to disable it

#### Scenario: Grouped view
- **WHEN** the user opens the Plugins tab
- **THEN** core plugins are in one collapsed group, each slot shows one active plugin, and add-ons are grouped by topic with their attribution
