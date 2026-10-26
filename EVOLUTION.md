# Research Hub — Plugins and the Two Improvement Loops

> How the Research Hub becomes a set of installable plugins that its own agents keep improving: the **knowledge
> loop** improves *what* the project searches for and knows; the **product loop** improves *how* the hub works
> (embedders, extractors, prompts, rankers) through replays on the user's own judgments. Agents do the work; the
> human reads, judges and gives opinions. Companion to `PLAN.md` (the v0 system as built) — this file plans everything after v0.

Written 2026-10-25, after v0 was completed. Revised the same day: product upgrades run through an **Upgrades tab** where the human decides at every
gate (idea → test → proof → implement), and **the whole hub is plug-and-play**, not only the pipeline. **Revised
2026-10-26 after v1-0 (§0):** the goal is a self-running daily cycle with the human *on* the loop; winning fixes to
the finding loop apply automatically with undo; the order is now core loop first.

---

## 0. The goal: a daily cycle the human only reads and judges (decided 2026-10-26)

The whole project exists for one loop: **agents find, rank and explain papers every day and keep making that
better; the human only reads, judges and gives opinions.** Every opinion (a 👎/👍/⭐ with a reason, a comment on
the weekly digest) becomes evidence the system improves on. Research behind this design (2026-10-26):
personalized paper recommenders (Scholar Inbox, PaperFlow) learn from thumbs and keep a few **exploration** picks
against filter bubbles and interest drift; LLM teams run an **eval flywheel** (error analysis of real failures
first, then checks for those failures, an automatic judge **calibrated on the human's own verdicts**, the human
spot-checks); reflective prompt optimizers (GEPA) improve prompts from failure traces without training; surveys of
autonomous research agents name the **verification gap** (unverified self-reported gains) as the main weakness, so
every claimed improvement here must come with numbers on held-out judgments.

**The cycle (one orchestrated workflow per project):**

| When | Who | What |
|---|---|---|
| Morning | agents | Sweep → gates → ranking → ~7 cards, one of them an **exploration** pick outside the usual interests (marked) |
| Any time | **you** | Read cards; 👎/👍/⭐ with a reason when you like; ask the desk anything |
| Nightly | agents | **Error analysis:** read 👎 reasons and the ⭐/👍 papers that ranked low, group them into failure modes, propose concrete fixes (a query, a gate threshold, a weight, a prompt or Jev wording, an embedder) |
| Nightly | harness | **Replay** each fix on past sweeps against your judgments (held-out part included); score with intervals and cost |
| Nightly | kernel | **Fixes that clearly win are applied** (a plugin-state commit), each with one-click **undo**; losers are recorded so they are not retried |
| Weekly | agents → **you** | **Digest:** what changed and why (with the evidence), what was tried and lost, precision over time, the judge's agreement with you, charter and new-question proposals. Your comments on it feed the next round |

**Autonomy (decided 2026-10-26):** fixes to the finding loop that win on the harness are applied automatically and
listed with undo (nothing hidden: offline replays only, never experiments on your live feed). Charter changes,
anything that raises the monthly cost noticeably, and product upgrades from outside (the Upgrades tab, §3) still
wait for your OK. **Obsidian is an add-on** (a separate optional image layer); the default viewer is the Library.

---

### 0.1 What may change, and how it is judged (decided 2026-10-26)

Improvement is not open-ended. Every part of the hub is in exactly one of four kinds, declared in its plugin
manifest (`kind`, `topic`, and for slots `benchmark`), and the Plugins tab groups plugins by topic and kind:

