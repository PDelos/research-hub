# Proposal

## Why

Starred papers must accumulate into knowledge the user can read and the agent can reason over: an
Obsidian-compatible vault, one connected evidence note per paper, searchable and always in the agent's
view as a compact index. This completes the v0 loop (find → judge → keep) and is the base for v1
relations, curriculum and v2 missing links. Layer 5, the top of the v0 pyramid; depends on
`v0-4-feedback` (star hand-off) and everything below.

## What Changes

- A per-project **vault** folder (markdown, Obsidian-compatible) with `index.md`, `log.md`,
  `charter.md`, `sources/`, `concepts/`, `questions/`.
- On ⭐, a durable **ingest** run: a `librarian` subagent writes one **evidence note** with fixed
  sections and properties, and connects it to at least one concept or question page.
- **User edits win**: the agent never overwrites user-edited content; it only creates notes and appends
  to designated sections.
- **Search**: keyword (BM25) index over the vault, rebuildable from the files; the vault is the source of
  truth.
- **Agent memory**: the vault index (one line per paper) is always in the project agent's context; full
  notes are read on demand (`query_kb`, `search_kb`).
- A **Library** view listing knowledge-base papers and opening notes.
- A **Knowledge base tab** that embeds the real Obsidian interface in the hub UI, served by
  [Ignis](https://github.com/Nystik-gh/ignis) (self-hosted Obsidian-as-a-web-app) as a second container in the
  same compose file, mounting the same vault folders. Everything runs on the hub machine; nothing needs
  Obsidian installed on the viewer's device.
- A **hub theme for Obsidian**: every new vault ships `.obsidian/` settings with a CSS snippet using the hub UI's
  colors, fonts and light/dark modes, and a default layout (index note open, ribbon and sync prompts hidden), so
  the embedded Obsidian looks like part of the hub.
- **Open in knowledge base** from the Library (and from paper cards later) jumps to that note in the tab.

**Pending a trial:** before this layer's design is written, run Ignis with a sample vault, the theme and the
iframe tab for about 30 minutes to confirm embedding, theming and note links work. The trial passes only if
side-by-side screenshots (light and dark) show the tab matching the hub's look and tab switching causes no reload. If it fails, the fallback is
the linuxserver/obsidian image (streamed desktop) behind the same tab; the requirements below do not change.

Out of scope: typed relations between papers and the graph view (v1), research directions (v2),
full-text reading (v1), Obsidian Bases views (v1), Obsidian community plugins (only core features are relied on).

Jev commands added: none. LLM calls added: one `reader`-model librarian run per starred paper.

Design and tasks are written when this layer is next to implement.

## Capabilities

### New Capabilities

- `knowledge-vault`: The project's markdown knowledge base: its layout, how starred papers become
  connected evidence notes, protection of user edits, search, and how the agent sees it.
- `knowledge-viewer`: Viewing and editing the vault through embedded Obsidian inside the hub UI: the tab,
  the hub theme, opening a specific note, access control, and behavior when the viewer is not running.

### Modified Capabilities

(none)

## Impact

- `rh-server`: ingest task, librarian subagent and tools (`kb_write_source`, `kb_upsert_concept`,
  `kb_upsert_question`, `query_kb`, `search_kb`), file watcher, FTS5 index; `rh-client-browser`:
  Library view and Knowledge base tab.
- Data: `/data/projects/<slug>/vault/` on the host, with `.obsidian/` theme and layout.
- Compose: a second service `knowledge` (Ignis, pinned version) in its own container, mounting only the vault
  folders, publishing no port; the hub proxies it at `/kb/` on port 4850, so the iframe is same-origin and needs
  no second password. Adds roughly a few hundred MB of RAM while running.
- License: Ignis is AGPL-3.0 and run unmodified in its own container; it contains no Obsidian code and downloads
  Obsidian from its official source (Obsidian is free for all use since 2025).
