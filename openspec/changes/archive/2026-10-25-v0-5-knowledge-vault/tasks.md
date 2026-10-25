# Tasks

## 1. Vault

- [x] 1.1 Add migration 6 (kb_notes, kb_fts, kb_requests attempts/reason); create the vault (layout, `.obsidian` template only when absent, charter.md with the hash rule) on approval and at startup; verify new-vault, existing-project (pending ⭐ queued) and user-edited-charter tests
- [x] 1.2 Implement note names, section-safe appends, index and log appends; verify name, collision, append-under-heading (user text untouched) and index/log tests

## 2. Ingest

- [x] 2.1 Implement the ingest runner and librarian tools (properties by code, grounded sections, links with backlinks, done only when connected, retries) and prompts; verify faux tests: note created with all properties and sections, "Not stated in the abstract", first paper of a concept, replay gives one note, third paper → three index lines, edited note keeps the user's Summary
- [x] 2.2 Implement FTS search (rebuild, watcher, rescan) and the desk's index section and tools `search_kb`, `query_kb`; verify rebuild-equals-incremental, external edit found within 10 s, "contact map" search with excerpt, and a faux desk answer from the index

## 3. Viewer

- [x] 3.1 Implement the viewer supervisor (Obsidian download, loopback preload, restart, status in `/v1/info`, `RH_KB_VIEWER`, `RH_KB_VIEWER_DIR`, `RH_KB_OBSIDIAN_VERSION`) and the same-origin proxy with the UI guard (HTTP and WebSocket); verify with a fake viewer: proxying, cross-site refused, loopback only, crash restart within 10 s, disabled and unavailable states
- [x] 3.2 Add the Library API (`/v1/kb/papers`, `/v1/kb/notes/:stem`, `/v1/kb/search`) and SDK methods; verify API tests
- [x] 3.3 Build the Library tab and the Knowledge base tab (kept mounted, loading and off states, require hand-off, open a note) and the hub theme template; verify `npm run build` and the UI test

## 4. Integration

- [x] 4.1 All tests, check, check:jev, check:env, lint, audit; offline end to end: ⭐ a card → note, links, index, search, Library
- [x] 4.2 Live check with the real viewer (Ignis from its pinned source when Docker is unavailable): ⭐ two live cards with a free model as librarian; record the notes, links, search, the tab in light and dark (screenshots), tab switching without reload, an external edit found by search, and the cost
- [x] 4.3 Dockerfile and compose: copy the pinned Ignis, `RH_KB_VIEWER*` variables, `.env.example`, README; verify the image builds and the viewer runs in the container (needs Docker access)

## Verification notes

- 4.1 (2026-10-23): 159 server, 35 durable-agent (1 skipped), 24 SDK tests pass; check, check:jev, check:env, lint
  (no new warnings) pass. Offline end to end through the UI proxy (viewer off): brief → charter → sweep → ⭐ →
  note `haddad-2026-models-methods-with-contrastive-pretraining` with all properties and seven sections, linked to
  `concepts/protein-language-models` and `questions/q1-…` (both link back), one index line, vault search finds it,
  `/kb/` answers 503 while the viewer is off; no errors. The durable-agent package's SIGKILL timing tests failed
  intermittently under load (different test each time, all pass on rerun; the package is unchanged).
- 4.2 live check (2026-10-23) on the live project from v0.3/v0.4, with the real viewer: Ignis 0.8.18 from its pinned
  source (Docker unavailable in this session), Obsidian 1.14.4 downloaded and unpacked by the hub itself
  (`kb.obsidian_download` → `kb.obsidian_ready`), librarian on `nvidia/nemotron-3.5-lightning:free`.
  - The three ⭐ papers queued during v0.4 were ingested at startup, all `done`: `bepler-2021-learning-the-protein-
    language-evolution`, `rao-2020-transformer-protein-language-models-are`, `xu-2022-peer-a-comprehensive-and-multi`;
    shared concept page `protein-language-model`, question pages for Q1, Q2 and Q5; index lines with the user's
    reasons. Index summaries were cut mid-word at 200 characters: now cut at a word with "…".
  - Real hub UI, Knowledge base tab: screenshots in `trial/real-kb-light.png`, `trial/real-kb-dark.png` (hub top bar,
    tabs and agent column unchanged; Obsidian in the hub colors and font; no title bar, ribbon or status bar). It
    opened on "New tab" instead of the index: now opens `index.md` first.
  - Tab switching: Feed → Knowledge base kept the same frame (no reload), shown again in 37 ms.
  - Library "Open in knowledge base" on PEER: the note opened in the loaded viewer in 302 ms, no reload
    (`trial/real-kb-note.png`).
  - An edit made inside Obsidian (`app.vault.modify`) was found by hub search in 652 ms; a note written by the hub
    appeared in Obsidian's vault in 602 ms.
  - Cost of the ingests: 9 librarian generations on the free model, $0; the project's totals (all live checks since
    v0.2): $0.0568 (Jev $0.0548, embeddings $0.0020, models $0).
- 4.3 (2026-10-25): image `research-hub:v0.5` built in 71 s, 613 MB (525 MB before; Ignis copied from
  `nobbe/ignis:0.8.18`). Test container (live mode, every model on the free one, no sweep, $0): healthy; viewer
  `unavailable` until a charter was approved, then the hub downloaded Obsidian 1.14.4 into `/data/kb-viewer` and
  Ignis 0.8.18 ran (`/v1/info` state running). Inside the container only two listeners: the hub on 0.0.0.0:4850
  (published on the host's 127.0.0.1) and Ignis on 127.0.0.1 (random port). `/kb/` through the hub: 200; the
  Knowledge base tab opened on `index.md` (`trial/docker-kb.png`). `docker restart`: viewer running again in 4 s
  with no second download (1 download over 2 starts). Ignis killed with SIGKILL inside the container: state
  `crashed`, restarted in 4.2 s, hub healthy throughout. (Passing the repo `.env` to `docker run` directly sets
  `RH_DATA_DIR=./data`; compose overrides it with `/data`, so use compose or set it as compose does.)
