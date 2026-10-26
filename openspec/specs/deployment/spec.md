# deployment Specification

## Purpose

Defines how the Research Hub is packaged, configured and run: one container per research project, started,
restarted and duplicated without losing data, leaking credentials, or letting projects interfere.

## Requirements

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

### Requirement: Persistent data volume
The hub SHALL store all state under one data directory (`/data` in the container), mounted from the host.

#### Scenario: Data survives container recreation
- **WHEN** the container is removed and recreated with the same data directory
- **THEN** every conversation, run record and setting from before is still present

#### Scenario: Data layout
- **WHEN** the hub starts with an empty data directory
- **THEN** it creates the project's agent database and app database directly in that directory

### Requirement: Projects never share state
Two project containers on one machine SHALL share no data, conversations, settings, credentials or browser state; the only shared things are the machine, its image and, if the user chooses, an OpenRouter key.

#### Scenario: Two projects
- **WHEN** a second project runs on port `4860` with its own data directory
- **THEN** both run, and a chat message, setting or cost in one never appears in the other

### Requirement: Data directory ownership
A container SHALL take an ownership lock on its data directory at startup, renewed every 15 seconds, and a second container pointed at the same directory SHALL refuse to start while the lock is fresh (younger than 60 seconds).

#### Scenario: Same folder twice
- **WHEN** a second container starts with a data directory already owned by a running container
- **THEN** it exits with a non-zero status and a log line naming the directory and the owning project and container

#### Scenario: Stale lock
- **WHEN** the previous owner died more than 60 seconds ago without releasing the lock
- **THEN** the new container takes over the lock and starts normally

#### Scenario: Restart after a crash
- **WHEN** the owner process crashed and the hub restarts on the same host (for example the container's restart policy) within 60 seconds
- **THEN** the lock is recognized as belonging to a dead process on this host and is taken over at once

### Requirement: Clear port conflicts
If the configured port is already in use, the hub SHALL exit with a message naming the port and how to choose another, instead of a raw stack trace.

#### Scenario: Port taken
- **WHEN** the hub starts on a port another process already uses
- **THEN** it exits non-zero and logs `port 4850 is in use; set RH_PUBLISH_PORT (compose) or RH_PORT to a free port`

### Requirement: Project identity
Each container SHALL be configured with a project name (`RH_PROJECT_NAME`) that appears in the UI title, `/v1/health`, every log line and the compose project name (`rh-<name>`).

#### Scenario: Identity everywhere
- **WHEN** a project named `proteins` is running
- **THEN** the page title, health response and log lines name `proteins`, and `docker ps` shows its container under `rh-proteins`

### Requirement: Separate browser state per project
Each project SHALL be reachable under its own host name (`<name>.localhost:<port>`) so two projects open in one browser keep separate cookies and storage.

#### Scenario: Two tabs
- **WHEN** `proteins.localhost:4850` and `genomics.localhost:4860` are open in one browser
- **THEN** using one never logs out, resets or changes the other, including the knowledge base view

### Requirement: Resource limits
Each project's compose file SHALL set memory and CPU limits (default 2 GB and 2 CPUs, configurable) so one project cannot starve the others.

#### Scenario: Limits applied
- **WHEN** a project container is inspected
- **THEN** it shows the configured memory and CPU limits

### Requirement: New project setup
A `new-project` script SHALL create a project folder with its compose file and `.env`, a free port, a unique compose project name, the project name, and a sweep time staggered from existing projects, and print the URL.

#### Scenario: Second project
- **WHEN** the user runs `./new-project.sh genomics` while `proteins` uses port 4850 and sweeps at 06:00
- **THEN** `genomics` gets a free port such as 4860, compose name `rh-genomics`, a sweep time 20 minutes later, and the script prints `http://genomics.localhost:4860`

### Requirement: Health reporting
The hub SHALL expose an unauthenticated health endpoint that reports readiness without revealing secrets.

#### Scenario: Healthy
- **WHEN** `GET /v1/health` is called after startup
- **THEN** it returns HTTP 200 with the version, the mode (`live` or `offline`) and the model provider, and no key values

### Requirement: Automatic restart
The container SHALL restart automatically after a crash or a host reboot unless the user stopped it.

#### Scenario: Process crash
- **WHEN** the server process exits unexpectedly
- **THEN** the container restarts it and `/v1/health` returns 200 again within 60 seconds

### Requirement: Credentials from environment only
Credentials SHALL be read only from environment variables and SHALL never appear in logs, API responses or the browser bundle.

#### Scenario: Key not exposed
- **WHEN** the UI bundle, `/v1/health`, `/v1/info` and the server log are searched for the value of `OPENROUTER_API_KEY`
- **THEN** the value is found in none of them

### Requirement: Fail closed in live mode
In live mode the hub SHALL refuse to start when `OPENROUTER_API_KEY` is missing, and SHALL say which variable is missing.

#### Scenario: Missing key
- **WHEN** the hub starts in live mode without `OPENROUTER_API_KEY`
- **THEN** it exits with a non-zero status and a log line naming `OPENROUTER_API_KEY`

### Requirement: Offline mode
The hub SHALL run fully offline with a deterministic fake model and mock Jev when `RH_MODE=offline`, making no external network calls.

#### Scenario: No keys, offline
- **WHEN** the hub starts with `RH_MODE=offline` and no API keys
- **THEN** it starts, chat works with the fake model, and no outbound request is made to OpenRouter or any other external service

### Requirement: Authenticated API
Every API route except health SHALL require a bearer token, and the browser SHALL reach the API through the hub's server side so the token never reaches the page.

#### Scenario: Missing token
- **WHEN** an API route other than `/v1/health` is called without a valid token
- **THEN** the hub responds with HTTP 401
