Add this starred paper to the knowledge base.

PAPER: {{title}}
AUTHORS: {{authors}}
YEAR: {{year}}
VENUE: {{venue}}
LEVEL: {{level}}
MATCHED_QUESTION: {{matched_question}}
USER_REASON: {{reason}}

ABSTRACT:
{{abstract}}

FULL_TEXT (sections, possibly trimmed):
{{full_text}}

RESEARCH_QUESTIONS:
{{questions}}

EXISTING_CONCEPTS: {{concepts}}
CHARTER_CONCEPTS: {{charter_concepts}}
EXISTING_NOTES: {{notes}}

## Workflow

1. Call `write_evidence_note` with summary, contributions, method, results, limitations and open_questions.
2. Call `link_note` with at least one concept and the matching research question ids.
3. If a tool returns an error, fix exactly what it names and call it again.

## Definition Of Done

- `write_evidence_note` succeeded once
- `link_note` succeeded with at least one concept or question
