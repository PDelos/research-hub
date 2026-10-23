# Spec Delta

## Purpose

Lets the user read and edit a project's knowledge base with the real Obsidian interface inside the hub's web
UI, running entirely on the hub machine, styled like the hub, and safe to leave running.

## ADDED Requirements

### Requirement: Knowledge base tab
The hub UI SHALL have a Knowledge base tab that shows the Obsidian interface for the current project's vault, served from the hub machine, so no Obsidian install is needed on the viewing device.

#### Scenario: Open the tab
- **WHEN** the user opens the Knowledge base tab of a project with a vault
- **THEN** the Obsidian interface loads inside the hub page with that project's vault open, within 10 seconds

### Requirement: Seamless embedding
The Knowledge base tab SHALL embed the viewer inside the hub layout without a visible frame border, keeping the hub top bar, tabs and agent column visible, so the user never leaves the hub or sees another application's window chrome.

#### Scenario: Hub frame stays
- **WHEN** the user switches to the Knowledge base tab
- **THEN** the hub top bar, tabs and agent column remain visible and unchanged, and the viewer fills only the content area with no border

#### Scenario: Obsidian chrome hidden
- **WHEN** the tab is open
- **THEN** Obsidian's title bar, ribbon, status bar and vault switcher are not shown, and no separate login or vault-picker screen appears

### Requirement: Instant tab switching
The viewer SHALL stay loaded while the user switches between hub tabs, so returning to the Knowledge base tab shows the same note and scroll position without reloading.

#### Scenario: Switch away and back
- **WHEN** the user opens a note, switches to Feed, then back to Knowledge base
- **THEN** the same note is shown at the same scroll position within 200 ms, with no reload or flash

### Requirement: Styled loading and errors
While the viewer loads or if it fails, the tab SHALL show a loading or error state styled like the rest of the hub UI, never a blank or unstyled page.

#### Scenario: Slow start
- **WHEN** the viewer takes longer than 1 second to load
- **THEN** a hub-styled loading state is shown until Obsidian is ready

### Requirement: Same files as the agent
The viewer SHALL read and write the same vault files the agent uses, so changes on either side appear on the other.

#### Scenario: Agent writes, user sees
- **WHEN** a starred paper is ingested while the tab is open
- **THEN** its new note appears in the Obsidian file list within 10 seconds without reloading the page

#### Scenario: User edits, hub sees
- **WHEN** the user edits a note in the tab
- **THEN** a hub search for the new text finds the note within 10 seconds, and the agent does not overwrite the edit

### Requirement: Hub theme
Every vault SHALL include Obsidian settings that enable a hub theme matching the hub UI's colors, fonts and corner radius, follow the hub's light or dark mode, and open with the vault index and without the ribbon or sync prompts.

#### Scenario: Matching look
- **WHEN** the tab opens in dark mode
- **THEN** Obsidian uses the hub's dark colors and font, and the index note is the open note

#### Scenario: Visual check
- **WHEN** screenshots of the Feed tab and the Knowledge base tab are compared in light and in dark mode
- **THEN** background, text, accent colors, font family and corner radius match the hub's design tokens

#### Scenario: User changes the theme
- **WHEN** the user picks a different theme inside Obsidian
- **THEN** the choice is kept and the hub does not reset it on restart

### Requirement: Open a specific note
The Library view SHALL offer "Open in knowledge base" for each paper, which shows the Knowledge base tab with that paper's note open.

#### Scenario: Jump to a note
- **WHEN** the user clicks "Open in knowledge base" on a paper in the Library
- **THEN** the tab opens with that paper's evidence note visible within 5 seconds

### Requirement: Separate container, reached only through the hub
The viewer SHALL run in its own container with access to the vault folders only (no hub databases or keys), SHALL publish no port of its own, and SHALL be reached only through the hub at `/kb/` on the hub's port, under the same browser protections as the rest of the hub UI.

#### Scenario: No direct access
- **WHEN** any machine, including the hub machine, tries to connect to the viewer container's port from outside the compose network
- **THEN** the connection is refused, and the viewer is only reachable at `http://<hub>/kb/`

#### Scenario: Cross-site request
- **WHEN** a page from another site requests `/kb/`
- **THEN** the hub refuses it as it refuses other cross-site UI requests

#### Scenario: Isolation
- **WHEN** the viewer container's mounts are listed
- **THEN** they contain the project vault folders and the viewer's own settings only

### Requirement: Viewer is optional at runtime
The hub SHALL keep working when the viewer is not running: the tab SHALL show a short explanation and how to start it, and the Library view SHALL still list and open notes.

#### Scenario: Viewer stopped
- **WHEN** the viewer service is stopped and the user opens the Knowledge base tab
- **THEN** the tab shows "The knowledge base viewer is not running" with the start command, and the Library still works

### Requirement: Pinned viewer version
The viewer SHALL run a pinned release, and the hub's health information SHALL report that version; upgrading SHALL be an explicit configuration change.

#### Scenario: Version reported
- **WHEN** `/v1/info` is requested while the viewer runs
- **THEN** it reports the viewer as running with its pinned version
