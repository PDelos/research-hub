# Research Hub — Detailed Design & Build Plan

> A self-hosted hub of research **projects**. Each project follows one theme and has its own
> **proactive durable agent** that sweeps for papers every day, uses **Jev to make almost every
> decision**, presents a few paper cards, learns from your 👎/👍/⭐ + reasons, and grows an
> Obsidian-compatible **knowledge base** from the papers you approve. Every week it reviews its own
> performance and **proposes improvements that you approve**.
>
> Field focus: **AI + bioinformatics (neural networks)**. Runs locally in **one Docker container**.

Last updated: 2026-10-22 (technology review + v0 pyramid)

---

## 0. Where this comes from

### Lessons from the two videos (IndyDevDan)

| Idea | How we apply it |
|---|---|
| **Proactive agent = durable agent + trigger + sandbox** | pi-durable agent per project + a scheduler tick + a Docker container |
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
telemetry projector, recovery test) as starting points; write our own multi-project server, SDK, UI and
schema. A full fork was rejected after measuring it: ~70% of its code (news domain 9.2K lines, news UI,
TUI/CLI/cron 3.9K) would be deleted or rewritten, and it assumes one project and ssh-deployed devices.
Pinned: `@earendil-works/pi-durable`, `pi-ai`, `chord` **1.1.0**; Express 5; Vue 3 + Vite.
pi-durable is experimental — all direct usage stays inside `packages/durable-agent`.

---

## 1. Concepts

| Term | Meaning |
|---|---|
| **Hub** | The app. Lists projects; one container can hold many |
| **Project** | One theme. Isolated agent, database, vault, schedule, weights, budget |
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

---

## 2. Architecture

```
┌──────────────────────────── Docker container: research-hub ─────────────────────────────┐
│                                                                                          │
│  Browser (Vue 3)  ◄── REST + SSE ──►  rh-server (Node 24, Express 5)                      │
│                                        ├─ static UI + token-holding proxy (no key in page)│
│                                        ├─ ticker: every 5 min → schedule.due()? → start   │
│                                        ├─ ProjectManager                                  │
│                                        │    └─ per project (lazy-opened, PID-locked):     │
│                                        │        pi-durable Harness (agent.sqlite)         │
│                                        │        ├─ agent: research-desk (root)            │
│                                        │        ├─ subagents: paper-reader, librarian,    │
│                                        │        │             reviewer                    │
│                                        │        └─ tasks: rh.sweep, rh.review, rh.ingest  │
│                                        ├─ Jev client (OpenRouter) + ledger                │
│                                        ├─ Paper sources (arXiv, OpenAlex, EuropePMC, bioRxiv)│
│                                        └─ Vault indexer (FTS5) + file watcher             │
│                                                                                          │
│  /data (volume)                                                                          │
│   ├─ hub.sqlite                      projects, global settings, cost rollups              │
│   ├─ cache.sqlite                    shared paper metadata cache (OpenAlex/Crossref)      │
│   └─ projects/<slug>/                                                                    │
│        ├─ brief.md                                                                       │
│        ├─ agent.sqlite               pi-durable: conversations, tasks, checkpoints        │
│        ├─ project.sqlite             app tables + sqlite-vec embeddings + FTS5 index      │
│        ├─ fulltext/<paper-id>.md     extracted full texts (L2)                           │
│        └─ vault/                     Obsidian vault (the KB, source of truth)            │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Two SQLite files per project, as in the news agent: **`agent.sqlite` belongs to pi-durable**,
**`project.sqlite` belongs to the app**. A projector copies agent telemetry (tool calls, tokens,
costs) into `project.sqlite`. Clients only read through the API.

**Scheduling** (the news agent's pattern, adapted): an in-process ticker fires every 5 minutes and asks
each project's `Schedule.due()`. Due slots are idempotent (`requestId = project:kind:slot`), so a
restart or a double tick never starts a second sweep. Defaults: **sweep daily at 06:00**,
**review Sundays at 07:00**, both editable per project. Docker `restart: unless-stopped` +
pi-durable checkpoints mean an interrupted sweep resumes from its last phase.

---

## 3. Project lifecycle

```
1. New project ──► upload brief.md
2. research-desk drafts CHARTER  (LLM, once)            ──► you edit/approve  (proposal type: charter)
3. Agent asks 3–5 scoping questions (ask_user cards)    ──► answers fold into charter
4. Level = foundational. First sweep runs immediately in ORIENTATION mode.
5. Daily: sweep → cards → you judge → ⭐ ingested into vault
6. Weekly: review → proposals → you approve/reject
7. Pause / archive any time (tasks stop, data kept)
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
| 5 | **enrich** | code | For survivors: OpenAlex + Crossref metadata (venue, citations, year, authors, refs, OA PDF, retraction flag) and one embedding from the configured OpenRouter embedding model. Cached in `cache.sqlite` |
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
| **reviewer** (subagent, weekly, read-only on settings) | Metrics, calibration, missing links, proposals | `review_metrics`, `jev_classify`, `query_kb`, `search_kb`, `propose_change` |

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
| missing links | Jev `link-candidate` over embedding-near but unlinked KB pairs from different clusters → top 3 → Sonnet writes **research directions** (become `questions/` notes on approval) |
| process | e.g. "cards per sweep 7 → 5, you skip the last 2" |
| report | A review card + proposal cards in the UI |

