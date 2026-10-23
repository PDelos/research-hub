# Research Hub

A self-hosted research assistant. **One container = one research project (one theme).** Each project gets a
durable agent (built on [pi-durable](https://github.com/earendil-works/pi)) that will sweep for papers, let
[Jev](https://openrouter.ai/docs/guides/community/jev) make the bulk decisions, present a few paper cards a day,
learn from your 👎/👍/⭐ and grow an Obsidian-compatible knowledge base. A new theme is a new container.

**Status: v0.1.** Durable agent, Jev client, live stream, browser UI and container setup (v0.0), plus the
project's brief, charter and schedule (v0.1). Paper search, cards and the knowledge base arrive layer by layer (see
`PLAN.md` §17 and `openspec/changes/`).

## Quick start (offline, no keys)

Needs Node 24 or newer.

```bash
npm install
npm run build -w rh-client-browser
RH_MODE=offline npm start -w rh-server
```

Open <http://localhost:4850>. Offline mode uses a fake model that echoes you and a mock Jev; nothing leaves your
machine. Data goes to `./data`.

## Starting a project

1. **Brief.** Open the UI: a new project asks for a brief (paste it or upload a `.md`, up to 50,000 characters).
2. **Charter.** The research desk drafts a charter in its own conversation on the `review` model: 3 to 7 research
   questions with weights, concepts, sub-areas, 5 to 20 search queries and what is out of scope. It may ask up to 5
   scoping questions; answering them produces a revised draft.
3. **Approve.** Edit anything in the Charter tab, then approve. Each approval is a numbered version; later edits or
   a new brief make a new draft while the approved version stays in force.
4. **Schedule.** Once approved, the daily sweep and weekly review run on schedule (Settings tab, or `RH_SWEEP_TIME`,
   `RH_REVIEW_TIME`, `RH_TIMEZONE`). Each slot runs exactly once, even across restarts; after downtime only the latest
   missed slot runs. Pause the project from the top bar to stop scheduled runs (chat keeps working). In v0.1 a due
   sweep is only recorded as requested; the sweep itself arrives in v0.3.

## Live mode

```bash
cp .env.example .env      # set RH_PROJECT_NAME and OPENROUTER_API_KEY
npm start -w rh-server
```

All models, embeddings and Jev go through OpenRouter. Each job's model is set in `.env` (`RH_MODEL_DESK`,
`RH_MODEL_READER`, `RH_MODEL_REVIEW`, `RH_MODEL_CHAT`, `RH_MODEL_JEV`); change a line and restart to switch models.
Without the key the server refuses to start and names the missing variable.

## Projects with Docker

Every research theme is its own container with its own data folder, port and name:

```bash
./new-project.sh proteins          # creates projects/proteins/ (compose file + .env), port 4850, sweep 06:00
./new-project.sh genomics          # projects/genomics/, port 4860, sweep 06:20
cd projects/proteins
#   put this project's OpenRouter key in .env
docker compose up -d               # open http://proteins.localhost:4850
```

`new-project.sh` gives every project a unique compose name (`rh-<name>`), the next free port, a sweep time 20
minutes after the previous project (so they don't hit the paper APIs together) and fresh tokens. Projects never
interfere:

| Shared thing | Protection |
|---|---|
| Data folder | a `.owner` lock: a second container on the same folder refuses to start and names the owner |
| Port | each project its own; a taken port gives `port 4850 is in use; set RH_PUBLISH_PORT …` |
| Browser | open each at `<name>.localhost:<port>`, so cookies and storage stay separate |
| CPU / memory | `RH_MEM_LIMIT` (2g) and `RH_CPUS` (2) per container |
| OpenRouter budget | use one key per project with a credit limit set at openrouter.ai |

Data lives in the project folder's `data/`, so `docker compose down && docker compose up -d` keeps everything,
and the container restarts itself unless you stop it. Stopping or removing a project is stopping or removing its
container. Keyless demo: `docker compose -f compose.offline.yml up -d` in the repository root.

## Calling the API

The browser UI needs no token: the server holds it and only answers same-origin requests. Scripts use a bearer
token: `RH_API_TOKEN` in `.env` (`new-project.sh` generates one; if unset, a random one is generated per start).

```bash
curl -s localhost:4850/v1/health
curl -s -H "authorization: Bearer $RH_API_TOKEN" -H 'content-type: application/json' \
  -d '{"content":"hello","waitMs":30000}' localhost:4850/v1/chat
curl -s -X POST -H "authorization: Bearer $RH_API_TOKEN" -H 'content-type: application/json' \
  -d '{}' localhost:4850/v1/jev/ping     # Jev smoke test: provider, model, latency, cost
```

| Route | What |
|---|---|
| `GET /v1/health` | Open. Project name, version, mode, providers |
| `GET /v1/info` | Models per job, Jev model, pi-durable version |
| `GET /v1/agent` | Agent state: model, context, busy, compaction |
| `POST /v1/chat` | Send a message (`content`, optional `requestId`, `waitMs`) |
| `GET /v1/stream` | Server-sent events: snapshot, then deltas |
| `GET /v1/transcript` | The conversation so far |
| `GET /v1/runs[/:id]` | Runs with model calls, tool calls, tokens and cost |
| `GET /v1/usage` | Cost totals (models, Jev, this month) |
| `POST /v1/jev/ping` | Jev smoke test |
| `GET /v1/project` | Overview: name, status, charter version, next sweep and review, cost this month |
| `POST /v1/project/pause` · `/resume` | Stop or restart scheduled runs |
| `GET/PUT /v1/brief` | Read or replace the brief (a new brief starts a charter draft) |
| `GET/PUT /v1/charter` | Draft, approved version, versions, scoping questions · edit the draft |
| `POST /v1/charter/answers` · `/approve` · `/retry` | Answer scoping questions · approve the draft · retry a failed draft |
| `GET /v1/charter/versions/:n` | An approved version |
| `GET/PUT /v1/schedule` | Sweep time and on/off, review weekday, time and on/off |
| `GET /v1/scheduled-runs` · `POST /v1/runs/{sweep,review}` | Run log (requested, skipped with reason) · run now |

## Development

```bash
npm test               # every workspace's tests, offline (fake model, mock Jev)
npm run check          # type-check everything
npm run check:jev      # Jev command wording vs. commands.lock.json
npm run check:env      # every env var read in code is documented in .env.example
npm run lint
```

Changing a Jev command's questions or policy requires bumping its `version` and running `npm run lock:jev`.

Layout: `packages/durable-agent` and `packages/jev` are vendored from
[pi-durable-news-agent](https://github.com/disler/pi-durable-news-agent) (see `NOTICE.md`); `packages/rh-sdk` holds
wire types, the stream reducer and a client; `apps/rh-server` is the server; `apps/rh-client-browser` the UI;
`new-project.sh` and `deploy/` set up project containers. Specs and planned changes live in `openspec/`
(OpenSpec), the overall plan in `PLAN.md`.