| Kind | Meaning | How a change is judged | In the Plugins tab |
|---|---|---|---|
| **Core** | Never a plugin you can change: the kernel (loader, lockfile, history and undo, permissions, budgets), the agent runtime, the database, the API and UI shell, the daily cycle (scheduler, nightly run, digest), your judgments and comments, the charter store, the markdown vault as the source of truth, and **the harness** (replays, judge calibration, benchmark presets, metrics, verdict rules) | Not changeable by plugins or upgrades; changed only by a new hub version | One collapsed group "Core (cannot be changed)" |
| **Slot** | One active plugin per slot, replaceable by an alternative | A **fixed benchmark preset** per slot (public benchmarks and/or replays on your judgments) and its primary metric; a candidate replaces the active plugin only if it wins on the preset | One line per slot: the active plugin, its alternatives, the last benchmark result; "replace", never "turn off" |
| **Add-on** | Any number active; each adds something (a paper source, an enricher, an integration, a tab, a desk tool, an MCP server) | Reasoning and **usage attribution** ("this source brought 14 cards this month, you liked 6"), shown in the digest; you keep or remove it | Active add-ons with on/off, and "Available" ones from the scout |
| **Preference** | One active, chosen by taste (the knowledge-base viewer, later themes) | Your choice; no benchmark | A simple picker |

**The slots and their presets:**

| Topic | Slot | Active today | Benchmark preset (primary metric) |
|---|---|---|---|
| Finding papers | **Ranking and gating** (gate thresholds, rank weights, cards per sweep, exploration picks) | rank formula + Jev gates | Replays on your judgments (v1-2): nDCG@n, held-out interval. No public benchmark measures your taste |
| Understanding papers | **Embedder** | Qwen3-Embedding-8B (OpenRouter) | SCIDOCS (BEIR, citation prediction), LitSearch (papers from research questions), plus: do your ⭐ papers rank near each other and your questions (nDCG@10) |
| Understanding papers | **Facet labeler** (background / method / result sentences) | Jev `abstract-facets` | PubMed 200k RCT and CSAbstruct (sentence roles; macro-F1) |
| Ranking | **Judge** | Jev `would-like` | Agreement with your verdicts (accuracy, kappa) |
| Knowledge base | **Knowledge-base search** | SQLite FTS5 | SciFact, NFCorpus (BEIR; nDCG@10), plus your questions to the desk |
| Understanding papers | **Full-text extraction** (later) | none yet | OmniDocBench; the research project's OfficeQA and UNIDOC-BENCH |
| Agents and models | **Model per job** (card writer, librarian, desk) | free model | Small task sets per job, judged pairwise with swapped positions, plus your ratings |

Public benchmarks run on **small cached samples** (a few hundred queries each) so a run costs cents, and the same
sample is used every week so results compare. Add-ons by topic: Finding papers (arXiv, OpenAlex, Europe PMC,
Semantic Scholar; candidates PubMed, bioRxiv by date, proceedings), Enrichment (OpenAlex; candidate Crossref),
Integrations (Zotero/BibTeX, notifications, extra tabs, desk tools, MCP servers).

### 0.2 The weekly upgrade

Each week the agent does one of two things, and the digest reports it:

1. **Improve one slot.** It picks the slot with the weakest numbers or the one your comments point at, searches
   the internet only for candidates for **that slot**, runs the slot's **fixed preset** on the candidate and on the
   active plugin, and reports. Changes of **settings** that win (thresholds, weights) are applied with undo; **new
   plugins** that win (another embedding model) are proposed with their numbers and installed when you approve.
2. **Scout add-ons.** It looks for add-ons worth having (new paper-source APIs, enrichers, integrations) and lists
   them with its reasoning; you install the ones you want, and usage attribution then shows their worth.

The agent never chooses freely what to optimize, never changes the core, and never changes how a slot is measured.

## 1. The idea in one picture

```
                         ┌──────────────── human: approve / reject / roll back ────────────────┐
                         ▼                                                                     │
  KNOWLEDGE LOOP   charter ──► sweeps ──► cards ──► 👎/👍/⭐ ──► knowledge base ──► review ──┘
  (what to know)      ▲                                                              │
                      └──────── charter proposals · new research questions ◄─────────┘

  PRODUCT LOOP     scout (web search: new models, methods, tools) ──► IDEA ──you──► TEST ──► PROOF
  (Upgrades tab)                                                        ▲                        │
                    rolled back ◄── VERIFIED ◄── IMPLEMENTED ◄──you──────┴──── you evaluate ◄─────┘
```

