# Research Hub

A self-hosted research assistant. **One container = one research project (one theme).** Each project gets a
durable agent (built on [pi-durable](https://github.com/earendil-works/pi)) that will sweep for papers, let
[Jev](https://openrouter.ai/docs/guides/community/jev) make the bulk decisions, present a few paper cards a day,
learn from your 👎/👍/⭐ and grow an Obsidian-compatible knowledge base. A new theme is a new container.

**Status: v0.5 (v0 complete).** Durable agent, Jev client, live stream, browser UI and container setup (v0.0), the project's
brief, charter and schedule (v0.1), paper search with paper representations (v0.2), the daily sweep with paper cards
(v0.3), judging with learning from your feedback (v0.4), and the knowledge base with the real Obsidian interface
inside the hub (v0.5). What comes after v0 is in `PLAN.md` §17.

## Quick start (offline, no keys)

Needs Node 24 or newer.

```bash
npm install
npm run build -w rh-client-browser
RH_MODE=offline npm start -w rh-server
```

Open <http://localhost:4850>. Offline mode uses a fake model that echoes you, a mock Jev, fake embeddings and
synthetic paper-source answers (ask "find papers on protein folding" to see a search); nothing leaves your machine.
Data goes to `./data`.

## Starting a project

1. **Brief.** Open the UI: a new project asks for a brief (paste it or upload a `.md`, up to 50,000 characters).
2. **Charter.** The research desk drafts a charter in its own conversation on the `review` model: 3 to 7 research
   questions with weights, concepts, sub-areas, 5 to 20 search queries and what is out of scope. It may ask up to 5
   scoping questions; answering them produces a revised draft.
3. **Approve.** Edit anything in the Charter tab, then approve. Each approval is a numbered version; later edits or
   a new brief make a new draft while the approved version stays in force.
4. **Schedule.** Once approved, the daily sweep and weekly review run on schedule (Settings tab, or `RH_SWEEP_TIME`,
   `RH_REVIEW_TIME`, `RH_TIMEZONE`). Each slot runs exactly once, even across restarts; after downtime only the latest
   missed slot runs. Pause the project from the top bar to stop scheduled runs (chat keeps working).
5. **Feed.** Each sweep brings a few paper cards (default 7). "Run sweep now" in the Feed starts one at once.

## Live mode

```bash
cp .env.example .env      # set RH_PROJECT_NAME and OPENROUTER_API_KEY
npm start -w rh-server
```

All models, embeddings and Jev go through OpenRouter. Each job's model is set in `.env` (`RH_MODEL_DESK`,
`RH_MODEL_READER`, `RH_MODEL_REVIEW`, `RH_MODEL_CHAT`, `RH_MODEL_JEV`); change a line and restart to switch models.
Without the key the server refuses to start and names the missing variable.

## Finding papers

Ask the research desk in chat, for example "find recent papers on ESM contact prediction since 2026-09-01". It calls
`search_papers` (at most 10 results per call) and answers with title, year, venue or preprint server, citations,
sources and a link. Behind it:

- **Sources, all keyless:** arXiv, OpenAlex and Europe PMC (which also covers bioRxiv and medRxiv preprints).
  Semantic Scholar is used only with `S2_API_KEY`. A failing source is retried (up to 3 attempts within 60 s) and
  reported; the others still answer. arXiv is paced at one request per 3 seconds.
- **One record per work:** results merge when any DOI, arXiv ID, PMID, PMCID or OpenAlex ID matches; a shared title
  alone only flags a possible duplicate. OpenAlex adds venue, citations, references, open-access link and retraction
  status (cached 7 days); a work not in OpenAlex yet stays pending and is retried on a later search.
- **Three representations per paper:** a whole-paper vector (title + abstract), facet vectors for background,
  method and result (Jev labels each abstract sentence with the `abstract-facets` command), and citation links
  from OpenAlex references. Together they let later layers find "same method, different problem".
- **Settings:** `CONTACT_EMAIL` is sent to OpenAlex and Europe PMC for their polite pools (the server warns once if
  it is missing). `RH_MODEL_EMBED` (default `qwen/qwen3-embedding-8b`) and `RH_EMBED_DIMS` (default 1024) choose
  the one embedding model; changing either re-embeds the project's papers in the background.
- **Cost** (measured live, 2026-10-23): about $0.0001 of Jev and $0.000006 of embeddings per new paper; the Runs
  tab shows Jev and embedding totals next to model costs.

## The daily sweep and paper cards

A sweep runs on its own at the scheduled time (or from "Run sweep now") and goes through seven phases, all visible
in the Runs tab:

1. **plan:** a weighted draw of up to 15 charter queries. Until you have judged 10 papers the project is in
   *orientation mode*: 5 queries also get a "review" variant and there is no date window, so early cards favor
   surveys, reviews and foundational work. Later sweeps search only since the previous sweep.
2. **gather:** each query on every source (10 results per source).
3. **dedupe:** papers that already have a card or were rejected before are dropped without asking Jev again.
4. **gate:** one Jev call per paper (`on-theme`, `paper-kind`, `worth-reading`): rejected below relevance 0.45 or
   worth 0.35 with the reason stored; relevance 0.45–0.55 passes as *borderline*.
5. **enrich:** OpenAlex metadata and the paper's vectors, for survivors only.
6. **level:** one Jev call per survivor (`level`, `importance`): foundational, core, advanced or frontier.
7. **rank:** importance, relevance, question weight, level fit and freshness; retracted papers are blocked; the top
   N become candidates (`cards_per_sweep`, 1 to 15, `PUT /v1/sweep-settings`).

Then the research desk writes the cards on the `desk` model: a summary of at most 80 words from the title and
abstract only (a summary with numbers that are not in the abstract is refused), and it must present or explain every
candidate. **Scores are computed by code, never by the model:** Relevance (Jev relevance and question weight),
Trust (peer review with a smaller preprint penalty in cs.* and q-bio.*, citations per year, open access, a described
method) and Value (novelty, worth reading, kind of paper), each with a one-line reason. "How these scores were
computed" on a card shows the formulas, inputs and Jev decisions with their versions.

A sweep survives restarts: every Jev decision is stored per paper and command version, so a resumed or repeated
sweep never pays twice. A failing phase retries after 30 s, 2 min and 8 min, then the sweep fails with the error.
Measured live (2026-10-23): a first sweep gathered 254 papers, 139 passed the gate, 7 cards, $0.041 (Jev $0.040,
embeddings $0.0014, cards on a free model); a second sweep the same day reused every decision and cost $0.0023.

## Judging cards

Every card has 👎 (not useful), 👍 (interesting) and ⭐ (add to the knowledge base), and an optional reason (up to
1,000 characters). Click a verdict again to remove it. You can also judge in chat: "star the second card, great
foundation". Your judgments teach the next sweeps, without any extra model calls:

- **Weights.** 👍 +0.10, ⭐ +0.15, 👎 −0.15 on the card's research question, the queries that found it and its
  sources, kept between 0.1 and 2. They are recomputed from the charter each time, so changing a verdict counts only
  once. The card's details show what changed; Settings lists every weight with its charter value.
- **Taste examples.** Your 8 most recent judgments (title, verdict, reason) go with every Jev gate and ranking call.
- **Reasons.** Jev `reason-parse` classifies each reason (off-topic, too-basic, great-method, …) and spots reasons
  that state a general rule ("skip papers without code"); those are queued for the weekly review.
- **Never again.** A judged paper is never presented again, and orientation mode (foundations first) ends after 10
  judged papers.
- **⭐** queues the paper for the knowledge base (v0.5); un-starring before it is added cancels that.
- **Precision@5**, the share of a sweep's top 5 cards you liked or starred among those you judged, is shown as a
  trend in the Feed.

## The knowledge base

Every ⭐ becomes an evidence note in the project's Obsidian vault (`$RH_DATA_DIR/vault/`): the librarian (the
`reader` model) writes Summary, Contributions, Method, Results, Limitations and Open questions from the title and
abstract only ("Not stated in the abstract" where they say nothing), and links the note to concept and research
question pages; the hub fills in the properties (identifiers, year, venue, level, scores, your reason) and adds a
line to `index.md` and `log.md`. **Your edits win:** the hub only creates notes and pages and appends under
`## Related papers` / `## Papers`, to the index and to the log; `charter.md` is refreshed only while you have not
edited it.

- **Library** tab: knowledge-base papers, keyword search over the vault, and each note rendered.
- **Knowledge base** tab: the real Obsidian interface (Ignis) inside the hub, in the hub's colors, light and dark,
  opening on the index; it stays loaded when you switch tabs, and "Open in knowledge base" in the Library jumps to a
  note. Edits you make there are searchable within seconds, and notes the hub writes appear without a reload.
- The research desk always sees `index.md` and opens notes on demand (`search_kb`, `query_kb`): ask "which papers in
  my knowledge base cover Q2?".
- Settings: `RH_KB_VIEWER` (on/off), `RH_KB_VIEWER_DIR`, `RH_KB_OBSIDIAN_VERSION` (see `.env.example`). Ignis is
  AGPL-3.0 and runs unmodified; Obsidian is downloaded from its official release on first start and is not part of
  this project or its image.

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
| `GET /v1/cards` · `GET /v1/cards/:id` | The Feed (cards grouped by sweep, newest first) · one card with score details |
| `GET /v1/sweeps[/:id]` | Sweeps with phases, counts, papers by status and the cost split |
| `GET/PUT /v1/sweep-settings` | Cards per sweep (1 to 15, default 7) |
| `PUT/DELETE /v1/cards/:id/judgment` | Judge a card (`verdict` up, down or star; optional `reason`) · remove the judgment |
| `GET /v1/weights` · `GET /v1/feedback/precision` | Effective weights with charter values · precision@5 per sweep |
| `GET /v1/kb/papers` · `/v1/kb/notes/:stem` · `/v1/kb/search?q=` | Knowledge-base papers · one note (properties and body) · vault search |
| `/kb/` (browser, same origin) | The embedded Obsidian viewer, proxied to the bundled Ignis |

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
