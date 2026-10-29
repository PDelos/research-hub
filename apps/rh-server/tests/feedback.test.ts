// Spec paper-feedback: judgments, ⭐ hand-off, dedupe, weights (tasks 1.1–1.3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleCharter } from "./fixtures/charter.ts";
import { choice, noul, score } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers, sweepEnv } from "./fixtures/sweep-env.ts";

const passAll = (id: string, _c: string, q: any) =>
  id === "relevance"
    ? score(0.75, 5)
    : id === "matched_question"
      ? choice("Q1", Object.keys(q.criteria))
      : id === "kind"
        ? choice("method", Object.keys(q.criteria))
        : id === "worth"
          ? noul(0.8)
          : undefined;

async function withCards(n = 4, over: Record<string, unknown> = {}) {
  const env = sweepEnv({ fetch: arxivOnlyFetch(fakePapers(n)), script: passAll, ...over });
  const sweep = await env.runner.settled(env.runner.start("manual").id);
  const cards = env.presentAll(sweep.id);
  return { env, sweep, cards };
}

test("gather records the charter queries that found each paper (review variants count for their base query)", async () => {
  const { env, sweep } = await withCards(2);
  try {
    const row = env.db.prepare("SELECT queries_json FROM sweep_papers WHERE sweep_id = ? LIMIT 1").get(sweep.id) as any;
    const queries = JSON.parse(row.queries_json) as string[];
    const charterQueries = new Set(env.charters.approved()!.charter.queries.map((q) => q.text));
    assert.ok(queries.length >= 1);
    assert.ok(
      queries.every((q) => charterQueries.has(q)),
      queries.join(" | "),
    );
  } finally {
    await env.done();
  }
});

test("star with a reason is stored, makes one knowledge-base request, and un-starring cancels it", async () => {
  const { env, cards } = await withCards();
  try {
    const card = cards[0];
    const j = env.feedback.judge(card.id, "star", "Clear baseline for Q2, code available");
    assert.equal(j.verdict, "star");
    assert.equal(j.reason, "Clear baseline for Q2, code available");
    assert.equal(j.ruleStatus, "pending", "waiting for reason-parse");
    env.feedback.judge(card.id, "star", "Clear baseline for Q2, code available");
    assert.equal(env.feedback.kbRequests().length, 1, "starred twice → one request");
    assert.equal(env.feedback.kbRequests()[0].status, "pending");
    env.feedback.judge(card.id, "up");
    assert.equal(env.feedback.kbRequests()[0].status, "cancelled");
    env.feedback.judge(card.id, "star");
    assert.equal(env.feedback.kbRequests()[0].status, "pending");
    env.feedback.clear(card.id);
    assert.equal(env.feedback.kbRequests()[0].status, "cancelled");
    assert.equal(env.feedback.get(card.id), undefined);
    assert.throws(() => env.feedback.judge(card.id, "love"), /verdict must be one of up, down, star/);
    assert.throws(() => env.feedback.judge(card.id, "up", "x".repeat(1001)), /1001 characters, at most 1000/);
    assert.throws(() => env.feedback.judge(9999, "up"), /no card 9999/);
  } finally {
    await env.done();
  }
});

test("👍 then 👎 nets one 👎; weights clamp at 2; effects show before and after; the plan uses effective weights", async () => {
  const charter = sampleCharter({
    queries: [
      { text: "protein language model", weight: 2 },
      "ESM embeddings",
      "contact prediction",
      "protein fine-tuning",
      "PLM benchmark",
    ],
  });
  const a = await withCards(3, { charter });
  const b = await withCards(3, { charter });
  try {
    a.env.feedback.judge(a.cards[0].id, "up");
    a.env.feedback.judge(a.cards[0].id, "down");
    b.env.feedback.judge(b.cards[0].id, "down");
    const strip = (ws: any[]) => ws.map((w) => `${w.kind}:${w.key}=${w.value}`).sort();
    assert.deepEqual(strip(a.env.feedback.weights()), strip(b.env.feedback.weights()), "the net change equals one 👎");
    const q1 = a.env.feedback.weights().find((w) => w.kind === "question" && w.key === "Q1")!;
    assert.equal(q1.base, 1);
    assert.equal(q1.value, 0.85);

    // A query already at 2.0 receives a ⭐ and stays 2.0 (the 👎 is cleared first, so the query is back at 2.0).
    a.env.feedback.clear(a.cards[0].id);
    const star = a.cards.slice(1).find((card) => {
      const row = a.env.db.prepare("SELECT queries_json FROM sweep_papers WHERE paper_id = ?").get(card.paperId) as any;
      return (JSON.parse(row.queries_json) as string[]).includes("protein language model");
    })!;
    assert.ok(star, "a card found by the weight-2 query");
    a.env.feedback.judge(star.id, "star");
    assert.equal(a.env.feedback.weight("query", "protein language model", 0), 2);
    const effects = a.env.feedback.effects(star.id);
    assert.deepEqual(
      effects.find((e) => e.kind === "query" && e.key === "protein language model"),
      { kind: "query", key: "protein language model", before: 2, after: 2 },
    );
    assert.ok(effects.some((e) => e.kind === "question" && e.key === "Q1" && e.before === 1 && e.after === 1.15));
    assert.ok(effects.some((e) => e.kind === "source" && e.key === "arxiv" && e.before < e.after));
    // The runner's charter carries the effective weights.
    const runnerQ1 = a.env.runner.charter().questions.find((q) => q.id === "Q1")!;
    assert.equal(runnerQ1.weight, 1.15, "the charter's 1 plus 0.15 for the ⭐");
    const down = a.cards.find((c) => c.id !== star.id && c.id !== a.cards[0].id)!;
    a.env.feedback.judge(down.id, "down", "too basic");
    const queriesOfDown = JSON.parse(
      (a.env.db.prepare("SELECT queries_json FROM sweep_papers WHERE paper_id = ?").get(down.paperId) as any)
        .queries_json,
    ) as string[];
    for (const q of queriesOfDown) {
      const charterWeight = a.env.charters.approved()!.charter.queries.find((x) => x.text === q)!.weight;
      assert.ok(a.env.runner.charter().queries.find((x) => x.text === q)!.weight <= charterWeight, q);
    }
  } finally {
    await a.env.done();
    await b.env.done();
  }
});

test("a 👎 paper found again is dropped in dedupe; orientation ends after 10 judged papers", async () => {
  const { env, cards } = await withCards(12);
  try {
    env.feedback.judge(cards[0].id, "down", "off-topic");
    const next = await env.runner.settled(env.runner.start("manual").id);
    assert.ok(!env.runner.papers(next.id).some((p) => p.paperId === cards[0].paperId));
    assert.equal(next.orientation, true);
    const more = env.presentAll(next.id);
    for (const c of [...cards.slice(1), ...more].slice(0, 9)) env.feedback.judge(c.id, "up");
    assert.equal(env.feedback.count(), 10);
    const later = await env.runner.settled(env.runner.start("manual").id);
    assert.equal(later.orientation, false);
  } finally {
    await env.done();
  }
});
