# Research Hub

A self-hosted hub of research projects. Each project gets a durable agent (built on
[pi-durable](https://github.com/earendil-works/pi)) that will sweep for papers, let
[Jev](https://openrouter.ai/docs/guides/community/jev) make the bulk decisions, present a few paper cards a day,
learn from your 👎/👍/⭐ and grow an Obsidian-compatible knowledge base.

**Status: v0.0 skeleton.** The durable agent, Jev client, live stream, browser UI and container work; paper
features arrive layer by layer (see `PLAN.md` §17 and `openspec/changes/`).

## Quick start (offline, no keys)

Needs Node 24 or newer.

```bash
npm install
npm run build -w rh-client-browser
RH_MODE=offline npm start -w rh-server
```

Open <http://localhost:4850>. Offline mode uses a fake model that echoes you and a mock Jev; nothing leaves your
machine.

## Live mode

```bash
cp .env.example .env      # then set OPENROUTER_API_KEY
npm start -w rh-server
```

All models, embeddings and Jev go through OpenRouter. Each job's model is set in `.env` (`RH_MODEL_DESK`,
`RH_MODEL_READER`, `RH_MODEL_REVIEW`, `RH_MODEL_CHAT`, `RH_MODEL_JEV`); change a line and restart to switch models.
Without the key the server refuses to start and names the missing variable.

## Docker

```bash
docker compose -f compose.offline.yml up -d   # keyless demo, data in ./data-offline
docker compose up -d                          # live, reads .env, data in ./data
```

One container serves the UI and the API on port 4850 (published on 127.0.0.1 only). Data lives in the mounted
folder, so `docker compose down && docker compose up -d` keeps everything. The container restarts itself unless you
stop it. To run a second hub on the same machine, copy this folder and set a different port and data folder:

```bash
RH_PUBLISH_PORT=4860 RH_HOST_DATA_DIR=./data-second docker compose -p hub2 up -d
```

## Calling the API

The browser UI needs no token: the server holds it and only answers same-origin requests. Scripts use a bearer
token: set `RH_API_TOKEN` in `.env` (if unset, a random one is generated per start and the log says so).

```bash
curl -s localhost:4850/v1/health
curl -s -H "authorization: Bearer $RH_API_TOKEN" -H 'content-type: application/json' \
  -d '{"content":"hello","waitMs":30000}' localhost:4850/v1/p/default/chat
curl -s -X POST -H "authorization: Bearer $RH_API_TOKEN" -H 'content-type: application/json' \
  -d '{}' localhost:4850/v1/p/default/jev/ping     # Jev smoke test: provider, model, latency, cost
```

| Route | What |
|---|---|
| `GET /v1/health` | Open. Version, mode, providers |
| `GET /v1/info` | Models per job, Jev model, projects, pi-durable version |
| `POST /v1/p/:slug/chat` | Send a message (`content`, optional `requestId`, `waitMs`) |
| `GET /v1/p/:slug/stream` | Server-sent events: snapshot, then deltas |
| `GET /v1/p/:slug/transcript` | The conversation so far |
| `GET /v1/p/:slug/runs[/:id]` | Runs with model calls, tool calls, tokens and cost |
| `GET /v1/p/:slug/usage` | Cost totals (models, Jev, this month) |
| `POST /v1/p/:slug/jev/ping` | Jev smoke test |

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
wire types, the stream reducer and a client; `apps/rh-server` is the server; `apps/rh-client-browser` the UI.
Specs and planned changes live in `openspec/` (OpenSpec), the overall plan in `PLAN.md`.
