// Spec paper-cards / paper-sweep: Feed and sweep APIs, live cards frame (task 3.3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readSse, type Frame } from "@rh/sdk";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { choice, noul, score, scripted } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers } from "./fixtures/sweep-env.ts";
import { startTestServer } from "./helpers.ts";

const passAll = (id: string, _c: string, q: any) =>
  id === "relevance"
    ? score(0.5, 5)
    : id === "matched_question"
      ? choice("Q1", Object.keys(q.criteria))
      : id === "kind"
        ? choice("survey", Object.keys(q.criteria))
        : id === "worth"
          ? noul(0.9)
          : undefined;

test("cards are grouped by sweep newest first, card details trace each score, sweeps show phases and the cost split, and the stream announces new cards", async () => {
  const jev = scripted(passAll);
  let batch = 0;
  const papers = [fakePapers(3, "First"), fakePapers(3, "Second").map((p, i) => ({ ...p, id: `2611.${20000 + i}` }))];
  const fetchBy: typeof fetch = ((input: any, init: any) => arxivOnlyFetch(papers[batch])(input, init)) as typeof fetch;
  const server = await startTestServer({
    hub: { ticker: false, fauxRules: [cardWriterRule], jevDecide: jev.decide, paperFetch: fetchBy },
  });
  const p = server.hub.project;
  p.brief.write("# Protein LMs");
  p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  p.charters.approve();
  const frames: Frame[] = [];
  const abort = new AbortController();
  const streaming = (async () => {
    const res = await fetch(`${server.url}/v1/stream`, {
      headers: { authorization: "Bearer test-api-token-0123456789" },
      signal: abort.signal,
    });
    for await (const message of readSse(res.body!)) frames.push(JSON.parse(message.data) as Frame);
  })().catch(() => {});
  try {
    await new Promise((r) => setTimeout(r, 200));
    for (const b of [0, 1]) {
      batch = b;
      const res = await fetch(`${server.url}/v1/runs/sweep`, {
        method: "POST",
        headers: { authorization: "Bearer test-api-token-0123456789" },
      });
      assert.equal(res.status, 202);
      for (let i = 0; i < 500 && p.sweeps.list().length < b + 1; i++) await new Promise((r) => setTimeout(r, 10));
      await p.sweeps.settled(p.sweeps.list()[0].id, 30_000);
    }
    const { groups } = await server.client.cards();
    assert.deepEqual(
      groups.map((g) => g.sweep.id),
      [2, 1],
      "newest sweep first",
    );
    assert.deepEqual(
      groups.map((g) => g.cards.length),
      [3, 3],
    );
    const card = groups[0].cards[0];
    assert.equal(card.rank, 1);
    assert.equal(card.borderline, true, "relevance 0.5 is in the review band");
    assert.deepEqual(card.matchedQuestion, { id: "Q1", text: "How do protein LMs transfer to structure?" });
    assert.ok(card.paper.title.startsWith("Second") && card.paper.authors.length && card.paper.link);
    const detail = await server.client.card(card.id);
    assert.equal(detail.details.decisions["on-theme"].version, 1);
    assert.ok(detail.paper.abstract);
    assert.match(detail.details.formulas.relevance, /0\.75 × Jev relevance/);

    const sweeps = await server.client.sweeps();
    assert.equal(sweeps.length, 2);
    assert.equal(sweeps[0].status, "completed");
    assert.equal(sweeps[0].cards, 3);
    const sweep = await server.client.sweep(sweeps[0].id);
    assert.deepEqual(Object.keys(sweep.phases), [
      "plan",
      "gather",
      "dedupe",
      "gate",
      "enrich",
      "level",
      "rank",
      "cards",
    ]);
    assert.ok(sweep.cost && sweep.cost.totalUsd === sweep.cost.jevUsd + sweep.cost.embeddingUsd + sweep.cost.modelUsd);
    assert.ok(sweep.cost.jevCalls >= 6);
    assert.equal(sweep.papers.filter((x) => x.status === "presented").length, 3);
    assert.ok(sweep.queries.length > 0);

    assert.deepEqual(await server.client.sweepSettings(), { cardsPerSweep: 7 });
    assert.deepEqual(await server.client.setSweepSettings({ cardsPerSweep: 3 }), { cardsPerSweep: 3 });
    await assert.rejects(server.client.setSweepSettings({ cardsPerSweep: 40 }), /1 to 15/);
    await assert.rejects(server.client.card(9999), /No card 9999/);

    await new Promise((r) => setTimeout(r, 500));
    const cardFrames = frames.filter((f): f is Extract<Frame, { type: "cards" }> => f.type === "cards");
    assert.ok(cardFrames.length >= 2, `${cardFrames.length} cards frames`);
    assert.equal(cardFrames.at(-1)!.count, 6);
    assert.equal(cardFrames.at(-1)!.sweep?.status, "completed");
  } finally {
    abort.abort();
    await streaming;
    await server.stop();
  }
});
