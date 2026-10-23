# Tasks

## 1. Repository scaffold

- [x] 1.1 Create npm workspace root (`package.json` with `packages/*`, `apps/*`; Node ≥ 24; TypeScript 5.9; `tsx`; oxlint/oxfmt) and `.gitignore` (`data/`, `.env`, `node_modules`); verify `npm install` succeeds
- [x] 1.2 Add `.env.example` listing `OPENROUTER_API_KEY`, `RH_MODE`, `RH_DATA_DIR`, `RH_PORT`, `RH_MODEL_*`, `RH_CLIENT_TOKEN`, `RH_API_TOKEN`; verify every variable read in code appears in it (a check script)

## 2. Vendor `durable-agent` and `jev` (spec: agent-runtime, jev-client)

- [x] 2.1 Copy both packages with tests from `disler/pi-durable-news-agent` at a recorded SHA into `packages/`, rename `@dna/*` → `@rh/*`, add `NOTICE.md` (URL, SHA, MIT text); verify their own test suites pass offline
- [x] 2.2 Remove the TypeSafe provider from the Jev client and its tests; add a test that every live request targets OpenRouter and that a failure never yields a mock answer
- [x] 2.3 Add the 30,000-byte input guard; verify a test with a 40,000-byte input fails before sending
- [x] 2.4 Add `RH_MODEL_JEV` (default `typesafe/jev-1.14`) and record the model ID in the ledger; verify a ledger test
- [x] 2.5 Add the `ping` command, `commands.lock.json` and `npm run check:jev`; verify a test where a wording change without a version bump fails
- [x] 2.6 Replace the vendored hard-coded model catalog with `RH_MODEL_DESK|READER|REVIEW|CHAT`; verify a test that changing `RH_MODEL_CHAT` changes the model recorded on the next run

## 3. Server core (spec: agent-runtime, deployment)

- [x] 3.1 Create `apps/rh-server` (Express 5) with config loading, `RH_MODE` (`live`|`offline`), and fail-closed startup without `OPENROUTER_API_KEY` in live mode; verify startup tests for both modes
- [x] 3.2 Open per-project storage `$RH_DATA_DIR/projects/default/{agent,project}.sqlite` (minimal app schema: settings, requests, telemetry); verify a test on an empty data dir creates both
- [x] 3.3 Prove `sqlite-vec` loads and FTS5 is available in `project.sqlite`; verify a startup self-check test
- [x] 3.4 Add the research-desk placeholder agent (short system prompt, allow-list hook, no tools); verify a faux chat round-trip test
- [x] 3.5 Add a test that a tool outside the allow-list is rejected and not executed
- [x] 3.6 Wire the telemetry projector (tool calls, tokens, model, cost per run) into `project.sqlite`; verify a test that a chat turn produces one run record with cost

## 4. API, stream and durability (spec: agent-runtime, deployment)

- [x] 4.1 Add bearer-token auth with two tokens (client, api) and an unauthenticated `/v1/health` (version, mode, providers, no secrets); verify 200/401 tests
- [x] 4.2 Add `/v1/p/:slug/chat` (202 + queued when busy), `/v1/p/:slug/runs`, `/v1/info`; verify a 404 test for an unknown slug and a queued-message test
- [x] 4.3 Add `/v1/p/:slug/stream` (snapshot then deltas) and the `rh-sdk` reducer; verify a two-client sync test and a reconnect-mid-reply test
- [x] 4.4 Port the crash-recovery test to a chat turn: SIGKILL mid-turn, restart, one reply, no duplicated messages or tool results
- [x] 4.5 Add a compaction test with lowered points: background compaction does not block a new message; force point waits then proceeds
- [x] 4.6 Add a network-guard test: offline mode with no keys makes zero outbound requests during startup, chat and Jev `ping`

## 5. Browser client (spec: deployment, agent-runtime)

- [x] 5.1 Create `apps/rh-client-browser` (Vue 3 + Vite): agent column (transcript, composer, model shown), Runs view (runs, tool calls, tokens, cost, project total), empty Feed placeholder; verify `npm run build` succeeds
- [x] 5.2 Serve the built UI and the token-holding proxy from `rh-server` on port 4850; verify a test that `/` serves the UI and proxied calls work with no token in the page
- [x] 5.3 Add a secret-leak test grepping the built bundle, `/v1/health`, `/v1/info` and captured logs for the key value; verify nothing is found

## 6. Docker (spec: deployment)

- [ ] 6.1 Write a multi-stage `Dockerfile` (`node:24-slim`, non-root, `/data`, `HEALTHCHECK`); verify `docker build` succeeds and the sqlite self-check passes inside the image
- [ ] 6.2 Write `docker-compose.yml` (4850, `./data:/data`, `env_file`, `restart: unless-stopped`) and `compose.offline.yml`; verify the offline stack is healthy within 60 s
- [ ] 6.3 Verify persistence: chat offline, `docker compose down && up`, message still present
- [ ] 6.4 Verify restart: kill the Node process inside the container, health returns within 60 s
- [ ] 6.5 Verify two project containers on ports 4850 and 4860 with separate data dirs share no state
- [x] 6.6 Write `README.md` (npm and Docker quick start, offline and live modes, env vars); verify the offline quick start works as written

## 7. Integration

- [x] 7.1 Run all offline tests, `npm run check`, `npm run check:jev` and lint; verify all pass
- [ ] 7.2 Live smoke (only with `OPENROUTER_API_KEY` and the user's approval to spend): one chat turn and one Jev `ping`; record resolved model IDs and cost in the change notes

## 8. One project per container (spec: deployment, agent-runtime; design D4, D11)

- [x] 8.1 Flatten storage to `$RH_DATA_DIR/{agent,project}.sqlite` and move an existing `projects/default/` there on first start; verify a migration test that keeps the old conversation and runs
- [x] 8.2 Drop the project segment from routes (`/v1/chat`, `/v1/stream`, `/v1/runs`, …), the SDK client and the UI; verify the full server suite passes against the new routes
- [x] 8.3 Add `RH_PROJECT_NAME` (validated) to config, page title, `/v1/health`, every log line and `.env.example`; verify tests for each and `npm run check:env`
- [x] 8.4 Add the data-directory ownership lock with heartbeat and stale takeover; verify tests that a second server on the same directory exits naming the owner, and that a lock older than 60 s is taken over
- [x] 8.5 Turn `EADDRINUSE` into the one-line port message; verify a test that starts a second server on a taken port
- [x] 8.6 Add `<name>.localhost` to the allowed UI hosts; verify a proxy test with `Host: proteins.localhost:4850`
- [x] 8.7 Add compose `name: rh-${RH_PROJECT_NAME}`, `mem_limit`/`cpus` from `RH_MEM_LIMIT`/`RH_CPUS`; verify `docker compose config` shows them (with Docker)
- [x] 8.8 Write `new-project.sh` (folder, compose, `.env` with name, free port, staggered sweep time, tokens; prints URL); verify a test run creating two projects in a temp dir gets distinct ports, names and sweep times
- [x] 8.9 Update `README.md` (one container per project, `new-project.sh`, host names, one OpenRouter key per project) and rerun task 7.1's checks; verify all pass

## Workflow follow-up

- Run `openspec validate v0-0-skeleton --strict` before applying.
- After implementation and review, archive the change so `openspec/specs/` gains `deployment`, `agent-runtime` and `jev-client`; the next layer (`v0-1-project-setup`) builds on them.
