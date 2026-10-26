## Context

v1-0 made every feature a plugin. The pieces of the daily cycle exist but are not one workflow: the weekly review
is only recorded as requested, nothing lists what changed with an undo, and the image is 607 MB (Node 177 MB,
Debian 87 MB, node_modules 154 MB mostly provider SDKs pi-ai never loads for OpenRouter, Ignis 69 MB).

## Goals / Non-Goals

**Goals:** a default image under 300 MB with Obsidian as an add-on; one cycle (sweep, nightly, weekly digest) that
runs without the user; exploration picks; every plugin-state change listed with a one-change undo; a digest page
the user reads and comments on.

**Non-Goals:** replays and scoring (v1-2), error analysis and automatic fixes (v1-3), proposals (v1-4); an LLM-written
digest; Alpine or distroless bases (sqlite-vec ships glibc binaries; Debian slim stays).

## Decisions

### D1. The server as one bundle
`vp pack` (tsdown) bundles `apps/rh-server/src/main.ts` into `apps/rh-server/dist/server.mjs`; the image runs
`node dist/server.mjs` (no tsx). External at runtime: `sqlite-vec` (a native SQLite extension found through its
package) and Node built-ins. pi-ai loads providers lazily; the bundle keeps the OpenAI-compatible client OpenRouter
uses and leaves out the Anthropic, Google, Bedrock and Mistral SDKs (their lazy imports would only run for those
providers, which the hub never configures). Built-in plugin code is reached through a static module map
(`src/kernel/builtins.ts`: id → `() => import(...)`) so the bundler includes it; manifests, prompts, Jev commands,
the vault template, `plugin-runner.mjs` and `loopback.cjs` stay files on disk. All on-disk paths resolve from one
`appDir()` (the folder holding `prompt_engineering/`), the same in development and in the bundle.

### D2. Images
Dockerfile stages: `build` (install, UI, bundle) → `lite` (node:26-slim, the bundle, a production install of
the externals only, the data files; `RH_KB_VIEWER=off`) → `obsidian` (FROM lite, adds Ignis at /opt/ignis,
`RH_KB_VIEWER=on`) → a final default stage equal to `lite`. Tags: `research-hub:latest` (lite) and
`research-hub:obsidian`. `new-project.sh --obsidian` writes the add-on image into the compose file.

### D3. Which viewer is active
`rh.kb` decides: a saved `kb.viewer` setting wins; otherwise Obsidian when its plugin is registered and can run
(Ignis installed and `RH_KB_VIEWER` not off), else the Library. The contributions route and the UI use this choice.
The Obsidian viewer, when not chosen or unable to run, reports why ("Ignis is not installed in this image").

### D4. Scheduler: nightly slot, review as digest
Migration 7 rebuilds `scheduled_runs` so `kind` may be `sweep`, `review` or `nightly`. The weekly `review` kind is
the digest (stored name kept so existing run logs stay valid; the UI says "digest"). `nightly` slots are daily at
`RH_NIGHTLY_TIME` (default 02:00), editable like the others. Deviation from "v0 tests unchanged" (a v1-0 rule): the
storage tests' expected schema version moves from 6 to 7 because the schema really changes.

### D5. `rh.digest`, the cycle plugin
A new required built-in plugin owns the cycle: it listens for `nightly` and `review` runs from `rh.schedule`,
records the day's figures (nightly) and builds the digest (weekly), marks the runs done, and serves the cycle
status. Tables (through `rh.db.migrate`): `p_rh_digest__digests` (week, created, body JSON),
`p_rh_digest__comments` (digest, section, text, created), `p_rh_digest__days` (day, figures JSON). It contributes
the Digest tab (order 15) and emits `digest.comment` events. Sections: cycle (sweeps, cards), judgments and
precision@5, exploration, knowledge base, cost, changes (with undo), your comments last week.

### D6. One-change undo
`PluginState.revert(commit)` compares the lockfile at the commit with its parent, and for each changed path
(a plugin's presence, enabled flag, version or one setting key) restores the parent's value, unless the current
value differs from the commit's (a later change touched it): then the undo is refused and nothing changes. The undo
is a commit "undo: <message>" by the actor who asked. The kernel re-applies the state afterwards.

### D7. The sweep's knobs become plugin settings
So that changes are commits with undo, `rh.sweep` declares `cardsPerSweep` (integer 1–15, default 7) and
`explorationPicks` (0–2, default 1) and handles setting changes live (`onSettingsChange`, no restart). On first
activation a value saved by v0 (`cards_per_sweep` in the settings table) becomes the plugin setting. `GET/PUT
/v1/sweep-settings` keep working on top of the plugin setting.

### D8. Exploration pick
In the rank phase, when the project has 👍/⭐ papers with whole-paper vectors, the last `explorationPicks` card slots
go to the gated papers outside the top `n − picks` with the lowest maximum cosine similarity to those liked
papers; ties go to the higher rank. Picks are recorded in `p_rh_sweep__exploration` and cards carry
`exploration: true`. Cost: none (vectors already exist).

## Risks / Trade-offs

- A bundle hides missing files until run time → the image test runs the offline cycle in the container.
- Leaving SDKs out of the bundle breaks a provider nobody uses → the model catalog only configures OpenRouter and
  the faux provider; a test checks the bundle starts and chats offline.
- Exploration may surface off-topic papers → it only picks among gated papers (on-theme already), and the digest
  shows how picks were judged so the setting can be lowered.

## Migration Plan

Existing projects: migration 7 runs once; a project moving to the light image falls back to the Library viewer
(Obsidian stays enabled and says why it is idle); `proteins` stays on the add-on image unless the user chooses.
Rollback: the v1-0 image ignores the new tables and the extra run kind.
