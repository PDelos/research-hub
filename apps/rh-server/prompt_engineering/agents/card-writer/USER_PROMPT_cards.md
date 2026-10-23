Write today's paper cards.

SWEEP: {{sweep_id}}
CANDIDATES: {{candidates}}
READER: {{stage}}

## Workflow

1. Call `list_candidates`.
2. For each candidate in rank order, call `present_paper` with its id and a summary of at most 80 words written
   only from its title and abstract. If it returns an error, fix exactly what it names and call it again.
3. Call `complete_sweep`, listing every candidate you did not present with its reason.

## Definition Of Done

- every candidate has a card or a skip reason
- `complete_sweep` succeeded once in this run
