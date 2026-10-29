## Decisions

### D1. Finders
Extension point `knowledge.finder` (cardinality many) offered by `rh.knowledge`; a finder plugin exports
`leads({ charter, since, limit }): Promise<Lead[]>` with `Lead = { summary, paperIds }` (at most 5 per finder). The
review collects the leads of every enabled finder (a failing finder is skipped with a note), adds a "Leads from the
finders" section (`- [finder-id] summary (#ids)`) to the prompt, and asks for `finder` in each direction (a lead's
finder id or `interests`). Unknown values count as `interests`.

### D2. The three finders
Vectors come from the sqlite-vec tables (`vec_whole`, `vec_method`, `vec_background`, rowid = paper id); cosine in
code. Liked = judged 👍/⭐ (all time, at most 60 most recent). Method transfer: pairs with method cosine ≥ the 80th
percentile of all pairs and background cosine ≤ the 40th percentile, best 3 by the difference. Missing links: pairs
with whole cosine in the top 20 % whose cards matched different questions and with no `citation_links` row either
way; Jev `link-candidate` (noul: could A's method or result inform B's question?) on at most 5, kept at ≥ 0.6.
Rising topics: words of 5+ letters (and bigrams) in titles of papers gathered in the last 14 days (all gathered, not
only cards) with count ≥ 3 and at least 3× their rate in the 60 days before, not in the charter text; best 3.

### D3. Attribution
Proposals get `finder` and, once an add-question is approved, `question_id` (migration 2). Stats per finder:
proposed, approved, rejected, and likes = 👍/⭐ judgments on cards created after approval whose
`matched_question` = that id.

### D4. Level
`rh.sweep` setting `level` (enum, default auto). `levelFit(level, orientation, target)`: auto → today's table;
otherwise 1 at the target, 0.75 one step away, 0.5 two, 0.3 three (orientation still prefers foundational first).
The sweep, replays and `SweepSettings` include it. Review rule over the window: liked cards ≥ 8 and ≥ 60 % above the
current level (auto counts as core), or "too-basic" 👎 ≥ 3 and more than "too-advanced" → propose the next level
(kind `level`, change `{ from, to }`); approving configures `rh.sweep` (actor `proposal:knowledge-<id>`).

### D5. Taste rules
The prompt lists open `rule_candidates` with probability ≥ 0.5 (at most 10); the model may return `tasteRules: [{ rule,
candidateIds }]` (≤ 2, rule ≤ 160 chars). Kind `taste-rule`; approving appends to the `rh.sweep` setting
`tasteRules` (array, at most 10 strings) and marks the candidates `accepted`. `PaperDecisions` sends
`state.taste_rules` with every paper decision when there are rules.
