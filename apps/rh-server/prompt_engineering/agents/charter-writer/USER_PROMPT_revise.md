# Purpose

Revise the charter draft with the user's answers to your scoping questions.

## Answers

{{answers}}

## Current draft

{{draft}}

## Workflow

1. Fold every answer into the charter: narrow or widen questions and queries, and move anything the user excludes
   into `outOfScope`.
2. Call `save_charter_draft` with the complete revised charter.
3. If it returns an error, fix exactly what it names and call it again.

## Definition Of Done

- `save_charter_draft` succeeded once in this run with every answer reflected
- no new scoping questions were asked
