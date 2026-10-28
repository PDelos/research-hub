## Why

EVOLUTION.md §0 and §4: the charter must follow the user's interests and the field, and the hub must find new
research questions, always as proposals the user approves. v1-1 to v1-4 built the finding loop that improves
itself; this change closes the knowledge loop: what the user liked, disliked and wrote becomes charter proposals with
evidence in the weekly digest, and approving one creates the charter version the next sweep uses.

## What Changes

- **The knowledge review** (new core plugin `rh.knowledge`): runs before each weekly digest and on request.
- **Charter changes from evidence** (code, no model call, last `windowDays`, default 28):
  - *weights*: a question or query whose learned weight (from judgments) moved at least 0.25 from the charter's
    weight is proposed at its learned value;
  - *retire a question*: at least 8 judged cards matched it and none was liked (only while more than 3 remain);
  - *drop a query*: it found at least 10 papers that became cards and none was liked (only while more than 5 remain).
- **New research questions and out-of-scope topics** (one call to the review model per review): from the liked and
  disliked papers with their reasons, the digest comments, the desk questions, liked papers that matched no
  question and the knowledge base's open questions, the model drafts at most 3 research directions (question, why,
  the motivating papers, 2 queries) and at most 2 out-of-scope topics (from 👎 "off topic" reasons). A new Jev
  command `question-promise` scores each direction; those under 0.5 are dropped.
- **Proposals**: each is an exact change with its evidence (judgments, papers, comments). **Approve** applies it to
  the approved charter as a new version (the history stays; weights replay; the vault's charter note follows) and
  the next sweep uses it; **Reject** takes an optional reason; **Undo** restores the previous charter as a new
  version while no later version exists. A proposal whose target no longer exists becomes stale.
- **Stable question ids**: question ids no longer shift when a question is retired; a new question gets the next
  free id (Q6, Q7, …). Drafts from the charter writer are numbered as before.
- **Where the user sees it**: a "Charter and questions" section in the digest and a Proposals section in the
  Charter tab, each with Approve / Reject.

Jev: one new command `question-promise` (noul). LLM: one review-model call per review (about $0.01).

## Out of scope

Same-method-different-problem and citation-gap candidates (need facet vectors and citation links in the KB: later);
level-up (curriculum) proposals; taste rules (v0's rule candidates stay as they are); changing the core.

## Capabilities

### New Capabilities
- `knowledge-loop`: the review, evidence rules, directions, proposals, approval into charter versions.

### Modified Capabilities
- `daily-cycle`: the digest gains a "Charter and questions" section.
- `project-charter`: approved proposals create versions; stable question ids.

## Impact

New built-in `rh.knowledge` (tables `p_rh_knowledge__*`, Jev command, routes `/v1/knowledge/*`), `src/charter.ts`
(`validateCharter` keeps ids on request, `Charters.approveVersion`), the digest (calls the review first, new
section), SDK, Charter and Digest tabs, an offline faux rule for the review model.
