## Why

The goal of the project (EVOLUTION.md §0, decided 2026-10-26) is a daily cycle that runs itself while the user only
reads, judges and comments. Today the parts exist (sweep, cards, judgments, plugin history) but nothing ties them
into one cycle the user can follow: the weekly review is only recorded as "requested", there is no place that says
what the system changed and lets the user undo it, every card follows known interests (no exploration), and the
image carries 600 MB, a third of it unused SDKs and the optional Obsidian viewer.

## What Changes

- **A light default image** (target under 300 MB): the server is bundled into one file without the provider SDKs it
  never loads at runtime; built-in plugins are compiled into it; Obsidian (Ignis) becomes an **add-on image**
  (`research-hub:obsidian`); the default viewer is the Library. `new-project.sh --obsidian` picks the add-on.
- **The daily cycle as one orchestrated workflow** (new capability `daily-cycle`): the morning sweep (unchanged),
  a **nightly slot** (default 02:00) that later changes fill with error analysis and replays (in this change it
  computes the day's figures and records the cycle), and the **weekly digest** replacing the review (default
  Sunday 07:00). A cycle status ("sweep done, 4 cards waiting, nightly at 02:00, digest Sunday") shows in the UI.
- **Exploration pick:** one card per sweep (setting `explorationPicks`, default 1, 0 turns it off) is the best-gated
  paper least similar to what the user liked, marked "Exploration" on the card.
- **"What changed" with undo:** every change to the plugin state (by the user, the kernel or an automatic fix) is
  listed with who made it, why and an Undo that reverses only that change.
- **The weekly digest page** (new Digest tab): the week's sweeps and cards, judgments and precision@5, the
  exploration picks and how they were judged, knowledge-base additions, cost, every change with Undo, and a
  comment box per section; comments are stored and shown in the next digest (later changes act on them).

No Jev command and no LLM call is added or changed: the digest is computed, not written by a model.

## Out of scope

Replays and the harness (v1-2), nightly error analysis and automatic fixes (v1-3), charter and question proposals
(v1-4), full text, the Upgrades tab, fine-tuning, MCP. Python add-ons. Pushing images to a registry.

## Capabilities

### New Capabilities
- `daily-cycle`: the orchestrated cycle (sweep, nightly slot, weekly digest), cycle status, exploration picks, the
  "What changed" feed with undo, the digest page with comments.

### Modified Capabilities
- `deployment`: the light default image and the Obsidian add-on image.
- `scheduling`: the weekly review becomes the weekly digest; a nightly slot is added.
- `knowledge-viewer`: Obsidian is an add-on; the Library is the default viewer when Obsidian is not available.

## Impact

Dockerfile (targets `lite` and `obsidian`), `new-project.sh`, a server bundle build (`vp pack` / tsdown), a static
map of built-in plugin modules, `rh.kb` viewer choice, `rh.sweep` (exploration), a new built-in `rh.digest`
plugin (tab, tables `p_rh_digest__*`), scheduler kinds `nightly` and `digest`, plugin-state undo of one commit,
SDK types and client methods, the UI (Digest tab, cycle status, exploration badge). Existing projects keep their
data; a project on the light image falls back to the Library viewer.
