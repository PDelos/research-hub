# Design

## Context

Built on v0.0 (`deployment`, `agent-runtime`, `jev-client`), see `openspec/changes/v0-0-skeleton`. Current state
of the code this change touches:

- `apps/rh-server/src/hub.ts` serves one hard-coded slug (`default`) and opens projects lazily.
- `apps/rh-server/src/project.ts` opens `projects/<slug>/{agent,project}.sqlite`, the research-desk root
  conversation (chat model) and telemetry.
- `project.sqlite` has migration 1 (settings, requests, telemetry). There is no hub-level database yet.
- Routes are already project-scoped (`/v1/p/:slug/…`); the UI hard-codes `PROJECT = "default"`.
- pi-durable 1.1.0 can create extra conversations with their own model and extensions
  (`harness.createConversation({ ownership: { kind: "ownerless" }, agent })`).

Requirements: `specs/project-lifecycle`, `specs/scheduling`. Motivation: proposal.md.

## Goals / Non-Goals

**Goals:**
- Projects become real: registry, brief, charter drafting with scoping questions, approval, lifecycle states.
- A scheduler that requests each project's sweep and review exactly once per slot, across restarts.
- A hub page and per-project charter and schedule screens in the UI.

**Non-Goals:**
- What a sweep or review actually does (v0.3 and v2). Here a due sweep only produces a `requested` record.
- Project deletion (archive keeps data; deleting files stays a manual operation).
- Multi-user access or per-project auth.

## Decisions

### D1. Hub registry in `hub.sqlite`, project data stays per project
`<data>/hub.sqlite` holds only the registry: `projects(slug PK, name, status, created_at, archived_at)`. Everything
else (brief, charters, scoping questions, schedule, scheduled-run records) lives in that project's own
`project.sqlite` or folder, which keeps the isolation requirement structural: a project's folder is complete on
its own. Alternative (all projects in one database) rejected: isolation would depend on query discipline.

Status values: `needs-brief` → `drafting-charter` → `charter-review` → `active`, plus `paused` and `archived`
(each remembering the status to return to). On first start after upgrading from v0.0, an existing
`projects/default/` folder is registered as "Default" with status `needs-brief`.

### D2. Slugs
Lowercase the name, replace runs of non-alphanumerics with `-`, trim to 64 characters; on collision append `-2`,
`-3`, … (spec: Duplicate name). Slugs never change after creation, even if the name does.

### D3. Brief storage
`projects/<slug>/brief.md` (UTF-8, ≤ 50,000 characters, validated before writing). Replacing the brief after the
charter is approved starts a new charter draft; the approved version stays in force until the new one is
approved.

### D4. Charter drafting in its own conversation
Each project gets a second, ownerless pi-durable conversation, the **charter writer**, created on the first brief
with the `review` model (Sonnet 5.5) and a `charter-writer` extension. Its id is stored in project settings, so
revisions keep the brief and earlier answers in context. It never shares context with the chat conversation.

The charter writer has two tools, both `onceInCommit` so a crash or replay never records twice:
- `save_charter_draft`: TypeBox-validated charter (below). Server-side checks enforce counts and ranges; a
  violation returns a tool error with the exact fix, as the news agent's `enumFeedback` does, so the model
  corrects itself.
- `ask_scoping_questions`: 1 to 5 questions, rejected once the project has asked 5 in total.