The knowledge loop ends in **proposals with evidence** that you approve in one click. The product loop is the
**Upgrades tab**: a staged workflow where the agent does the work and **you decide at every gate** (which ideas to
test, and whether the proof justifies the upgrade). Everything is reversible with one click.

---

## 2. Everything is a plugin

### 2.0 A small kernel, everything else plugged in

The hub becomes a **microkernel**: a small core that only knows how to load plugins, give them services and keep
the project's state safe; every feature, from the paper sources to the knowledge-base viewer, the UI tabs and the
agents, is a plugin that can be installed, swapped or removed. The design follows proven plugin systems:

- **Extension points owned by the plugin that offers them** (Backstage): a plugin can open its own extension
  points (the knowledge-base plugin offers `kb.viewer`, the sweep plugin offers `sweep.phase`), many small
  extension points rather than a few big ones, and plugins talk to each other only through them.
- **Contribution points declared in the manifest** (VS Code): UI tabs, settings panels, chat tools, commands and
  status-bar items are declared, so the host can show, disable and audit them without running plugin code.
- **The kernel** keeps only: plugin loading and the lockfile, the project database and file area per plugin,
  secrets and budgets, the durable agent runtime, scheduling, the HTTP server with its security guard, and the
  proposals inbox. Everything else is replaceable.

| Area | Extension point | Built-in plugin (v0) | Alternatives to plug in |
|---|---|---|---|
| Knowledge base storage | `kb.store` | Markdown vault (Obsidian-compatible) | a Logseq graph, a Trilium database, a plain folder of notes |
| Knowledge base viewer | `kb.viewer` | Obsidian through Ignis (graph view by default) | SilverBullet or Logseq (self-hosted web), Quartz (read-only site), the hub's own graph and Library views |
| UI | `ui.tab`, `ui.panel`, `ui.card` | Feed, Library, Knowledge base, Charter, Runs, Settings | a reading-list tab, a proposals tab, a dashboard, a different card layout |
| Agents | `agent` | research desk, charter writer, card writer, librarian | a reviewer, a scout, an engineer, a different desk persona |
| Models | `model.provider` | OpenRouter (all jobs), faux (offline) | direct provider APIs, a local model server |
| Decisions | `decision.engine` | Jev through OpenRouter, mock Jev | another small judge model, a local classifier |
| Notifications | `notify` | none | email digest, Telegram or Slack message, desktop notification |
| Import and export | `io` | none | Zotero, BibTeX, Notion, PDF upload |
| Pipeline | the slots in 2.1 | | |

### 2.1 Pipeline slots

> Superseded in detail by §0.1 (2026-10-26): the slots, their benchmark presets and what is core.

The paper pipeline's extension points (the v0 code is refactored into the first built-in plugins without
changing behavior):

| Slot | What it does | Built-in plugins (from v0) | Candidate plugins to try |
|---|---|---|---|
| `source` | Find papers by query | arXiv, OpenAlex, Europe PMC, Semantic Scholar | bioRxiv by date, PubMed, conference proceedings, web search |
| `enricher` | Add metadata | OpenAlex | Crossref, Semantic Scholar, citation counts |
| `gate` / `ranker` | Jev decisions and ranking | `on-theme`, `paper-kind`, `worth-reading`, `level`, `importance` + rank formula | new Jev commands, other thresholds, other formulas |
| `fulltext` | Get and structure the full text (⭐) | — (new) | arXiv HTML, Europe PMC XML, PDF text, Docling (PDF → markdown), **native multimodal pages** (page images, no conversion) |
| `summarizer` | Facet summaries (problem, method, findings, open questions) | — (new) | prompt variants, models |
| `embedder` | Vectors | Qwen3-Embedding-8B (OpenRouter) | Gemini Embedding 2 (multimodal), EmbeddingGemma (local), fine-tuned students |
| `representation` | Which vectors per paper | whole + Jev facets + citations | facet summaries, page-image vectors, chunk vectors |
| `card-writer` / `librarian` | Prompts and tools of the writing agents | v0 prompts | prompt variants, models |
| `kb-search` | Search the vault (also as an **MCP server** for outside agents) | FTS5 keyword search | hybrid keyword + vector, multimodal search over figures and tables |
| `question-finder` | Propose new research questions (knowledge loop) | — | same-method-different-problem, missing links, recurring open questions, contradictions, citation gaps, rising topics |
| `scout` | Look for product improvements (product loop) | — | web search, arXiv, GitHub releases, Hugging Face, MTEB leaderboards |

