## MODIFIED Requirements

### Requirement: Single-container deployment
Each research project SHALL run as exactly one container that serves the API, the browser UI and every helper process on one port (default `4850`); a second theme is a second container. The default image SHALL be under 300 MB and run the server as one bundled file; the Obsidian viewer SHALL come only with the add-on image `research-hub:obsidian`.

#### Scenario: Start with compose
- **WHEN** the user runs `docker compose up -d` in the hub folder with a valid `.env`
- **THEN** the container starts, and the UI and API are reachable on `http://localhost:4850` within 60 seconds

#### Scenario: Light image
- **WHEN** the default image is built
- **THEN** it is under 300 MB, contains no Ignis, and a project on it runs the whole offline cycle

#### Scenario: Obsidian add-on
- **WHEN** a project is created with `./new-project.sh <name> --obsidian`
- **THEN** its compose file uses `research-hub:obsidian` and the Knowledge base tab can show Obsidian
