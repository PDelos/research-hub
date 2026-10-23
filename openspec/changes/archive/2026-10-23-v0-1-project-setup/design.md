# Design

## Context

Built on v0.0 (`deployment`, `agent-runtime`, `jev-client`), see `openspec/changes/v0-0-skeleton`. By the time
this layer starts, v0.0's task group 8 has flattened the server to one project per container: storage directly in
`$RH_DATA_DIR`, routes without a project segment (`/v1/chat`, `/v1/stream`, …), `RH_PROJECT_NAME`, the data-dir
lock and `new-project.sh`. `project.sqlite` has migration 1 (settings, requests, telemetry). pi-durable 1.1.0 can
create extra conversations with their own model and extensions
(`harness.createConversation({ ownership: { kind: "ownerless" }, agent })`).

Requirements: `specs/project-charter`, `specs/scheduling`. Motivation: proposal.md.

## Goals / Non-Goals

**Goals:**
- The project gets direction: brief, charter drafting with scoping questions, approval and versions, pause.
- A scheduler that requests the sweep and review exactly once per slot, across restarts.
- A brief screen, Charter and Settings tabs, and a project overview in the UI.

**Non-Goals:**
- Several projects in one container (a new theme is a new container; see `deployment`).
- What a sweep or review actually does (v0.3 and v2). Here a due sweep only produces a `requested` record.
- Multi-user access.

## Decisions

### D1. Project status lives in `project.sqlite`
Settings key `status`: `needs-brief` → `charter-review` → `active`, plus `paused` (remembering the status to
return to). It is derived where possible (no brief → `needs-brief`; no approved charter → `charter-review`) and
stored only for `paused`, so it cannot drift from the data.

### D2. Brief storage
`$RH_DATA_DIR/brief.md` (UTF-8, ≤ 50,000 characters, validated before writing). Replacing the brief after
approval starts a new draft; the approved version stays in force until the next approval.

### D3. Charter drafting in its own conversation
A second, ownerless pi-durable conversation, the **charter writer**, is created on the first brief with the
`review` model (Sonnet 5.5) and a `charter-writer` extension. Its id is stored in settings so revisions keep the
brief and earlier answers in context; it never shares context with the chat conversation.

