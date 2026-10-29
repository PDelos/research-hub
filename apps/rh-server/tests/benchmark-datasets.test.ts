// Spec slots: Datasets and fixed samples (v1-3 task 2.2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSample, SampleUnavailable, type DatasetIo } from "../src/harness/benchmarks/datasets.ts";
import { benchmarkFetch } from "./fixtures/benchmarks/datasets.ts";

function io(offline = false) {
  const { fetch, requests } = benchmarkFetch();
  const cache = new Map<string, string>();
  const value: DatasetIo = {
    offline,
    fetchBytes: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    readCache: (name) => cache.get(name),
    writeCache: (name, content) => void cache.set(name, content),
  };
  return { io: value, requests, cache };
}

test("a retrieval sample is built once from Parquet and TSV, with relevant documents and distractors, then reused", async () => {
  const s = io();
  const first = await loadSample("scidocs", s.io);
  assert.equal(first.downloaded, true);
  const { sample } = first;
  assert.equal(sample.queries.length, 12, "every query with a relevant document (fewer than 100 here)");
  assert.ok(!sample.queries.some((q) => q.id === "q99"), "a score-0 qrel is not relevant");
  for (const q of sample.queries) for (const d of sample.relevant[q.id]) assert.ok(sample.docs.some((x) => x.id === d));
  assert.equal(sample.docs.length, 42);
  assert.equal(s.requests.length, 3);
  const again = await loadSample("scidocs", s.io);
  assert.equal(again.downloaded, false);
  assert.equal(s.requests.length, 3, "cached: nothing downloaded the second time");
  assert.ok(s.cache.has("benchmarks/scidocs-v2.json"));

  // The same seed gives the same sample.
  const other = io();
  assert.deepEqual((await loadSample("scidocs", other.io)).sample, sample);
  assert.equal((await loadSample("litsearch", other.io)).sample.queries.length, 12);
});

test("the PubMed sample maps sentence roles to background, method and result", async () => {
  const { sample } = await loadSample("pubmed-rct", io().io);
  assert.equal(sample.abstracts.length, 5);
  assert.deepEqual(
    sample.abstracts[0].sentences.map((x) => x.label),
    ["background", "background", "method", "result", "result"],
  );
});

test("offline mode never downloads: a missing sample is reported", async () => {
  const s = io(true);
  await assert.rejects(loadSample("scidocs", s.io), SampleUnavailable);
  assert.equal(s.requests.length, 0);
});
