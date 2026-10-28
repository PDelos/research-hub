## Context

The charter (questions with ids Q1…Qn and weights, concepts, sub-areas, queries with weights, out-of-scope topics) is
read fresh by every sweep. Judgments nudge per-question and per-query weights in the `weights` table on top of the
charter's base weights (`feedback.replay()` recomputes them for a new version). Cards record `matched_question`;
`sweep_papers.queries_json` records which charter queries found each paper. The digest is built from records without
an LLM call (spec daily-cycle).

## Decisions

### D1. `rh.knowledge` (core, topic knowledge)
Depends on rh.charter, rh.feedback, rh.kb, rh.decision-jev, rh.provider-openrouter. Tables `p_rh_knowledge__reviews`
(report JSON, cost, created) and `__proposals` (review, kind, change JSON, evidence JSON, status proposed / approved /
rejected / stale / undone, base charter version, applied version, reason, created, decided). Settings: `enabled`
(true), `windowDays` (28), `maxDirections` (3), `minPromise` (0.5). The digest calls `review()` before it builds (the
LLM call happens in the review, not in the digest); a failure leaves the digest without new proposals. Open proposals
of the same kind and target are replaced, not duplicated.

### D2. Evidence rules (deterministic)
Window `windowDays`. Weight drift: `weights` rows of kind question or query with |value − base| ≥ 0.25 → kind
`weight` {target, from: base, to: value rounded to 0.05, clamped 0.1–2}. Retire: ≥ 8 judged cards with
`matched_question` = Qk, none 👍/⭐, more than 3 questions → kind `retire-question`. Drop query: ≥ 10 papers that
became cards with the query in `queries_json`, none liked, more than 5 queries → kind `drop-query`. Evidence lists
the counts and up to 5 paper titles with verdicts.

### D3. Directions from the review model
One `rh.models.complete` call (job `review`) with a system prompt marked `knowledge-review` and an evidence pack:
the charter; up to 20 liked papers (title, matched question, reason) and 20 disliked (title, reason kind, reason);
digest comments in the window; up to 20 desk questions (user inputs); liked papers with no matched question; up to
10 open questions from KB notes. Answer: JSON `{directions: [{question, why, paperIds, queries}], outOfScope:
[{topic, why, paperIds}]}`. Validation: question ≤ 300 chars, 1–3 queries ≤ 120 chars, paper ids must exist, at most
`maxDirections` and 2. Jev `question-promise` (noul) per direction with the charter's questions, the direction and
the titles of its papers: specific, answerable from the literature, not covered by a current question, fits the
user's level. Kept at ≥ `minPromise`; kind `add-question` {text, queries}. Out-of-scope topics need at least 2
"off topic" 👎 papers among their paper ids; kind `add-out-of-scope` {topic}. Offline: a faux rule answers from the
evidence (most frequent liked-title term) so the loop runs without keys.

### D4. Applying a proposal
`Charters.approveVersion(charter, "user")` validates with stable ids and inserts the next approved version without
touching an open draft. Changes: weight → set the target's weight; retire-question → remove it (other ids unchanged);
drop-query → remove it; add-question → append with the next free id (if 7 questions exist, refused: "retire one
first") and append its queries while under 20; add-out-of-scope → append. A target that no longer exists → stale.
Then `feedback.replay()` and `kb.syncVault()`; event `charter.changed`. Undo: allowed while the applied version is
the latest; approves the base charter body as a new version.

### D5. Stable ids
`validateCharter(input, { keepIds: true })` keeps ids of the form `Q<n>` when unique and assigns `Q<max+1>` to
questions without one; without the option it renumbers as before (the charter writer's drafts).

### D6. UI and API
`GET /v1/knowledge` (latest reviews, open and decided proposals), `POST /v1/knowledge/review`,
`POST /v1/knowledge/proposals/:id/{approve,reject,undo}`. Digest section `knowledge`: the period's proposals with
Approve / Reject (open) or their outcome. Charter tab: a Proposals section with the same actions.
A charter rewritten through a draft (the charter writer, the user's edit) is renumbered as before: it is a new
direction, and its questions are matched afresh.
