## ADDED Requirements

### Requirement: Local embedder alternative
The Embedder slot SHALL have a local alternative that runs a model from the data folder (in the full image or at a
configured URL), and switching the active embedder plugin SHALL apply without a restart.

#### Scenario: Switch to the local embedder
- **WHEN** a proposal to use the fine-tuned local model is approved
- **THEN** the papers are re-embedded with it in the background and similarity search keeps working
