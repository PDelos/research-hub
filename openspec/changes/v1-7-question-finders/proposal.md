## Why

EVOLUTION.md §6 step 8: the knowledge review (v1-5) drafts new research questions from one evidence pack. New ways of
finding questions should be pluggable and judged by what they bring (which strategy's proposals the user approves,
and which approved questions lead to ⭐ papers), and two promised proposal kinds are missing: moving the user's level
up, and taste rules from the reasons the user keeps giving.

## What Changes

- **Question finders** (extension point `knowledge.finder`, many): each finder contributes leads (a short summary
  and the papers behind it); the review model gets them next to the evidence pack and says which finder each
  direction came from (or "interests" for the pack itself). Three built-in finders (add-ons, topic knowledge):
  - `rh.finder-method-transfer`: pairs of liked papers whose method vectors are close while their background
    vectors are far apart ("has A's method been tried on B's problem?");
  - `rh.finder-missing-links`: liked papers close in their whole vectors, matched to different questions, with no
    citation between them, kept when Jev `link-candidate` says one could inform the other;
  - `rh.finder-rising-topics`: words rising among papers gathered in the last 14 days against the 60 days before
    and not in the charter.
- **Attribution**: each add-question proposal records its finder; per finder the hub counts proposals, approvals,
  rejections and the 👍/⭐ cards of approved questions since approval, shown in the Charter tab and the digest.
- **Level up**: a sweep setting `level` (auto, foundational, core, advanced, frontier; default auto, which keeps
  today's level fit). The review proposes the next level when most liked cards in the window are above the current
  level (at least 8 liked, 60 %) or 👎 "too basic" reasons dominate; approving sets the setting (one undoable change);
  replays use it.
- **Taste rules**: the review model may turn open rule candidates (generalizable reasons) into at most 2 rules;
  approved rules become the sweep setting `tasteRules` (undoable) and go with every Jev paper decision next to the
  taste examples.

## Capabilities

### Modified Capabilities
- `knowledge-loop`: finders, attribution, level-up and taste-rule proposals.
- `paper-sweep`: the `level` and `tasteRules` settings.

## Impact

`rh.knowledge` (extension point, prompt, kinds, attribution, migration), three new finder plugins, Jev
`link-candidate`, `rh.sweep` settings, `src/sweep/sweep.ts` and `decisions.ts`, replay, SDK, Charter/Digest UI.
