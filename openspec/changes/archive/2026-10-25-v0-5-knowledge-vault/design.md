# Design

## Context

Baseline: `paper-feedback` queues a `kb_requests` row per ⭐ (pending, cancelled on un-star). Papers have
metadata, abstracts, facet labels and vectors; cards carry scores, level, kind and the matched question; judgments
carry the user's reason. The hub serves its UI and API from one origin behind the UI proxy (host and same-origin
checks). Requirements: `specs/knowledge-vault`, `specs/knowledge-viewer`. The Ignis trial (proposal) fixed the
viewer architecture: same origin, a `require` hand-off from the hub page, and a loopback preload.

## Goals / Non-Goals

**Goals:**
- Every ⭐ becomes exactly one grounded, connected evidence note in an Obsidian-compatible vault the user owns.
- The agent sees the vault index always and reads or searches notes on demand.
- The real Obsidian UI inside the hub, same look, live, safe, and optional.

**Non-Goals:** typed relations and the graph view, Bases views, full text, community plugins (v1+).

## Decisions

### D1. Vault layout and ownership
`$RH_DATA_DIR/vault/` with `index.md`, `log.md`, `charter.md`, `sources/`, `concepts/`, `questions/` and
`.obsidian/` (copied from `apps/rh-server/vault-template/` only when absent, so the user's Obsidian settings are
never reset). Created when a charter is approved, and at startup when the charter is approved but the vault is
missing (then pending ⭐ requests are ingested). Hub-owned files (`charter.md`) are rewritten on a new charter
version only if their content still equals what the hub last wrote (hash kept in settings), so user edits win. The
hub writes only: new notes, new pages, appended lines under `## Related papers` / `## Papers`, and appended lines in
`index.md` and `log.md` (D3).

### D2. Ingest (one ownerless conversation per ⭐, `reader` model)
An `Ingest` runner (like the card writer) takes the oldest pending `kb_requests` row, one at a time. Code writes the
note's properties (title, doi/arxiv/openalex/pmid, year, venue or server, level, kind, relevance, trust, value,
kb_added, why = the user's reason verbatim); the librarian writes only the seven sections through tools:
- `write_evidence_note({summary, contributions, method, results, limitations, open_questions})`: every section
  non-empty; a section without support says exactly "Not stated in the abstract"; numbers must appear in the title,
  abstract or reason (the card grounding check). Memoized; the file name is
  `{first-author-lastname}-{year}-{first-5-title-words}` (ASCII, lowercase, `-`, collisions get `-2`), recorded in
  `kb_notes(paper_id UNIQUE, stem, created_at)`, so a replay finds the existing note.
- `link_note({concepts: [name], questions: [Q-id]})`: at least one; creates `concepts/<slug>.md` or
  `questions/<qid>-<slug>.md` when missing, adds the links to the note's `concepts`/`questions` properties (only in
  the note just written), and appends a backlink under the page's `## Papers`.
The request becomes `done` only when the note exists and links to at least one page that links back; then code
appends the index line (title · one-line summary · level · reason) and a log entry. A run that ends otherwise
leaves the request pending with `attempts + 1` (retried after 1 minute, up to 3 attempts, then `failed` with the
reason). Un-starring before ingestion cancels (v0.4); a `done` note stays.

### D3. Section-safe appends
`appendUnderHeading(file, heading, line)` inserts the line at the end of that heading's section (before the next
heading of the same or higher level), adding the heading at the end of the file if absent; it never rewrites other
bytes. Index and log are append-only.

### D4. Search: FTS5 from the files
`kb_fts(path, title, body)` (FTS5, BM25) holds every `.md` file except `.obsidian/`; `rebuild()` recreates it from
disk in sorted path order (deterministic ranking); a recursive `fs.watch` (debounced 500 ms) re-indexes changed
files, and a 5 s rescan by modification time backs it up, so external edits are searchable within 10 s.
`search(query, k=8)` returns path, title, a `snippet()` excerpt and the BM25 score.

### D5. Agent memory
The research desk gets a dynamic system section with `index.md` (cut at 16,000 characters with a note) and two
tools: `search_kb({query})` and `query_kb({stem})` (the full note). The desk prompt says to answer from the index and
open notes only for papers it cites. `DESK_TOOLS` gains both.

### D6. Viewer process (Ignis) and proxy
`KbViewer` supervises `node --require <loopback.cjs> <RH_KB_VIEWER_DIR>/apps/ignis-server/server/index.js` with
`PORT` (a free loopback port), `VAULT_ROOT=$RH_DATA_DIR/kb-viewer/vaults` (a symlink `<project>` → the vault),
`DATA_ROOT` and `OBSIDIAN_ASSETS_PATH` under `$RH_DATA_DIR/kb-viewer/`. On first start the hub downloads the pinned
Obsidian package (`RH_KB_OBSIDIAN_VERSION`, default 1.14.4) from Obsidian's official release and unpacks it with
`@electron/asar`; offline mode never downloads (the viewer reports `unavailable` until the package exists).
Crashes restart after 2 s (backoff to 10 s). Status `disabled | unavailable | starting | running | crashed` and the
pinned versions are in `/v1/info`. The hub proxies, on its own origin and under the UI proxy's host and same-origin
rules (cross-site requests and foreign WebSocket origins refused): `/kb/*` → the viewer's `/*`, plus the viewer's
absolute prefixes `/api/`, `/ws`, `/vault-files/`, `/downloads/`, and `/assets/` after the hub's own static files.
`RH_KB_VIEWER=off` disables it; `RH_KB_VIEWER_DIR` (default `/opt/ignis`) locates Ignis. The image copies the
pinned release: `COPY --from=nobbe/ignis:0.8.18 /app /opt/ignis` (AGPL, unmodified, separate program).

### D7. UI
- **Knowledge base tab:** an iframe to `/kb/`, mounted on first open and kept mounted (hidden with `v-show`) so
  switching tabs never reloads it; no border, fills the content area; a hub-styled loading overlay until Obsidian's
  workspace is ready, and an explanation when the viewer is off or unavailable. The hub page sets `window.require`
  to the frame's own `require` (trial finding 1). "Open in knowledge base" calls the frame's
  `app.workspace.openLinkText(stem, "")` (same origin), or loads `/kb/?file=…` on first open.
- **Library tab:** knowledge-base papers (title, level, date added, reason) and a rendered note view (properties
  table and sections, rendered with `marked`), with "Open in knowledge base".
- **Hub theme:** `vault-template/.obsidian/` (CSS snippet with the hub tokens for light and dark, no status bar or
  vault switcher; `appearance.json` with theme `system`, ribbon hidden).

## Risks / Trade-offs

- [Ignis is young and tied to Obsidian versions] → both pinned; the Library works without the viewer; `off` switch.
- [Same-origin viewer shares the hub origin] → it is only reachable through the hub's existing UI guard; Ignis's
  cross-origin plugin proxy is not exposed beyond what Ignis already restricts; no community plugins are installed.
- [The librarian writes weak notes] → code owns properties, grounding check on numbers, "Not stated in the
  abstract" for gaps, user edits win.

## Migration Plan

Migration 6 adds `kb_notes`, `kb_fts` and `kb_requests.attempts`/`reason`. Projects with an approved charter get a
vault at the next start, and earlier ⭐ requests are ingested.
