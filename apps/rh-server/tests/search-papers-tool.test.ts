// Spec paper-sources: paper search from chat (task 5.1). Offline mode: synthetic source responses, fake embeddings,
// mock Jev; no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, say } from "@rh/durable-agent";
import { deskSearchRule } from "../src/faux-rules.ts";
import { startTestServer } from "./test-server.ts";

test("asking the desk for papers calls search_papers, stores and represents the records, and answers with metadata", async () => {
  const server = await startTestServer({ hub: { fauxRules: [deskSearchRule] } });
  try {
    const before = await server.client.usage();
    const sent = await server.client.send("Find recent papers on ESM contact prediction", { waitMs: 20_000 });
    assert.equal(sent.status, "done");
    const answer = sent.answer!.text;
    assert.match(answer, /^5 papers for "ESM contact prediction" \(stored in the project\):/);
    const lines = answer.split("\n").filter((l) => /^\d+\. /.test(l));
    assert.equal(lines.length, 5);
    for (const line of lines)
      assert.match(line, /\(\d{4}\) · .+ · (\d+ citations|citations unknown) · sources: [a-z, ]+ · https:\/\//);
    assert.match(answer, /Sources: arxiv 5, openalex 5, europepmc 5, semanticscholar skipped\./);

    const papers = server.hub.project.papers;
    assert.ok(papers.store.count() >= 10, `${papers.store.count()} stored`);
    const merged = papers.store.all().filter((p) => p.sources.includes("arxiv") && p.sources.includes("openalex"));
    assert.ok(merged.length >= 1, "a preprint and its journal version became one record");
    const shown = papers.store.all().slice(0, 5);
    for (const p of shown) assert.ok(papers.vectors.kinds(p.id).includes("whole"), `paper ${p.id} has a whole vector`);

    // Representation costs are counted: one Jev facet call per paper with an abstract, and the embedding calls.
    const after = await server.client.usage();
    assert.ok(after.jevCalls >= before.jevCalls + 5, `jev calls ${before.jevCalls} → ${after.jevCalls}`);
    assert.ok(
      after.embeddingCalls > before.embeddingCalls,
      `embedding calls ${before.embeddingCalls} → ${after.embeddingCalls}`,
    );
    // Priced calls (live mode) add to the dollar totals.
    server.hub.project.papers.embeddingLedger.record({
      model: "qwen/qwen3-embedding-8b",
      inputs: 20,
      tokens: 4000,
      costUsd: 0.00004,
      costSource: "reported",
      elapsedMs: 300,
    });
    const priced = await server.client.usage();
    assert.ok(Math.abs(priced.embeddingUsd - after.embeddingUsd - 0.00004) < 1e-12);
    assert.ok(Math.abs(priced.totalUsd - (priced.modelUsd + priced.jevUsd + priced.embeddingUsd)) < 1e-12);
    assert.ok(priced.monthUsd >= 0.00004);
  } finally {
    await server.stop();
  }
});

test("search_papers rejects a limit of 50 with the maximum of 10 per call, and searches nothing", async () => {
  const server = await startTestServer({
    hub: {
      fauxRules: [
        (turn) =>
          turn.results.length
            ? say(`${turn.results[0].isError ? "ERROR" : "OK"}: ${turn.results[0].text}`)
            : call("search_papers", { query: "protein", limit: 50 }),
      ],
    },
  });
  try {
    const sent = await server.client.send("go", { waitMs: 10_000 });
    assert.match(sent.answer!.text, /^ERROR: Not searched: limit 50 is not allowed: at most 10 results per call/);
    assert.equal(server.hub.project.papers.store.count(), 0);
  } finally {
    await server.stop();
  }
});
