## MODIFIED Requirements

### Requirement: Viewer is optional at runtime
The viewer SHALL be a plugin contributing to the `kb.viewer` extension point; Obsidian SHALL be available only in the add-on image, and without an explicit choice the active viewer SHALL be Obsidian when it can run and the Library otherwise; the hub SHALL keep working when the Obsidian viewer is disabled (as a plugin, or with `RH_KB_VIEWER=off`) or not installed: the Knowledge base tab SHALL show the active viewer, and the Library view SHALL still list and open notes.

#### Scenario: Viewer disabled
- **WHEN** the Obsidian viewer plugin is disabled and the user opens the Knowledge base tab
- **THEN** the tab shows the Library viewer, and the Library tab still works

#### Scenario: Alternative viewer
- **WHEN** the Library viewer is the active `kb.viewer`
- **THEN** the Knowledge base tab shows it, and no Obsidian process runs

#### Scenario: Light image
- **WHEN** a project that used Obsidian starts on the light image without a saved viewer choice
- **THEN** the Library is the active viewer and the Obsidian viewer reports "Ignis is not installed in this image"