### 2.2 What a plugin is (VS Code style)

A plugin is a folder with an **`rh-plugin.json`** manifest, modeled on a VS Code extension's `package.json`: what
it needs from the kernel (`engines`), **when** it wakes up (`activationEvents`), **what it adds**, declared rather
than coded (`contributes`), which plugins it builds on (`dependencies`), and what it may touch (`permissions`):

```jsonc
{
  "id": "rh.viewer-obsidian",                 // publisher.name, unique
  "version": "1.0.0",
  "displayName": "Obsidian viewer (Ignis)",
  "engines": { "research-hub": "^1.0.0" },    // kernel API versions it works with
  "main": "server/index.ts",                   // activate(context) / deactivate()
  "browser": "ui/index.ts",                    // optional UI code (tabs, panels)
  "dependencies": ["rh.kb"],                   // activated first; their exported APIs are available
  "activationEvents": ["onStartup:vault", "onView:knowledge-base"],
  "contributes": {
    "kb.viewer": [{ "id": "obsidian", "title": "Obsidian", "proxyPath": "/kb/" }],   // another plugin's extension point
    "tabs": [{ "id": "knowledge-base", "title": "Knowledge base", "order": 30 }],
    "settings": {                              // JSON schema, shown in Settings, validated by the kernel
      "rh.viewerObsidian.enabled": { "type": "boolean", "default": true },
      "rh.viewerObsidian.obsidianVersion": { "type": "string", "default": "1.14.4" }
    },
    "commands": [{ "id": "rh.viewerObsidian.openGraph", "title": "Open the graph" }],
    "processes": [{ "id": "ignis", "restart": "always", "network": "loopback" }]
  },
  "permissions": {
    "network": ["github.com"],                 // only to download Obsidian
    "files": ["vault:read-write", "own"],      // the vault and its own folder
    "secrets": [],
    "budgetUsdPerDay": 0
  }
}
```

- **Activation is lazy**, as in VS Code: a plugin's code runs only when one of its events fires (startup, a view
  opening, a sweep phase, a command, a chat tool call), so a disabled or unused plugin costs nothing.
- **`contributes` is declarative**: the kernel builds the tab bar, Settings, the command list, the chat tools and
  the Jev command lock from the manifests, and can show, disable and audit them without running plugin code.
