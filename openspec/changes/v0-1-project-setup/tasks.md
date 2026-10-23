# Tasks

## 1. Storage and status

- [x] 1.1 Add `project.sqlite` migration 2 (`charters`, `scoping_questions`, `scheduled_runs` with UNIQUE(kind, slot)); verify a migration test from version 1 keeps existing telemetry rows
- [x] 1.2 Implement derived project status (D1) with stored `paused`; verify unit tests for each status and that pausing remembers the status to return to

## 2. Brief (spec: project-charter)

- [x] 2.1 Add `GET/PUT /v1/brief` storing `brief.md` (UTF-8 markdown ≤ 50,000 characters); verify tests for a valid brief (status `charter-review` once a draft exists), a 60,000-character brief (400 naming the limit, nothing stored) and a fresh project reporting `needs-brief`
- [x] 2.2 Replacing the brief after approval starts a new draft while the approved charter stays in force; verify a test

## 3. Charter drafting (spec: project-charter)

- [x] 3.1 Define the charter schema and validator (D3) shared by the agent tool and the edit route; verify tests for every bound with exact messages, including "questions: 9 given, 3 to 7 allowed"
- [x] 3.2 Add the `charter-writer` extension, its system prompt and the tools `save_charter_draft` and `ask_scoping_questions` (`onceInCommit`, 5-question total cap); verify tool tests including a replay that records the draft once and a rejected sixth question
- [x] 3.3 Create the charter conversation on the first brief with the `review` model and submit the draft run; mark the run failed if it ends without a saved draft; verify a faux test where a brief yields a Q1..Qn draft plus questions, the chat transcript has no drafting messages, and telemetry shows the `review` model
- [x] 3.4 Prove the correction loop: a faux rule saves an invalid draft, gets the tool error, then saves a valid one; verify only the valid draft is stored, and 3 invalid saves mark the run failed with `POST /v1/charter/retry` working
- [x] 3.5 Add `POST /v1/charter/answers` storing answers and submitting one revision run; verify a faux test where answering "clinical applications are out of scope" yields a draft listing it under out-of-scope
- [x] 3.6 Add `GET/PUT /v1/charter` and `POST /v1/charter/approve` with versioning; verify tests that approval sets status `active`, an edit plus approval creates version 2, and version 1 stays readable

## 4. Pause and overview (spec: project-charter)

- [x] 4.1 Add `POST /v1/project/pause` and `/resume`; verify tests that scheduled runs stop while paused and chat still works
- [x] 4.2 Add `GET /v1/project` overview (name, status, charter version, next sweep and review, cost this month); verify a test for an active and a paused project

## 5. Scheduling (spec: scheduling)

- [x] 5.1 Implement the time-zone slot helper with `RH_TIMEZONE`, `RH_SWEEP_TIME`, `RH_REVIEW_TIME`; verify fixed-clock tests including a DST change in Europe/Madrid, and add the variables to `.env.example` (`npm run check:env` passes)
- [x] 5.2 Add schedule settings with environment defaults and `GET/PUT /v1/schedule`; verify tests that `RH_SWEEP_TIME=06:20` shows "daily 06:20", turning the sweep off survives a restart, and saved settings override the environment
- [x] 5.3 Implement the ticker (every 60 s and at startup) recording requested runs with the unique slot key; verify tests for two ticks in one slot (one record) and a restart inside a slot (no second request)
- [x] 5.4 Implement catch-up and eligibility (D5); verify fixed-clock tests: two days down → one request plus a skipped record; charter not approved → skipped "charter not approved"; paused at slot time → skipped "project paused" and nothing caught up after resuming
- [x] 5.5 Add manual triggers (`POST /v1/runs/{sweep,review}`) and the one-active-run rule; verify a manual sweep at 05:30 does not block the 06:00 slot and a request while one is `running` is skipped "sweep already running"
- [x] 5.6 Add `GET /v1/scheduled-runs`; verify a test listing requested and skipped runs with reasons

## 6. UI (spec: project-charter, scheduling)

- [ ] 6.1 Add the brief screen (paste or `.md` upload, character counter) and the top-bar overview with pause/resume; verify `npm run build` and an HTTP test that the built page loads
- [ ] 6.2 Add the Charter tab (draft/approved view, version picker, scoping questions with answers, inline edits, Approve, Retry); verify `npm run build` and a manual offline check with a faux charter
- [ ] 6.3 Add the Settings tab (schedule) and the scheduled-run log in the Runs tab; verify `npm run build`
- [ ] 6.4 Update `README.md` (brief → charter flow, schedule, new routes and variables); verify the documented commands work

## 7. Integration

- [ ] 7.1 Run all offline tests, `npm run check`, `npm run check:jev`, `npm run check:env`, lint and `npm audit`; verify all pass
- [ ] 7.2 Live check (only with `OPENROUTER_API_KEY` and the user's approval to spend): submit a real brief, let Sonnet 5.5 draft the charter, answer its questions, approve; record cost and any schema corrections in the change notes

## Workflow follow-up

- Run `openspec validate v0-1-project-setup --strict` before applying.
- Apply only after v0.0 task group 8 (one project per container) is done.
- After implementation and review, archive the change so `openspec/specs/` gains `project-charter` and `scheduling`.
