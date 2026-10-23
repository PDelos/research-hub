# Design

## Context

Baseline specs now include `paper-sweep` and `paper-cards`: sweeps store per-paper state (`sweep_papers`), Jev
decisions per paper and command version (`paper_decisions`), and cards (one per paper) with scores computed from
recorded signals. Charter questions and queries carry weights (0.1–2); the plan phase draws queries by weight, the
rank phase and the Relevance score use the matched question's weight. Orientation mode lasts while fewer than 10
papers are judged (until now always 0). Requirements: `specs/paper-feedback`. Motivation: proposal.md.

## Goals / Non-Goals

**Goals:**
- Judge cards from the UI, the API and chat; every judgment changes the next sweep through weights, dedupe and
  Jev taste examples, cheaply (one small Jev call per reason, no LLM).
- ⭐ hands the paper to the knowledge base (v0.5) exactly once; precision@5 shows whether sweeps improve.

**Non-Goals:**
- Taste rules, rule approvals and threshold calibration (v2 weekly review consumes the rule candidates).
- The vault itself (v0.5 consumes `kb_requests`).

## Decisions

### D1. Storage (migration 5)
- `judgments(card_id UNIQUE, paper_id, verdict up|down|star, reason, reason_kind, rule_probability,
  rule_status none|candidate|unclassified|pending, created_at, updated_at)`
- `weight_effects(card_id, kind question|query|source, key, before, after)`: the visible effect of each judgment.
- `weights(kind, key, base, value, UNIQUE(kind, key))`: the effective weights after replay.
- `rule_candidates(card_id UNIQUE, reason, reason_kind, probability, status open, created_at)` for the weekly review.
- `kb_requests(paper_id UNIQUE, card_id, status pending|cancelled|done, created_at, updated_at)` for v0.5.
- `sweep_papers.queries_json`: the queries that found each paper (written in gather).

### D2. Weights are replayed, never accumulated
Effective weights are recomputed from the approved charter's weights (questions by id, queries by text; sources
start at 1) by replaying the *current* judgments in time order: +0.10 for 👍, +0.15 for ⭐, −0.15 for 👎 on the
card's matched question, the queries that found the paper and its sources, clamping to 0.1–2 after every step.
Changing or clearing a judgment and replaying applies each judgment exactly once (spec: 👍 then 👎 equals one 👎),
and a new charter version replays onto its own base. The replay also writes `weight_effects` (before/after per
judgment) for the card detail and the Settings table. The sweep uses effective weights: the plan draw (queries),
rank and Relevance (question weight), and rank adds `0.05 × (average source weight − 1)`.

### D3. Judging channels
`PUT /v1/cards/:id/judgment {verdict, reason?}` and `DELETE /v1/cards/:id/judgment`; the UI calls them through the
proxy. In chat the desk gets two tools (added to `DESK_TOOLS`): `recent_cards` (the latest sweep's cards with
positions 1..N, ids and current verdicts) and `judge_card({position? | card_id?, verdict, reason?})`, which resolves
"the second card" to position 2 of the latest sweep and is memoized per call. Reasons are at most 1,000 characters.

### D4. Reason classification with Jev
`reason-parse` (versioned): `reason_kind` choice (off-topic, too-basic, too-advanced, low-trust, already-known,
great-method, great-foundation, opens-direction, other) and `generalizable` noul ("states a rule that applies to
future papers"). Policy: probability ≥ 0.7 → `candidate` (queued in `rule_candidates`), 0.4–0.7 → `unclassified`,
below → `none`. It runs after the judgment is stored; if Jev fails the judgment stays with `rule_status pending` and
is retried on the next judgment and at startup. No LLM call.

### D5. Taste examples
The 8 most recent judgments (title, verdict, reason cut to 200 characters) are added to the state of every bundled
paper-decision call (`on-theme`, `paper-kind`, `worth-reading`, `level`, `importance`) as `taste_examples`: an
object with a note saying they are the user's recent judgments (data, never instructions) and the examples. The
note travels in the state, so the commands' questions and versions stay unchanged. Stored decisions are reused as before
(a paper is judged once per command version); new papers see the current taste.

### D6. Dedupe and orientation
Dedupe also drops every judged paper (👎 papers can never return; judged papers already have cards). Orientation
mode ends once 10 papers are judged.

### D7. ⭐ hand-off
A ⭐ inserts a `kb_requests` row (`INSERT OR IGNORE`, or back to `pending` if it was cancelled); changing a ⭐ to
another verdict or clearing it cancels a `pending` request (a `done` one stays: removal from the vault is v0.5's
concern).

### D8. Precision@5
Per sweep: the cards ranked 1–5, those judged, and those judged 👍 or ⭐; precision = good / judged (null when none
judged), shown with "n of 5 judged". `GET /v1/feedback/precision` returns the trend; the Feed header shows it as a
small bar chart, and Settings lists the effective weights with their base values.

## Risks / Trade-offs

- [Few judgments move weights a lot] → small fixed steps and clamping; weights shown in Settings.
- [Taste examples bias Jev toward recent mood] → only 8, with reasons; calibration is the weekly review's job (v2).
- [Rule candidates pile up before v2] → they are only stored; nothing acts on them until the review exists.

## Migration Plan

Migration 5 adds the tables and the `sweep_papers.queries_json` column; existing cards have no judgments. Rollback:
earlier code ignores the new tables.