- **Plugins export APIs** from `activate()` for the plugins that depend on them (VS Code's extension exports).
- **Extension points belong to the plugin that offers them** (Backstage): `rh.papers` offers `papers.source`,
  `rh.kb` offers `kb.viewer` and `kb.store`, `rh.sweep` offers `sweep.phase`; many small points rather than a few
  big ones; plugins talk only through extension points and exported APIs.
- **Plugin UIs are Web Components** (custom elements inheriting the hub's CSS variables), so a plugin's tab can be
  written in Vue, plain JavaScript or anything else; the hub itself stays Vue 3.5 with Vue Router 5 and Pinia 4,
  built, tested, linted and formatted with **Vite+** (`vp`). A plugin template ships the same `vp` setup, so
  agent-written plugins are formatted, linted and tested the same way.
- **The kernel API** (`rh`, versioned like `vscode`): `db` (the plugin's own tables and migrations), `files` (its
  own folder; the vault through `rh.kb`), `settings`, `secrets` (only those declared), `http` (only declared hosts,
  paced, with budgets), `models`, `decisions` (Jev), `agents` (register agents and chat tools), `scheduler`,
  `events`, `processes` (supervised child processes), `ui`, `proposals`.

### 2.3 Where plugins run: three levels of trust

| Kind | Examples | Runs | Risk |
|---|---|---|---|
| **built-in** | the v0 features refactored | in the kernel's process, like VS Code's built-in extensions | trusted, shipped with the image |
| **config** | prompts, Jev commands, thresholds, rank weights, model choices, `contributes`-only plugins | data read by the host, no code | low |
| **code** (third-party or agent-written) | a new ranker, a source client, a UI tab | a separate **plugin host** process (like VS Code's extension host) with Node's permission model: only declared files and hosts, secrets never visible, LLM and HTTP calls through kernel clients that enforce budgets | medium |
| **process** | Docling (Python), a local embedder, a fine-tuning job, Ignis, any MCP server | a supervised child process speaking **MCP over stdio** (or HTTP on loopback), with the same declared limits | medium–high |

MCP as the process-plugin protocol means any MCP server can become a plugin, and every hub tool can be exposed
to outside agents. It is the same architecture as the research project's deliverable (a multimodal search tool
behind an MCP server).

### 2.4 Install, uninstall, versions

- **Registry:** built-in plugins in the image; others from a folder, a git URL or (later) a catalog.
- **Lockfile per project** (`plugins.lock.json`: id, version, config, content hash), like the Jev commands lock.
  One plugin is **active** per slot, others can be **installed but inactive**, or **under test** (run by the tester
  beside the active one when the user asks, on a copy of the data; never serving the user).
- **UI and CLI:** Plugins tab: list, install, enable, disable, uninstall, configure, see metrics and history.
- **Every change is a commit** in the project's own plugin repo (`$RH_DATA_DIR/plugins/`, a git repo): an audit
  trail and one-click rollback to any previous lockfile.
- **Data stays compatible:** plugins that change stored data (an embedder, a representation) declare it; the host
  re-computes in the background as v0 already does for a model change, and never mixes versions.

---

### 2.5 What v1-0 built (2026-10-26)

- **Kernel** (`apps/rh-server/src/kernel/`): manifests with field-level errors, discovery, dependency resolution,
  lazy activation with a 10 s limit, the `rh` API 1.0.0 with permission and budget enforcement, the plugin state in
  a per-project git repository with history and rollback, install with approval, and external plugins in their own
  Node process (permission model, no network except declared hosts through `rh.http`, no secrets).
- **19 built-in plugins** (`apps/rh-server/plugins/`) wrap the v0 code with no behavior change (every v0 test
  passes unchanged). Core ones are `required` (configurable, not disablable); sources, viewers and the Runs tab can
  be turned off.
- **Extension points that exist now:** `papers.source` (many), `papers.enricher` (many), `papers.embedder` (one),
  offered by `rh.papers`; `kb.viewer` (one), offered by `rh.kb`. The others in 2.0 and 2.1 (`kb.store`,
  `sweep.phase`, `fulltext`, `summarizer`, `notify`, `io`, …) are added when their second implementation arrives,
  so each point is designed against two real cases. Models and decisions reach plugins through `rh.models` and
  `rh.decisions` (the provider plugins register them).
- **Representations** stay inside `rh.papers` until v1-2 splits them out with full-text facets.
- **The UI** builds its tabs, the viewer choice and the plugin settings from contributions; external plugins bring
  tabs as custom elements. A plugin's settings change is applied live when it handles it (`onSettingsChange`),
  otherwise by restarting the plugin. An installed plugin's chat tools reach the desk from the next start.
- **"Done when" for step 1:** all v0 tests pass unchanged ✅; disabling the Obsidian viewer stops its process and
  the Library takes over ✅ (the Knowledge base tab stays, showing the active viewer); rollback restores an earlier
  lockfile ✅. Swapping the embedder re-embeds through v0's model-change path; there is one embedder plugin until
  Gemini Embedding 2 arrives in v1-2, which will exercise it.

## 3. The product loop: the Upgrades tab

> **Later (2026-10-26):** the Upgrades tab is for changes found *outside* the project (new models, methods, tools on
> the internet) and keeps its gates. Fixes the system finds in its own daily cycle (§0) do not wait for it: they are
> replayed on your judgments and applied with undo. The harness of 3.5 is built first, in `v1-2-harness`.

The hub upgrades itself through one tab and one workflow. Ideas come from the **internet** (new state-of-the-art
models, methods, tools and architectures for what the hub does), because the hub is meant for any research
theme; a project's own knowledge base is only an extra source when its theme happens to be about the hub's own
techniques (as with the current multimodal-retrieval project). **You make every decision; the agent does the
searching, testing and implementing.**

### 3.1 The workflow: four gates

| Stage | Who | What happens | Gate (you) |
|---|---|---|---|
| **1. Idea** | scout agent | An upgrade idea card: what to change, which part of the hub, why it might help (with links to the sources it found), expected benefit, effort, cost and risk | **Test it** · not now · reject (with a reason) |
| **2. Testing** | test agent | Builds or installs the candidate as a plugin variant beside the current one (never replacing it), runs it on the same inputs, scores both | (you can stop it; it has a budget) |
| **3. Proof** | test agent | A **proof report** (3.3) | **Implement** · test more (say what) · reject |
| **4. Implemented** | kernel | The variant becomes the active plugin (a commit in the plugin history, re-computation in the background if needed) | — |
| **5. Verified** | kernel | After a set time (default 7 days) the same metrics are re-measured on real use; a regression offers a one-click rollback | keep · roll back |

You can also write an idea yourself ("try Docling 3 for PDFs") or ask the research desk in chat; it lands at stage 1.
Ideas you reject are remembered with your reason, so the scout does not suggest them again, and the reasons tell
it what you value.

### 3.2 Where ideas come from (the scout)

A scheduled agent (weekly by default, or "find ideas now" in the tab) that reads the **product charter** (3.4)
and the hub's current setup (which plugin fills each slot, its measured quality and cost), then searches:

| Source | For what |
|---|---|
| **Web search** (through OpenRouter's web search, about $0.02 per search; another search provider can be a plugin) | new models and methods, release notes, benchmark leaderboards (MTEB, retrieval and document-understanding benchmarks), blog posts and comparisons |
| arXiv and the hub's own paper search | recent papers on retrieval, embeddings, document understanding, ranking, summarization, agents |
| GitHub and package releases | new versions of what the hub uses (Ignis, Docling, pi-durable, extractors) |
| Model catalogs (OpenRouter, Hugging Face) | new or cheaper models for each job |
| The project's knowledge base | only when its theme overlaps the hub's techniques |

For each slot it asks "is there something clearly better, cheaper or simpler now?", keeps only ideas with a
concrete source and a testable claim, scores them cheaply with Jev (`idea-promise`: concrete, testable, relevant to
a weak spot, not already rejected) and shows the best few (default 5) per run. Each idea cites its sources.

### 3.3 Proof: what "solid" means

A proof report answers one question: **is the candidate better than what runs now, for this hub, at acceptable
cost?** It contains:

- **What was compared:** current plugin vs candidate, versions and settings, the inputs used (this project's
  papers, notes and questions, plus public benchmarks for the slot), and the budget spent.
- **Metrics with confidence intervals** (bootstrap over items) and a verdict per metric: better, same, worse.
  The slot's harness defines the metrics (for example precision of the top cards against your judgments, note
  grounding and completeness, retrieval recall, extraction accuracy on tables and charts), plus cost per day and
  latency.
- **Side-by-side examples:** a few of the clearest wins and losses, A and B next to each other (two rankings, two
  notes, two search results, two extractions of the same table).
- **Judge verdicts:** a judge model compares pairs with positions swapped; only consistent verdicts count; the
  report shows how often it was inconsistent.
- **Your spot check:** optional votes on a handful of pairs, open or blind, which also calibrate the judge.
- **Risks and side effects:** new dependencies, licenses, data that must be re-computed, what leaves the machine.
- **A recommendation** with the reasoning, which you can accept or ignore.

"Test more" sends it back with your instructions (more items, another benchmark, a different setting).

### 3.4 The product charter

Like the research charter, a page you own, describing what "better" means for the hub: which metrics matter
(card precision, note quality, retrieval quality, extraction accuracy, cost per day), constraints (budget per day
and per test, allowed providers and licenses, what may leave the machine, RAM and GPU), and topics the scout should
watch or ignore. The scout and the test agent read it; you edit it.

### 3.5 Benchmarks (the harness)

> Decided 2026-10-26 (§0.1): the harness is core; each slot has a fixed preset; candidates are only ever compared on
> their slot's preset.

Every slot has a harness: datasets, metrics and a report generator, used by the test agent. Datasets come from
the project's history (gathered papers with Jev decisions and your judgments, ⭐ full texts, questions and
relevant notes), from labels written and relabeled by a strong model and Jev (the Gecko recipe, spot-checked), and
from public benchmarks (OfficeQA, UNIDOC-BENCH and SpanishGovernmentMultimodalQA for full-text extraction and
knowledge-base search; SciRepEval-style tasks for embedders).

### 3.6 Implementing upgrades

Most upgrades are a **plugin swap or a setting** (a different embedder, a new extractor, another model for a job,
a new Jev command version): implementing means activating the tested variant, as a commit in the plugin history.
When an idea needs new code, the **engineer agent** writes it as a plugin in a sandbox (a git worktree of the
plugin repository); it must pass the slot's contract tests before testing starts, and its code is shown in the
proof report. Agent-written code is never implemented without your approval.

### 3.7 Fine-tuning as an upgrade

Fine-tuning an embedder (an EmbeddingGemma or Qwen3-0.6B student trained on LLM- and Jev-supervised pairs over
the project's facets, plus your judgments) is one more idea type: testing it means running the training job (a
process plugin), then the same proof report against the current embedder.

## 4. The knowledge loop (as planned in PLAN.md §8, now built from plugins)

Unchanged in substance: the review reads the user's interests (judgments, reasons, chat, edits) and the field,
proposes charter changes and new research questions, and the user approves. Two refinements from this plan:

- `question-finder` strategies are plugins, so new ways of finding questions can be added, A/B tested (which
  strategy's questions does the user accept, and which lead to ⭐ papers?) and improved like anything else.
- Knowledge proposals (charter changes, research directions, taste rules) appear in the Charter tab's review
  section; product upgrades have their own **Upgrades** tab (§3). Both use the same approve / reject / roll back
  actions and the same plugin history.

---

## 5. The research project as the first real test

The current project (agents searching multimodal document collections) is the same problem the hub faces when it
reads ⭐ papers: charts, tables and scanned pages lost in text conversion. So the hub doubles as a testbed:

- `fulltext` variants are exactly the research comparison: **Docling markdown** vs **native multimodal pages
  embedded with Gemini Embedding 2** vs **hybrid** (page images plus model-written descriptions of figures).
- `kb-search` variants, exposed through **MCP**, are the research deliverable's search tool; the hub's agents (and
  outside agents such as Antigravity) can use them.
- The research benchmarks (OfficeQA, UNIDOC-BENCH, SpanishGovernmentMultimodalQA) become harness datasets, so
  every experiment the product loop runs is also a data point for the report or paper.

---

## 6. Plan of action

Each step is an OpenSpec change, built and verified like v0 (tests, an offline end-to-end, a live check, archived
before the next). Order chosen so that each step makes the next one cheaper.

| Step | Change | Delivers | Done when |
|---|---|---|---|
| **1** ✅ 2026-10-26 | `v1-0-plugin-core` | The kernel, all of v0 as built-in plugins, the Plugins tab, install with approval, rollback (§2.5) | All v0 tests pass unchanged; viewer swap and rollback work in the container |
| **2** ✅ 2026-10-26 | `v1-1-lite-daily-cycle` | **A light image** (the server bundled into one file without unused SDKs; Obsidian/Ignis as an optional add-on image; Library the default viewer; target under 300 MB). **The daily cycle as one orchestrated workflow** (sweep → cards with an exploration pick → nightly analysis slot → weekly digest), a **"What changed" feed with undo**, and the **digest page** where you read and comment | The lite image runs a project end to end; the cycle runs on its own for a simulated week offline; the digest lists every change with undo and takes comments |
| **3** ✅ 2026-10-26 | `v1-2-harness` | **Replays** of past sweeps against your judgments (train and held-out split), nDCG, precision@5, recall of ⭐ with bootstrap intervals; a **judge calibrated on your verdicts**; the Quality view. This is the preset of the Ranking slot | A change to a gate threshold is replayed and scored with an interval; the judge's agreement with your verdicts is reported |
| **4** | `v1-3-slots-and-benchmarks` | The **classification** of §0.1 in every manifest (kind, topic, benchmark); the **Plugins tab grouped by topic and kind** (core collapsed, slots with alternatives, add-ons on/off); **benchmark presets** and a runner on cached public samples (first: Embedder with SCIDOCS + LitSearch samples, Facet labeler with PubMed RCT); **usage attribution** for add-ons in the digest | The embedder and facet presets run offline on cached samples and report their metric; the Plugins tab shows the four kinds; the digest shows per-source attribution |
| **5** | `v1-4-weekly-upgrade` | The weekly upgrade of §0.2: nightly error analysis and slot choice, web search for candidates of one slot, the slot's preset on candidate vs active, settings winners applied with undo, plugin winners proposed; add-on scouting; a memory of what lost | A seeded weakness in the Ranking slot is found, a better setting is proven on held-out judgments and applied with undo; a candidate embedder is benchmarked and proposed; a new source is suggested with reasoning |
| **6** | `v1-5-knowledge-loop` | Interests from your judgments, **charter proposals** and **new research questions** in the digest (you approve) | A digest proposes a charter change with evidence; approving it creates a charter version the next sweep uses |
| **7** | later | Full text and facet vectors for ⭐ (its slot preset: OmniDocBench and the research benchmarks), the engineer agent, fine-tuning (prompt optimization first), MCP for outside agents | Planned again when the loops run |


## 7. Decisions

0. **Settled (2026-10-26, later the same day):** what may change is fixed by §0.1 (core, slots with benchmark
   presets, add-ons judged by attribution, preferences); the harness is core; the weekly upgrade (§0.2) improves
   one slot on its preset or scouts add-ons, never something chosen freely. Public benchmarks run on small cached
   samples stored per project.
0. **Settled (2026-10-26):** the goal is the daily cycle of §0 with the human on the loop. Winning fixes to the
   finding loop apply automatically with undo; charter changes, cost increases and outside upgrades wait for
   approval. Obsidian is an optional add-on; the Library is the default viewer. The image must be light. Order:
   core loop first (§6). Everything is a plugin (2.0); no hidden experiments on the live feed.
1. **Python inside the image** for process plugins (Docling, fine-tuning): not in the default image; optional
   add-on images per heavy plugin, like Obsidian.
2. **Where training runs:** decided when fine-tuning is planned again (this machine's 4 GB GPU or a rented one).
