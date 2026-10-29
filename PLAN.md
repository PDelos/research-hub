# Research Hub — Detailed Design & Build Plan

> A self-hosted research assistant. **One container = one research project (one theme)**; a new theme is a
> new container. Each has its own **proactive durable agent** that sweeps for papers every day, uses **Jev to make almost every
> decision**, presents a few paper cards, learns from your 👎/👍/⭐ + reasons, and grows an
> Obsidian-compatible **knowledge base** from the papers you approve. Every week it reviews its own
> performance and what you have shown interest in, and **proposes improvements, charter updates and new
> research questions that you approve**: the charter evolves with you and with the field.
>
> **Built from plugins, like VS Code** (from v1): a small kernel and plugins for everything else (paper sources,
> embedders, agents, UI tabs, the knowledge-base viewer), each with a declarative manifest, lazy activation and
> extension points, installable, swappable and removable per project. See **[EVOLUTION.md](EVOLUTION.md)**.
>
> Field focus: **AI + bioinformatics (neural networks)**. Runs on your own machine or server, **one Docker
> container per project**, everything (including the Obsidian knowledge-base viewer) inside it.

Last updated: 2026-10-29 (v0 and v1 complete, v1-0 to v1-9; next: review, real use, shipping). This is the original
design document; where the built system differs, *As built* notes say so, and README.md describes the hub as it is.
The direction since v1 and every decision are in EVOLUTION.md; trust, relations and curriculum are v2.

---

## 0. Where this comes from

### Lessons from the two videos (IndyDevDan)

| Idea | How we apply it |
|---|---|
| **Proactive agent = durable agent + trigger + sandbox** | pi-durable agent + a scheduler tick + the project's Docker container |
| "Doesn't wait for you to work. Works for you, then waits." | Daily sweep runs without you; cards wait for your review |
| **In → near → out of the loop** | You stay *near* the loop: approve KB additions and proposals, never drive sweeps by hand |
| **The agent decides, the task runs** | Deterministic, checkpointed durable task (gather/gate/dedupe/rank) + the agent for judgment (what to read, how to present) |
| **Jev at every gate**, the LLM only sees what survives | ~15 Jev commands (§5); the main model touches only the top few papers |
| **Data flywheel**: votes + labels tune the system | 👎/👍/⭐ + reason → weights, few-shot examples, taste rules, calibration |
| **Two-way prompting** (`ask_taste`) | Agent asks you when Jev is uncertain or signals conflict |
| **Custom tools only** (no bash/file tools) | Paper-specific toolset (§6) |
| **Detached clients** (browser, TUI, CLI on one API) | API + SSE stream; browser first, CLI later |
| **Tokenomics**: model spend is mostly the agent re-reading its chat | Compaction, short sweep prompts, Jev for bulk judgments, cheap model for routine turns |
| Shared state, durable jobs with phases, live tool changes, forking | Used for sweeps, reviews, read-only mode during review |

### Reference code (all MIT)

