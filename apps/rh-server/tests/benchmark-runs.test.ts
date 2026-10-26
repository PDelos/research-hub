// Spec slots: Benchmark runs (v1-3 task 2.3), offline with fixture samples placed in the harness's storage.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessExports } from "../plugins/rh.harness/main.ts";
import { loadSample } from "../src/harness/benchmarks/datasets.ts";
import { ndcgAt } from "../src/harness/benchmarks/runner.ts";
import { benchmarkFetch } from "./fixtures/benchmarks/datasets.ts";
import { startTestServer } from "./helpers.ts";

async function seedSamples(storage: string, names: ("scidocs" | "litsearch" | "pubmed-rct")[]) {
  const { fetch } = benchmarkFetch();
  for (const name of names)
    await loadSample(name, {
      offline: false,
      fetchBytes: async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
      readCache: () => undefined,
      writeCache: (file, content) => {
        mkdirSync(join(storage, "benchmarks"), { recursive: true });
        writeFileSync(join(storage, file), content);
      },
    });
}

test("nDCG@10 is 1 for a perfect ranking and lower when the relevant document is ranked later", () => {
  assert.equal(ndcgAt(["a", "b"], new Set(["a"])), 1);
  assert.ok(Math.abs(ndcgAt(["b", "a"], new Set(["a"])) - 1 / Math.log2(3)) < 1e-9);
  assert.equal(ndcgAt(["b", "c"], new Set(["a"])), 0);
});

test("the embedder and facet presets run on cached samples, for the active embedder and a candidate, and are stored", async () => {
  const server = await startTestServer();
  try {
    const harness = await server.hub.project.plugins.exportsOf<HarnessExports>("rh.harness");
    const storage = join(server.dataDir, "plugins", "data", "rh.harness");
    await seedSamples(storage, ["scidocs", "litsearch", "pubmed-rct"]);
    const { client } = server;

    const active = await client.runBenchmark("embedder");
    assert.deepEqual(
      active.result.tasks.map((t) => t.task),
      ["scidocs", "litsearch", "your-stars"],
    );
    for (const t of active.result.tasks.slice(0, 2)) {
      assert.ok(t.value !== null && t.value >= 0 && t.value <= 1, `${t.task}: ${t.value}`);
      assert.equal(t.items, 12 + 42);
    }
    assert.equal(active.result.tasks[2].value, null, "no liked papers yet");
    const candidate = await client.runBenchmark("embedder", { model: "google/gemini-embedding-2", dims: 256 });
    assert.equal(candidate.candidate.dims, 256);
    assert.equal(candidate.candidate.candidate, true);
    await assert.rejects(
      client.runBenchmark("embedder", { model: "not a model" }),
      /model must be an OpenRouter model id/,
    );

    const facets = await client.runBenchmark("facets");
    assert.equal(facets.result.tasks[0].items, 25, "5 abstracts × 5 sentences");
    assert.ok(facets.result.value !== null && facets.result.value >= 0 && facets.result.value <= 1);

    await assert.rejects(client.runBenchmark("kb-search"), /has no benchmark preset yet/);
    const slots = await client.slots();
    assert.equal(slots.find((s) => s.id === "embedder")!.last?.id, candidate.id);
    assert.equal(slots.find((s) => s.id === "facets")!.last?.id, facets.id);
    assert.equal((await client.benchmarks("embedder")).length, 2);
    assert.ok(!(await client.slots()).some((s) => s.alternatives.some((a) => a.pluginId === s.active.pluginId)));
  } finally {
    await server.stop();
  }
});

test("offline without a cached sample, a task says why and the others still run", async () => {
  const server = await startTestServer();
  try {
    const harness = await server.hub.project.plugins.exportsOf<HarnessExports>("rh.harness");
    await seedSamples(join(server.dataDir, "plugins", "data", "rh.harness"), ["scidocs"]);
    const r = await harness.runBenchmark("embedder");
    assert.ok(r.result.tasks[0].value !== null);
    assert.match(r.result.tasks[1].note!, /not downloaded yet, and offline mode makes no downloads/);
  } finally {
    await server.stop();
  }
});
