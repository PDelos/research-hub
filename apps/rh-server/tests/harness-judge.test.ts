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
import { startTestServer, until } from "./test-server.ts";

// Exercises advanced features, so it runs in the full profile whatever RH_PROFILE says (v2-0 D7).
process.env.RH_PROFILE = "full";

/** Three sweeps of 12 papers, half "Good" (the user likes them) and half "Bad". */
/** The user likes the "Good" papers, starring every other one, and dislikes the rest. */
const userVerdict = (title: string, cardId: number) => {
  if (!title.startsWith("Good")) return "down";
  return cardId % 2 ? "star" : "up";
};

async function project(judgeLikes: (title: string) => number) {
  let batch = 0;
  const batches = [0, 1, 2].map((b) =>
    fakePapers(12, "x").map((p, i) => ({
      ...p,
      id: `26${30 + b}.${50000 + i}`,
      title: `${i % 2 ? "Bad" : "Good"} paper ${b}-${i} on protein language models`,
    })),
  );
  const jev = scripted((id, _c, question: any, state: any) => {
    if (id === "like") return noul(judgeLikes(String(state.paper?.title ?? "")));
    if (id === "relevance") return score(0.6, 5);
    if (id === "matched_question") return choice("Q1", Object.keys(question.criteria));
    if (id === "kind") return choice("survey", Object.keys(question.criteria));
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
  const projectRuntime = server.hub.project;
  projectRuntime.brief.write("# x");
  projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  projectRuntime.charters.approve();
  await projectRuntime.plugins.kernel.configure("rh.sweep", { cardsPerSweep: 10, explorationPicks: 0 });
  for (const b of [0, 1, 2]) {
    batch = b;
    projectRuntime.scheduler.trigger("sweep");
    await until(() => projectRuntime.sweeps.list().length === b + 1, 10_000, "sweep");
    await projectRuntime.sweeps.settled(projectRuntime.sweeps.list(1)[0].id, 30_000);
  }
  for (const group of (await server.client.cards(100)).groups)
    for (const card of group.cards) await server.client.judge(card.id, userVerdict(card.paper.title, card.id));
  const harness = await projectRuntime.plugins.exportsOf<HarnessExports>("rh.harness");
  const likeCalls = () => jev.calls.filter((c) => c.questions.includes("like")).length;
  return { server, p: projectRuntime, harness, likeCalls };
}

test("a judge that agrees with the user is trusted, its labels are cached, and the budget stops labelling", async () => {
  const env = await project((title) => (title.startsWith("Good") ? 0.9 : 0.1));
  try {
    const night = await env.harness.night();
    assert.equal(night.calibration.cases, 30);
    assert.equal(night.calibration.agreement, 1);
    assert.equal(night.calibration.trusted, true);
    assert.equal(night.labelled, 6, "the ranked-out papers the user never saw");
    const calls = env.likeCalls();
    const again = await env.harness.night();
    assert.equal(again.labelled, 0);
    assert.equal(env.likeCalls(), calls, "cached labels are reused");
    assert.equal(env.harness.quality().labels.judge, 36);

    // Budget: with today's budget used up, labelling stops and nothing else is affected.
    env.p.db.exec(
      `DELETE FROM ${env.harness.judge.tables.labels} WHERE paper_id NOT IN (SELECT paper_id FROM judgments)`,
    );
    env.p.plugins.services.budgets.charge("rh.harness", 1);
    const stopped = await env.harness.judge.labelRecent();
    assert.deepEqual(stopped, { labelled: 0, stoppedByBudget: true });

    // A replay makes no Jev, model or embedding call.
    const count = (t: string) => Number((env.p.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n);
    const before = [count("jev_calls"), count("generations"), count("embedding_calls")];
    const storedReplay = await env.harness.replay({ cardsPerSweep: 5 });
    assert.deepEqual([count("jev_calls"), count("generations"), count("embedding_calls")], before);
    assert.equal(storedReplay.report.sweeps.total, 3);
    assert.equal(storedReplay.report.sweeps.labelled, 3);
    assert.ok(["better", "worse", "inconclusive"].includes(storedReplay.report.verdict));
    assert.equal(storedReplay.report.judgeUsed, true);
  } finally {
    await env.server.stop();
  }
});

test("a judge that disagrees is not trusted: replays use only the user's verdicts", async () => {
  const env = await project(() => 0.9);
  try {
    const night = await env.harness.night();
    assert.equal(night.calibration.trusted, false);
    assert.ok(night.calibration.agreement! < 0.7);
    assert.equal(env.harness.judge.labelsIfTrusted(), undefined);
    const storedReplay = await env.harness.replay({ cardsPerSweep: 5 });
    assert.equal(storedReplay.report.judgeUsed, false);
    assert.equal(env.harness.quality().judge?.trusted, false);
  } finally {
    await env.server.stop();
  }
});

test("the harness API, the digest's quality section and the desk's replay_variant tool", async () => {
  const env = await project((title) => (title.startsWith("Good") ? 0.9 : 0.1));
  try {
    const { client } = env.server;
    await env.harness.night();
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

    const digest = await (await env.p.plugins.exportsOf<DigestExports>("rh.digest")).buildDigest();
    assert.equal(digest.quality?.judge?.trusted, true);
    assert.ok(digest.quality?.replays.some((r) => r.id === stored.id));

    const sent = await client.send('use replay_variant {"variant": {"cardsPerSweep": 5}}', { waitMs: 20_000 });
    assert.equal(sent.status, "done");
    assert.match(sent.answer!.text, /^(better|worse|inconclusive): nDCG/);
    assert.equal((await client.replays())[0].requestedBy, "desk");
  } finally {
    await env.server.stop();
  }
});
