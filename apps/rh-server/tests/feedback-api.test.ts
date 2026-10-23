// Spec paper-feedback: judging through the API, weights, precision@5 (task 3.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { choice, noul, score, scripted } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers } from "./fixtures/sweep-env.ts";
import { startTestServer } from "./helpers.ts";

const passAll = (id: string, _c: string, q: any) =>
  id === "relevance" ? score(0.75, 5) : id === "matched_question" ? choice("Q2", Object.keys(q.criteria)) : id === "worth" ? noul(0.8) : id === "generalizable" ? noul(0.1) : id === "reason_kind" ? choice("great-foundation", Object.keys(q.criteria)) : undefined;

test("judging through the API: verdicts on cards, weight effects in details, weights, and precision@5 (2 ⭐, 1 👎, 2 unjudged → 67%)", async () => {
  const jev = scripted(passAll);
  const server = await startTestServer({ hub: { ticker: false, fauxRules: [cardWriterRule], jevDecide: jev.decide, paperFetch: arxivOnlyFetch(fakePapers(7)) } });
  const p = server.hub.project;
  try {
    p.brief.write("# Protein LMs");
    p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    p.charters.approve();
    p.feedback.replay();
    p.scheduler.trigger("sweep");
    for (let i = 0; i < 500 && !p.sweeps.list()[0]; i++) await new Promise((r) => setTimeout(r, 10));
    await p.sweeps.settled(p.sweeps.list()[0].id, 30_000);
    const cards = (await server.client.cards()).groups[0].cards;
    assert.equal(cards.length, 7);
    assert.equal(cards[0].judgment, null);

    const starred = await server.client.judge(cards[0].id, "star", "Clear baseline for Q2, code available");
    assert.equal(starred.judgment!.verdict, "star");
    assert.equal(starred.judgment!.reason, "Clear baseline for Q2, code available");
    assert.ok(starred.weightEffects.some((e) => e.kind === "question" && e.key === "Q2" && e.before === 1.5 && e.after === 1.65));
    await server.client.judge(cards[1].id, "star");
    await server.client.judge(cards[2].id, "up");
    await server.client.judge(cards[2].id, "down", "too basic for me");
    const weights = await server.client.weights();
    const q2 = weights.find((w) => w.kind === "question" && w.key === "Q2")!;
    assert.deepEqual({ base: q2.base, value: q2.value }, { base: 1.5, value: 1.65 }, "+0.15 +0.15 −0.15");
    assert.ok(weights.some((w) => w.kind === "source" && w.key === "arxiv"));

    const [precision] = await server.client.precision();
    assert.deepEqual({ top: precision.top, judged: precision.judged, good: precision.good }, { top: 5, judged: 3, good: 2 });
    assert.ok(Math.abs(precision.precision! - 2 / 3) < 1e-9);

    const regrouped = (await server.client.cards()).groups[0].cards;
    assert.equal(regrouped[2].judgment!.verdict, "down");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(p.feedback.get(cards[0].id)!.ruleStatus, "none", "the reason was parsed in the background");
    assert.equal(p.feedback.get(cards[0].id)!.reasonKind, "great-foundation");

    const cleared = await server.client.clearJudgment(cards[1].id);
    assert.equal(cleared.judgment, null);
    assert.deepEqual(p.feedback.kbRequests().map((r) => r.status).sort(), ["cancelled", "pending"]);
    await assert.rejects(server.client.judge(cards[0].id, "meh" as any), /verdict must be one of up, down, star/);
    await assert.rejects(server.client.judge(99999, "up"), /No card 99999/);
  } finally {
    await server.stop();
  }
});

test("in chat, \"star the second card, great foundation\" records a ⭐ with that reason on the latest sweep's second card", async () => {
  const { deskJudgeRule } = await import("../src/faux-rules.ts");
  const jev = scripted(passAll);
  const server = await startTestServer({ hub: { ticker: false, fauxRules: [cardWriterRule, deskJudgeRule], jevDecide: jev.decide, paperFetch: arxivOnlyFetch(fakePapers(4)) } });
  const p = server.hub.project;
  try {
    p.brief.write("# Protein LMs");
    p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    p.charters.approve();
    p.scheduler.trigger("sweep");
    for (let i = 0; i < 500 && !p.sweeps.list()[0]; i++) await new Promise((r) => setTimeout(r, 10));
    await p.sweeps.settled(p.sweeps.list()[0].id, 30_000);
    const second = (await server.client.cards()).groups[0].cards[1];
    const sent = await server.client.send("star the second card, great foundation", { waitMs: 15_000 });
    assert.equal(sent.status, "done");
    assert.match(sent.answer!.text, /⭐ recorded on card \d+ .* with the reason "great foundation"/);
    const j = p.feedback.get(second.id)!;
    assert.deepEqual({ verdict: j.verdict, reason: j.reason }, { verdict: "star", reason: "great foundation" });
    assert.equal(p.feedback.kbRequests().length, 1);
  } finally {
    await server.stop();
  }
});
