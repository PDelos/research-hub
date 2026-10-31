# Tasks

## 1. Profile setting and declarative enablement

- [x] 1.1 `loadConfig` reads `RH_PROFILE` (`core` default, `full`; other values a `ConfigError` naming the
  variable), `Config.profile`, passed into the plugin host's `env`; `.env.example` documents it. Verify: config
  tests for default, `full` and an invalid value.
- [x] 1.2 `contributes.enablement` accepts `profile: "full"` (with or without `env`); `initiallyEnabled` returns
  false for it unless `RH_PROFILE=full`. Verify: manifest/settings tests (schema accepts it; enablement per profile).
- [x] 1.3 The nine plugins declare `enablement.profile: "full"`; `rh.engineer`, `rh.upgrades`, `rh.knowledge`,
  `rh.harness` drop `"required": true`. Verify: a new project in core lists exactly those nine disabled; in full
  none (kernel test).
- [ ] 1.4 Tests run in either profile: `tests/test-server.ts` passes `RH_PROFILE` through; tests that exercise the
  gated plugins pin `profile: "full"` in their configuration without changing assertions. Verify: `npm test` passes
  with `RH_PROFILE=full` and with `RH_PROFILE=core`.

## 2. One-time profile switch for existing projects

- [x] 2.1 Lockfile fields `profile` and `profileDisabled`; at start a differing profile is applied in one `kernel`
  commit (`profile: core` disables, `profile: full` re-enables what core disabled and is still off); a lockfile
  without `profile` counts as `full`. Verify: kernel-state tests: full→core one commit, core→core no commit,
  core→full restores, user re-enable survives restart, Undo of the profile commit re-enables without re-applying.

## 3. Graceful degradation on the server

- [ ] 3.1 API error `feature_off` (409, `details.plugin`) in `ApiFault` and the SDK's `ErrorCode`; the engineer,
  upgrades, harness and knowledge routes map `PluginUnavailable` to it. Verify: API test calling one route of each
  with its plugin off.
- [ ] 3.2 The digest treats a disabled knowledge review as off (no warning) and leaves out Quality, Sources,
  Upgrade and Charter when their plugins are off. Verify: digest test with the four plugins off; cycle-week test in
  core (7 sweeps, 7 nightly, 1 digest, none failed).
- [ ] 3.3 `/v1/info` reports `profile`; `PluginSummary.advanced` marks plugins declaring `profile: "full"`.
  Verify: API test.
- [ ] 3.4 Enabling each of the nine live in core works without a restart (its route answers, or for finders /
  converter / embedder, it shows in its extension point). Verify: one test per plugin.

## 4. UI

- [ ] 4.1 Core tab bar: only Feed, Library, Charter, Settings; Settings "Under the hood" lists the other active
  tabs; their URLs still open. Full unchanged. Verify: Playwright tests in both profiles.
- [ ] 4.2 Settings "Advanced features": the advanced plugins with description, state and switch (enable/disable
  through the existing endpoint; a blocked plugin offers to enable its dependency first). Verify: Playwright test
  switching the harness on and seeing the Quality entry appear.
- [ ] 4.3 Charter, Digest and Plugins views hide what needs a disabled feature without an error; in core the Digest
  view hides empty sections. Verify: Playwright test in core (no error banner, no Proposals section).

## 5. Docs and verification

- [ ] 5.1 README profile section, `new-project.sh` writes `RH_PROFILE=core`, `.env.example`. Verify: `npm run check`.
- [ ] 5.2 Run `npm test`, `npm run check`, `npm run test:ui` and `scripts/e2e-offline.sh` with `RH_PROFILE=full`
  and with `RH_PROFILE=core` (e2e steps for gated features run in full and check `feature_off` in core). Verify:
  all pass in both.
- [ ] 5.3 Light and dark screenshots of the core UI (Feed, Settings with Advanced features and Under the hood).
  Verify: four PNGs listed in the summary.

## Workflow follow-up

- Archive the change (`openspec archive v2-0-core-profile`).
- Summarise what changed and which feature sits behind which plugin; open a PR from `core-profile` to `master`; do not
  merge.