| Repo | What we take |
|---|---|
| [`disler/pi-durable-news-agent`](https://github.com/disler/pi-durable-news-agent) | **Vendor `durable-agent` + `jev` packages; reference for the rest.** Sweep task, Jev package (client, commands-as-JSON, policy, ledger), `durable-agent` package (harness, models, compaction, subagents, observability), taste/feedback logic, schedule, SSE, Vue client, faux-model + mock-Jev tests, crash-recovery test |
| [`disler/durable-pi`](https://github.com/disler/durable-pi) | App-state, durable jobs, multi-client patterns, pi docs (`ai_docs/`) |
| [`disler/ten-levels-of-jev`](https://github.com/disler/ten-levels-of-jev) | `hyper-jev` skill: question design, confidence gates, model routing, production checks |
| [`earendil-works/pi`](https://github.com/earendil-works/pi) `packages/durable` | pi-durable 1.1.0: `Harness`, `defineTask`, `defineTool`, `defineExtension`, SQLite storage |
| [`kepano/obsidian-skills`](https://github.com/kepano/obsidian-skills) | Obsidian markdown / Bases rules for the librarian agent |
| [LLM-wiki for papers (gist)](https://gist.github.com/joonan30/cbce305684d079dbe9a3fbaefe4e3959) | Vault layout: one evidence note per paper, concepts, questions, "not ingested until connected", BM25-first search |

**Decision: fresh repo, vendor two packages.** Copy `durable-agent` and `jev` (≈2.6K lines, the
hardest and best-tested parts) with their tests; copy single infra files (SSE, auth, idempotency,
telemetry projector, recovery test) as starting points; write our own server, SDK, UI and schema for one project
per container. A full fork was rejected after measuring it: ~70% of its code (news domain 9.2K lines, news UI,
TUI/CLI/cron 3.9K) would be deleted or rewritten, and it assumes ssh-deployed devices.
Pinned in v0: `@earendil-works/pi-durable`, `pi-ai`, `chord` **1.1.0**; Express 5; Vue 3 + Vite; Node 24.

**Stack (re-checked 2026-10-25, applied in v1-0):** Node **26** LTS (LTS from 2026-10-28; Node 24 is in
maintenance since 2026-10-20) · **Vite+ 1.x** (`vp`: one CLI and one config for the dev server and build (Vite 8),
tests (Vitest 5), linting (Oxlint), formatting (Oxfmt) and task caching) · TypeScript **6.0** (TypeScript 7's native
compiler has no API for Vue's type checker yet; move to 7.1 when it is stable and `vue-tsc` supports it, a first
candidate for the Upgrades tab) · Vue **3.5** + Vue Router **5** + Pinia **4**, Web Components for plugin UIs ·
Playwright **1.64** for UI tests · Express **5.3** · pi-durable, pi-ai, chord **1.4.0** (from 1.1.0, upgraded with
the recovery tests) · sqlite-vec 0.1.9 · isomorphic-git and ajv for the plugin system.
pi-durable is experimental — all direct usage stays inside `packages/durable-agent`.

---

## 1. Concepts

| Term | Meaning |
|---|---|
| **Research Hub ("hub")** | The app. One running container serves exactly one project |
| **Project** | One theme = one container: its own agent, data folder, vault, schedule, weights, port and name |
| **Brief** | Your document describing the project idea (markdown upload) |
| **Charter** | Agent-drafted, you-approved: research questions (Q1..Qn), concepts, sub-areas, search queries, out-of-scope |
| **Level** | Curriculum stage: `foundational → core → advanced → frontier` |
| **Sweep** | Daily run: gather → gate → … → cards |
| **Candidate** | A paper found by a sweep, before it becomes a card |
| **Card** | A presented paper: 3 scores + level + relations + summary |
| **Judgment** | Your 👎 / 👍 / ⭐ + optional reason paragraph |
| **KB / Vault** | Obsidian-compatible markdown wiki of ⭐ papers + concepts + questions + directions |
| **Proposal** | A change the agent wants (rule, query, weight, level, direction…). Needs your approval |
| **Review** | Weekly self-improvement run that produces proposals |
| **Kernel** | The small core (from v1): plugin loading, lockfile, storage, secrets and budgets, agent runtime, scheduling, HTTP with its guard, proposals inbox |
| **Plugin** | Everything else, VS Code style: an `rh-plugin.json` manifest (`engines`, `activationEvents`, declarative `contributes`, `dependencies`, `permissions`), `activate(context)`/`deactivate()`, an optional exported API |
| **Extension point** | A named place where plugins contribute (e.g. `papers.source`, `kb.viewer`, `tabs`), owned by the plugin that offers it |
| **Upgrade** | A change to the hub itself, in the Upgrades tab: an idea (found on the internet) → you ask for a test → the agent tests it beside the current plugin → a proof report → you ask to implement → verified after 7 days, one-click rollback |

---

## 2. Architecture

```
┌──────────────── Docker container: rh-<name>  (one per project, own port, own /data) ─────────────────┐
│                                                                                                      │
│  Browser (Vue 3) at <name>.localhost:<port>  ◄── REST + SSE ──►  rh-server (Node 26, Express 5)       │
│                                                ├─ static UI + token-holding proxy (no key in page)  │
│                                                ├─ /kb/ proxy ──► Ignis (bundled child process,       │
│                                                │                 loopback only, supervised)          │
│                                                ├─ ticker: every 60 s → due slots → request runs      │
│                                                ├─ pi-durable Harness (agent.sqlite)                  │
│                                                │   ├─ agent: research-desk (root, chat)              │
│                                                │   ├─ conversation: charter-writer                   │
│                                                │   ├─ subagents: paper-reader, librarian, reviewer   │
│                                                │   └─ tasks: rh.sweep, rh.review, rh.ingest          │
│                                                ├─ Jev client (OpenRouter) + ledger                   │
│                                                ├─ Paper sources (arXiv, OpenAlex, EuropePMC, bioRxiv)│
│                                                └─ Vault indexer (FTS5) + file watcher                │
│                                                                                                      │
│  /data (volume, owned via .owner lock)                                                               │
│   ├─ brief.md                                                                                        │
│   ├─ agent.sqlite        pi-durable: conversations, tasks, checkpoints                               │
│   ├─ project.sqlite      app tables, metadata cache, sqlite-vec embeddings, FTS5 index               │
│   ├─ fulltext/<id>.md    extracted full texts (L2)                                                   │
│   ├─ vault/              Obsidian vault (the KB, source of truth) + .obsidian/ hub theme             │
│   └─ kb-viewer/          Ignis settings + the Obsidian app it downloads once (~200 MB)               │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘

Another theme = another container (rh-genomics on :4860 with its own /data). Containers never talk to each other.
```

**From v1: kernel + plugins** (EVOLUTION.md §2). The boxes above become plugins around a small kernel:

```
 kernel ─ plugin loader + lockfile (data/plugins, git) · rh API (db, files, settings, secrets, http, models,
          decisions, agents, scheduler, events, processes, ui, proposals) · HTTP + guard · pi-durable runtime
   │
   ├─ rh.provider-openrouter   models.provider        ├─ rh.papers        offers papers.source, papers.enricher
   ├─ rh.decision-jev          decision.engine        │    ├─ rh.source-arxiv / -openalex / -europepmc / -s2
   ├─ rh.desk                  agent + chat tools     ├─ rh.representations   offers papers.embedder
   ├─ rh.charter               agent + Charter tab    │    └─ rh.embedder-openrouter (Qwen3 → Gemini Embedding 2)
   ├─ rh.schedule              scheduler slots        ├─ rh.sweep         offers sweep.phase; Feed tab, Runs
   ├─ rh.feedback              judgments, weights     └─ rh.kb            offers kb.store, kb.viewer; Library tab
   └─ rh.settings-ui           Settings tab                └─ rh.viewer-obsidian   kb.viewer (Ignis) + Knowledge base tab
```

Two SQLite files, as in the news agent: **`agent.sqlite` belongs to pi-durable**,
**`project.sqlite` belongs to the app**. A projector copies agent telemetry (tool calls, tokens,
costs) into `project.sqlite`. Clients only read through the API.

**Scheduling:** an in-process ticker runs every 60 seconds and records due slots in `scheduled_runs` with a
unique `(kind, slot)` key, so a restart or a double tick never starts a second sweep. Defaults: **sweep daily
at `RH_SWEEP_TIME`** (06:00; `new-project.sh` staggers projects 20 minutes apart), **review Sundays at
07:00**, both editable. Docker `restart: unless-stopped` +
pi-durable checkpoints mean an interrupted sweep resumes from its last phase.

---

## 3. Project lifecycle

```
1. ./new-project.sh proteins  ──► folder, .env, free port, compose name rh-proteins, staggered sweep time
2. docker compose up -d        ──► open http://proteins.localhost:4850
3. Paste or upload brief.md    ──► charter-writer drafts the CHARTER + up to 5 scoping questions
4. Answer, edit, approve       ──► charter v1; status active
5. Level = foundational. First sweep runs in ORIENTATION mode.
6. Daily: sweep → cards → you judge → ⭐ ingested into the vault (read/edit it in the Knowledge base tab)
7. Weekly: review → proposals → you approve/reject
8. Pause any time (no scheduled runs, data kept); stop or remove the container to end the project
```

---

## 4. The daily sweep (`rh.sweep`, durable task)

Same structure as `dna.news-sweep`: every phase commits a checkpoint; failures retry with durable
backoff (30 s, 2 min, 8 min); a crash resumes mid-phase and **never pays Jev twice** for an item
already judged (results stored on the candidate row).

| # | Phase | Who | What happens |
|---|---|---|---|
| 1 | **plan** | code + Jev | Pick this sweep's query bag: weighted draw from charter queries (news-agent `planQueries`), plus level-specific modifiers (§9). Add **citation-chase seeds**: references and citing papers of ⭐ KB papers (OpenAlex); S2 recommendations only if `S2_API_KEY` |
| 2 | **gather** | code | arXiv (cs.LG, cs.AI, q-bio.*), OpenAlex search + citation graph, Europe PMC, bioRxiv (Semantic Scholar optional). Window: new since last sweep for frontier; any age for foundational/core |
| 3 | **dedupe-id** | code | Normalize IDs (DOI, arXiv id, PMID/PMCID, OpenAlex id). Merge versions. Drop already-carded / judged / in-KB papers |
| 4 | **gate** | **Jev** | `on-theme` + `paper-kind` + `worth-reading` on title + abstract. Chunks of 10, 5 in parallel. Below thresholds → rejected (kept for stats). Review band → kept but flagged |
| 5 | **enrich** | code | For survivors: OpenAlex + Crossref metadata (venue, citations, year, authors, refs, OA PDF, retraction flag) and one embedding from the configured OpenRouter embedding model. Cached for 7 days in `project.sqlite` |
| 6 | **trust** | code + **Jev** | Deterministic signals (§7) + Jev `trust-read` on abstract (+ full text if available). Reference verification sample |
| 7 | **level** | **Jev** | `level` score → foundational/core/advanced/frontier + `prereq-heavy` |
| 8 | **relate** | sqlite-vec + **Jev** | Shortlist 8 nearest KB papers by embedding; Jev `relation` (one question per pair via `each`) → typed edges. Empty KB → relate to charter questions instead |
| 9 | **dedupe-story** | **Jev** | `same-work` for near-duplicates the IDs missed (preprint vs journal version, companion papers) |
| 10 | **rank** | **Jev** + code | Jev `importance` (given level, weights, taste examples) × level fit × source weight × freshness. Top N (default 7, 1–15) become candidates |
| → | **agent** | research-desk | Receives the ranked list (one line each). Sends `paper-reader` subagents (≤3) to the top items with full text available; writes each card with `present_paper`; asks you via `ask_user` when Jev flagged conflict; `complete_sweep` last |

**Main-model budget per sweep:** ~1 agent turn per card + ≤3 reader subagents. Everything
above the line is code + Jev.

---

## 5. Jev in the middle — every decision it makes

Jev ("System One") answers bounded questions: **`noul`** (yes/no probability), **`choice`**
(≤255 options), **`score`** (2–10 ordered levels). Commands live as versioned JSON in
`prompt_engineering/jev/<command>/command.json` (news-agent format: `state`, `questions`, `policy`,
optional `each`). Independent questions about the same input go in **one call**. Every call goes
through the ledger (cost, model, command version, raw payload) and is stored with the decision.

### 5.1 Commands

| Command | Stage | Questions (type) | Decision in code | Replaces |
|---|---|---|---|---|
| `on-theme` | gate | `relevance` (score 5: unrelated → core to a heavily weighted question) · `matched_question` (choice: Q1..Qn + `none`) | reject < `relevance_min`; review band flagged | LLM relevance read of every abstract |
| `paper-kind` | gate | `kind` (choice: survey, review, tutorial, method, application, benchmark, dataset, tool/software, position, theory, other) | curriculum routing; surveys boosted at foundational | LLM classification |
| `worth-reading` | gate | `worth` (noul) · `novelty` (score 4) | reject < `worth_min` | LLM triage |
| `trust-read` | trust | `overclaim` (score 4: claims match results → claims far beyond results) · `methods_described` (noul) · `generic_text` (noul: vague, templated, no specific results — AI-slop signal) · `code_or_data` (noul) · `limitations_stated` (noul) | combined with deterministic signals (§7) | LLM trust review |
| `level` | level | `level` (score 4: foundational → frontier) · `prereq_heavy` (noul) | sets card level; "Read first" lookup if prereq_heavy | LLM difficulty judgment |
| `relation` (`each` over shortlisted KB papers) | relate | `relation` (choice: extends, applies-to-new-domain, same-problem-other-method, supports, contradicts, prerequisite-of, builds-on, unrelated) · `strength` (score 3) | edges with type + strength; only strong ones shown on card | LLM pairwise comparison (the most expensive step otherwise) |
| `same-work` | dedupe | `same` (noul) · `adds` (noul: new results vs other version) | merge or attach as version | LLM dedupe |
| `importance` | rank | `importance` (score 4: skip → read today) | rank score | LLM ranking |
| `claim-support` (`each` over claims) | reader subagent | `supported` (noul) | reader reports only supported claims; review band → "unverified" tag | LLM self-checking |
| `ask-user` | agent | `conflict` (noul: high relevance but low trust, or scores disagree with taste examples) | agent calls `ask_user` instead of guessing | LLM deciding when to ask |
| `reason-parse` | feedback | `reason_kind` (choice: off-topic, too-basic, too-advanced, low-trust, already-known, great-method, great-foundation, opens-direction, other) · `generalizable` (noul: states a rule that applies to future papers) | nudges weights; **only `generalizable=true` escalates to the LLM** to draft a taste-rule proposal | LLM reading every reason |
| `chat-route` | chat | `route` (choice: kb-lookup, feed-steer, feedback, plan-or-synthesis, small-talk) · `hard` (noul) | Haiku for simple routes, Sonnet for plan/synthesis or `hard` | Always using the big model |
| `link-candidate` (`each` over KB pairs) | review | `bridge` (noul: A's method/result could address B's open question) · `already_linked` (noul) | **only top pairs** go to the LLM to write a research direction | LLM scanning all pairs |
| `proposal-evidence` | review | `sufficient` (noul: the evidence supports this change) | drafts without evidence are dropped before you see them | LLM self-critique |
| `level-ready` | review | `ready` (noul: your reasons show command of the current level) | triggers a level-up proposal | LLM judgment |
| `interest-topic` (`each` over chat turns and reasons) | review | `topic` (choice over charter questions + `new`) · `strength` (score 3) | uncovered strong topics become charter-proposal candidates | LLM reading the chat history |
| `idea-promise` (`each` over upgrade ideas) | upgrades (scout) | `concrete` (noul: names a specific model, method or tool with a source) · `testable` (noul: can be measured on this hub's data or a public benchmark) · `weak_spot` (score 3: targets a slot that measures poorly or costs much) · `already_rejected` (noul) | only the best few (default 5) per scout run become idea cards | LLM triage of everything found |
| `question-promise` (`each` over candidate questions) | review | `specific` (noul) · `answerable` (noul: literature can address it) · `covered` (noul: an existing question already covers it) · `fit` (score 3: fits your level) | only the top 3–5 reach the review model | LLM brainstorming over everything |

All commands receive `taste_examples` (your recent judgments: title, verdict, **short reason**) and
`taste_rules` (approved rules) in `state` — the news agent's few-shot pattern, extended with reasons.

### 5.2 Policy & safety

- Thresholds live in each command's `policy` block, versioned with it. Bump `version` when a question changes.
- Every `noul` has a **review band** (e.g. 0.4–0.7) → flag, escalate, or ask you. Never auto-accept the middle.
- Jev never authorizes side effects: KB writes and setting changes go through tools + approvals.
- Paper text is treated as data, never instructions (stated in every instruction, as in `same-story`).
- **Calibration**: the weekly review compares Jev's gate/importance decisions with your actual
  judgments and proposes threshold changes (e.g. "`relevance_min` 0.45 → 0.55: 0 of 31 papers in 0.45–0.55 were starred").
- Fallback when Jev is down: sweep phase retries with backoff, then fails visibly. No silent switch to another provider.
- Later experiment (proposal-gated): fine-tune local **Laya** on the judgment log and A/B it against Jev.

### 5.3 What the main LLM still does (and only this)

| Job | When | Model |
|---|---|---|
| Draft charter from brief | Once per project | Sonnet 5.5 |
| Sweep orchestration + write cards (summary, why, relation sentence) | Daily, top ~7 | Haiku 5.5 |
| Paper-reader subagents (full text → findings, claims) | Daily, ≤3 | Haiku 5.5 |
| Librarian: write evidence note + connect it on ⭐ | Per ⭐ | Haiku 5.5 |
| Weekly review synthesis, research directions, taste-rule drafts | Weekly | Sonnet 5.5 |
| Chat | On demand, routed by `chat-route` | Haiku 5.5 or Sonnet 5.5 |

Models, embeddings and Jev all via **OpenRouter** (one key; switch models by config). Verified on
OpenRouter 2026-10-22:

| Job | Model ID | Price per M tokens (in / out) |
|---|---|---|
| desk, reader, librarian, simple chat | `anthropic/claude-haiku-5.5` | $0.10 / $0.50 (`:batch` $0.05 / $0.25) |
| charter, weekly review, directions, hard chat | `anthropic/claude-sonnet-5.5` | $2.00 / $10.00 (`:batch` $1 / $5) |
| embeddings (all papers) | `qwen/qwen3-embedding-8b` (default, configurable) | $0.01 in |
| Jev | `typesafe/jev-1.14` (pinned; `~typesafe/jev-latest` only if chosen) | ~$0.042 in, output free |

OpenRouter adds a 5.5% fee on credit purchases. `:batch` variants exist for non-urgent work (a later
cost lever). Jev runs on OpenRouter's **Decisions API, marked alpha**; inputs above ~32 KB switch Jev to a
slower, less accurate long-context mode, so Jev only ever sees title/abstract-sized text (≤ 30,000 bytes).

---

## 6. Agents & tools

| Agent | Role | Tools (`allowOnly` enforced) |
|---|---|---|
| **research-desk** (root, per project) | Runs sweeps, writes cards, talks to you | `run_paper_sweep`, `list_candidates`, `read_paper`, `research_papers` (spawns readers), `jev_classify`, `present_paper`, `ask_user`, `query_kb`, `search_kb`, `card_feedback`, `edit_query`, `edit_source_weight`, `propose_change`, `set_schedule`, `complete_sweep` |
| **paper-reader** (subagent) | Reads full text, extracts claims/method/results, checks claims with Jev | `read_paper`, `read_full_text`, `jev_classify`, `report_findings` |
| **librarian** (subagent, on ⭐) | Writes the vault evidence note, connects it to ≥1 concept/question page | `read_paper`, `read_full_text`, `search_kb`, `kb_write_source`, `kb_upsert_concept`, `kb_upsert_question`, `kb_link` |
| **reviewer** (subagent, weekly, read-only on settings) | Metrics, calibration, interests, charter proposals, new research questions, proposals | `review_metrics`, `interest_report`, `question_candidates`, `similar_papers`, `jev_classify`, `query_kb`, `search_kb`, `propose_change`, `propose_charter_change`, `propose_research_direction` |
| **scout** (v1-4, weekly or on demand; built as the `rh.upgrades` plugin's web research, not a separate agent) | Finds upgrade ideas for the hub on the internet | `web_search` (OpenRouter), `search_papers`, `release_feeds`, `model_catalog`, `plugin_status`, `jev_classify`, `propose_idea` |
| **tester** (v1-4, on your request; built as the slot benchmark presets of `rh.harness`, not a separate agent) | Runs an idea's candidate beside the current plugin and writes the proof report | `install_variant`, `run_harness`, `judge_pairs`, `sample_examples`, `write_proof_report` |
| **engineer** (v1-5, on your request) | Writes plugin code when an idea needs it, in a sandbox | `read_plugin`, `write_plugin_files`, `run_contract_tests` (sandboxed worktree only) |

**Built in v0** (the names above are the full plan; v0 shipped a subset): research desk `search_papers`,
`recent_cards`, `judge_card`, `search_kb`, `query_kb`; card writer `list_candidates`, `present_paper`,
`complete_sweep`; librarian `write_evidence_note`, `link_note`; charter writer `save_charter_draft`,
`ask_scoping_questions`. From v1-0 every agent and tool is contributed by a plugin.

Tool rules (from the news agent): `replay: "safe"` where re-running is harmless; anything that
creates a card, subagent, task or KB note runs **once per tool task** (`onceInCommit`), so a
replay finds the same object instead of creating a second one.

---

## 7. Scoring — three scores + level

Each score is 0–100 with a **one-line reason** built from its strongest signals.

| Score | Inputs | Formula (initial, tuned by review) |
|---|---|---|
| **Relevance** | Jev `on-theme.relevance`, matched question weight, embedding similarity to KB/charter, level fit | `0.5·jev + 0.2·similarity + 0.2·question_weight + 0.1·level_fit` |
| **Trust** | Deterministic: peer-reviewed venue (field-aware: preprints not penalized much in cs), citation velocity (citations / years), code/data link, retraction (hard veto), reference verification ratio, author h-index (light). Jev: `overclaim`, `methods_described`, `generic_text`, `limitations_stated` | weighted sum; retraction → card blocked; failed reference verification → ⚠️ |
| **Value** | Jev `novelty`, relation types to KB (contradicts / applies-to-new-domain score high), bridge potential (links distant KB clusters), actionability (`code_or_data`, kind = method/tool/dataset) | weighted sum |
| **Level** (tag) | Jev `level` + `prereq_heavy`, paper kind, age, citation count | label + "Read first: …" |

**Reference verification** (anti-AI-slop): resolve a sample of 10 references via Crossref/OpenAlex.
Unresolvable references above 20% → ⚠️ "references could not be verified".

Card example:
> **Relevance 85** · Q2 (protein structure), fits Core · **Trust 72** · ✅ NeurIPS ✅ code ⚠️ 3 citations ·
> **Value 90** · first to apply X to Y — *Relates to:* extends [[jumper-2021-highly-accurate-protein-structure]]

---

## 8. Feedback, taste & self-improvement

**Judgment actions on a card:** 👎 not useful · 👍 interesting · ⭐ add to KB · optional reason paragraph.

| Effect | Mechanism | Cost |
|---|---|---|
| Weights move | 👍/⭐ nudge matched question, query, source, author weights up; 👎 down (news-agent `applyFeedback`, ±0.1/0.15, clamped 0.1–2) | free |
| Few-shot | Last ~8 judgments (title + verdict + reason, trimmed) go into every Jev command's `taste_examples` | free |
| Reason parsing | Jev `reason-parse` → category nudges (e.g. "too advanced" lowers level fit weight) | ~$0.00004 |
| Taste rules | `generalizable` reasons → LLM drafts a rule → **proposal** → you approve → rule goes into `taste_rules` | rare LLM call |
| KB | ⭐ → `rh.ingest` task → librarian writes vault note (§10) | 1 Haiku run |
| Never resurface | 👎 papers are remembered and excluded | free |

### Weekly review (`rh.review`, durable task)

| Phase | Work |
|---|---|
| metrics | Precision@5 (share of top-5 cards you ⭐/👍), judgments per level, Jev agreement per command, cost per sweep, sources' star rates |
| calibrate | Find thresholds where Jev and you disagree systematically → threshold proposals |
| taste | Cluster this week's reasons → rule proposals (only after `proposal-evidence` passes) |
| queries & sources | Dead queries (0 stars in N sweeps), productive new terms from ⭐ papers, source weights |
| curriculum | `level-ready` → level-up proposal |
| interests | What you engage with since the last review: ⭐/👍/👎 and reasons, rule candidates, weight drift of questions/queries/sources, what you asked the desk in chat (topics extracted by Jev), notes you edited or opened in the vault |
| charter | **Charter proposals** from interests and evidence: add, raise, lower or retire research questions; add queries (productive terms from ⭐ papers and chat), retire dead ones; add or remove out-of-scope topics; adjust concepts and sub-areas. Each is a diff against the approved charter with its evidence (the judgments, papers and chat turns behind it) |
| field | What changed outside: topics and terms rising among recently gathered papers (including rejected ones), sub-areas the sweeps never reach, highly cited new work near the KB |
| new questions | Candidate research questions from several sources (see "Finding new questions" below), filtered by Jev, the best 3–5 written up by the review model as **research directions** with the papers that motivate them |
| missing links | Jev `link-candidate` over embedding-near but unlinked KB pairs from different clusters → top pairs feed "new questions" |
| process | e.g. "cards per sweep 7 → 5, you skip the last 2" |
| report | A review card + proposal cards in the UI |

Proposals are rows with `type`, `diff` (exact change), `evidence`, `status`. **Approve** applies the diff
deterministically; **reject** with an optional reason (which also feeds `taste_examples`).
Every decision is logged; accuracy is charted week over week on the project dashboard.

**As built in v1-5 (2026-10-28):** the review is the `rh.knowledge` plugin and runs before each digest. It covers
the interests, charter and new-questions phases with the evidence rules and one review-model call described in
README "The knowledge loop" (sources: liked/disliked papers with reasons, digest comments, desk questions, unmatched
liked papers, KB open questions). Not built yet: metrics/calibrate/curriculum phases as proposals, taste-rule
clustering, field trends, same-method-different-problem, missing links and citation gaps (they need facet vectors
and citation links in the KB).

### The charter evolves (with your approval)

The charter is the project's statement of direction, so it never changes silently, but it is no longer fixed
after the first approval. Every review proposes concrete charter changes from what you showed interest in and from
what changed in the field; approving them creates a **new charter version** (the history stays, `charter.md` in
the vault follows unless you edited it). Approved research directions become **new charter questions** (Q6, Q7, …)
with their own queries, so the very next sweep searches for evidence on them. Questions that stay unproductive (no
⭐ for several weeks) are proposed for retirement. The review frequency is a setting (weekly by default; "every N
days" or on demand from the UI).

### Finding new questions

Candidate questions are generated cheaply by code and Jev from the project's own material, and only the best few
reach the review model:

| Source | How |
|---|---|
| Same method, different problem | Pairs with close **method** facet vectors but distant **background** vectors (v0.2 representations): "has A's method been tried on B's problem?" |
| Missing links | `link-candidate`: A's method or result could address B's open question, and they are not linked or citing each other |
| Recurring open questions | The "Open questions" sections of KB notes, clustered; a question that recurs across papers and no KB paper answers |
| Contradictions | Jev `relation` (v2) or a review-time check flags papers whose results disagree: "which holds, and when?" |
| Citation-graph gaps | Two clusters of KB papers that never cite each other but share concepts |
| Rising topics | Terms and topics growing among recently gathered papers that the charter does not cover yet |
| Your interests | Topics you keep asking about in chat or starring that no charter question covers |

Jev scores each candidate (`question-promise`: specific, answerable from literature, not already covered by a
charter question, fits your level), the top 3–5 go to the review model, which writes each as a research direction:
the question, why it might produce results, the motivating papers, and suggested queries. On approval it becomes a
charter question and a `questions/` page in the vault.

---

## 9. Curriculum

| Level | Query modifiers & sources | Ranking bias |
|---|---|---|
| **foundational** | `survey`, `review`, `tutorial`, `introduction to`; OpenAlex sort by citations; any year; **most-cited references of your ⭐ papers** | `paper-kind` ∈ {survey, review, tutorial} ↑, high citations ↑ |
| **core** | charter queries; landmark method papers; benchmark papers | methods + benchmarks ↑ |
| **advanced** | specific sub-area queries; recent strong venues (2–3 years) | specificity ↑ |
| **frontier** | newest preprints (since last sweep); citing papers of ⭐ papers | freshness ↑, novelty ↑ |

Each sweep: ~80% at the current level, 1–2 "peek ahead" cards from the next level.
Prerequisite edges (`prerequisite-of`) produce "Read first: [[…]]" on cards. Level changes only via
approved proposal or a manual setting.

---

## 10. Knowledge base: Obsidian vault + SQLite

**The vault is the source of truth for knowledge; SQLite is the source of truth for the pipeline.**

```
vault/
├── index.md                 # L0: one line per KB paper (title · one-liner · level · your reason)
├── log.md                   # append-only: ingests, merges, approved proposals
├── brief.md                 # copy of the project brief
├── charter.md               # approved charter (questions Q1..Qn)
├── sources/<stem>.md        # L1: one evidence note per ⭐ paper
├── concepts/<name>.md       # reusable definitions, linked from sources
├── questions/<slug>.md      # open problems + research directions (missing links live here)
└── views/reading-list.base  # Obsidian Bases view over sources (by level, status)
```

**Stem:** `{first-author-lastname}-{year}-{first-5-title-tokens}` (from the LLM-wiki gist).

**Evidence note** (`sources/<stem>.md`), fixed sections:

```markdown
---
title: "…"
doi: "…"            arxiv: "…"          openalex: "…"
year: 2021          venue: "Nature"     level: core
kind: method        kb_added: 2026-10-30
scores: { relevance: 85, trust: 92, value: 80 }
why: "Your reason, verbatim"
extends: ["[[…]]"]  contradicts: []      prerequisite_of: ["[[…]]"]
questions: ["[[q2-…]]"]
concepts: ["[[protein-language-models]]"]
---
## Summary
## Contributions
## Method
## Results
## Limitations
## Open questions
## Related papers
```

Rules:
- **A paper is not ingested until it is connected** to ≥1 concept or question page.
- Typed relations are frontmatter properties: our app reads them, Obsidian's graph shows them.
- **Your edits win.** The agent changes existing notes only through approved proposals; it may append to
  `## Related papers` and `log.md`. A file watcher re-indexes on change.
- The librarian's system prompt includes the relevant rules from kepano's `obsidian-markdown`
  and `obsidian-bases` skills, so notes and views are valid Obsidian.

**Indexes in `project.sqlite`** (rebuildable from the vault at any time):
- **FTS5 (BM25)** over vault notes — primary `search_kb` (benchmark in the gist: 118/120 hits, <1 ms).
- **sqlite-vec** embeddings (one OpenRouter embedding model for every paper, so all vectors are comparable) — used for
  relate shortlists, gate similarity, missing-link pairs.

**Agent memory = progressive disclosure:**

| Layer | Content | Size | Loaded |
|---|---|---|---|
| L0 | `index.md` | ~60 tok/paper | always (cached system section) |
| L1 | evidence note | ~800 tok | `query_kb(stem)` |
| L2 | full text | 8–15K tok | `read_full_text(id)` (readers, deep chat) |

---

## 11. Data model (`project.sqlite`)

| Table | Key columns |
|---|---|
| `settings` | schedule, cards per sweep, level, model ids, budget caps |
| `charter_questions` | id, text, weight, status |
| `queries` | term, kind (charter/level/learned), weight, enabled, last_searched, star_rate |
| `sources` | kind (arxiv/openalex/europepmc/biorxiv/s2/citation-chase), config, weight |
| `papers` | ids (doi, arxiv, pmid, pmcid, openalex), title, abstract, authors, year, venue, metadata JSON, embedding ref |
| `candidates` | paper_id, sweep_id, status, jev results (JSON per command + version), scores, level, rank, reject reason |
| `edges` | from, to, type, strength, origin (jev/user/librarian), reason |
| `cards` | candidate_id, scores, reasons, props, presented_at |
| `judgments` | card_id, verdict, reason, reason_kind (Jev), created_at |
| `kb_entries` | paper_id, stem, added_at, why |
| `taste_rules` | text, source proposal, active |
| `proposals` | type, diff JSON, evidence, status, decided_at, decision reason |
| `sweeps` / `reviews` | phase statuses, counts, cost, task id, errors |
| `jev_calls` | command, version, model, cost, latency, answers, candidate/card ref (raw payload optional) |
| `telemetry` | tool calls, tokens, cost per run (projected from agent.sqlite) |
| `vault_fts` / `vec_papers` | FTS5 index, sqlite-vec table |

---

## 12. Paper sources (all free, keyless unless noted)

| Source | Use | Notes (checked live 2026-10-22) |
|---|---|---|
| arXiv API | cs.LG, cs.AI, cs.CL, q-bio.* | works keyless; 1 req / 3 s politeness |
| OpenAlex | search, venues, citation counts, references, citing works, `is_retracted`, OA PDF | works keyless; polite pool with contact email |
| Crossref | DOI resolution, retractions, **reference verification** | polite pool with contact email |
| Europe PMC | biomed literature, **open-access full text (XML)** | keyless |
| bioRxiv / medRxiv API | biology preprints | keyless |
| Semantic Scholar | TLDRs, recommendations | **optional**: the keyless pool returned HTTP 429 on every request, so only used with `S2_API_KEY` |

Full text (v2): prefer structured sources (arXiv HTML, Europe PMC OA XML) over PDFs. For PDFs, a
**Docling** sidecar is the leading option for multi-column academic layouts, tables and formulas (it is
Python, so it would be bundled as a supervised helper process inside the project container, like Ignis;
decide in v2). Record the extractor in note
properties so notes can be re-extracted later.

---

## 13. API & UI

**API** (Express 5, bearer tokens, idempotency keys, SSE — from the news agent). One project per container,
so routes have no project segment. Built in v0: `/v1/{health,info,agent,chat,stream,transcript,runs,usage,
jev/ping,project,brief,charter,schedule,scheduled-runs,cards,sweeps,sweep-settings,weights,feedback/precision,
kb/papers,kb/notes,kb/search}`, `/v1/runs/{sweep,review}` (manual), `/v1/cards/:id/judgment`, and `/kb/` (the
bundled Obsidian viewer). Built in v1: `/v1/plugins…` (v1-0), `/v1/cycle`, `/v1/digests…` (v1-1), `/v1/harness…` (v1-2), `/v1/slots…`,
`/v1/attribution` (v1-3), `/v1/upgrades…`, `/v1/proposals…`, `/v1/suggestions…` (v1-4), `/v1/knowledge…` (v1-5).

**UI** (Vue 3):

| Screen | Content |
|---|---|
| Screen | Content | Status |
|---|---|---|
| **Top bar / overview** | Project name, status, charter version, next sweep, monthly cost, pause; later level, pending proposals and upgrades | v0 |
| **Brief / Charter** | Brief (paste or upload), charter draft with scoping questions, versions, approve; the knowledge review's charter proposals and new questions | v0; proposals v1-5 |
| **Feed** (left) + **Agent** (right) | Cards with scores and reasons, 👎/👍/⭐ + reason box, precision trend; agent chat with live tool calls | v0 |
| **Library** | Knowledge-base papers, keyword search, rendered notes, "Open in knowledge base" | v0 |
| **Knowledge base** | The real Obsidian interface (Ignis), hub-themed, opening on the **graph view** (papers, concepts, questions in three colors), Graph/Index buttons | v0 (graph 2026-10-25) |
| **Runs** | Chat runs, sweeps with phases, papers by status and the cost split, scheduled runs | v0 |
| **Settings** | Schedule, cards per sweep, weights with their charter values | v0; plugin settings v1-0 |
| **Plugins** | Every plugin: state, version, contributions, permissions, settings, history; enable, disable, install, uninstall, roll back | v1-0 |
| **Upgrades** | The weekly upgrade: the latest run (focus, reason, every candidate with its numbers, the result), proposals to approve or reject, add-on suggestions to dismiss, earlier runs, "Run one now". (The staged idea → test → proof workflow sketched earlier was replaced by fixed slots and presets, EVOLUTION.md §0.1–0.2) | v1-4 |
| **Graph (typed relations)** | Typed edges between papers (extends, contradicts…), missing-link pairs | v2 |

**Knowledge base tab (v0.5):** the real Obsidian interface embedded in the hub UI, served by
[Ignis](https://github.com/Nystik-gh/ignis) (self-hosted Obsidian-as-a-web-app, a Node.js server, AGPL, pinned)
**bundled inside the project's container**: the image copies a pinned Ignis release, the hub starts it as a
supervised child process on the container's loopback interface, and proxies it at `/kb/`, so the iframe is
same-origin on the project's port. The tab stays loaded when switching tabs, shows no frame border, and Obsidian's
own chrome is hidden. Each vault ships a hub theme (`.obsidian/` CSS snippet + layout) matching the hub's colors,
fonts and light/dark mode. `RH_KB_VIEWER=off` disables it. The trial (2026-10-23) settled the details: the
viewer must be same-origin (Ignis's absolute API paths are forwarded, and the hub page lends Obsidian the frame's
`require`), and a preload binds Ignis to loopback. From v1-0 the viewer is a plugin (`rh.viewer-obsidian`) that can
be disabled or swapped (for example for the Library viewer).

**UI technology (decided 2026-10-25):** stay with **Vue 3**, built with **Vite+** (no switch, no meta-framework); add **Vue
Router** (plugin tabs as routes, replacing the hand-made hash router) and **Pinia** (shared state as plugins add
views) in v1-0; **plugin UIs mount as Web Components** (custom elements with the hub's CSS variables, like VS
Code's webviews), so plugin authors and agents can use any framework or none; **Playwright** for UI tests and
screenshots (`npm run test:ui`; it replaced `scripts/screenshot.mjs` in v1-0); no component library, the hub's own tokens keep one look.

---

## 14. Docker: one container per project

- `Dockerfile`: `node:26-slim` (from v1-0; v0 used `node:24-slim`), `npm ci`, build the UI with Vite+, copy a pinned Ignis release (v0.5), run `rh-server` as a
  non-root user; `rh-server` supervises helper processes (Ignis, later Docling).
- `docker-compose.yml` per project: `name: rh-<name>`, one service, `restart: unless-stopped`, port
  `127.0.0.1:<port>:4850`, volume `./data:/data`, `env_file: .env`, `mem_limit`/`cpus` (2 GB / 2 CPUs default),
  healthcheck on `/v1/health`.
- `.env` per project: `RH_PROJECT_NAME`, `OPENROUTER_API_KEY` (models + embeddings + Jev; one key per project
  recommended, with OpenRouter's per-key credit limit), `RH_SWEEP_TIME`, `CONTACT_EMAIL`, `S2_API_KEY`
  (optional), tokens, model IDs, budget caps. Never committed.
- **New theme:** `./new-project.sh genomics` creates `projects/genomics/` with its compose file and `.env`, the next
  free port (4860, 4870, …), compose name `rh-genomics`, a sweep time 20 minutes after the last project's, and
  prints `http://genomics.localhost:4860`.

**Projects never interfere** (spec `deployment`):

| Shared thing | Protection |
|---|---|
| Data folder | `.owner` lock with a 15 s heartbeat; a second container on the same folder refuses to start |
| Port | each project its own; a taken port gives a one-line error, not a stack trace |
| Browser cookies/storage | each project at `<name>.localhost:<port>` (browsers keep cookies per host name) |
| Docker names | compose project `rh-<name>`; logs and health carry the project name |
| CPU / memory | per-container limits |
| Paper APIs (one IP) | staggered sweep times, per-source pacing, backoff on 429 |
| OpenRouter balance | one key per project with its own credit limit (recommended) |

- Host prerequisite: Docker daemon running + user in `docker` group (currently not set up).

---

## 15. Cost model (estimates from verified prices — measured in v0 and shown in Runs)

| Item | Per day per project |
|---|---|
| Jev: ~300 candidates × 3 gate commands + level/importance for ~40 survivors | ~1,000 calls × ~$0.00004 ≈ **$0.04** |
| Embeddings: ~300 abstracts × ~300 tokens with `qwen3-embedding-8b` (whole + 3 facet vectors) | **< $0.002** |
| Jev `abstract-facets`: one call per new paper (~10 sentence questions; measured $0.0001 per paper on 2026-10-23) | ~300 × $0.0001 ≈ **$0.03** |
| Desk agent sweep run + 7 cards (Haiku 5.5, ~200K in / 10K out incl. re-reading) | ~$0.03 |
| ≤3 reader subagents with full text (v2, Haiku 5.5) | ~$0.01–0.03 |
| Librarian per ⭐ (~2/day, Haiku 5.5) | ~$0.01 |
| Weekly review (Sonnet 5.5, ~100K in / 10K out) | ~$0.30 per week |
| **Total** | **≈ $3–6 / project / month**; chat extra |

Budget caps per project (daily/monthly) stop new sweeps and notify when reached.

---

## 16. Testing (inherited approach)

- **Offline by default**: faux model provider + mock Jev (`JEV_BACKEND=mock`) + fixture papers. No spend.
- Unit: policy functions with fixed Jev answers at threshold boundaries; scoring formulas; stem generation; vault parsing.
- Durable: **SIGKILL mid-gate** → restart → each paper judged once, each card presented once (port `recovery.test.ts`).
- Idempotency: double tick → one sweep; replayed `present_paper` → one card; replayed ⭐ → one note.
- Vault: rebuild indexes from vault equals incremental index; user-edited note not overwritten.
- Live smoke (only when authorized): one real sweep on a test project, report cost and model IDs observed.

---

## 17. Build pyramid (OpenSpec changes)

**v0 is complete (2026-10-25)**: all six layers below are archived. **v1-0 is complete (2026-10-26)**: the kernel
and all of v0 as VS Code-style plugins (what it built: EVOLUTION.md §2.5). **v1-1 is complete (2026-10-26)**: the light image (232 MB, Obsidian as an
add-on), the daily cycle (sweep with exploration picks, nightly run, weekly digest with comments) and one-change undo. **What comes next is planned in
[EVOLUTION.md §0 and §6](EVOLUTION.md)** (revised 2026-10-26: core loop first, human on the loop):
`v1-1-lite-daily-cycle` ✅ (a light image, Obsidian as an add-on, the daily cycle orchestrated with a weekly digest and
a "What changed" feed with undo) → `v1-2-harness` ✅ (replays on your judgments, a judge calibrated on your verdicts: the Ranking slot's preset) →
`v1-3-slots-and-benchmarks` ✅ (every plugin classified as core, slot, add-on or preference; the Plugins tab grouped by
topic; benchmark presets per slot on cached public samples; usage attribution for add-ons) → `v1-4-weekly-upgrade` ✅
(each week one focus chosen by Jev: ranking variants replayed and the winner applied with undo, an embedder candidate
benchmarked and proposed, or add-ons scouted on the web) → `v1-5-knowledge-loop` ✅ (before each digest, charter
proposals with evidence: weights, questions and queries to retire, new research questions scored by Jev, out-of-scope
topics; an approved proposal is the next charter version) (charter and new-question proposals).
Step 7, built completely (EVOLUTION.md §6): `v1-6-full-text` ✅ (full text from arXiv HTML, Europe PMC and
bioRxiv XML or PDFs through the Converter slot: pdf.js in the light image, Docling in `research-hub:full`) →
`v1-7-question-finders` ✅ (pluggable question finders judged by attribution, level-up and taste-rule proposals) →
`v1-8-engineer` ✅ (ideas researched and built into plugins: paper sources, fine-tuned embedders on Kaggle) →
`v1-9-mcp` ✅ (every project an MCP server for outside agents, read-only, with its own token). Step 7 is complete (2026-10-29); next come review cycles, testing and shipping. What may change and how
it is judged: EVOLUTION.md §0.1.

v0 was built bottom-up; each layer is one OpenSpec change that depends only on the layers below it and
is applied, tested and archived before the next starts. Every change, v0-0 to v1-9, is archived in
`openspec/changes/archive/` with its proposal, design, specs and tasks; the merged specs are in `openspec/specs/`.

```
                         ┌──────────────────────────┐
              v0-5       │ knowledge-vault · viewer │  ⭐ → connected notes, search, Library, Obsidian tab
                       ┌─┴──────────────────────────┴─┐
              v0-4     │ paper-feedback               │  👎/👍/⭐ + reason, weights, few-shot, precision@5
                     ┌─┴──────────────────────────────┴─┐
              v0-3   │ paper-sweep · paper-cards        │  durable sweep, Jev gates, ranked cards
                   ┌─┴──────────────────────────────────┴─┐
              v0-2 │ paper-sources · representations     │  keyless sources, one record per work, 3 layers
                 ┌─┴──────────────────────────────────────┴─┐
              v0-1│ project-charter · scheduling            │  brief → charter, pause, exactly-once slots
               ┌─┴──────────────────────────────────────────┴─┐
              v0-0 │ deployment · agent-runtime · jev-client   │  one container per project, durable agent, Jev
               └──────────────────────────────────────────────┘
```

| Layer | Change | Capabilities | Jev commands added | Done when |
|---|---|---|---|---|
| 0 | `v0-0-skeleton` | deployment, agent-runtime, jev-client | `ping` | One container per project that cannot interfere with another; faux agent chats; crash test passes; offline suite green |
| 1 | `v0-1-project-setup` | project-charter, scheduling | — | Brief → approved charter; sweeps requested exactly once per slot |
| 2 | `v0-2-paper-sources` | paper-sources, paper-representations | `abstract-facets` | Queries return deduplicated, enriched records with whole-paper vectors, Jev-labeled facet vectors (background/method/result) and citation links; papers searchable from chat |
| 3 | `v0-3-daily-sweep` | paper-sweep, paper-cards | `on-theme`, `paper-kind`, `worth-reading`, `level`, `importance` | ~7 useful, foundational-first cards per day |
| 4 | `v0-4-feedback` | paper-feedback | `reason-parse` | Judgments change weights and Jev inputs; precision@5 shown |
| 5 | `v0-5-knowledge-vault` | knowledge-vault, knowledge-viewer | — | ⭐ papers become connected notes, readable and editable in the embedded Obsidian tab |

After v0 (superseded in detail by **[EVOLUTION.md](EVOLUTION.md)**, 2026-10-25: the whole product becomes
plugins, with a knowledge loop and a product loop of experiments, benchmarks and A/B tests; its plan of action
replaces the phase list below):

| Phase | Deliverables |
|---|---|
| **v1 — self-improvement and an evolving charter** (moved first, 2026-10-25) | `rh.review` on a configurable schedule; proposals UI; interests (judgments, reasons, chat via `interest-topic`); charter proposals → new charter versions; new research questions from the sources in §8 (`question-promise`, `link-candidate`, same-method-different-problem, recurring open questions, citation gaps, rising topics) → research directions → charter questions; taste rules from rule candidates; `proposal-evidence`, `level-ready`; calibration |
| **v2 — trust, relations, curriculum** | Crossref reference verification; Jev `trust-read`, `relation` (also feeds contradiction-based questions), `same-work`; full text (arXiv HTML / Europe PMC XML / Docling); paper-reader subagents + `claim-support`; curriculum level-ups; Graph view (Cytoscape.js); Obsidian Bases views |
| **v3 — breadth & polish** | Budgets, `chat-route`, `:batch` models for non-urgent work, CLI client, project export, optional Laya experiment |

---

## 18. Risks & mitigations

| Risk | Mitigation |
|---|---|
| pi-durable is experimental, API changes | Pin an exact version (1.1.0 in v0, 1.4.0 from v1-0); all usage behind `packages/durable-agent`; upgrade deliberately with recovery tests |
| Jev outage | Gate is behind a `Judge` interface; an LLM-backed judge as config fallback (explicit, not automatic) |
| Jev miscalibrated for scientific abstracts | Review bands, weekly calibration against your judgments, thresholds versioned |
| API rate limits (arXiv, OpenAlex), shared by every project on one IP | 7-day metadata cache, politeness delays, staggered sweep times, keyless sources by default, durable backoff |
| Two projects interfere on one machine | Data-folder lock, own port/name/host name, resource limits (§14) |
| Ignis (young, unofficial) breaks on an Obsidian update | Pinned release; Library view still works; `RH_KB_VIEWER=off` |
| OpenRouter Decisions API (Jev) is alpha | One client module, pinned Jev model, raw payloads in the ledger to diagnose shape changes |
| Embedding model change | Vectors record their model; re-embed in background; never mix models in one comparison |
| Prompt injection via paper text | "Treat text as data" in every Jev/LLM prompt; no bash/file tools; KB writes via schema-checked tools |
| Vault edit conflicts | Agent writes only new notes/appends; changes via proposals; watcher re-index |
| Cost creep from chat history | Compaction policy, sweep conversation separate from chat, budget caps |
| Vendored packages drift from upstream | Record source SHA in `NOTICE.md`; review upstream when upgrading pi-durable |
| pi-durable stalls or breaks | Isolation in `packages/durable-agent`; Mastra is the most mature TypeScript fallback |

---

## 19. Open items

- [x] Docker access (2026-10-25)
- [x] `OPENROUTER_API_KEY` (covers models, embeddings and Jev)
- [x] First project brief: the `proteins` project (multimodal document search for agents) runs in Docker
- [x] One project per container, owner lock, `new-project.sh`
- [x] Ignis trial (2026-10-23, from source): passed with a same-origin `/kb/` proxy and a loopback preload (see v0.5 proposal)
- [ ] Contact email for OpenAlex and Europe PMC polite pools (`CONTACT_EMAIL`); optional Semantic Scholar API key
- [ ] Optional: a Kaggle account and `KAGGLE_API_TOKEN` for the engineer's free fine-tuning (only tested against a fake
  Kaggle API so far); `RH_MCP_TOKEN` in existing projects' `.env` to turn MCP on
- [x] Python (decided 2026-10-28): not in the core image; Docling in the add-on image `research-hub:full` as the Converter slot's alternative
- [x] Where fine-tuning runs (decided 2026-10-28): Kaggle Notebooks, free, through Kaggle's API (needs a free Kaggle account and API key)
- [x] Autonomy policy (decided 2026-10-26, built in v1-4): setting winners on the finding loop apply with undo; new plugins (another embedder), charter changes and cost increases wait for approval

---

## 20. Technology review (2026-10-22; plugin design added 2026-10-25)

**Plugin design (2026-10-25):** VS Code's extension model (declarative `contributes`, `activationEvents`, an
extension host for third-party code, a versioned API namespace, extension exports) plus Backstage's extension
points owned by plugins; process plugins speak MCP. Chosen over a monolith with feature flags (not swappable by
users or agents) and over a microservice per feature (conflicts with one container per project).

Each choice was checked against current alternatives; ✅ = kept, 🔄 = changed by this review.

| Job | Choice | Alternatives considered | Verdict |
|---|---|---|---|
| Durable agent runtime | pi-durable 1.4.0 from v1-0 (1.1.0 in v0; via vendored `durable-agent`) | Mastra (most complete TS stack; durable agents still beta), LangGraph.js (most production-proven), Inngest/Temporal (durability layers, need an agent loop on top) | ✅ Kept: the reference implementation and its Jev integration are proven on it; isolated so Mastra is a viable fallback |
| Codebase start | Fresh repo + vendored `durable-agent`, `jev` | Full fork of the news agent | 🔄 Changed: fork would delete/rewrite ~70% |
| LLMs | OpenRouter: Haiku 5.5 / Sonnet 5.5 | Direct Anthropic API | ✅ Kept per user choice; Haiku 5.5 verified at $0.10/$0.50 per M; `:batch` variants available |
| Bulk decisions | Jev `typesafe/jev-1.14` via OpenRouter | Local zero-shot (GLiClass, DeBERTa), Laya (needs fine-tuning) | ✅ Kept; 🔄 pinned version, 30 KB input cap (long-context mode above ~32 KB), alpha API noted |
| Embeddings | One OpenRouter embedding model (`qwen/qwen3-embedding-8b`) | SPECTER2 via Semantic Scholar | 🔄 Changed: S2 keyless pool returned 429 on every request; one model gives comparable vectors for all sources |
| Paper metadata & citations | OpenAlex (+ Crossref) | Semantic Scholar | 🔄 OpenAlex primary (keyless, verified live, has `is_retracted`); S2 optional |
| HTTP server | Express 5 | Fastify, Hono (2–3× faster) | ✅ Kept: single-user local service, reused Express infra code |
| Toolchain | **Vite+ 1.x** (`vp`: Vite 8, Vitest 5, Oxlint, Oxfmt, task caching, one config) from v1-0 | separate Vite, ESLint, Prettier, Jest; Biome | 🔄 New (2026-10-25): stable since 2026-09-28 (MIT); we already used Oxlint and Oxfmt separately; formatting and linting become enforced checks |
| Language | TypeScript 6.0 (from 5.9) | TypeScript 7.0 (native, 8–12× faster builds) | ⏳ 7.0 has no API for Vue's type checker; move at 7.1 when `vue-tsc` supports it |
| Runtime | Node 26 LTS (from 24) | stay on 24 (maintenance) | 🔄 Node 26 is LTS from 2026-10-28 |
| UI | Vue 3.5; from v1-0 also Vue Router 5, Pinia 4, Web Components for plugin UIs, Playwright 1.64 for UI tests | React, Svelte, Nuxt or another meta-framework, a component library | ✅ Kept (re-checked 2026-10-25): the app is small and works; a rewrite buys nothing; plugin UIs stay framework-agnostic through custom elements; SSR is not needed for a single-user local app |
| Database | `node:sqlite` + FTS5 + `sqlite-vec` | Postgres + pgvector, Qdrant, Neo4j | ✅ Kept; **tested locally**: FTS5 BM25 and sqlite-vec v0.1.9 KNN work on Node 26 with `allowExtension` |
| Knowledge base | Obsidian-compatible markdown vault | Vector-DB RAG, graph DB | ✅ Kept: matches the 2026 "LLM wiki" pattern; BM25 over markdown benchmarked well |
| Knowledge base viewer (v0.5) | Ignis: real Obsidian UI as a self-hosted web app, bundled in the project container, iframe tab, hub theme | linuxserver/obsidian (streamed desktop: laggy, heavy), Ignis as a separate container, Quartz (read-only), own Library view only | 🔄 New: user wants Obsidian in the browser, all on the server, one container per project; pending a 30-minute trial |
| Deployment unit | One container per project | Several projects in one hub container | 🔄 Changed 2026-10-23 at the user's request: simpler, isolated by Docker; interference prevented by locks, ports, host names, limits, staggering |
| Graph view (v2) | Cytoscape.js | sigma.js (WebGL, large graphs), G6 | ✅ Kept for hundreds of nodes; sigma.js if graphs grow to thousands |
| PDF → markdown (v2) | Structured sources first; Docling for PDFs | Marker (GPU), MarkItDown (shallow), GROBID (no math) | 🔄 New: Docling as the leading option, decided in v2 |
| Spec process | OpenSpec 1.14.3, layered changes | Plain PLAN.md | ✅ Kept; all six v0 changes pass `openspec validate --strict` |