Proposals are rows with `type`, `diff` (exact change), `evidence`, `status`. **Approve** applies the diff
deterministically; **reject** with an optional reason (which also feeds `taste_examples`).
Every decision is logged; accuracy is charted week over week on the project dashboard.

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

Full text (v1): prefer structured sources (arXiv HTML, Europe PMC OA XML) over PDFs. For PDFs, a
**Docling** sidecar is the leading option for multi-column academic layouts, tables and formulas (it is
Python, so it would be a second process or container; decide in v1). Record the extractor in note
properties so notes can be re-extracted later.

---

## 13. API & UI

**API** (Express 5, bearer tokens, idempotency keys, SSE — from the news agent):
`/v1/hub/projects` · `/v1/p/:slug/{feed,cards/:id/judge,kb,graph,proposals/:id/decide,sweeps,reviews,settings,chat,stream}` ·
`/v1/p/:slug/workflows/{sweep,review}` (ticker/manual).

**UI** (Vue 3):

| Screen | Content |
|---|---|
| **Hub** | Project tiles: theme, level, last sweep, unread cards, pending proposals, monthly cost, pause |
| **Project · Feed** (left) + **Agent** (right) | Cards with scores/reasons/relations and 👎/👍/⭐ + reason box; agent chat with live tool calls |
| **Library** | KB list from vault (filter by level/concept/question), open note, "open in Obsidian" link |
| **Graph** | Cytoscape view of KB + typed edges; highlighted missing-link pairs |
| **Directions** | Research-direction cards from reviews (approved → `questions/`) |
| **Proposals** | Pending/decided proposals with diff + evidence, approve/reject + reason |
| **Runs** | Sweeps and reviews: phases, Jev calls, tool calls, tokens, cost (news-agent Executions view) |
| **Settings** | Charter, queries & weights, sources, level, schedule, cards per sweep, models, budget cap |

