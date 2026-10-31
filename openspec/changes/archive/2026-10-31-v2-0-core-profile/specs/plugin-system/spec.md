## MODIFIED Requirements

### Requirement: v0 as built-in plugins
All v0 features SHALL be provided by built-in plugins with unchanged behavior: paper sources, representations, sweep and cards, feedback, charter, schedule, knowledge base and its viewers, the research desk, the model provider and the decision engine; disabling an optional built-in plugin SHALL remove its feature without breaking the others. The engineer, the weekly upgrade, the knowledge review and the harness SHALL be optional built-ins (not required), like the question finders, the Docling converter and the local embedder.

#### Scenario: Unchanged behavior
- **WHEN** the v0 test suite runs against the plugin-based hub
- **THEN** every v0 test passes without changing its assertions

#### Scenario: Disable an optional feature
- **WHEN** the Semantic Scholar source plugin or the Obsidian viewer plugin is disabled
- **THEN** sweeps, chat and the Library keep working

#### Scenario: Disable the self-improvement plugins
- **WHEN** the engineer, weekly upgrade, knowledge review and harness plugins are all disabled
- **THEN** sweeps, cards, judgments, the Library, the nightly run and the weekly digest keep working
