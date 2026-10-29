// Spec daily-cycle: Exploration pick (task 5.1): after the user likes papers, the last card slot goes to the gated
// paper outside the top ones least like them; none before any 👍/⭐, none with explorationPicks 0.
import assert from "node:assert/strict";
import { test } from "node:test";
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

test("exploration picks: none before likes, one marked last card after, none when turned off", async () => {
  let batch = 0;
  const batches = [0, 1, 2].map((b) =>
    fakePapers(12, `Batch${b}`).map((p, i) => ({ ...p, id: `26${10 + b}.${String(30000 + i)}` })),
  );
  const fetchBy = ((input: any, init: any) => arxivOnlyFetch(batches[batch])(input, init)) as typeof fetch;
  const server = await startTestServer({
    hub: { ticker: false, fauxRules: [cardWriterRule], jevDecide: scripted(passAll).decide, paperFetch: fetchBy },
  });
  const projectRuntime = server.hub.project;
  projectRuntime.brief.write("# Protein LMs");
  projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  projectRuntime.charters.approve();
  const sweep = async (b: number) => {
    batch = b;
    projectRuntime.scheduler.trigger("sweep");
    for (let i = 0; i < 500 && projectRuntime.sweeps.list().length < b + 1; i++)
      await new Promise((r) => setTimeout(r, 10));
    const id = projectRuntime.sweeps.list()[0].id;
    await projectRuntime.sweeps.settled(id, 30_000);
    return server.client.sweep(id);
  };
  try {
    const first = await sweep(0);
    const firstCards = first.papers.filter((x) => x.status === "presented");
    assert.ok(firstCards.length >= 7, JSON.stringify(first.papers.map((x) => x.status)));
    assert.ok(
      first.papers.every((x) => !x.exploration),
      "no likes yet: no exploration",
    );

    const { groups } = await server.client.cards();
    for (const card of groups[0].cards.slice(0, 2)) await server.client.judge(card.id, "star", "Exactly my topic");

    const second = await sweep(1);
    const picks = second.papers.filter((x) => x.exploration);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].rank, 7, "the last card slot");
    const cards = (await server.client.cards()).groups[0].cards;
    assert.equal(cards.filter((c) => c.exploration).length, 1);

    await projectRuntime.plugins.kernel.configure("rh.sweep", { explorationPicks: 0 });
    const third = await sweep(2);
    assert.ok(third.papers.every((x) => !x.exploration));
  } finally {
    await server.stop();
  }
});
