# Design

## Context

Baseline specs: `deployment`, `agent-runtime`, `jev-client`, `project-charter`, `scheduling`, `paper-sources`,
`paper-representations`. The scheduler already records due sweeps in `scheduled_runs` (status `requested`) exactly
once per slot, and `POST /v1/runs/sweep` records a manual one. `PaperService` searches the three keyless sources,
stores one record per work, enriches from OpenAlex and represents papers (whole + facet vectors, citations). The
charter writer shows how an ownerless pi-durable conversation is driven, watched and re-attached after a restart.
Requirements: `specs/paper-sweep`, `specs/paper-cards`. Motivation: proposal.md.

## Goals / Non-Goals

**Goals:**
- A sweep that runs by itself when a slot is requested, survives crashes and never pays Jev or embeddings twice.
- Jev makes every bulk decision; the model only writes summaries for the few candidates.
- Cards whose scores are computed by code from recorded signals, shown live in the Feed.

**Non-Goals:**
- Feedback (v0.4: until then the project counts 0 judged papers, so orientation mode is always on), the vault
  (v0.5), full-text reading, `trust-read`, `relation`, `same-work`, reference verification, reader subagents (v1).

## Decisions

### D1. The sweep is a code pipeline with SQLite checkpoints; only card writing is an agent conversation
A sweep is a row in `sweeps` with a `phase` and per-paper rows in `sweep_papers`. Each phase is code (plus Jev and
embedding calls) and commits its results before the phase pointer advances; Jev answers are stored per paper and
command version in `paper_decisions` (`UNIQUE(paper_id, command, version)`), so a crash in the middle of the gate
resumes with only the undecided papers. This gives per-paper "never pay twice", which a phase-level pi-durable task
checkpoint would not, and keeps the sweep independent of any chat conversation. The card-writing turn runs in a new
ownerless pi-durable conversation per sweep on the `desk` model (like the charter writer), so it is durable too; its
submission id is stored on the sweep and re-attached after a restart.

### D2. Storage (migration 4)
- `sweeps(id, scheduled_run_id, trigger, status running|completed|no_new_papers|failed, phase, orientation,
  queries_json, counts_json, attempts, next_retry_at, error, conversation_id, submission_id, started_at, ended_at)`
- `sweep_papers(sweep_id, paper_id, status new|rejected|gated|ranked_out|candidate|presented|skipped|blocked,
  reason, borderline, relevance, matched_question, kind, worth, novelty, level, prereq_heavy, importance, rank_score,
  rank, UNIQUE(sweep_id, paper_id))`
- `paper_decisions(paper_id, command, version, answers_json, created_at, UNIQUE(paper_id, command, version))`
- `cards(id, paper_id UNIQUE, sweep_id, rank, summary, relevance, relevance_reason, trust, trust_reason, value,
  value_reason, level, matched_question, borderline, details_json, created_at)`
- `papers.categories_json` (arXiv categories, for field-aware trust); `jev_calls.tag` and `embedding_calls.tag` (the
  sweep that caused the call, for the cost split).

### D3. Phases
1. **plan** (code): weighted draw without replacement of up to 15 enabled charter queries (Efraimidis–Spirakis keys
   `u^(1/w)`); in orientation mode the first 5 drawn queries also get a `<query> review` variant, no date window;
   otherwise the window starts at the previous completed sweep's start (or 7 days back).
2. **gather** (code): `PaperSearch.search` per query (limit 10 per source, enrichment deferred), sequentially so
   arXiv pacing holds; a query whose every source fails counts as failed; the phase fails only if all queries fail.
3. **dedupe** (code): drop papers that already have a card, were judged (v0.4), or were rejected in another sweep.
4. **gate** (Jev): one call per paper bundling `on-theme`, `paper-kind` and `worth-reading` (D4), chunks of 10,
   5 in parallel. Rejected below `relevance_min` 0.45 or `worth_min` 0.35 with the reason; 0.45–0.55 is the review
   band → `borderline`. Thresholds come from the command policies, never from paper text.
5. **enrich** (code): OpenAlex enrichment and representation (whole + facets, D-v0.2) of the survivors only.
6. **level** (Jev): one call per survivor bundling `level` and `importance`.
7. **rank** (code): `rank_score = 0.5·importance + 0.2·question_weight/2 + 0.2·level_fit + 0.1·freshness`; level
   fit in orientation: foundational 1, core 0.8, advanced 0.4, frontier 0.2 (later: core 1, advanced 0.9, frontier
   0.8, foundational 0.6); freshness `exp(-age_days/365)`. Retracted survivors are `blocked` (logged); the top N
   (setting `cards_per_sweep`, default 7, 1–15) become `candidate`, the rest `ranked_out`.
