# Tasks

## 1. Registry and storage

- [ ] 1.1 Add `hub.sqlite` with the `projects` table and a registry module (create, list, get, set status with remembered previous status); verify unit tests for each status transition in design D1
- [ ] 1.2 Register an existing `projects/default/` folder as "Default" (`needs-brief`) on first start; verify a test that starts on a v0.0-style data dir and finds the project with its old conversation
- [ ] 1.3 Add `project.sqlite` migration 2 (`charters`, `scoping_questions`, `scheduled_runs` with UNIQUE(kind, slot)); verify a migration test from version 1 keeps existing telemetry rows
- [ ] 1.4 Implement slug generation (D2); verify tests for "Protein LMs" → `protein-lms`, a duplicate → `protein-lms-2`, unicode and 200-character names

## 2. Projects and briefs (spec: project-lifecycle)

- [ ] 2.1 Make `Hub` read projects from the registry instead of the `default` constant; verify the v0.0 server tests still pass and a 404 test for an unregistered slug
- [ ] 2.2 Add `POST /v1/projects` and `GET /v1/projects`, storing `brief.md` and validating UTF-8 markdown ≤ 50,000 characters; verify tests for create (201 + slug + status `drafting-charter`), a 60,000-character brief (400 naming the limit) and listing
- [ ] 2.3 Add `PUT /v1/p/:slug/brief`; verify a test that replacing the brief starts a new draft while the approved charter stays in force
- [ ] 2.4 Add pause, resume and archive (D1, D7) including 409 `project archived` on every write and chat; verify tests for each transition, chat still working while paused, and archived projects hidden from the default list
- [ ] 2.5 Add a project isolation test: messages, settings, charters and runs in project A never appear in project B, and B's cost total is unchanged

## 3. Charter drafting (spec: project-lifecycle)

- [ ] 3.1 Define the charter schema and validator (D4) shared by the agent tool and the edit route; verify tests for every bound (3–7 questions, weights 0.1–2, 5–20 queries, lengths) with exact error messages
- [ ] 3.2 Add the `charter-writer` extension, its system prompt and the tools `save_charter_draft` and `ask_scoping_questions` (`onceInCommit`, 5-question total cap); verify tool tests including a replay that records the draft once
- [ ] 3.3 Create the charter conversation on the first brief with the `review` model and submit the draft run; mark the run failed if it ends without a saved draft; verify a faux test where a brief yields a numbered Q1..Qn draft plus questions, and the run telemetry shows the `review` model
- [ ] 3.4 Prove the correction loop: a faux rule saves an invalid draft first, receives the tool error, then saves a valid one; verify only the valid draft is stored, and that 3 invalid saves mark the run failed
- [ ] 3.5 Add `POST /v1/p/:slug/charter/answers` that stores answers and submits one revision run; verify a faux test where answering "clinical applications are out of scope" yields a draft listing it under out-of-scope
- [ ] 3.6 Add `GET/PUT /v1/p/:slug/charter` and `POST /v1/p/:slug/charter/approve` with versioning (D4); verify tests that approval sets status `active`, a later edit creates version 2 and version 1 stays readable

## 4. Scheduling (spec: scheduling)

- [ ] 4.1 Implement the time-zone slot helper (`RH_TIMEZONE`, default UTC) for daily and weekly slots; verify fixed-clock tests including a DST change in Europe/Madrid, and add `RH_TIMEZONE` to `.env.example` (`npm run check:env` passes)
- [ ] 4.2 Add per-project schedule settings with defaults (sweep daily 06:00, review Sunday 07:00) and `GET/PUT /v1/p/:slug/schedule`; verify tests for defaults on a new project, turning the sweep off, and changing the weekday
- [ ] 4.3 Implement the ticker (every 60 s and at startup) recording requested runs with the unique slot key; verify tests for two ticks in one slot (one record) and a restart inside a slot (no second request)
- [ ] 4.4 Implement catch-up and eligibility rules (D6); verify fixed-clock tests: two days down → one request for today plus a skipped note; charter not approved → skipped "charter not approved"; paused at slot time → nothing requested and nothing caught up after resuming
- [ ] 4.5 Add manual triggers and the one-active-run rule; verify tests that a manual sweep at 05:30 does not block the 06:00 slot and that a request while a sweep is `running` is recorded skipped with "sweep already running"
- [ ] 4.6 Add `GET /v1/p/:slug/scheduled-runs` and the next-run calculation used by the overview; verify a test that the next run is shown only for active projects

## 5. Hub overview and UI (spec: project-lifecycle, scheduling)

- [ ] 5.1 Add `GET /v1/p/:slug` overview (name, status, charter state, next sweep and review, cost this month); verify a test with one active and one paused project
- [ ] 5.2 Add the hash router and the Hub page (project tiles, new-project dialog with paste or `.md` upload, pause/resume/archive); verify `npm run build` and an HTTP test that the built page loads
- [ ] 5.3 Add the Charter tab (draft/approved view, version picker, scoping questions with answers, inline edits, Approve) and the Settings tab (schedule); verify `npm run build` and a manual check in offline mode with a faux charter
- [ ] 5.4 Show scheduled runs (requested/skipped with reason) in the Runs tab; verify `npm run build`
- [ ] 5.5 Update `README.md` (projects, charter flow, schedule, new routes, `RH_TIMEZONE`); verify the documented commands work

## 6. Integration

- [ ] 6.1 Run all offline tests, `npm run check`, `npm run check:jev`, `npm run check:env`, lint and `npm audit`; verify all pass
- [ ] 6.2 Live check (only with `OPENROUTER_API_KEY` and the user's approval to spend): create a project from a real brief, let Sonnet 5.5 draft the charter, answer its questions, approve; record cost and any schema corrections in the change notes

## Workflow follow-up

- Run `openspec validate v0-1-projects --strict` before applying.
- After implementation and review, archive the change so `openspec/specs/` gains `project-lifecycle` and `scheduling`.
