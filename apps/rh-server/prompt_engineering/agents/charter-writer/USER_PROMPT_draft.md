# Purpose

Draft the charter for this research project from the user's brief.

## Variables

QUESTIONS_LEFT: {{questions_left}}

## Brief

{{brief}}

## Workflow

1. Read the brief. Decide what it leaves open that would change the charter.
2. If QUESTIONS_LEFT is above 0 and something important is open, call `ask_scoping_questions` once with at most
   QUESTIONS_LEFT questions.
3. Call `save_charter_draft` with a complete charter that follows the charter rules. Where a scoping question is
   still open, keep that part of the charter general.
4. If `save_charter_draft` returns an error, fix exactly what it names and call it again.

## Definition Of Done

- `save_charter_draft` succeeded once in this run
- at most QUESTIONS_LEFT scoping questions were asked
