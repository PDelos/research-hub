# Spec Delta

## Purpose

Defines how the Research Hub is packaged, configured and run on a single machine, so that a hub can be
started, restarted and duplicated without losing data or leaking credentials.

## ADDED Requirements

### Requirement: Single-container deployment
The hub SHALL run as one container that serves both the API and the browser UI on one port (default `4850`).

#### Scenario: Start with compose
- **WHEN** the user runs `docker compose up -d` in the hub folder with a valid `.env`
- **THEN** the container starts, and the UI and API are reachable on `http://localhost:4850` within 60 seconds

### Requirement: Persistent data volume
The hub SHALL store all state under one data directory (`/data` in the container), mounted from the host.

#### Scenario: Data survives container recreation
- **WHEN** the container is removed and recreated with the same data directory
- **THEN** every conversation, run record and setting from before is still present

#### Scenario: Per-project layout
- **WHEN** the hub starts with an empty data directory
- **THEN** it creates `projects/default/` containing the project's agent database and app database

### Requirement: Separate hubs on one machine
Two hubs SHALL run side by side when given different ports and data directories, without sharing any state.

#### Scenario: Two hubs
- **WHEN** a second compose folder uses port `4860` and its own data directory
- **THEN** both hubs run, and a chat message in one never appears in the other

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
