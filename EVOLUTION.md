# Research Hub — Plugins and the Two Improvement Loops

> How the Research Hub becomes a set of installable plugins that its own agents keep improving: the **knowledge
> loop** improves *what* the project searches for and knows; the **product loop** improves *how* the hub works
> (embedders, extractors, prompts, rankers) through benchmarks, experiments and A/B tests. Humans verify; agents
> do the work. Companion to `PLAN.md` (the v0 system as built) — this file plans everything after v0.

Written 2026-10-25, after v0 was completed.

---

## 1. The idea in one picture

```
                         ┌──────────────── human: approve / reject / roll back ────────────────┐
                         ▼                                                                     │
  KNOWLEDGE LOOP   charter ──► sweeps ──► cards ──► 👎/👍/⭐ ──► knowledge base ──► review ──┘
  (what to know)      ▲                                                              │
                      └──────── charter proposals · new research questions ◄─────────┘

  PRODUCT LOOP     product charter ──► scout (web, arXiv, GitHub, HF) ──► ideas ──► experiments
  (how to work)        ▲                                                                │
                       │          plugin variants ──► contract tests ──► benchmarks ──► A/B
                       └──────── adoption proposals with evidence ◄─────────────────────┘
```

Both loops end in the same place: a **proposal with evidence** that a human approves in one click (or that an
auto-approve policy accepts, if the human allowed it for that kind of change), applied deterministically and
reversible with one click.

---

## 2. Everything is a plugin

### 2.1 Slots (extension points)

The hub's pipeline becomes a fixed set of **slots**; every behavior that fills a slot is a **plugin**. The v0 code
is refactored into the first (built-in) plugins without changing behavior.

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

### 2.2 What a plugin is

A plugin is a folder with a **manifest**:

```yaml
id: embedder.gemini-embedding-2          # slot.name
version: 1.2.0
slot: embedder
kind: config | code | process            # see 2.3
description: Gemini Embedding 2 through OpenRouter, 1024 dims, task instructions per facet
config: { model: google/gemini-embedding-2, dims: 1024 }   # validated against the slot's config schema
permissions:
  network: [openrouter.ai]               # nothing else is reachable
  llm_budget_usd_per_day: 0.10
  files: [read: vault]                    # default: none
provides: [embed(texts, task) -> vectors]
tests: tests/                             # must pass the slot's contract tests + its own
metrics: [retrieval@k, facet-agreement, cost, latency]   # what its slot's harness measures
```

### 2.3 Three kinds of plugins, three levels of trust

| Kind | Examples | Runs | Risk |
|---|---|---|---|
| **config** | prompts, Jev commands, thresholds, rank weights, model choices | data read by the host | low: no code |
| **code** | a new ranker, a new source client | TypeScript module in a worker with Node's permission model (only its declared files and hosts; secrets never visible, LLM and HTTP calls through host clients that enforce budgets) | medium |
| **process** | Docling (Python), a local embedder, a fine-tuning job, an MCP server | a child process speaking **MCP over stdio**, supervised like the Ignis viewer, with the same declared limits | medium–high |

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

## 3. The product loop: experiments, benchmarks, A/B tests

### 3.1 The product charter

Like the research charter, a page the human owns, describing **what "better" means for the product**:

- **Goals and metrics:** precision@5 of sweeps, share of ⭐ among cards, note quality (grounding, completeness),
  retrieval quality in the knowledge base, extraction accuracy on full texts, cost per day, latency.
- **Constraints:** budget per day and per experiment, allowed providers and licenses, privacy (what may leave the
  machine), resource limits (RAM, GPU).
- **Autonomy policy:** per slot and per kind, what may be adopted automatically (for example: config plugins that
  win significantly, cost within budget) and what always needs a human.
- **Idea backlog:** ideas from the human, the scout and the review, each with status.

### 3.2 The scout

