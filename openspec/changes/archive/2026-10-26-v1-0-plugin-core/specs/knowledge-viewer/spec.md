# Spec Delta

## Purpose

The knowledge-base viewer becomes a plugin contributing to the `kb.viewer` extension point, and the Knowledge base
tab opens on the graph view.

## MODIFIED Requirements

### Requirement: Hub theme
Every vault SHALL include Obsidian settings that enable a hub theme matching the hub UI's colors, fonts and corner radius, follow the hub's light or dark mode, open on the graph view with papers, concepts and research questions in distinct colors, and show no ribbon or sync prompts; settings the hub adds later SHALL reach existing vaults only where the user has not set them.

#### Scenario: Matching look
- **WHEN** the tab opens in dark mode
- **THEN** Obsidian uses the hub's dark colors and font, and the graph view is open

#### Scenario: Graph colors
- **WHEN** the graph view shows the knowledge base
- **THEN** source notes, concept pages and question pages have three distinct colors, and index, log and charter are not shown

#### Scenario: Visual check
- **WHEN** screenshots of the Feed tab and the Knowledge base tab are compared in light and in dark mode
- **THEN** background, text, accent colors, font family and corner radius match the hub's design tokens

#### Scenario: User changes the theme
- **WHEN** the user picks a different theme inside Obsidian
- **THEN** the choice is kept and the hub does not reset it on restart

### Requirement: Viewer is optional at runtime
The viewer SHALL be a plugin contributing to the `kb.viewer` extension point; the hub SHALL keep working when it is disabled (as a plugin, or with `RH_KB_VIEWER=off` as the default) or not running: the tab SHALL show a short explanation and how to enable it, or the active alternative viewer, and the Library view SHALL still list and open notes.

#### Scenario: Viewer disabled
- **WHEN** the Obsidian viewer plugin is disabled and the user opens the Knowledge base tab with no other viewer active
- **THEN** the tab shows "The knowledge base viewer is off" with how to turn it on, and the Library still works

#### Scenario: Alternative viewer
- **WHEN** the Library viewer is the active `kb.viewer`
- **THEN** the Knowledge base tab shows it, and no Obsidian process runs
