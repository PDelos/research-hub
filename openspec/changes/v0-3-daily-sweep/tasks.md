# Tasks

## 1. Storage and commands

- [ ] 1.1 Add migration 4 (sweeps, sweep_papers, paper_decisions, cards, papers.categories_json, jev_calls.tag, embedding_calls.tag) and store arXiv categories from the arXiv client; verify a migration test from version 3 and a test that arXiv categories are stored
- [ ] 1.2 Add the five Jev commands (`on-theme`, `paper-kind`, `worth-reading`, `level`, `importance`) with policies and the data-only instruction, update the lock, and implement command bundling (one call, answers split per command, stored in paper_decisions, reused when present); verify bundle tests with the mock Jev and `npm run check:jev`
- [ ] 1.3 Add cost tags (AsyncLocalStorage) recorded on Jev and embedding calls; verify a test that calls inside a tagged scope carry the tag and others do not

## 2. Sweep pipeline (spec: paper-sweep)

- [ ] 2.1 Implement the plan phase (weighted draw of up to 15 queries, orientation variants and window); verify the 100-sweep weighted-draw test and the orientation test
- [ ] 2.2 Implement gather and dedupe (seen-before papers dropped without Jev); verify a test with yesterday's rejected paper
- [ ] 2.3 Implement the gate with thresholds, reasons and the review band; verify off-topic (0.2 → "below relevance_min 0.45"), borderline and injection tests
- [ ] 2.4 Implement enrich, level and rank (blocked retracted, top N candidates, ranked out); verify the 30-survivors/N=7 test and a level test
- [ ] 2.5 Implement the runner: phase records and counts, resume after restart, retries 30 s / 2 min / 8 min then failed, `no_new_papers`, scheduler hand-off and scheduled_runs status, cost split; verify crash-in-gate (one set of decisions per paper), persistent-failure and empty-sweep tests

## 3. Cards (spec: paper-cards)

- [ ] 3.1 Implement score computation (Relevance, Trust with field-aware preprint penalty, Value) with reasons ≤ 120 characters and details; verify the AI-preprint test and traceability fields
- [ ] 3.2 Implement the card writer (conversation, tools, grounding check, one card per paper, completion with skipped reasons, re-attach after restart) and its prompts; verify faux-agent tests for a complete card, no invented numbers, replay, a skipped candidate, and the retracted block
- [ ] 3.3 Add the API routes, the SSE `cards` frame and SDK methods; verify API tests (cards grouped newest first, card details, sweep detail with cost split)
- [ ] 3.4 Build the Feed view (card groups, borderline badge, scores with reasons, details toggle, live updates) and sweep details in Runs; verify `npm run build` and a UI test that the page serves

## 4. Integration

- [ ] 4.1 Offline end-to-end: approve a charter, trigger a sweep, get cards through the UI proxy; run all tests, `npm run check`, `check:jev`, `check:env`, lint and `npm audit`; verify all pass
- [ ] 4.2 Live check (keyless sources, Jev and embeddings at a few cents at most; cards on a free model): one sweep on a real charter; record counts per phase, gate rejections with reasons, the cards, and the cost split
- [ ] 4.3 Update `README.md` (daily sweep, cards, settings); verify the documented commands work