A scheduled agent (weekly, configurable) that reads the product charter and searches for improvements: the web,
arXiv (with the hub's own paper search), GitHub releases of used tools (Ignis, Docling, pi-durable), Hugging Face
and MTEB leaderboards, OpenRouter's model lists. It writes **ideas**: what, why it might help which metric, effort,
risk, cost. Jev ranks them cheaply (`idea-promise`); the top ones become **experiment plans** automatically: which
plugin variant to build or install, which benchmark, how much budget. Examples it should find on its own:
"Gemini Embedding 2 is GA on OpenRouter; test it as `embedder`", "Docling 3 released; test it as `fulltext`".

### 3.3 Benchmarks (offline evaluation)

Every slot has a **harness**: datasets, metrics and a report. Datasets come from three places:

| Source | Example datasets |
|---|---|
| **The project's own history** (the most important) | gathered papers with Jev decisions and the user's judgments (gate and ranking quality); ⭐ papers' full texts (extraction and summary quality); questions → relevant notes (retrieval); method/problem pairs labeled by an LLM and Jev (facet quality) |
| **LLM- and Jev-supervised labels** | pairs and queries generated and relabeled by a strong model (the Gecko recipe), spot-checked by a second model |
| **Public benchmarks** | OfficeQA, UNIDOC-BENCH, SpanishGovernmentMultimodalQA for `fulltext` and `kb-search` (the research project's benchmarks), SciRepEval-style tasks for `embedder` |

Results carry confidence intervals (bootstrap over items) and cost; a variant "wins" only with a minimum effect
size and no guardrail regression (cost, errors, latency).

### 3.4 Online experiments (A/B with the human's real use)

| Slot type | Method | Signal |
|---|---|---|
| ranking (sweep, cards) | **interleaving**: the feed mixes candidates from variant A and B, the user does not know which is which | judgments → precision per variant |
| writing (card-writer, librarian, summarizer) | **shadow mode**: both run, the user sees one; a judge model compares blind; occasionally the user is asked "which note is better?" | pairwise preference |
| infrastructure (embedder, fulltext, kb-search) | **shadow mode** on real traffic | harness metrics on live data |

Experiments have budgets, a maximum duration and **guardrails** (stop automatically on errors, cost spikes or a
precision drop).

### 3.5 Adoption

An experiment ends with an **adoption proposal**: the metrics with intervals, cost difference, example
differences (two notes side by side, rankings before and after), risks. The human approves, rejects or extends;
the autonomy policy may adopt low-risk winners automatically and only notify. Adoption updates the lockfile
(a commit), triggers background re-computation if needed, and keeps the previous version one click away.
Regressions after adoption roll back automatically and are reported.

### 3.6 Agent-written plugins

An **engineer** agent can create a new plugin version itself: a prompt variant, new config, a modified ranker, a
new source client. It works in a sandbox copy (a git worktree of the plugin repo), must pass the slot's contract
tests and its own tests, then the harness; only then can it become an experiment. Code written by an agent is
never adopted without a human, whatever the autonomy policy says, unless the human explicitly allows it for
that slot.

### 3.7 Fine-tuning as a plugin

The embedding fine-tune (an EmbeddingGemma or Qwen3-0.6B "student" trained on LLM- and Jev-supervised pairs over
the project's facets, plus the user's judgments) is a **process plugin**: a training job that produces a new
`embedder` version, which then goes through the same harness and A/B as anything else. It runs only when enough
data exists and only if its harness predicts a gain worth the cost.

---

## 4. The knowledge loop (as planned in PLAN.md §8, now built from plugins)

Unchanged in substance: the review reads the user's interests (judgments, reasons, chat, edits) and the field,
proposes charter changes and new research questions, and the user approves. Two refinements from this plan:

- `question-finder` strategies are plugins, so new ways of finding questions can be added, A/B tested (which
  strategy's questions does the user accept, and which lead to ⭐ papers?) and improved like anything else.
- The review and the scout share one **proposals inbox** in the UI: charter changes, research directions, taste
  rules, plugin adoptions, all with evidence and the same approve / reject / roll back actions.

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
| **1** | `v1-0-plugin-core` | Slots, manifests, registry, lockfile in a per-project git repo, Plugins tab, install / enable / disable / uninstall / rollback; **v0 refactored into built-in plugins** with no behavior change | All v0 tests pass unchanged; swapping the embedder plugin re-embeds in the background; rollback restores the previous lockfile |
| **2** | `v1-1-harness` | Evaluation harness per slot; datasets from project history; LLM/Jev-labeled datasets; reports with intervals and cost; CLI and UI | The current embedder and Gemini Embedding 2 are compared on this project's data with a report |
| **3** | `v1-2-fulltext-and-facets` | ⭐ → full text (`fulltext` plugins: arXiv HTML, Europe PMC XML, PDF text, Docling as a process plugin, native multimodal pages); facet summaries; full-text notes; junk-abstract repair; Gemini Embedding 2 as an `embedder` plugin | Notes of ⭐ papers fill all sections from full text; the harness compares the `fulltext` variants on the research benchmarks |
| **4** | `v1-3-knowledge-loop` | Review, interests, charter proposals, new research questions (`question-finder` plugins), proposals inbox | A review proposes charter changes and research directions with evidence; approving one creates a charter version the next sweep uses |
| **5** | `v1-4-experiments` | Shadow mode, interleaving A/B, guardrails, adoption proposals, auto-rollback, autonomy policy | An A/B of two ranker configs runs on the real feed and ends in an adoption proposal |
| **6** | `v1-5-product-charter-and-scout` | Product charter page, scout agent (web, arXiv, GitHub, HF), ideas → experiment plans automatically | The scout finds a real improvement idea and turns it into an experiment without help |
| **7** | `v1-6-engineer-and-fine-tuning` | Engineer agent writing plugin variants in a sandbox; supervised fine-tuning job as a process plugin | An agent-written prompt variant and a fine-tuned embedder each go through tests, harness and A/B to a proposal |
| **8** | `v1-7-mcp` | Hub tools as an MCP server for outside agents; MCP servers installable as plugins | An outside agent searches the project's knowledge base through MCP |

Steps 1–3 also make the research project's experiments runnable inside the hub; steps 4–8 add the autonomy.

## 7. Decisions to confirm

1. **Order:** plugin core first (recommended, since everything after is a plugin) vs. the knowledge loop first.
2. **Default autonomy:** everything waits for approval at first; later the human can allow auto-adoption per slot
   (suggested first candidates: config plugins with a significant win within budget).
3. **Python inside the image** for process plugins (Docling, fine-tuning): adds about 1–1.5 GB to the image; the
   alternative is optional sidecar images per heavy plugin.
4. **Where training runs:** on this machine's GPU (Quadro P2000, 4 GB: enough for a 300M student, slowly) or a
   rented GPU for occasional jobs.
