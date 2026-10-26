## 1. Knobs

- [ ] 1.1 `rh.sweep` settings `relevanceMin`, `worthMin`, `rankWeights` read by the gate and rank phases (defaults unchanged); verify sweep tests unchanged and a threshold setting changing the next sweep's gate

## 2. Replays

- [ ] 2.1 `src/harness`: features of past sweeps, replay (gate, rank, exploration), labels, metrics (nDCG@n, precision@5, recall of ⭐, coverage), held-out split, seeded paired bootstrap, verdicts; verify unit tests with a synthetic history (a known-better variant wins, a worse one loses, too little data, estimated papers counted, no paid calls)

## 3. The judge

- [ ] 3.1 Jev command `would-like` (locked), labels cache, calibration (agreement, kappa, trusted rule), nightly labelling within the budget through `rh.decisions`; verify tests with scripted Jev (calibrated and uncalibrated judges, budget stop, cache reuse)

## 4. Plugin, API, UI

- [ ] 4.1 `rh.harness` plugin: tables, `cycle.nightly` listener, replays stored, routes `/v1/harness/quality`, `/v1/harness/replays`, `POST /v1/harness/replay`, SDK; the digest's Quality section; the `replay_variant` desk tool; verify API tests and a chat round trip offline
- [ ] 4.2 UI: the Quality tab (judge agreement, quality over time, replays) and the digest's Quality section; verify build and Playwright tests with screenshots

## 5. Integration

- [ ] 5.1 All tests, checks, audit, offline e2e (a replay and the Quality view), UI tests, bundle and light image
- [ ] 5.2 README, PLAN/EVOLUTION status; archive