Its two tools are `onceInCommit`, so a crash or replay never records twice:
- `save_charter_draft`: TypeBox-validated charter. Server-side checks enforce counts and ranges; a violation
  returns a tool error naming the exact fix (as the news agent's `enumFeedback` does), so the model corrects
  itself. Three failed saves in one run mark the run failed.
- `ask_scoping_questions`: 1 to 5 questions, rejected once 5 have been asked in total.

One drafting run = one submission ("Brief: … Draft the charter" or "Answers: … Revise the draft"). The server
checks on settlement that the run saved a draft, else marks it failed and offers "Retry draft". Approval and
edits are plain API writes, not agent work.

Charter shape, stored as JSON per version in `charters(version, status draft|approved|superseded, body_json,
source agent|user, created_at, approved_at)`:

```
questions: 3–7 × { id "Q1".., text ≤ 300 chars, weight 0.1–2 (default 1) }
concepts:  1–30 strings      subAreas: 1–15 strings
queries:   5–20 × { text ≤ 120 chars, weight 0.1–2 }
outOfScope: 0–20 strings
```

Alternative (one structured-output completion, no agent) rejected: the conversation keeps brief and answers for
revisions, and tool-error feedback makes schema compliance reliable without forced tool use.

### D4. Scoping questions round trip
`scoping_questions(id, round, text, answer, asked_at, answered_at)`. The first draft is saved together with its
questions, so the user always sees a draft. `POST /v1/charter/answers` stores the answers and submits one
revision run with all answers of that round.

### D5. Scheduler
An in-process ticker runs every 60 s (spec: ≤ 5 min) and once at startup. In `RH_TIMEZONE` (IANA name, default
`UTC`) it computes the latest due slot per kind: `sweep:YYYY-MM-DD` at the sweep time, `review:YYYY-Www` at the
review weekday and time. Defaults come from `RH_SWEEP_TIME` (`HH:MM`, default 06:00) and `RH_REVIEW_TIME`
(`<weekday> HH:MM`, default `sun 07:00`); saved settings override them. A run is recorded with
`INSERT … ON CONFLICT DO NOTHING` into `scheduled_runs(id, kind, slot, trigger scheduled|manual, status
requested|running|done|failed|skipped, reason, created_at, UNIQUE(kind, slot))`: the unique key gives
exactly-once across ticks, restarts and races.

- **Catch-up:** only the latest due slot is requested; earlier missed slots since the last recorded one are
  recorded once each as `skipped` (`missed while the hub was down`).
- **Not eligible:** charter not approved → latest slot recorded `skipped` (`charter not approved`); paused →
  recorded `skipped` (`project paused`). Resuming stores `resumed_at`; slots before it are never caught up.
- **Manual:** slot `manual:<timestamp>`, trigger `manual`; it never occupies the scheduled slot.
- **One active run per kind:** if a record of that kind is `running`, a new request is recorded `skipped`
  (`sweep already running`). Nothing reaches `running` until v0.3 implements sweeps.

Time-zone math uses `Intl.DateTimeFormat` with an explicit zone (no new dependency), tested across DST changes.
Staggering between projects is configuration (`RH_SWEEP_TIME` set by `new-project.sh`), not runtime
coordination: containers never talk to each other.

### D6. API

| Route | Purpose |
|---|---|
| `GET /v1/project` | overview: name, status, charter version, next sweep and review, cost this month |
| `GET/PUT /v1/brief` | read or replace the brief (a new brief starts a draft) |
| `GET /v1/charter` · `PUT /v1/charter` | current draft, approved version, version list, open questions · user edit of the draft |
| `POST /v1/charter/answers` · `POST /v1/charter/approve` · `POST /v1/charter/retry` | answer questions · approve · retry a failed draft |
| `POST /v1/project/pause` · `POST /v1/project/resume` | lifecycle |
| `GET/PUT /v1/schedule` | sweep time/on, review weekday/time/on |
| `GET /v1/scheduled-runs` · `POST /v1/runs/{sweep,review}` | run log · manual trigger |

### D7. UI
- **Brief screen** when status is `needs-brief`: paste or upload a `.md`, with the 50,000-character counter.
- **Overview** in the top bar: project name, status badge, charter version, next sweep, cost this month,
  pause/resume.
- **Charter tab:** draft or approved charter, version picker, open scoping questions with answer boxes, inline
  editing of questions, weights, queries, concepts and out-of-scope, Approve, Retry.
- **Settings tab:** schedule (times, weekday, on/off, time zone shown).
- **Runs tab** gains the scheduled-run log (requested / skipped with reason).

### D8. Faux model for tests
Offline tests script the charter writer with faux rules that call `ask_scoping_questions` and
`save_charter_draft`, including a deliberately invalid draft to prove the correction loop. Model choice is
asserted from telemetry (`review` model on charter runs, `chat` model on chat runs).

## Risks / Trade-offs

- [The model repeatedly produces an invalid charter] → exact tool errors; after 3 failed saves the run fails and
  the UI offers Retry and manual editing.
- [Time zones and DST] → `Intl`-based helper with fixed-clock tests for the March and October transitions.
- [Clock jumps or a suspended laptop] → the unique slot key prevents duplicates; catch-up is capped at one request.
- [The charter conversation grows over many revisions] → same compaction settings as chat.

## Migration Plan

`project.sqlite` migration 2 adds `charters`, `scoping_questions`, `scheduled_runs`; settings keys `status`,
`schedule`, `charter_conversation`, `resumed_at`. An existing project without a brief starts as `needs-brief`.
Rollback: v0.0 code ignores the new tables.
