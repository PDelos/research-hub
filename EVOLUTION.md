# Research Hub — Plugins and the Two Improvement Loops

> How the Research Hub becomes a set of installable plugins that its own agents keep improving: the **knowledge
> loop** improves *what* the project searches for and knows; the **product loop** improves *how* the hub works
> (embedders, extractors, prompts, rankers) through benchmarks, experiments and A/B tests. Humans verify; agents
> do the work. Companion to `PLAN.md` (the v0 system as built) — this file plans everything after v0.

Written 2026-10-25, after v0 was completed. Revised the same day: product upgrades run through an **Upgrades tab** where the human decides at every
gate (idea → test → proof → implement), and **the whole hub is plug-and-play**, not only the pipeline.

---

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
  One plugin is **active** per slot, others can be **installed but inactive**, or **in an experiment** (2 variants
  splitting traffic).
- **UI and CLI:** Plugins tab: list, install, enable, disable, uninstall, configure, see metrics and history.
- **Every change is a commit** in the project's own plugin repo (`$RH_DATA_DIR/plugins/`, a git repo): an audit
  trail and one-click rollback to any previous lockfile.
- **Data stays compatible:** plugins that change stored data (an embedder, a representation) declare it; the host
  re-computes in the background as v0 already does for a model change, and never mixes versions.

---

## 3. The product loop: the Upgrades tab

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
| **1** | `v1-0-plugin-core` | The kernel; extension and contribution points for every area in 2.0 and 2.1; manifests, registry, lockfile in a per-project git repo, Plugins tab, install / enable / disable / uninstall / rollback; **all of v0 refactored into built-in plugins** (including the Obsidian viewer and the UI tabs) with no behavior change | All v0 tests pass unchanged; swapping the embedder re-embeds in the background; disabling the Obsidian viewer plugin removes its tab and process; rollback restores the previous lockfile |
| **2** | `v1-1-harness` | Evaluation harness per slot; datasets from project history; LLM/Jev-labeled datasets; reports with intervals and cost; CLI and UI | The current embedder and Gemini Embedding 2 are compared on this project's data with a report |
| **3** | `v1-2-fulltext-and-facets` | ⭐ → full text (`fulltext` plugins: arXiv HTML, Europe PMC XML, PDF text, Docling as a process plugin, native multimodal pages); facet summaries; full-text notes; junk-abstract repair; Gemini Embedding 2 as an `embedder` plugin | Notes of ⭐ papers fill all sections from full text; the harness compares the `fulltext` variants on the research benchmarks |
| **4** | `v1-3-knowledge-loop` | Review, interests, charter proposals, new research questions (`question-finder` plugins), proposals inbox | A review proposes charter changes and research directions with evidence; approving one creates a charter version the next sweep uses |
| **5** | `v1-4-upgrades` | The Upgrades tab and its workflow (idea → test → proof → implement → verify, your decision at each gate); the scout with web search through OpenRouter, arXiv, release feeds and model catalogs; the test agent running candidates beside the current plugins; proof reports (metrics with intervals, side-by-side examples, pairwise judge with swapped positions, your spot checks); implementing as a plugin swap; verification after 7 days with rollback; the product charter | The scout suggests a real upgrade from a web source, you ask for a test, the proof report compares it with the current plugin on this project's data, you implement it, and it can be rolled back |
| **6** | `v1-5-engineer` | The engineer agent writing new plugin code for ideas that need it, in a sandbox, with contract tests, shown in the proof report | An idea that needs a new source or ranker is built by the agent, tested, proven and implemented on your approval |
| **7** | `v1-6-fine-tuning` | Embedder fine-tuning with LLM and Jev supervision as an upgrade type (training as a process plugin) | A fine-tuned student goes through test and proof against the current embedder |
| **8** | `v1-7-mcp` | Hub tools as an MCP server for outside agents; MCP servers installable as plugins | An outside agent searches the project's knowledge base through MCP |

Steps 1–3 also make the research project's experiments runnable inside the hub; steps 4–8 add the autonomy.

## 7. Decisions to confirm

0. **Settled:** product upgrades go through the Upgrades tab with your decision at every gate (idea → test →
   proof → implement); ideas come from the internet first; no hidden A/B tests. Everything is a plugin, including
   the knowledge-base viewer and the UI (2.0). The Knowledge base tab opens as a graph.
1. **Order:** plugin core first (recommended, since everything after is a plugin) vs. the knowledge loop first.
2. **Default autonomy:** everything waits for approval at first; later the human can allow auto-adoption per slot
   (suggested first candidates: config plugins with a significant win within budget).
3. **Python inside the image** for process plugins (Docling, fine-tuning): adds about 1–1.5 GB to the image; the
   alternative is optional sidecar images per heavy plugin.
4. **Where training runs:** on this machine's GPU (Quadro P2000, 4 GB: enough for a 300M student, slowly) or a
   rented GPU for occasional jobs.
