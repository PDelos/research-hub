# Design

## Context

Greenfield repository. Reference implementation: `disler/pi-durable-news-agent` (MIT; pi-durable,
pi-ai and chord 1.1.0, Express 5.3, Vue 3.5, Vite 8, Node ≥ 24, `tsx`, `node:test`). Measured source
size of that repo: `durable-agent` 1.3K lines, `jev` 1.3K, sdk 2.8K, server infra 2.8K, **news domain
9.2K, browser 5.6K (mostly news UI), TUI/CLI/cron 3.9K**. Forking would mean deleting or rewriting ~70%
and inheriting single-project, three-client and ssh-device assumptions; see proposal.md for scope.
Requirements: `specs/deployment`, `specs/agent-runtime`, `specs/jev-client`.

## Goals / Non-Goals

**Goals:**
- Reuse the two hardest, best-tested packages unchanged in behavior; write everything else for our
  domain (one project per container, papers, vault) so every line exists on purpose.
- A skeleton whose offline test suite passes and that runs in Docker with one chat-capable agent.

**Non-Goals:**
- Any paper logic, schema or paper Jev commands (layers v0.1–v0.5).
- Tracking upstream: vendored code is ours after import; fixes are cherry-picked by hand.

## Decisions

### D1. Vendor packages, not fork the app
Copy `apps/shared/packages/durable-agent` and `apps/shared/packages/jev` (with tests) at a recorded
commit SHA into `packages/`, rename `@dna/*` → `@rh/*`, and note provenance + MIT text in `NOTICE.md`.
Alternatives: full fork + strip (rejected: ~70% deletion, wrong assumptions); building on pi-durable
with no reuse (rejected: re-solves compaction, idempotent tools, telemetry, Jev ledger); a different
framework such as Mastra or LangGraph.js (rejected for now: mature and popular, but pi-durable is what
the reference implementation and its Jev integration are proven on; keeping pi-durable behind
`packages/durable-agent` leaves Mastra as the fallback if pi-durable stalls).

### D2. Own server and SDK, copying single files where they fit
`rh-server` is new. Copied as starting points and adapted: `sse.ts` (snapshot + deltas), `auth.ts`
(token scopes), `idempotency.ts`, the telemetry projector wiring, and `recovery.test.ts`. `rh-sdk` holds
wire types, route table and the stream reducer for transcript and runs; no capabilities-parity test
(only one client exists).

### D3. Express 5
Express 5 over Fastify/Hono: Fastify and Hono are 2–3× faster in benchmarks, but this is a single-user
local service where throughput is irrelevant, and the copied SSE/auth/idempotency code is Express code.
Revisit only if we need typed RPC across client and server.

### D4. One project per container
A container serves exactly one research project. Storage lives directly in `$RH_DATA_DIR`: `agent.sqlite`
(pi-durable) and `project.sqlite` (app), later `brief.md` and `vault/`. Routes have no project segment
(`/v1/chat`, `/v1/stream`, …). One pi-durable `Harness` per process. A new theme is a new container with its own
data directory and port (D11). Alternative (several projects inside one hub) rejected by the user: it adds a
registry, slugs and in-process isolation for no benefit over containers.

*Implementation note:* tasks 1–7 first built a project-scoped layout (`projects/default/`, `/v1/p/:slug/…`);
task group 8 flattens it to this design and migrates an existing `projects/default/` folder.

### D5. Models from configuration via OpenRouter
Env `RH_MODEL_DESK|READER|REVIEW|CHAT|JEV`. Defaults (verified on OpenRouter 2026-10-22):
desk/reader/chat `anthropic/claude-haiku-5.5` ($0.10/$0.50 per M), review `anthropic/claude-sonnet-5.5`
($2/$10 per M), Jev `typesafe/jev-1.14`. Pinned IDs, not `~…-latest` aliases, for reproducibility.
Context windows and prices come from pi-ai's OpenRouter metadata.

### D6. Jev client: OpenRouter only
Keep the vendored client's request validation, 30 s timeout, 3 attempts on 429/502/503/529, raw payload
retention and ledger. Remove the TypeSafe provider branch. Add a 30,000-byte input guard (Jev's
long-context mode starts around 32 KB), a `ping` command, and `commands.lock.json`
(`{name, version, sha256(questions+policy)}`) checked by `npm run check:jev`. Endpoint: OpenRouter's
Decisions API, which is marked **alpha**; all calls go through this one client so an API change is a
one-file fix.

### D7. One process, one port
Express serves the built Vue app and an in-process proxy that holds the client token server-side (the
news agent used a separate hub process on another port). Port 4850.

### D8. Storage engine
Node's built-in `node:sqlite` (`DatabaseSync`) for `project.sqlite`, as the reference does; verified
locally on Node 26 that FTS5 works and that `sqlite-vec` v0.1.9 loads with `allowExtension: true` and
answers KNN queries. Both are needed from v0.2 on; v0.0 only proves the extension loads in the container.

### D9. Container
`node:24-slim`, multi-stage (install + Vite build → runtime with production deps), non-root user,
`/data` volume, `HEALTHCHECK` on `/v1/health`, compose `restart: unless-stopped`, plus
`compose.offline.yml` for keyless demos.

### D10. Offline mode
`RH_MODE=offline` → faux model provider + mock Jev; a network guard in tests fails on any outbound fetch.

### D11. Projects never interfere
- **Data lock:** `$RH_DATA_DIR/.owner` holds `{project, container hostname, pid, heartbeat}`, renewed every 15 s
  and removed on clean shutdown; a fresh lock (< 60 s) makes a second container exit. The pi-durable PID lock alone
  is not enough: PIDs repeat across containers.
- **Ports:** `EADDRINUSE` is turned into a one-line error naming the port and `RH_PUBLISH_PORT`.
- **Identity:** `RH_PROJECT_NAME` (lowercase, `[a-z0-9-]`, ≤ 40 chars) in the page title, health, every log
  line, and the compose project name `rh-<name>`.
- **Browser state:** access via `<name>.localhost:<port>`; browsers resolve `*.localhost` to loopback and keep
  cookies per host name. `RH_ALLOWED_HOSTS` gets the name automatically.
- **Resources:** compose `mem_limit`/`cpus` from `RH_MEM_LIMIT` (2g) and `RH_CPUS` (2).
- **Shared outside world:** one IP for all projects (arXiv, OpenAlex pacing) → the `new-project` script
  staggers sweep times by 20 minutes; one OpenRouter balance → README recommends one key per project with
  OpenRouter's per-key credit limit.
- **`new-project.sh <name>`** creates `projects/<name>/` next to the repo with `docker-compose.yml` (image
  `research-hub:latest`), `.env` from `.env.example` with name, port (first free from 4850 in steps of 10),
  sweep time and tokens, and prints the URL.

## Risks / Trade-offs

- [pi-durable 1.1.0 is experimental and changes without notice] → exact pin; all imports inside
  `packages/durable-agent` and `rh-server/src/runtime.ts`; recovery test gates every upgrade.
- [OpenRouter Decisions API is alpha] → single client module, pinned Jev model, ledger keeps raw
  payloads to diagnose shape changes.
- [Vendored packages drift from upstream fixes] → record source SHA; review upstream changelog when
  upgrading pi-durable.
- [Faux model hides real-provider issues] → manual live smoke task once a key exists.
- [In-process proxy weakens the reference's two-process token separation] → two tokens kept, page never
  receives the API token, test greps the bundle and responses for it.
