# Tasks

## 1. Storage and judgments

- [x] 1.1 Add migration 5 (judgments, weight_effects, weights, rule_candidates, kb_requests, sweep_papers.queries_json) and record the queries that found each paper in gather; verify a migration test from version 4 and a gather test
- [x] 1.2 Implement judgments (set, change, clear; reason ≤ 1,000 characters), the ⭐ hand-off (one request, cancel on un-star) and dedupe of judged papers; verify star-with-reason, star-twice, un-star cancels, and found-again tests
- [x] 1.3 Implement weight replay (steps, clamping, charter base, sources) with weight_effects, and use effective weights in plan, rank and Relevance; verify the clamp, 👍-then-👎 and visible-change tests and that a judged query is drawn with its new weight

## 2. Jev

- [x] 2.1 Add the `reason-parse` command and classification (candidate ≥ 0.7, unclassified 0.4–0.7, pending on failure, retried); verify rule-candidate, unclassified and Jev-down tests and `npm run check:jev`
- [x] 2.2 Add taste examples (8 most recent, reasons ≤ 200 characters) to the paper-decision commands; verify that the next gate's recorded Jev input contains a judgment made before it

## 3. Channels and metrics

- [x] 3.1 Add the judgment routes, precision@5 (`GET /v1/feedback/precision`), weights (`GET /v1/weights`), card views with the verdict and weight effects, SDK methods; verify API tests including the precision example (2 ⭐, 1 👎, 2 unjudged → 67%, 3 of 5 judged)
- [x] 3.2 Add the desk tools `recent_cards` and `judge_card` and two desk-prompt lines; verify a faux-agent test for "star the second card, great foundation"
- [x] 3.3 Build the UI: judge buttons and reason box on cards, verdict shown, weight changes in details, precision trend in the Feed, weights table in Settings; verify `npm run build` and the UI test

## 4. Integration

- [x] 4.1 Run all tests, `npm run check`, `check:jev`, `check:env`, lint and `npm audit`; offline end to end: judge cards and see weights, precision and the next sweep change
- [x] 4.2 Live check (Jev `reason-parse` and a sweep with taste examples; chat on a free model): judge a few live cards with reasons including one rule-like reason, ask the desk to star a card, run a second sweep; record classifications, weight changes, the taste examples in the gate input, precision and cost
- [x] 4.3 Update `README.md` (judging, weights, precision, rule candidates); verify the documented commands work

## Verification notes

- 4.1 (2026-10-23): 143 server, 35 durable-agent, 24 SDK tests pass; check, check:jev, check:env, lint (no new
  warnings), audit (0) pass. Offline end to end through the UI proxy: brief → charter → approve → sweep → ⭐ (effects
  shown: question, query, two sources 1 → 1.15), ⭐, 👎 → precision@5 2 of 3 judged (67%, as in the spec example);
  "downvote the fourth card, too advanced for now" in chat recorded 👎 with that reason; the next sweep dropped the
  7 carded papers; 3 reasons parsed; no errors.
- 4.2 live check (2026-10-23) on the live project from v0.3 (14 cards; judgments made by the implementer for the
  check, as a newcomer to protein LMs would), Jev live, chat on `nvidia/nemotron-3.5-lightning:free`:
  - Reasons classified by `reason-parse`: "Perfect overview … exactly the foundation I need" → great-foundation
    (rule 0.05); "Directly answers my question on contacts from attention maps" → great-method; "Useful, though I
    mostly care about ESM" → great-method (rule 0.34, none); "Too broad: skip general bioinformatics LLM surveys, I
    only want protein language models" → off-topic, rule 0.76 → **rule candidate**; "Viral sequences are off-topic
    for me" → off-topic, rule 0.81 → rule candidate.
  - Chat: "Please star the sixth card of the latest sweep, great benchmark to compare models." The free model called
    `recent_cards` then `judge_card`: ⭐ on PEER with that reason (great-method).
  - Bug found and fixed: overlapping background parses sent the same reasons to Jev several times (16 calls for 5
    reasons, $0.00044); parsing is now serialized (test added); afterwards 1 call per reason.
  - Weights after 7 judgments: Q2 1 → 1.25, Q1 → 1.15, Q5 → 1.1, Q4 → 0.85; sources openalex 1.2, arxiv 1.15,
    europepmc 0.7. Query weights did not move for these cards: they were gathered before v0.4 recorded the queries
    that found each paper (new sweeps record them).
  - Third sweep: every gate call carried 7 taste examples (recorded in `jev_calls.extra_json`); 261 gathered, 129
    dropped as seen before, 8 new gate calls, $0.00073, 74 s; cards led by ESM-2/ESMFold ("Evolutionary-scale
    prediction of atomic-level protein structure"), "Fine-tuning protein language models boosts predictions" and
    an ESM applications survey.
  - Precision@5: sweep 1 100% (2 of 5 judged), sweep 2 50% (2 of 5 judged), sweep 3 not judged yet.
- 4.3: README "Judging cards" section and routes.
