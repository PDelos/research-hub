# Tasks

## 1. Storage and commands

- [x] 1.1 Add migration 4 (sweeps, sweep_papers, paper_decisions, cards, papers.categories_json, jev_calls.tag, embedding_calls.tag) and store arXiv categories from the arXiv client; verify a migration test from version 3 and a test that arXiv categories are stored
- [x] 1.2 Add the five Jev commands (`on-theme`, `paper-kind`, `worth-reading`, `level`, `importance`) with policies and the data-only instruction, update the lock, and implement command bundling (one call, answers split per command, stored in paper_decisions, reused when present); verify bundle tests with the mock Jev and `npm run check:jev`
- [x] 1.3 Add cost tags (AsyncLocalStorage) recorded on Jev and embedding calls; verify a test that calls inside a tagged scope carry the tag and others do not

## 2. Sweep pipeline (spec: paper-sweep)

- [x] 2.1 Implement the plan phase (weighted draw of up to 15 queries, orientation variants and window); verify the 100-sweep weighted-draw test and the orientation test
- [x] 2.2 Implement gather and dedupe (seen-before papers dropped without Jev); verify a test with yesterday's rejected paper
- [x] 2.3 Implement the gate with thresholds, reasons and the review band; verify off-topic (0.2 → "below relevance_min 0.45"), borderline and injection tests
- [x] 2.4 Implement enrich, level and rank (blocked retracted, top N candidates, ranked out); verify the 30-survivors/N=7 test and a level test
- [x] 2.5 Implement the runner: phase records and counts, resume after restart, retries 30 s / 2 min / 8 min then failed, `no_new_papers`, scheduler hand-off and scheduled_runs status, cost split; verify crash-in-gate (one set of decisions per paper), persistent-failure and empty-sweep tests

## 3. Cards (spec: paper-cards)

- [x] 3.1 Implement score computation (Relevance, Trust with field-aware preprint penalty, Value) with reasons ≤ 120 characters and details; verify the AI-preprint test and traceability fields
- [x] 3.2 Implement the card writer (conversation, tools, grounding check, one card per paper, completion with skipped reasons, re-attach after restart) and its prompts; verify faux-agent tests for a complete card, no invented numbers, replay, a skipped candidate, and the retracted block
- [x] 3.3 Add the API routes, the SSE `cards` frame and SDK methods; verify API tests (cards grouped newest first, card details, sweep detail with cost split)
- [x] 3.4 Build the Feed view (card groups, borderline badge, scores with reasons, details toggle, live updates) and sweep details in Runs; verify `npm run build` and a UI test that the page serves

## 4. Integration

- [x] 4.1 Offline end-to-end: approve a charter, trigger a sweep, get cards through the UI proxy; run all tests, `npm run check`, `check:jev`, `check:env`, lint and `npm audit`; verify all pass
- [x] 4.2 Live check (keyless sources, Jev and embeddings at a few cents at most; cards on a free model): one sweep on a real charter; record counts per phase, gate rejections with reasons, the cards, and the cost split
- [x] 4.3 Update `README.md` (daily sweep, cards, settings); verify the documented commands work

## Verification notes

- 4.1 (2026-10-23): offline end to end through the UI proxy (brief → charter with 2 scoping questions answered →
  approved v1 → manual sweep: 249 gathered, 7 cards, no errors). 132 server tests, 35 durable-agent, 24 SDK pass;
  `npm run check`, `check:jev`, `check:env`, lint (no new warnings) and `npm audit` (0 vulnerabilities) pass.
- 4.2 live check (2026-10-23), live sources, Jev and embeddings; charter, chat and cards on
  `nvidia/nemotron-3.5-lightning:free`; no `CONTACT_EMAIL`. The free model drafted a charter (5 questions, 10 queries,
  out of scope: clinical drug discovery) from a brief on protein language models; approved; manual sweep:
  - plan 15 queries + 5 review variants (orientation); gather 254 (no failed query, 42 s); dedupe 0 dropped;
    gate 139 passed, 115 rejected (98 "below relevance_min 0.45", e.g. pathology foundation models at 0.06;
    17 "below worth_min 0.35"), 45 borderline; enrich: the first attempt timed out on an embedding batch and the
    30 s retry succeeded without repeating any Jev call; level 139 (8 foundational, 9 core, 66 advanced, 56 frontier);
    rank 7 candidates; cards: 7 presented, 0 skipped. Total 349 s.
  - Cards (orientation): two PLM surveys, "Learning the protein language" (Cell Systems), "PLMs and structure
    prediction", TAPE, "The language of proteins", ProtTrans; summaries grounded (numbers only from abstracts).
  - Cost: Jev $0.0401 (529 calls), embeddings $0.0014 (28 calls), model $0; total $0.0415.
  - Fixes from the check: facet labeling now runs in 5 parallel lanes and embedding requests allow 60 s per
    attempt; reasons cut the last part with "…" instead of dropping it; ranking adds Jev relevance (borderline
    foundational papers had outranked central ones; spec and design updated).
  - A second sweep the same day: 257 gathered, 113 dropped as seen before, 33 new Jev calls, $0.0023, 81 s, 7 new
    cards (e.g. "Transformer protein language models are unsupervised structure learners", PEER benchmark).
- 4.3: README "The daily sweep and paper cards" section, routes table, status v0.3.