One drafting run = one submission to the charter conversation ("Brief: … Draft the charter", or "Answers: …
Revise the draft"). The run must end with a `save_charter_draft` call; the server checks this when the
submission settles and marks the run failed otherwise. Approval and edits are plain API writes, not agent work.

Charter shape (stored as JSON per version in `charters(version, status draft|approved|superseded, body_json,
created_at, approved_at, source agent|user)`):

```
questions: 3–7 × { id "Q1".., text ≤ 300 chars, weight 0.1–2 (default 1) }
concepts:  1–30 strings      subAreas: 1–15 strings
queries:   5–20 × { text ≤ 120 chars, weight 0.1–2 }
outOfScope: 0–20 strings
```

Alternative (a single structured-output completion, no agent) rejected: the conversation keeps the brief and
answers for revisions, and tool-error feedback makes schema compliance reliable without forced tool use.

### D5. Scoping questions round trip
Questions are stored in `scoping_questions(id, round, text, answer, asked_at, answered_at)`. The UI shows
unanswered questions; `POST /charter/answers` stores answers and submits one revision run with all answers of
that round. The first draft is saved together with its questions, so the user always sees a draft, never an
empty screen.

### D6. Scheduler
An in-process ticker runs every 60 s (spec: ≤ 5 min) and once at startup. For each registered project it
computes, in the hub time zone (`RH_TIMEZONE`, default `UTC`, IANA name), the latest due slot per kind:
`sweep:YYYY-MM-DD` for the daily time, `review:YYYY-Www` for the weekly day and time. A run is recorded by
`INSERT … ON CONFLICT DO NOTHING` into `scheduled_runs(id, kind, slot UNIQUE(kind, slot), trigger
scheduled|manual, status requested|running|done|failed|skipped, reason, created_at)`. The unique key is what
makes it exactly once across ticks, restarts and races.

- **Catch-up:** only the latest due slot is requested; earlier missed slots since the last recorded one are
  recorded once as `skipped` with reason `missed while the hub was down`.
- **Not eligible** (charter not approved, project paused or archived): the latest slot is recorded `skipped` with
  the reason (`charter not approved`, `project paused`), except paused/archived slots are not caught up after
  resuming: resuming stores `resumed_at`, and slots before it are ignored.
- **Manual:** slot `manual:<timestamp>` with trigger `manual`; it never occupies the scheduled slot.
- **One active run per kind:** if a record of that kind is `running`, a new request is recorded `skipped`
  with `sweep already running`. In v0.1 nothing moves a record to `running` (sweeps arrive in v0.3), so
  `requested` is where it stops.

Time-zone math uses `Intl.DateTimeFormat` with an explicit zone (no new dependency), with tests across a DST
change. Alternative (pi-durable `sleepUntil` tasks per project) rejected for the reasons in PLAN.md §2: the
slot table is simpler to inspect and the unique key gives exactly-once for free.

### D7. API

| Route | Purpose |
|---|---|
| `GET /v1/projects` · `POST /v1/projects {name, brief}` | list, create (201 with slug) |
| `GET /v1/p/:slug` | overview: name, status, charter state, next runs, cost this month |
| `PUT /v1/p/:slug/brief` | replace the brief (starts a new draft) |
| `GET /v1/p/:slug/charter` | current draft, approved version, version list, open questions |
| `PUT /v1/p/:slug/charter` | user edit of the draft (validated with the same rules) |
| `POST /v1/p/:slug/charter/answers` | answer scoping questions, triggers a revision |
| `POST /v1/p/:slug/charter/approve` | approve the current draft → new version, status `active` |
| `POST /v1/p/:slug/{pause,resume,archive}` | lifecycle |
| `GET/PUT /v1/p/:slug/schedule` | sweep time/on, review weekday/time/on |
| `GET /v1/p/:slug/scheduled-runs` · `POST /v1/p/:slug/runs/{sweep,review}` | run log, manual trigger |

Archived projects: reads work, every write and chat returns 409 `project archived`. `Hub.slugs()` reads the
registry. The `default` constant goes away except for the v0.0 migration.

### D8. UI
A small hash router (`#/` hub, `#/p/:slug/:tab`) instead of adding vue-router. Screens:
- **Hub page:** project tiles (name, status, charter state, next sweep, cost this month), pause/resume/archive,
  "New project" (name + brief: paste or upload a `.md` file).
- **Project → Charter tab:** draft or approved charter, version picker, open scoping questions with answer boxes,
  inline editing of questions, weights, queries, concepts, out-of-scope, and Approve.
- **Project → Settings tab:** schedule (times, weekday, on/off, time zone shown).
- **Runs tab** gains the scheduled-run log (requested / skipped with reason).

### D9. Faux model for tests
Offline tests script the charter writer with faux rules that call `ask_scoping_questions` and
`save_charter_draft` (including one deliberately invalid draft to prove the correction loop). Model choice is
asserted from telemetry (`review` model on charter runs, `chat` model on chat runs).

## Risks / Trade-offs

- [The model produces an invalid charter repeatedly] → tool errors name the exact violation; after 3 failed
  saves the run is marked failed and the UI offers "Retry draft" and manual editing.
- [Time zones and DST] → `Intl`-based helper with fixed-clock tests for the March and October transitions.
- [Clock jumps or a long-suspended laptop] → the unique slot key prevents duplicates; catch-up rules cap it at
  one request.
- [Charter conversation grows over many revisions] → it uses the same compaction settings as chat.
- [Ticker work blocks the event loop with many projects] → per-tick work is a few indexed queries per project;
  fine for tens of projects.

## Migration Plan

1. New `hub.sqlite`; register an existing `projects/default/` as "Default" (`needs-brief`).
2. `project.sqlite` migration 2: `charters`, `scoping_questions`, `scheduled_runs`; settings keys `schedule`,
   `charter_conversation`, `resumed_at`.
3. Rollback: v0.0 code ignores `hub.sqlite` and the new tables; the default project keeps working.
