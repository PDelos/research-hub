// Spec paper-sweep: Level and taste-rule settings (v1-7 task 1.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, replayCards, type SweepHistory } from "../src/harness/replay.ts";
import { levelFit } from "../src/sweep/sweep.ts";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { choice, noul, score, scripted } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers } from "./fixtures/sweep-env.ts";
import { startTestServer, until } from "./helpers.ts";

test("level fit: auto keeps the earlier table; a target level fits best and less per step away; orientation first", () => {
  assert.equal(levelFit("core", false), 1);
  assert.equal(levelFit("advanced", false, "advanced"), 1);
  assert.equal(levelFit("foundational", false, "advanced"), 0.5);
  assert.equal(levelFit("frontier", false, "foundational"), 0.3);
  assert.equal(levelFit("foundational", true, "advanced"), 1, "orientation still starts with foundations");
});

test("a replay with a level ranks papers at that level first", () => {
  const sweepHistory: SweepHistory = {
    sweepId: 1,
    startedAt: Date.now(),
    orientation: false,
    liked: [],
    vectors: new Map(),
    pool: [
      { paperId: 1, relevance: 0.8, worth: 0.8, importance: 0.5, level: "foundational" },
      { paperId: 2, relevance: 0.8, worth: 0.8, importance: 0.5, level: "frontier" },
    ],
  } as never;
  const s = { ...DEFAULT_SETTINGS, cardsPerSweep: 1, explorationPicks: 0 };
  assert.deepEqual(replayCards(sweepHistory, { ...s, level: "frontier" }).cards, [2]);
  assert.deepEqual(replayCards(sweepHistory, { ...s, level: "foundational" }).cards, [1]);
});

test("approved taste rules go with every paper decision; settings are validated", async () => {
  const jev = scripted((id, _c, q: any) =>
    id === "relevance"
      ? score(0.75, 5)
      : id === "matched_question"
        ? choice("Q1", Object.keys(q.criteria))
        : id === "worth"
          ? noul(0.8)
          : undefined,
  );
  const server = await startTestServer({
    hub: {
      ticker: false,
      fauxRules: [cardWriterRule],
      jevDecide: jev.decide,
      paperFetch: arxivOnlyFetch(fakePapers(3)),
    },
  });
  try {
    const projectRuntime = server.hub.project;
    projectRuntime.brief.write("# x");
    projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    projectRuntime.charters.approve();
    await assert.rejects(projectRuntime.plugins.kernel.configure("rh.sweep", { level: "expert" }));
    await projectRuntime.plugins.kernel.configure("rh.sweep", {
      tasteRules: ["No clinical trials"],
      level: "advanced",
    });
    projectRuntime.scheduler.trigger("sweep");
    await until(() => projectRuntime.sweeps.list().length === 1, 10_000, "sweep");
    await projectRuntime.sweeps.settled(projectRuntime.sweeps.list(1)[0].id, 30_000);
    const withRules = jev.calls.filter((c) => (c.state as any).taste_rules);
    assert.ok(withRules.length > 0);
    assert.deepEqual((withRules[0].state as any).taste_rules.rules, ["No clinical trials"]);
  } finally {
    await server.stop();
  }
});
