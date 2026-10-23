# Tasks

## 1. Storage and judgments

- [x] 1.1 Add migration 5 (judgments, weight_effects, weights, rule_candidates, kb_requests, sweep_papers.queries_json) and record the queries that found each paper in gather; verify a migration test from version 4 and a gather test
- [x] 1.2 Implement judgments (set, change, clear; reason ≤ 1,000 characters), the ⭐ hand-off (one request, cancel on un-star) and dedupe of judged papers; verify star-with-reason, star-twice, un-star cancels, and found-again tests
- [x] 1.3 Implement weight replay (steps, clamping, charter base, sources) with weight_effects, and use effective weights in plan, rank and Relevance; verify the clamp, 👍-then-👎 and visible-change tests and that a judged query is drawn with its new weight

## 2. Jev

- [x] 2.1 Add the `reason-parse` command and classification (candidate ≥ 0.7, unclassified 0.4–0.7, pending on failure, retried); verify rule-candidate, unclassified and Jev-down tests and `npm run check:jev`
- [x] 2.2 Add taste examples (8 most recent, reasons ≤ 200 characters) to the paper-decision commands; verify that the next gate's recorded Jev input contains a judgment made before it

## 3. Channels and metrics

- [ ] 3.1 Add the judgment routes, precision@5 (`GET /v1/feedback/precision`), weights (`GET /v1/weights`), card views with the verdict and weight effects, SDK methods; verify API tests including the precision example (2 ⭐, 1 👎, 2 unjudged → 67%, 3 of 5 judged)
- [ ] 3.2 Add the desk tools `recent_cards` and `judge_card` and two desk-prompt lines; verify a faux-agent test for "star the second card, great foundation"
- [ ] 3.3 Build the UI: judge buttons and reason box on cards, verdict shown, weight changes in details, precision trend in the Feed, weights table in Settings; verify `npm run build` and the UI test

## 4. Integration

- [ ] 4.1 Run all tests, `npm run check`, `check:jev`, `check:env`, lint and `npm audit`; offline end to end: judge cards and see weights, precision and the next sweep change
- [ ] 4.2 Live check (Jev `reason-parse` and a sweep with taste examples; chat on a free model): judge a few live cards with reasons including one rule-like reason, ask the desk to star a card, run a second sweep; record classifications, weight changes, the taste examples in the gate input, precision and cost
- [ ] 4.3 Update `README.md` (judging, weights, precision, rule candidates); verify the documented commands work
