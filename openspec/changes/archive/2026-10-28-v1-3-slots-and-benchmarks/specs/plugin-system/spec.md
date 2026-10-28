## MODIFIED Requirements

### Requirement: Plugins view
The UI SHALL have a Plugins tab grouping every installed plugin by kind and topic: Core (collapsed, marked as not changeable), Slots (each slot with its active plugin, alternatives and last benchmark), Add-ons (with on/off and usage attribution) and Preferences; each plugin shows its state (active, inactive, disabled, failed, incompatible), version, description, contributions, permissions, settings and history, with actions to enable, disable, configure, install, uninstall and roll back where its kind allows.

#### Scenario: Failed plugin shown
- **WHEN** a plugin failed to activate
- **THEN** the Plugins tab shows it as failed with the error message and a button to disable it

#### Scenario: Grouped view
- **WHEN** the user opens the Plugins tab
- **THEN** core plugins are in one collapsed group, each slot shows one active plugin, and add-ons are grouped by topic with their attribution
