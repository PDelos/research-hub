# Research Hub

A self-hosted research assistant. **One container = one research project (one theme).** Each project gets a
durable agent (built on [pi-durable](https://github.com/earendil-works/pi)) that will sweep for papers, let
[Jev](https://openrouter.ai/docs/guides/community/jev) make the bulk decisions, present a few paper cards a day,
learn from your 👎/👍/⭐ and grow an Obsidian-compatible knowledge base. A new theme is a new container.

**Status: v1.4 (the weekly upgrade).** v0 built the durable agent, Jev client, live stream, browser UI and containers (v0.0),
the brief, charter and schedule (v0.1), paper search with representations (v0.2), the daily sweep with paper cards
(v0.3), learning from your judgments (v0.4) and the knowledge base with the real Obsidian interface (v0.5). v1.0 turns
all of it into **plugins, like VS Code**: a small kernel and a plugin for every feature, which you can enable,
disable, configure, swap, install and roll back per project (see [Plugins](#plugins)). v1.1 makes the hub light
(232 MB, Obsidian as an add-on image) and runs **one daily cycle** you only read and judge (see
[The daily cycle](#the-daily-cycle)). v1.2 measures the hub on your judgments ([Quality](#quality-the-harness)), v1.3 sorts every plugin into core, slots,
add-ons and preferences with a fixed benchmark per slot ([What can change](#what-can-change-and-how-it-is-judged)),
and v1.4 adds [the weekly upgrade](#the-weekly-upgrade): once a week the hub improves one slot on its benchmark or
looks for new sources to add.

## Architecture and what comes next

A small **kernel** (plugin discovery, the per-project plugin state, the durable agent runtime, the database, HTTP,
permissions and budgets) runs **plugins**: paper sources, the embedder, the decision engine, the charter, sweep,
feedback, the research desk, the knowledge base and its viewers, and the UI tabs. Each has an `rh-plugin.json`
manifest, activates only when needed and declares what it may reach. Next (planned in
[EVOLUTION.md](EVOLUTION.md) §0 and §6): the goal is a **daily cycle that runs itself**: agents sweep, rank and
explain papers, analyze what you disliked or missed every night, replay candidate fixes on your past judgments and
apply the ones that clearly win (each with undo), and send a weekly digest you read and comment on. You only read,
judge and give opinions. Steps: a lighter image with the orchestrated cycle (v1-1), the replay harness on your
judgments (v1-2), plugins grouped as core, slots with fixed benchmark presets, add-ons and preferences (v1-3), the
weekly upgrade of one slot or a scout for add-ons (v1-4), all done; next, charter and new-question proposals (v1-5). Not
everything can change: the core (including the harness that measures everything) never does; see EVOLUTION.md §0.1.

## Quick start (offline, no keys)

Needs Node 26 or newer.

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

## The daily cycle

Each project runs one cycle on its own; your part is reading, judging and, when you like, commenting.

| When | What happens |
|---|---|
| Every morning (`RH_SWEEP_TIME`, 06:00) | The sweep brings about 7 cards. Once you have liked papers, the last card is an **Exploration** pick: a paper outside the top ones, least like what you liked, so the feed does not narrow (setting `explorationPicks` of `rh.sweep`, 0 to 2, default 1) |
| Any time | You judge cards 👎/👍/⭐ with a reason, or ask the desk |
| Every night (`RH_NIGHTLY_TIME`, 02:00) | The nightly run records the day; the judge is recalibrated and labels new papers; once a week the [weekly upgrade](#the-weekly-upgrade) runs after it |
| Weekly (`RH_REVIEW_TIME`, Sunday 07:00) | The **digest** (Digest tab): the week's sweeps and cards, your judgments and precision@5, the exploration picks and how you judged them, new knowledge-base notes, quality, sources, the week's upgrade, cost, and **every change** with an **Undo**. Each section has a comment box; your comments appear in the next digest |

A status line on the Feed and the Digest says where the cycle stands: the last sweep, how many cards wait for you,
and the next sweep, nightly run and digest. **Undo** reverses one change and keeps later ones (it is refused, with
the reason, when a later change touched the same setting). Cards per sweep and exploration picks are plugin
settings, so their changes are listed and undoable too.

## Quality: the harness

The hub measures itself on your judgments. A **replay** applies other sweep settings (gate thresholds
`relevanceMin`/`worthMin`, `rankWeights`, `cardsPerSweep`, `explorationPicks`) to past sweeps from their stored
scores (no searches, no paid calls) and compares the cards it would have shown with the current settings: nDCG
(⭐ 2, 👍 1, 👎 0), precision@5 and recall of ⭐, with a 95 % interval on the most recent sweeps (held out) and a
verdict: better, worse, inconclusive, or not enough data (under 3 sweeps with judged cards).

Papers you never judged get a label from the **judge** (the Jev command `would-like`, using your research questions
and recent judgments), but only while it agrees with your own verdicts in at least 70 % of 20+ cases; it is
recalibrated and labels new papers every night within $0.20 a day. The **Quality** tab shows the judge's
agreement, your cards over time and every replay; the digest summarizes them; and you can ask the desk "would 10
cards a day be better?". The harness is part of the core: no plugin or upgrade can change how things are measured.

## The weekly upgrade

Once every 7 days (setting `everyDays` of `rh.upgrades`), after the nightly run, the hub works on **exactly one**
thing, and the Upgrades tab and the digest report what it did:

| Focus | What it does | What changes |
|---|---|---|
| **Ranking** | Counts what went wrong in the last 60 days (👎 by reason: off topic, too basic or advanced, low trust; liked cards ranked low; exploration picks liked or not; cards left unjudged) and replays at most 12 setting variants around the current ones, the ones the analysis points at first | The variant with the verdict "better" and the highest held-out lower bound is **applied** as one change with **Undo**; with none, nothing changes |
| **Embedder** | Takes OpenRouter's embedding catalog, keeps models at most $0.25 per million tokens not tried in the last 90 days, shortlists 2 by a web search (or the 2 newest), and runs the embedder benchmark on the active model and each candidate within the run's cost cap (`maxRunUsd`, $0.50) | A candidate that beats the active model by 0.02 mean nDCG@10 without losing on "your stars" is **proposed**; Approve switches the embedder and re-embeds the papers in the background, with Undo |
| **Scout add-ons** | A web search for up to 5 free paper APIs or integrations that fit your research questions and that the hub does not have | A **list** with links and reasons; you dismiss what you do not want |

The focus is chosen by the Jev command `upgrade-focus` from each slot's last result and age, your digest comments
since the last upgrade, the failure counts and the last focuses; when it is unsure (confidence under 0.4) the focus
rotates ranking → embedder → scout. You can also start a run in the Upgrades tab. An upgrade never changes the core
or how a slot is measured, and every report lists every candidate it tried with its numbers.

Web searches go through OpenRouter's web plugin on the `chat` model (about $0.007 a search); their cost counts in the
run's cost and the plugin's daily budget. A first live run (2026-10-28, free chat model): ranking on a fresh project
said "not enough data" ($0); scouting suggested CORE, Lens, OpenCitations, dblp and Crossref ($0.007, 79 s); the
embedder run benchmarked Qwen3-Embedding-8B (0.679 mean nDCG@10) against the shortlisted Qwen3-Embedding-4B
(0.678, not better), skipped Gemini Embedding 001 (about $0.18, over a $0.10 cap) and proposed nothing ($0.035,
17 minutes, mostly embedding the samples).

## The knowledge base

Every ⭐ becomes an evidence note in the project's Obsidian vault (`$RH_DATA_DIR/vault/`): the librarian (the
`reader` model) writes Summary, Contributions, Method, Results, Limitations and Open questions from the title and
abstract only ("Not stated in the abstract" where they say nothing), and links the note to concept and research
question pages; the hub fills in the properties (identifiers, year, venue, level, scores, your reason) and adds a
line to `index.md` and `log.md`. **Your edits win:** the hub only creates notes and pages and appends under
`## Related papers` / `## Papers`, to the index and to the log; `charter.md` is refreshed only while you have not
edited it.

- **Library** tab: knowledge-base papers, keyword search over the vault, and each note rendered.
- **Knowledge base** tab: shows the active viewer. Without a choice it is Obsidian where the image has it (the
  `research-hub:obsidian` add-on) and the Library otherwise; pick one under Plugins → Knowledge base.
- **Obsidian** (add-on image): the real Obsidian interface (Ignis) inside the hub, in the hub's colors, light and dark,
  opening on the **graph view** (papers, concepts and research questions in three colors; Graph and Index buttons); it stays loaded when you switch tabs, and "Open in knowledge base" in the Library jumps to a
  note. Edits you make there are searchable within seconds, and notes the hub writes appear without a reload.
- The research desk always sees `index.md` and opens notes on demand (`search_kb`, `query_kb`): ask "which papers in
  my knowledge base cover Q2?".
- Settings: `RH_KB_VIEWER` (on/off), `RH_KB_VIEWER_DIR`, `RH_KB_OBSIDIAN_VERSION` (see `.env.example`). Ignis is
  AGPL-3.0 and runs unmodified; Obsidian is downloaded from its official release on first start and is not part of
  this project or its image.

## Plugins

Every feature is a plugin; the **Plugins** tab lists them with their state (active, ready, disabled, failed,
blocked, incompatible), what each adds (tabs, chat tools, commands, Jev commands, agents, processes, extension
points), what it may reach (hosts, files, secrets, a daily budget), its settings and its history.

| Plugin | What it does | Can you turn it off? |
|---|---|---|
| `rh.provider-openrouter`, `rh.decision-jev` | Models for every agent; Jev decisions | no (the hub needs them) |
| `rh.papers`, `rh.embedder-openrouter` | Search, storage, enrichment, representations; the embedder | no |
| `rh.source-arxiv`, `-openalex`, `-europepmc`, `-semanticscholar` | Paper sources (OpenAlex also enriches) | yes: the next search skips it |
| `rh.charter`, `rh.schedule`, `rh.sweep`, `rh.feedback`, `rh.desk` | Charter, schedule, sweep and cards, judgments, the research desk | no |
| `rh.kb` | The vault, its index, the librarian, the Library and Knowledge base tabs | no |
| `rh.viewer-obsidian`, `rh.viewer-library` | What the Knowledge base tab shows (Obsidian, or the Library view) | yes |
| `rh.runs-ui`, `rh.settings-ui`, `rh.plugins-ui` | The Runs, Settings and Plugins tabs | Runs only |

- **Enable, disable, configure:** changes apply at once, without a restart; disabling a plugin others need first
  lists them and asks. Plugin settings appear under Settings (defaults come from the environment, so `.env` keeps
  working); invalid values are refused with the setting and the rule.
- **Swap the viewer:** the `rh.kb` setting *Knowledge base viewer* picks Obsidian or the Library view; the Obsidian
  process stops while another viewer is active. `RH_KB_VIEWER=off` at a project's first start leaves the Obsidian
  plugin disabled.
- **Install** from a git URL or a folder on the server: the hub shows what the plugin adds and asks for, and installs
  only after you approve. Installed plugins run in their own process under Node's permission model: no network
  except the hosts they declare (through the hub), only their own folder and storage, no secrets they did not
  declare. A crash or hang fails that plugin only. **Uninstall** keeps its data unless you tick "also delete its data".
- **History and rollback:** every change is a commit in `$RH_DATA_DIR/plugins/` (a git repository with
  `plugins.lock.json`), with who made it; "Restore this state" re-applies any earlier state.

## What can change, and how it is judged

Every plugin is one of four kinds, and the Plugins tab groups them that way, by topic:

- **Core** (collapsed, cannot be changed): the kernel, the agent runtime, the database, the daily cycle, your
  judgments, the charter, the vault, and the harness that measures everything.
- **Slots** (one active each, replaced only when a benchmark says so): Ranking and gating (preset: replays on your
  judgments), Embedder (SCIDOCS, LitSearch and "your stars"; nDCG@10), Facet labeler (PubMed 20k RCT; macro-F1),
  Judge (agreement with you); Knowledge-base search and Models per job get presets later. Each slot card shows the
  active implementation, its alternatives and the last result; "Run benchmark" runs the preset.
- **Add-ons** (turn on or off): paper sources, enrichers, integrations, extra tabs. They are judged by what they
  bring: each source shows the cards it found in the last 30 days and how many you liked (also in the digest).
- **Preferences**: the knowledge-base viewer.

Public benchmarks run on small fixed samples (100 queries or abstracts, seed 7), downloaded once per project from
Hugging Face and cached, so results compare week to week; the datasets keep their licenses (SCIDOCS CC BY-SA 4.0,
LitSearch MIT, PubMed 20k RCT its authors' terms). A first live run (2026-10-28): Qwen3-Embedding-8B scored
SCIDOCS 0.555 / LitSearch 0.795 nDCG@10 ($0.009), Gemini Embedding 2 0.489 / 0.877 ($0.17); the facet labeler
0.908 macro-F1 ($0.013).

## Writing a plugin

A plugin is a folder with an `rh-plugin.json` and, if it has code, an ES module:

```json
{
  "id": "acme.pubmed",
  "version": "0.1.0",
  "displayName": "PubMed",
  "engines": { "research-hub": "^1.0.0" },
  "main": "main.mjs",
  "activationEvents": ["onExtensionPoint:papers.source", "onChatTool:pubmed_count"],
  "contributes": {
    "papers.source": [{ "id": "pubmed", "title": "PubMed" }],
    "chatTools": [
      {
        "name": "pubmed_count",
        "description": "How many PubMed papers match a query.",
        "parameters": { "type": "object", "required": ["query"], "properties": { "query": { "type": "string" } } }
      }
    ]
  },
  "permissions": { "network": ["eutils.ncbi.nlm.nih.gov"] }
}
```

```js
// main.mjs: rh calls are asynchronous (the plugin runs in its own process).
export async function activate({ rh }) {
  const search = (term) =>
    rh.http.json(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=${encodeURIComponent(term)}`);
  await rh.agents.registerChatTool("pubmed_count", async ({ query }) => (await search(query)).esearchresult.count);
  return {
    // A papers.source contribution is served by the exported client with its id.
    sources: { pubmed: { name: "pubmed", search: async (q) => [/* SourcePaper records for q.query */] } },
  };
}
```

- **Activation events:** `onStartup`, `onView:<tab>`, `onCommand:<id>`, `onChatTool:<name>`,
  `onExtensionPoint:<point>`, `onSchedule:<kind>`; code runs only after one fires.
- **Contributions:** `tabs`, `settings` (JSON schema properties, `env` for an environment default), `commands`,
  `chatTools`, `jevCommands`, `prompts`, `processes`, `enablement`, and contributions to extension points other
  plugins offer (`papers.source`, `papers.enricher`, `papers.embedder`, `kb.viewer`). A plugin can offer its own
  points under `extensionPoints` (cardinality one or many).
- **A tab of its own:** add `"browser": "ui/view.js"` and a tab whose `view` is a custom element name
  (`acme-view`); the module defines the element, which receives `rhClient` (the hub's API client) and inherits the
  hub's CSS variables (`--ink`, `--muted`, `--line`, `--accent`…), so it follows light and dark mode.
- **The `rh` API (1.0.0):** `db` (own tables `p_<plugin>__*`, numbered migrations), `files` (storage, the vault if
  declared), `http`, `secrets`, `models`, `embeddings`, `decisions`, `agents`, `commands`, `scheduler`, `events`,
  `processes`, `ui`. Paid calls count against `permissions.budgetUsdPerDay`.
- Try it: Plugins → Install a plugin → Folder on the server. Examples: `apps/rh-server/tests/fixtures/plugins/`
  (`acme.sample` with a chat tool and a paper source, `acme.reading-list` with a tab).

## Projects with Docker

Every research theme is its own container with its own data folder, port and name:

```bash
./new-project.sh proteins          # creates projects/proteins/ (compose file + .env), port 4850, sweep 06:00
./new-project.sh genomics          # projects/genomics/, port 4860, sweep 06:20
./new-project.sh notes --obsidian  # with the Obsidian viewer (the add-on image)
cd projects/proteins
#   put this project's OpenRouter key in .env
docker compose up -d               # open http://proteins.localhost:4850
```

Two images: `research-hub:latest` (light: 232 MB on disk, an 82 MB download; the server is one bundled file on a
minimal Node runtime; the Library shows the knowledge base) and `research-hub:obsidian` (the same plus Obsidian, 297
MB). `docker compose build` builds the one a project's compose file names.

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
| `GET /v1/info` | Models per job, Jev model, pi-durable version, kernel API version, plugins with versions and states |
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
| `GET /v1/scheduled-runs` · `POST /v1/runs/{sweep,nightly,review}` | Run log (requested, skipped with reason) · run now (review = the digest) |
| `GET /v1/cycle` | Where the daily cycle stands: last sweep, cards waiting, next sweep, nightly run and digest |
| `GET /v1/digests[/:id]` · `POST /v1/digests/:id/comments` | Weekly digests · comment on a section (`section`, `text`) |
| `GET /v1/slots` · `POST /v1/slots/:id/benchmark` · `GET /v1/slots/benchmarks` | Slots with active implementation, preset and last result · run a preset (`candidate`, e.g. `{ "model": "google/gemini-embedding-2", "dims": 1024 }`) · past runs |
| `GET /v1/attribution?days=30` | Cards each paper source brought, and how many you liked |
| `GET /v1/upgrades` · `POST /v1/upgrades/run` | Runs with their reports, proposals and suggestions · start a run now (`focus`: `ranking`, `embedder` or `scout-addons`; without it Jev chooses), in the background |
| `POST /v1/proposals/:id/approve` · `POST /v1/proposals/:id/reject` · `POST /v1/suggestions/:id/dismiss` | Decide on a proposed upgrade · dismiss a suggested add-on |
| `GET /v1/harness/quality` · `GET /v1/harness/replays` · `POST /v1/harness/replay` | The judge's agreement and quality over time · replays · replay a variant (`variant`) |
| `GET /v1/cards` · `GET /v1/cards/:id` | The Feed (cards grouped by sweep, newest first) · one card with score details |
| `GET /v1/sweeps[/:id]` | Sweeps with phases, counts, papers by status and the cost split |
| `GET/PUT /v1/sweep-settings` | Cards per sweep (1 to 15, default 7) |
| `PUT/DELETE /v1/cards/:id/judgment` | Judge a card (`verdict` up, down or star; optional `reason`) · remove the judgment |
| `GET /v1/weights` · `GET /v1/feedback/precision` | Effective weights with charter values · precision@5 per sweep |
| `GET /v1/kb/papers` · `/v1/kb/notes/:stem` · `/v1/kb/search?q=` | Knowledge-base papers · one note (properties and body) · vault search |
| `/kb/` (browser, same origin) | The embedded Obsidian viewer, proxied to the bundled Ignis |
| `GET /v1/plugins` · `GET /v1/plugins/:id` | Plugins with state, the kernel API version · one plugin's contributions, permissions, settings, history |
| `GET /v1/plugins/contributions` | Tabs, the knowledge-base viewer choice, settings grouped by plugin |
| `POST /v1/plugins/install` · `/install/:planId/approve` · `DELETE /install/:planId` | Prepare an install (`source`: `folder` or `git`) · approve · cancel |
| `POST /v1/plugins/:id/enable` · `/disable` | Enable · disable (`cascade` to take dependents along) |
| `PUT /v1/plugins/:id/settings` · `DELETE /v1/plugins/:id` | Change settings (`values`, null removes) · uninstall (`?deleteData=true`) |
| `GET /v1/plugins/history` · `POST /v1/plugins/rollback` · `POST /v1/plugins/undo` | Every change · restore an earlier state (`commit`) · undo one change, keeping later ones (`commit`) |

## Development

```bash
npm test               # every workspace's tests, offline (fake model, mock Jev)
npm run check          # vp check (formatting, lint, types) + workspace type checks + check:jev + check:env
npm run test:ui        # Playwright UI tests and light/dark screenshots, offline (uses the system Chromium if any)
scripts/e2e-offline.sh # the whole flow through the UI proxy (plugins and the cycle included), about a minute
                       #   E2E_BUNDLE=1: on the bundled server · E2E_IMAGE=research-hub:latest: inside a container
npm run pack -w rh-server  # bundle the server into apps/rh-server/dist (what the image runs)
npm run lint           # vp lint;  npm run fmt: vp fmt
```

The toolchain is **Vite+** (`vp`: Vite, Vitest, Oxlint, Oxfmt) with one root `vite.config.ts`, on Node 26 LTS and
TypeScript 6.0; the UI is Vue 3.5 with Vue Router 5 and Pinia 4; the agent runtime is pi-durable 1.4.0.

Changing a Jev command's questions or policy requires bumping its `version` and running `npm run lock:jev`.

Layout: `packages/durable-agent` and `packages/jev` are vendored from
[pi-durable-news-agent](https://github.com/disler/pi-durable-news-agent) (see `NOTICE.md`); `packages/rh-sdk` holds
wire types, the stream reducer and a client; `apps/rh-server` is the server (the kernel in `src/kernel/`, the built-in plugins in `plugins/`);
`apps/rh-client-browser` the UI;
`new-project.sh` and `deploy/` set up project containers. Specs and planned changes live in `openspec/`
(OpenSpec), the overall plan in `PLAN.md`.
