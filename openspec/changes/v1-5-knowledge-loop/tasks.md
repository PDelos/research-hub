## 1. Charter

- [x] 1.1 Stable ids (`validateCharter` keepIds) and `Charters.approveVersion`; verify retire keeps ids, a new question gets the next id, drafts renumber as before

## 2. The knowledge plugin

- [x] 2.1 `rh.knowledge`: tables, settings, `review()`, evidence rules (weights, retire, drop query) with evidence; verify with seeded judgments
- [x] 2.2 Directions: evidence pack, review-model call, validation, Jev `question-promise`, out-of-scope; offline faux rule; verify with a scripted answer
- [x] 2.3 Approve / reject / undo / stale into charter versions (weights replay, vault, event); verify the next sweep uses an approved question

## 3. API and UI

- [ ] 3.1 Routes `/v1/knowledge*`, SDK, the digest runs the review first and gains the section; verify API tests
- [ ] 3.2 Digest section and the Charter tab's Proposals with Approve / Reject / Undo; verify build and Playwright tests

## 4. Integration

- [ ] 4.1 All tests, checks, audit, offline e2e (a review with a proposal approved), UI tests, bundle and light image; one live review on a throwaway project (cost recorded)
- [ ] 4.2 README, PLAN/EVOLUTION; archive