**Knowledge base tab (v0.5):** the real Obsidian interface embedded in the hub UI, served by
[Ignis](https://github.com/Nystik-gh/ignis) (self-hosted Obsidian-as-a-web-app, AGPL, pinned) as a second
compose service in its own container (vault folders only, no published port), proxied by the hub at `/kb/` so
the iframe is same-origin on port 4850. Each vault ships a hub theme
(`.obsidian/` CSS snippet + layout) so it looks like part of the hub. Fallback if Ignis fails its trial:
linuxserver/obsidian (streamed desktop) behind the same tab. Everything runs on the hub machine.

---

## 14. Docker

- `Dockerfile`: `node:24-slim`, `npm ci`, build Vue, run `rh-server` as non-root user.
- `docker-compose.yml`: one service, `restart: unless-stopped`, port `4850`, volume `./data:/data`,
  `env_file: .env`, healthcheck on `/v1/health`.
- `.env`: `OPENROUTER_API_KEY` (models + embeddings + Jev), `CONTACT_EMAIL`, `S2_API_KEY` (optional)
  (OpenAlex/Crossref polite pool), `RH_CLIENT_TOKEN`, model IDs, budget caps. Never committed.
- **Another hub** = copy the compose folder, change port and data dir.
- Host prerequisite: Docker daemon running + user in `docker` group (currently not set up).

---

## 15. Cost model (estimates from verified prices — measured in v0 and shown in Runs)

| Item | Per day per project |
|---|---|
| Jev: ~300 candidates × 3 gate commands + level/importance for ~40 survivors | ~1,000 calls × ~$0.00004 ≈ **$0.04** |
| Embeddings: ~300 abstracts × ~300 tokens with `qwen3-embedding-8b` | **< $0.001** |
| Desk agent sweep run + 7 cards (Haiku 5.5, ~200K in / 10K out incl. re-reading) | ~$0.03 |
| ≤3 reader subagents with full text (v1, Haiku 5.5) | ~$0.01–0.03 |
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

v0 is built bottom-up; each layer is one OpenSpec change that depends only on the layers below it and
is applied, tested and archived before the next starts. All six v0 changes exist in `openspec/changes/`
with proposals and behavior specs; design and tasks are written for each layer when it is next.

```
                         ┌──────────────────────────┐
              v0-5       │ knowledge-vault          │  ⭐ → connected evidence notes, search, Library
                       ┌─┴──────────────────────────┴─┐
              v0-4     │ paper-feedback               │  👎/👍/⭐ + reason, weights, few-shot, precision@5
                     ┌─┴──────────────────────────────┴─┐
              v0-3   │ paper-sweep · paper-cards        │  durable sweep, Jev gates, ranked cards
                   ┌─┴──────────────────────────────────┴─┐
              v0-2 │ paper-sources · paper-embeddings     │  keyless sources, one record per work, vectors
                 ┌─┴──────────────────────────────────────┴─┐
              v0-1│ project-lifecycle · scheduling          │  brief → charter, isolation, exactly-once slots
               ┌─┴──────────────────────────────────────────┴─┐
              v0-0 │ deployment · agent-runtime · jev-client   │  container, durable agent, Jev client
               └──────────────────────────────────────────────┘
```

| Layer | Change | Capabilities | Jev commands added | Done when |
|---|---|---|---|---|
| 0 | `v0-0-skeleton` | deployment, agent-runtime, jev-client | `ping` | Container runs, faux agent chats, crash test passes, offline suite green |
| 1 | `v0-1-projects` | project-lifecycle, scheduling | — | Brief → approved charter; sweeps requested exactly once per slot |
| 2 | `v0-2-paper-sources` | paper-sources, paper-embeddings | — | Queries return deduplicated, enriched, embedded records |
| 3 | `v0-3-daily-sweep` | paper-sweep, paper-cards | `on-theme`, `paper-kind`, `worth-reading`, `level`, `importance` | ~7 useful, foundational-first cards per day |
| 4 | `v0-4-feedback` | paper-feedback | `reason-parse` | Judgments change weights and Jev inputs; precision@5 shown |
| 5 | `v0-5-knowledge-vault` | knowledge-vault | — | ⭐ papers become connected notes that open in Obsidian |

After v0:

| Phase | Deliverables |
|---|---|
| **v1 — trust, relations, curriculum** | Crossref reference verification; Jev `trust-read`, `relation`, `same-work`; full text (arXiv HTML / Europe PMC XML / Docling); paper-reader subagents + `claim-support`; curriculum level-ups; Graph view (Cytoscape.js); Obsidian Bases views |
| **v2 — self-improvement** | `rh.review`; proposals UI; taste rules from rule candidates; `proposal-evidence`, `level-ready`, `link-candidate`; calibration; research directions |
| **v3 — breadth & polish** | Budgets, `chat-route`, `:batch` models for non-urgent work, CLI client, project export, optional Laya experiment |

---

## 18. Risks & mitigations

| Risk | Mitigation |
|---|---|
| pi-durable is experimental, API changes | Pin 1.1.0; all usage behind `packages/durable-agent`; upgrade deliberately with recovery tests |
| Jev outage | Gate is behind a `Judge` interface; an LLM-backed judge as config fallback (explicit, not automatic) |
| Jev miscalibrated for scientific abstracts | Review bands, weekly calibration against your judgments, thresholds versioned |
| API rate limits (arXiv, OpenAlex) | Shared cache, politeness delays, keyless sources by default, chunked gather with durable backoff |
| OpenRouter Decisions API (Jev) is alpha | One client module, pinned Jev model, raw payloads in the ledger to diagnose shape changes |
| Embedding model change | Vectors record their model; re-embed in background; never mix models in one comparison |
| Prompt injection via paper text | "Treat text as data" in every Jev/LLM prompt; no bash/file tools; KB writes via schema-checked tools |
| Vault edit conflicts | Agent writes only new notes/appends; changes via proposals; watcher re-index |
| Cost creep from chat history | Compaction policy, sweep conversation separate from chat, budget caps |
| Vendored packages drift from upstream | Record source SHA in `NOTICE.md`; review upstream when upgrading pi-durable |
| pi-durable stalls or breaks | Isolation in `packages/durable-agent`; Mastra is the most mature TypeScript fallback |

---

## 19. Open items before v0.0

- [ ] Docker: start daemon, add user to `docker` group (`sudo systemctl enable --now docker`, `sudo usermod -aG docker dlos`, re-login)
- [ ] `OPENROUTER_API_KEY` (covers models + Jev); confirm current model IDs + prices
- [ ] Contact email for OpenAlex/Crossref polite pools; optional Semantic Scholar API key
- [ ] First project brief (markdown) to test with

---

## 20. Technology review (2026-10-22)

Each choice was checked against current alternatives; ✅ = kept, 🔄 = changed by this review.

| Job | Choice | Alternatives considered | Verdict |
|---|---|---|---|
| Durable agent runtime | pi-durable 1.1.0 (via vendored `durable-agent`) | Mastra (most complete TS stack; durable agents still beta), LangGraph.js (most production-proven), Inngest/Temporal (durability layers, need an agent loop on top) | ✅ Kept: the reference implementation and its Jev integration are proven on it; isolated so Mastra is a viable fallback |
| Codebase start | Fresh repo + vendored `durable-agent`, `jev` | Full fork of the news agent | 🔄 Changed: fork would delete/rewrite ~70% |
| LLMs | OpenRouter: Haiku 5.5 / Sonnet 5.5 | Direct Anthropic API | ✅ Kept per user choice; Haiku 5.5 verified at $0.10/$0.50 per M; `:batch` variants available |
| Bulk decisions | Jev `typesafe/jev-1.14` via OpenRouter | Local zero-shot (GLiClass, DeBERTa), Laya (needs fine-tuning) | ✅ Kept; 🔄 pinned version, 30 KB input cap (long-context mode above ~32 KB), alpha API noted |
| Embeddings | One OpenRouter embedding model (`qwen/qwen3-embedding-8b`) | SPECTER2 via Semantic Scholar | 🔄 Changed: S2 keyless pool returned 429 on every request; one model gives comparable vectors for all sources |
| Paper metadata & citations | OpenAlex (+ Crossref) | Semantic Scholar | 🔄 OpenAlex primary (keyless, verified live, has `is_retracted`); S2 optional |
| HTTP server | Express 5 | Fastify, Hono (2–3× faster) | ✅ Kept: single-user local service, reused Express infra code |
| UI | Vue 3 + Vite | React | ✅ Kept: reference UI patterns are Vue |
| Database | `node:sqlite` + FTS5 + `sqlite-vec` | Postgres + pgvector, Qdrant, Neo4j | ✅ Kept; **tested locally**: FTS5 BM25 and sqlite-vec v0.1.9 KNN work on Node 26 with `allowExtension` |
| Knowledge base | Obsidian-compatible markdown vault | Vector-DB RAG, graph DB | ✅ Kept: matches the 2026 "LLM wiki" pattern; BM25 over markdown benchmarked well |
| Knowledge base viewer (v0.5) | Ignis: real Obsidian UI as a self-hosted web app, in an iframe tab, hub theme | linuxserver/obsidian (streamed desktop: laggy, heavy), Quartz (read-only), own Library view only | 🔄 New: user wants Obsidian in the browser, all on the server; pending a 30-minute trial |
| Graph view (v1) | Cytoscape.js | sigma.js (WebGL, large graphs), G6 | ✅ Kept for hundreds of nodes; sigma.js if graphs grow to thousands |
| PDF → markdown (v1) | Structured sources first; Docling for PDFs | Marker (GPU), MarkItDown (shallow), GROBID (no math) | 🔄 New: Docling as the leading option, decided in v1 |
| Spec process | OpenSpec 1.14.3, layered changes | Plain PLAN.md | ✅ Kept; all six v0 changes pass `openspec validate --strict` |
