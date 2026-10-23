# Proposal

## Why

The user's judgments are the system's only ground truth. Every 👎/👍/⭐ and every short reason must
immediately make the next sweep better, cheaply and transparently, and ⭐ must hand papers to the
knowledge base. Layer 4 of the v0 pyramid; depends on `v0-3-daily-sweep` (cards, Jev commands) and below.

## What Changes

- Judge any card with 👎 (not useful), 👍 (interesting) or ⭐ (add to knowledge base), plus an optional
  reason of up to 1,000 characters; judgments can be changed.
- Judgments **nudge weights** of the matched research question, the queries that found the paper, and its
  source, with fixed steps and bounds.
- Recent judgments with their reasons become **few-shot taste examples** in every Jev command's input.
- Jev `reason-parse` classifies each reason (cheap); reasons it marks as stating a general rule are
  queued as **rule candidates** for the weekly review (v2) instead of spending an LLM call now.
- ⭐ emits an "add to knowledge base" request consumed by `v0-5-knowledge-vault`.
- Precision@5 (share of each sweep's top-5 cards the user 👍/⭐) is computed per sweep and shown.

Out of scope: taste rules and approvals (v2 weekly review), the vault itself (v0.5).

Jev commands added: `reason-parse`. LLM calls added: none.

Design and tasks are written when this layer is next to implement.

## Capabilities

### New Capabilities

- `paper-feedback`: Recording the user's judgments and reasons, and how they change weights, Jev inputs
  and metrics, including the hand-off of ⭐ papers to the knowledge base.

### Modified Capabilities

(none)

## Impact

- `rh-server`: judgments table, feedback routes and agent tool `card_feedback`, weight updates, taste
  example builder, `reason-parse` command; `rh-client-browser`: judge buttons, reason box, precision chart.
