## 1. Light image

- [x] 1.1 Resolve every on-disk path from one `appDir()`; reach built-in plugin code through a static module map; verify all tests pass and the offline e2e passes
- [ ] 1.2 Bundle the server with `vp pack` (tsdown) into `apps/rh-server/dist/server.mjs` with only `sqlite-vec` external and the unused provider SDKs left out; verify the bundle starts offline, chats, sweeps and serves the UI
- [ ] 1.3 Dockerfile stages `lite` (default, `RH_KB_VIEWER=off`) and `obsidian` (adds Ignis); `new-project.sh --obsidian`; verify the lite image is under 300 MB and runs the offline e2e inside the container

## 2. Viewer choice

- [ ] 2.1 `rh.kb` chooses the active viewer (saved setting, else Obsidian when it can run, else Library); the contributions route and UI use it; the idle Obsidian viewer says why; verify tests for the light-image fallback, an explicit choice and the existing swap tests

## 3. Scheduler and the sweep's settings

- [ ] 3.1 Migration 7 (`nightly` run kind), nightly slots at `RH_NIGHTLY_TIME` (default 02:00) in the schedule settings and UI, the review shown as the weekly digest; verify scheduling tests for the nightly slot (exactly once, catch-up) and the updated storage version
- [ ] 3.2 `rh.sweep` settings `cardsPerSweep` and `explorationPicks` (live, with the v0 value carried over), `/v1/sweep-settings` on top of them; verify the v0 sweep-settings tests and a settings change without restart

## 4. Undo

- [ ] 4.1 `PluginState.revert(commit)` and kernel undo with conflict refusal; `POST /v1/plugins/undo` and the SDK method; verify tests for undoing one of two changes, a refused conflicting undo, and undo of an install

## 5. The cycle

- [ ] 5.1 Exploration picks in the rank phase (cosine to liked papers, recorded, `exploration` on cards); verify tests for a pick, no pick without judgments, and `explorationPicks: 0`
- [ ] 5.2 The `rh.digest` plugin: nightly figures, the weekly digest (sections of D5, no LLM call), comments with `digest.comment` events, cycle status, `GET /v1/cycle`, `GET /v1/digests[/:id]`, `POST /v1/digests/:id/comments`; verify tests for a simulated offline week (7 sweeps, 7 nightly runs, 1 digest, each once), digest contents and carried-forward comments
- [ ] 5.3 UI: the Digest tab (sections, changes with Undo, comments), the cycle status line, the Exploration badge on cards; verify `npm run build`, Playwright tests (digest renders, undo from the digest, comment saved) and light/dark screenshots

## 6. Integration

- [ ] 6.1 All tests, checks, audit, the offline e2e (now including a nightly run, a digest, a comment and an undo) and the UI tests
- [ ] 6.2 Images: build `research-hub:latest` (lite) and `research-hub:obsidian`; record sizes; start `proteins` on the image the user wants (ask; default the Obsidian add-on so nothing changes for it) and check the cycle status and digest in the container
- [ ] 6.3 README (light image and add-on, the daily cycle, the Digest tab, undo), PLAN/EVOLUTION status
