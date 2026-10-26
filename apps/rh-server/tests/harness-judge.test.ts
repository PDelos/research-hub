// Spec harness: Labels and the calibrated judge, Nightly labelling within budget, Replay from stored scores (no new
// calls) (v1-2 tasks 3.1, 4.1), on an offline project with scripted Jev.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessExports } from "../plugins/rh.harness/main.ts";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule, deskToolRule } from "../src/faux-rules.ts";
import type { DigestExports } from "../plugins/rh.digest/main.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { choice, noul, score, scripted } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers } from "./fixtures/sweep-env.ts";
import { startTestServer, until } from "./helpers.ts";

/** Three sweeps of 12 papers, half "Good" (the user likes them) and half "Bad". */
async function project(judgeLikes: (title: string) => number) {
  let batch = 0;
  const batches = [0, 1, 2].map((b) =>
    fakePapers(12, "x").map((p, i) => ({
      ...p,
      id: `26${30 + b}.${50000 + i}`,
      title: `${i % 2 ? "Bad" : "Good"} paper ${b}-${i} on protein language models`,
    })),
  );
  const jev = scripted((id, _c, q: any, state: any) => {
    if (id === "like") return noul(judgeLikes(String(state.paper?.title ?? "")));
    if (id === "relevance") return score(0.6, 5);
    if (id === "matched_question") return choice("Q1", Object.keys(q.criteria));
    if (id === "kind") return choice("survey", Object.keys(q.criteria));
    if (id === "worth") return noul(0.9);
    return undefined;
  });
  const server = await startTestServer({
    hub: {
      ticker: false,
      fauxRules: [cardWriterRule, deskToolRule],
      jevDecide: jev.decide,
      paperFetch: ((i: any, o: any) => arxivOnlyFetch(batches[batch])(i, o)) as typeof fetch,
    },
  });
  const p = server.hub.project;
  p.brief.write("# x");
  p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  p.charters.approve();
  await p.plugins.kernel.configure("rh.sweep", { cardsPerSweep: 10, explorationPicks: 0 });
  for (const b of [0, 1, 2]) {
    batch = b;
    p.scheduler.trigger("sweep");
    await until(() => p.sweeps.list().length === b + 1, 10_000, "sweep");
    await p.sweeps.settled(p.sweeps.list(1)[0].id, 30_000);
  }
  for (const group of (await server.client.cards(100)).groups)
    for (const card of group.cards)
      await server.client.judge(card.id, card.paper.title.startsWith("Good") ? (card.id % 2 ? "star" : "up") : "down");
  const harness = await p.plugins.exportsOf<HarnessExports>("rh.harness");
  const likeCalls = () => jev.calls.filter((c) => c.questions.includes("like")).length;
  return { server, p, harness, likeCalls };
}

test("a judge that agrees with the user is trusted, its labels are cached, and the budget stops labelling", async () => {
  const s = await project((title) => (title.startsWith("Good") ? 0.9 : 0.1));
  try {
    const night = await s.harness.night();
    assert.equal(night.calibration.cases, 30);
    assert.equal(night.calibration.agreement, 1);
    assert.equal(night.calibration.trusted, true);
    assert.equal(night.labelled, 6, "the ranked-out papers the user never saw");
    const calls = s.likeCalls();
    const again = await s.harness.night();
    assert.equal(again.labelled, 0);
    assert.equal(s.likeCalls(), calls, "cached labels are reused");
    assert.equal(s.harness.quality().labels.judge, 36);

    // Budget: with today's budget used up, labelling stops and nothing else is affected.
    s.p.db.exec(`DELETE FROM ${s.harness.judge.tables.labels} WHERE paper_id NOT IN (SELECT paper_id FROM judgments)`);
    s.p.plugins.services.budgets.charge("rh.harness", 1);
    const stopped = await s.harness.judge.labelRecent();
    assert.deepEqual(stopped, { labelled: 0, stoppedByBudget: true });

    // A replay makes no Jev, model or embedding call.
    const count = (t: string) => Number((s.p.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n);
    const before = [count("jev_calls"), count("generations"), count("embedding_calls")];
    const r = await s.harness.replay({ cardsPerSweep: 5 });
    assert.deepEqual([count("jev_calls"), count("generations"), count("embedding_calls")], before);
    assert.equal(r.report.sweeps.total, 3);
    assert.equal(r.report.sweeps.labelled, 3);
    assert.ok(["better", "worse", "inconclusive"].includes(r.report.verdict));
    assert.equal(r.report.judgeUsed, true);
  } finally {
    await s.server.stop();
  }
});

test("a judge that disagrees is not trusted: replays use only the user's verdicts", async () => {
  const s = await project(() => 0.9);
  try {
    const night = await s.harness.night();
    assert.equal(night.calibration.trusted, false);
    assert.ok(night.calibration.agreement! < 0.7);
    assert.equal(s.harness.judge.labelsIfTrusted(), undefined);
    const r = await s.harness.replay({ cardsPerSweep: 5 });
    assert.equal(r.report.judgeUsed, false);
    assert.equal(s.harness.quality().judge?.trusted, false);
  } finally {
    await s.server.stop();
  }
});

test("the harness API, the digest's quality section and the desk's replay_variant tool", async () => {
  const s = await project((title) => (title.startsWith("Good") ? 0.9 : 0.1));
  try {
    const { client } = s.server;
    await s.harness.night();
    await assert.rejects(client.replay({ cardsPerSweep: 40 }), /cardsPerSweep: must be an integer from 1 to 15/);
    await assert.rejects(client.replay({ colour: 1 } as never), /colour: not a sweep setting a replay can change/);
    const stored = await client.replay({ relevanceMin: 0.5 });
    assert.equal(stored.requestedBy, "user");
    assert.equal(stored.report.current.relevanceMin, 0.45);
    assert.equal(stored.report.candidate.relevanceMin, 0.5);
    assert.equal((await client.replays())[0].id, stored.id);
    const quality = await client.quality();
    assert.equal(quality.judge?.trusted, true);
    assert.equal(quality.overTime.length, 3);
    assert.ok(quality.overTime.every((q) => q.ndcg !== undefined));

    const digest = await (await s.p.plugins.exportsOf<DigestExports>("rh.digest")).buildDigest();
    assert.equal(digest.quality?.judge?.trusted, true);
    assert.ok(digest.quality?.replays.some((r) => r.id === stored.id));

    const sent = await client.send('use replay_variant {"variant": {"cardsPerSweep": 5}}', { waitMs: 20_000 });
    assert.equal(sent.status, "done");
    assert.match(sent.answer!.text, /^(better|worse|inconclusive): nDCG/);
    assert.equal((await client.replays())[0].requestedBy, "desk");
  } finally {
    await s.server.stop();
  }
});
