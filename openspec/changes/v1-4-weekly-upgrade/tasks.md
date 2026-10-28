## 1. Foundations

- [x] 1.1 Embedder settings `model`/`dims` with env defaults, live change (`embedder.changed`), the delegating embedder in rh.papers with table resize, re-sync and catch-up; native-size embeddings for benchmarks; verify a live switch re-embeds without restart and existing tests pass
- [x] 1.2 `research` in rh.provider-openrouter (OpenRouter web plugin; unavailable offline unless a test fetch is injected); verify with a fake OpenRouter

## 2. The upgrade plugin

- [ ] 2.1 `rh.upgrades`: tables, settings, nightly trigger when due, manual run, Jev `upgrade-focus` with rotation fallback; verify due/not-due and focus tests
- [ ] 2.2 Ranking procedure (analysis, grid, replays, apply with undo or nothing); verify with seeded judgments that a winner is applied and undoable, and that no winner changes nothing
- [ ] 2.3 Embedder procedure (catalog, shortlist, cost cap, benchmarks, proposal, approve/reject); verify offline with a fake catalog and research answer
- [ ] 2.4 Scout procedure (suggestions, dismiss); verify with a fake research answer

## 3. API and UI

- [ ] 3.1 Routes `/v1/upgrades`, `/v1/upgrades/run`, `/v1/proposals/:id/{approve,reject}`, `/v1/suggestions/:id/dismiss`, SDK; the digest's Upgrade section; verify API tests
- [ ] 3.2 The Upgrades tab and the digest section; verify build and Playwright tests

## 4. Integration

- [ ] 4.1 All tests, checks, audit, offline e2e (an upgrade run), UI tests, bundle and light image; one live upgrade run of each focus on a throwaway project (cost recorded)
- [ ] 4.2 README, PLAN/EVOLUTION; archive
