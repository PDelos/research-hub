// Spec paper-sweep: Jev gate (Threshold setting), Ranking (rankWeights) (v1-2 task 1.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { choice, noul, score, scripted } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers } from "./fixtures/sweep-env.ts";
import { startTestServer, until } from "./helpers.ts";

const answers = (id: string, _c: string, q: any) =>
  id === "relevance"
    ? score(0.5, 5)
    : id === "matched_question"
      ? choice("Q1", Object.keys(q.criteria))
      : id === "kind"
        ? choice("survey", Object.keys(q.criteria))
        : id === "worth"
          ? noul(0.9)
          : undefined;

test("gate thresholds and rank weights come from rh.sweep settings; unset means the commands' policy", async () => {
  let batch = 0;
  const batches = [0, 1].map((b) => fakePapers(6, `K${b}`).map((p, i) => ({ ...p, id: `26${20 + b}.${40000 + i}` })));
  const server = await startTestServer({
    hub: {
      ticker: false,
      fauxRules: [cardWriterRule],
      jevDecide: scripted(answers).decide,
      paperFetch: ((i: any, o: any) => arxivOnlyFetch(batches[batch])(i, o)) as typeof fetch,
    },
  });
  const p = server.hub.project;
  p.brief.write("# x");
  p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  p.charters.approve();
  const sweep = async (b: number) => {
    batch = b;
    p.scheduler.trigger("sweep");
    await until(() => p.sweeps.list().length === b + 1, 10_000, "sweep");
    await p.sweeps.settled(p.sweeps.list(1)[0].id, 30_000);
    return server.client.sweep(p.sweeps.list(1)[0].id);
  };
  try {
    const first = await sweep(0);
    const relevance = first.papers[0].relevance!;
    assert.ok(
      first.papers.every((x) => x.status !== "rejected"),
      "relevance clears the default 0.45",
    );
    assert.equal(p.plugins.kernel.settings("rh.sweep").relevanceMin, undefined);

    await p.plugins.kernel.configure("rh.sweep", { relevanceMin: Math.min(1, relevance + 0.05) });
    const second = await sweep(1);
    assert.ok(second.papers.every((x) => x.status === "rejected"));
    assert.match(second.papers[0].reason!, new RegExp(`below relevance_min ${Math.min(1, relevance + 0.05)}`));

    await assert.rejects(p.plugins.kernel.configure("rh.sweep", { rankWeights: { importance: 2 } }), /rankWeights/);
    await p.plugins.kernel.configure("rh.sweep", {
      rankWeights: { importance: 0, relevance: 1, question: 0, level: 0, freshness: 0 },
    });
    assert.deepEqual(p.plugins.kernel.settings("rh.sweep").rankWeights, {
      importance: 0,
      relevance: 1,
      question: 0,
      level: 0,
      freshness: 0,
    });
  } finally {
    await server.stop();
  }
});
