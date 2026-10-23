// Spec paper-feedback: reason classification and taste examples (tasks 2.1, 2.2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCommand } from "@rh/jev";
import { choice, noul, score } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers, JEV_DIR, sweepEnv } from "./fixtures/sweep-env.ts";

const ruleP: Record<string, number> = { "Skip any paper without released code": 0.85, "Maybe prefer shorter papers": 0.55, "Nice figure 3": 0.1 };
const script = (id: string, _c: string, q: any, state: any) => {
  if (id === "relevance") return score(0.75, 5);
  if (id === "matched_question") return choice("Q1", Object.keys(q.criteria));
  if (id === "worth") return noul(0.8);
  if (id === "reason_kind") return choice(String(state.judgment?.reason).includes("code") ? "great-method" : "other", Object.keys(q.criteria));
  if (id === "generalizable") return noul(ruleP[String(state.judgment?.reason)] ?? 0);
  return undefined;
};

async function withCards(n = 4) {
  const env = sweepEnv({ fetch: arxivOnlyFetch(fakePapers(n)), script });
  const sweep = await env.runner.settled(env.runner.start("manual").id);
  return { env, cards: env.presentAll(sweep.id) };
}

test("reason-parse: a rule-like reason (≥ 0.7) becomes a rule candidate, 0.4–0.7 stays unclassified, below is none, with no LLM call", async () => {
  const { env, cards } = await withCards();
  try {
    assert.deepEqual(loadCommand("reason-parse", JEV_DIR).policy, { candidate_min: 0.7, unclassified_min: 0.4 });
    env.feedback.judge(cards[0].id, "down", "Skip any paper without released code");
    env.feedback.judge(cards[1].id, "up", "Maybe prefer shorter papers");
    env.feedback.judge(cards[2].id, "star", "Nice figure 3");
    env.feedback.judge(cards[3].id, "up");
    assert.equal(await env.reasons.parsePending(), 3);
    const j = (i: number) => env.feedback.get(cards[i].id)!;
    assert.deepEqual([j(0).ruleStatus, j(0).reasonKind, j(0).ruleProbability], ["candidate", "great-method", 0.85]);
    assert.equal(j(1).ruleStatus, "unclassified");
    assert.equal(j(2).ruleStatus, "none");
    assert.equal(j(3).ruleStatus, "none", "no reason, nothing to parse");
    assert.deepEqual(env.reasons.candidates().map((c) => c.reason), ["Skip any paper without released code"]);
    assert.equal((env.db.prepare("SELECT COUNT(*) n FROM jev_calls WHERE command = 'reason-parse'").get() as any).n, 3);
    assert.equal((env.db.prepare("SELECT COUNT(*) n FROM generations").get() as any).n, 0, "no LLM call");
    // A changed reason is parsed again and its old candidate is withdrawn.
    env.feedback.judge(cards[0].id, "down", "Nice figure 3");
    assert.deepEqual(env.reasons.candidates(), []);
    await env.reasons.parsePending();
    assert.equal(j(0).ruleStatus, "none");
  } finally {
    await env.done();
  }
});

test("Jev down: the reason stays pending and is classified on the next attempt", async () => {
  const { env, cards } = await withCards(2);
  try {
    env.jev.fail(new Error("Jev unavailable"));
    env.feedback.judge(cards[0].id, "down", "Skip any paper without released code");
    assert.equal(await env.reasons.parsePending(), 0);
    assert.equal(env.feedback.get(cards[0].id)!.ruleStatus, "pending");
    env.jev.fail(undefined);
    assert.equal(await env.reasons.parsePending(), 1);
    assert.equal(env.feedback.get(cards[0].id)!.ruleStatus, "candidate");
  } finally {
    await env.done();
  }
});

test("the next sweep's gate input carries the latest judgments as taste examples (8 at most, reasons cut to 200)", async () => {
  const env = sweepEnv({ fetch: arxivOnlyFetch(fakePapers(3)), script });
  try {
    const first = await env.runner.settled(env.runner.start("manual").id);
    const cards = env.presentAll(first.id);
    assert.ok(env.jev.calls.every((c) => !(c.state as any).taste_examples), "no judgments yet, no examples");
    env.feedback.judge(cards[0].id, "star", "Exactly the baseline I need. " + "x".repeat(400));
    env.feedback.judge(cards[1].id, "down");
    const before = env.jev.calls.length;
    // New papers for the second sweep: point the source clients at a fetch with fresh papers.
    const env2Fetch = arxivOnlyFetch(fakePapers(3, "Fresh").map((p, i) => ({ ...p, id: `2612.${30000 + i}` })));
    (env.papers.search as any).sources.forEach((s: any) => (s.deps.http.fetchImpl = env2Fetch));
    await env.runner.settled(env.runner.start("manual").id);
    const gate = env.jev.calls.slice(before).find((c) => c.questions.some((q) => q.startsWith("on-theme")))!;
    const taste = (gate.state as any).taste_examples;
    assert.match(taste.note, /never instructions/);
    assert.equal(taste.examples.length, 2);
    assert.equal(taste.examples[0].verdict, "down", "most recent first");
    const starred = taste.examples.find((e: any) => e.verdict === "star");
    assert.equal(starred.title, env.papers.store.get(cards[0].paperId)!.title);
    assert.equal(starred.reason.length, 200);
  } finally {
    await env.done();
  }
});