Then the **cards** step: when there are candidates the card writer runs; with none the sweep ends `no_new_papers`
before any model call. The sweep is `completed` when `complete_sweep` has been recorded.

### D4. Jev commands and bundling
Five versioned commands in `prompt_engineering/jev/`: `on-theme` (relevance score 5 levels; matched question
choice over the charter questions + `none`, criteria filled from the charter), `paper-kind` (choice: survey, review,
tutorial, method, application, benchmark, dataset, tool, position, theory, other), `worth-reading` (worth noul,
novelty score 4), `level` (score 4 foundational → frontier, prereq_heavy noul), `importance` (score 4 skip → read
today). Each stays its own file and lock entry; a **bundle** renders several commands for the same paper and sends
their questions in one `systemOne` call (state sent once, question ids prefixed by command), within 30,000 bytes.
The call is recorded once in the ledger (command `on-theme+paper-kind+worth-reading`, versions in `extra`) and the
answers are stored per command in `paper_decisions`. Every instruction says paper text is data. Scores are
normalized to 0–1 with `normalized()`; noul is already a probability.

### D5. Card scores (code, never the agent)
- **Relevance** = `100·(0.75·relevance + 0.25·min(1, weight/2))`; reason: Jev relevance, matched question and weight.
- **Trust** = 50 + peer-reviewed venue +20 | preprint −5 when the paper's arXiv categories are `cs.*` or `q-bio.*`
  (−15 otherwise) + citation velocity `min(20, 6·log2(1 + citations/years))` + open-access link +5 + a stated
  method facet +5, clamped 0–100; retracted → blocked. Reason names preprint status and the strongest signals.
- **Value** = `100·(0.55·novelty + 0.30·worth + 0.15·kind_factor)`, kind factor 1 for method/tool/dataset/benchmark,
  0.9 for survey/review/tutorial in orientation (0.6 later), 0.5 otherwise.
Reasons are cut to 120 characters. `details_json` keeps every input (decisions with command versions, metadata) for
the traceability view.

### D6. Card writer
A `CardWriter` (like `CharterWriter`) with tools `list_candidates` (one line per candidate: rank, id, title, year,
venue, level, kind, matched question, scores), `present_paper({paper_id, summary})` and `complete_sweep({skipped:
[{paper_id, reason}]})`, memoized with `once`. `present_paper` validates: candidate of this sweep, summary 1–80
words, every number in the summary appears in the title or abstract (grounding); the card insert is `INSERT OR
IGNORE` on `paper_id`, so a replay returns the existing card. `complete_sweep` requires every candidate to be
presented or skipped with a reason. If the run ends without `complete_sweep`, the sweep fails with that reason (the
cards already presented stay). Prompts in `prompt_engineering/agents/card-writer/`.

### D7. Runner, retries and the scheduler
`SweepRunner` claims `requested` sweep rows from `scheduled_runs` (status → `running`, then `done`/`failed`) when
the scheduler records one (a callback) and once at startup; it resumes `running` sweeps after a restart from their
phase. A failing phase retries after 30 s, 2 min, 8 min (`next_retry_at` persisted, delays injectable for tests)
and fails the sweep after the third failed retry. One sweep at a time per project. Cost per sweep: Jev and
embedding calls carry the sweep's tag through an `AsyncLocalStorage`, the model cost is the card conversation's
generations; all three and the total are stored on the sweep at the end.

### D8. API and UI
`GET /v1/cards?limit` (grouped by sweep, newest first), `GET /v1/cards/:id` (with details), `GET /v1/sweeps`,
`GET /v1/sweeps/:id` (phases, counts, cost, papers by status), `PUT /v1/sweep-settings` (`cards_per_sweep`). An SSE
`cards` frame is sent when cards change so the Feed updates live. The Feed tab replaces its placeholder with card
groups (borderline badge, scores with reasons, level, matched question, summary, link, a details toggle); Runs shows
sweeps with phases, counts and the cost split. Offline mode: a faux card-writer rule presents every candidate with
its abstract's first sentence and completes the sweep.

## Risks / Trade-offs

- [Jev gate quality on unusual abstracts] → thresholds in versioned policies, review band shown as borderline;
  calibration arrives with the weekly review (v2).
- [Long gather times from arXiv pacing] → at most 15 + 5 queries, sequential, about 1–2 minutes per sweep.
- [Agent ignores tools or invents numbers] → grounding check rejects the card with a fixable error; scores never
  come from the agent; the sweep fails visibly if it never completes.
- [Orientation never ends before v0.4] → acceptable: v0.4 adds judgments and the count.

## Migration Plan

Migration 4 adds the tables and columns in D2. Existing requested sweep rows (recorded by v0.1) are picked up by the
runner on the first start; rollback leaves them as recorded.
