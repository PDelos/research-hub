# Tasks

## 1. Vault

- [x] 1.1 Add migration 6 (kb_notes, kb_fts, kb_requests attempts/reason); create the vault (layout, `.obsidian` template only when absent, charter.md with the hash rule) on approval and at startup; verify new-vault, existing-project (pending ⭐ queued) and user-edited-charter tests
- [x] 1.2 Implement note names, section-safe appends, index and log appends; verify name, collision, append-under-heading (user text untouched) and index/log tests

## 2. Ingest

- [x] 2.1 Implement the ingest runner and librarian tools (properties by code, grounded sections, links with backlinks, done only when connected, retries) and prompts; verify faux tests: note created with all properties and sections, "Not stated in the abstract", first paper of a concept, replay gives one note, third paper → three index lines, edited note keeps the user's Summary
- [x] 2.2 Implement FTS search (rebuild, watcher, rescan) and the desk's index section and tools `search_kb`, `query_kb`; verify rebuild-equals-incremental, external edit found within 10 s, "contact map" search with excerpt, and a faux desk answer from the index

## 3. Viewer

- [ ] 3.1 Implement the viewer supervisor (Obsidian download, loopback preload, restart, status in `/v1/info`, `RH_KB_VIEWER`, `RH_KB_VIEWER_DIR`, `RH_KB_OBSIDIAN_VERSION`) and the same-origin proxy with the UI guard (HTTP and WebSocket); verify with a fake viewer: proxying, cross-site refused, loopback only, crash restart within 10 s, disabled and unavailable states
- [ ] 3.2 Add the Library API (`/v1/kb/papers`, `/v1/kb/notes/:stem`, `/v1/kb/search`) and SDK methods; verify API tests
- [ ] 3.3 Build the Library tab and the Knowledge base tab (kept mounted, loading and off states, require hand-off, open a note) and the hub theme template; verify `npm run build` and the UI test

## 4. Integration

- [ ] 4.1 All tests, check, check:jev, check:env, lint, audit; offline end to end: ⭐ a card → note, links, index, search, Library
- [ ] 4.2 Live check with the real viewer (Ignis from its pinned source when Docker is unavailable): ⭐ two live cards with a free model as librarian; record the notes, links, search, the tab in light and dark (screenshots), tab switching without reload, an external edit found by search, and the cost
- [ ] 4.3 Dockerfile and compose: copy the pinned Ignis, `RH_KB_VIEWER*` variables, `.env.example`, README; verify the image builds and the viewer runs in the container (needs Docker access)
