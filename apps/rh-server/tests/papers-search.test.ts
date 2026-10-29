// Spec paper-sources: search across sources, failure isolation, enrichment and the S2 key gate (tasks 3.5, 3.6).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectDb } from "../src/db.ts";
import { PoliteHttp } from "../src/papers/http.ts";
import { PaperSearch } from "../src/papers/search.ts";
import { MetadataCache, PaperStore } from "../src/papers/store.ts";
import { fakeFetch, fixture, recorded, type Route } from "./fixtures/papers/fake-fetch.ts";
import { tempDir } from "./test-server.ts";

const noPacing = { "export.arxiv.org": 0, "api.openalex.org": 0, "www.ebi.ac.uk": 0, "api.semanticscholar.org": 0 };
const instantSleep = async () => {};

function setup(routes: Route[], options: { s2ApiKey?: string; now?: () => number } = {}) {
  const temp = tempDir();
  const { db } = openProjectDb(join(temp.dir, "project.sqlite"));
  const fake = fakeFetch(...routes);
  const store = new PaperStore(db);
  const search = new PaperSearch({
    store,
    cache: new MetadataCache(db, options.now),
    http: new PoliteHttp({ fetch: fake.fetch, pacing: noPacing, sleep: instantSleep }),
    s2ApiKey: options.s2ApiKey,
  });
  return { search, store, fake, db, done: () => (db.close(), temp.cleanup()) };
}

/** OpenAlex DOI batch lookups answer nothing (works not in OpenAlex yet). */
/** arXiv and the OpenAlex search find nothing, so Europe PMC is the only source with results. */
const onlyEpmc: Route = (url) => {
  if (url.host === "export.arxiv.org") return new Response("<feed/>");
  if (url.searchParams.has("search")) return Response.json({ results: [] });
  return undefined;
};

const openalexKnowsNothing: Route = (url) =>
  url.host === "api.openalex.org" && url.searchParams.get("filter")?.startsWith("doi:")
    ? Response.json({ results: [] })
    : undefined;

test("a query runs on arXiv, OpenAlex and Europe PMC; each paper lists its sources; no request goes to Semantic Scholar without a key", async () => {
  const env = setup([openalexKnowsNothing, recorded]);
  try {
    const result = await env.search.search({ query: "protein language model", limit: 25 });
    assert.deepEqual(
      result.sources.map((r) => [r.source, r.status, r.count]),
      [
        ["arxiv", "ok", 3],
        ["openalex", "ok", 3],
        ["europepmc", "ok", 3],
        ["semanticscholar", "skipped", 0],
      ],
    );
    assert.equal(result.papers.length, 9);
    assert.equal(result.created, 9);
    assert.ok(result.papers.every((p) => p.sources.length >= 1));
    assert.deepEqual(
      result.papers.slice(0, 3).map((p) => p.sources[0]),
      ["arxiv", "openalex", "europepmc"],
      "ranks interleave across sources",
    );
    const preprint = result.papers.find((p) => p.server === "bioRxiv" && p.sources.includes("europepmc"))!;
    assert.ok(preprint.ids.doi && preprint.abstract);
    assert.ok(!env.fake.requests.some((r) => r.url.host === "api.semanticscholar.org"));
    // OpenAlex results count as enriched; the others were looked up in one batch and stay pending.
    assert.equal(result.enrichment.pending, 6);
    assert.equal(env.fake.requests.filter((r) => r.url.searchParams.get("filter")?.startsWith("doi:")).length, 1);
  } finally {
    env.done();
  }
});

test("Semantic Scholar is queried with x-api-key only when S2_API_KEY is set", async () => {
  const s2: Route = (url) => (url.host === "api.semanticscholar.org" ? Response.json({ data: [] }) : undefined);
  const env = setup([s2, openalexKnowsNothing, recorded], { s2ApiKey: "s2-key-abc" });
  try {
    const result = await env.search.search({ query: "protein", limit: 5 });
    assert.deepEqual(
      result.sources.find((r) => r.source === "semanticscholar"),
      { source: "semanticscholar", status: "ok", count: 0 },
    );
    const request = env.fake.requests.find((r) => r.url.host === "api.semanticscholar.org")!;
    assert.equal(request.headers.get("x-api-key"), "s2-key-abc");
  } finally {
    env.done();
  }
});

test("Europe PMC down (503): the other sources' results return and Europe PMC is listed as failed with the reason", async () => {
  const down: Route = (url) => (url.host === "www.ebi.ac.uk" ? new Response("", { status: 503 }) : undefined);
  const env = setup([down, openalexKnowsNothing, recorded]);
  try {
    const result = await env.search.search({ query: "protein language model" });
    assert.deepEqual(
      result.sources.find((r) => r.source === "europepmc"),
      {
        source: "europepmc",
        status: "failed",
        count: 0,
        error: "HTTP 503 after 3 attempts",
      },
    );
    assert.equal(result.papers.length, 6);
    assert.equal(env.fake.requests.filter((r) => r.url.host === "www.ebi.ac.uk").length, 3);
  } finally {
    env.done();
  }
});

test("a fresh preprint not yet in OpenAlex stays pending, is retried on a later search, and becomes done with metadata", async () => {
  let now = Date.parse("2026-10-23T08:00:00Z");
  let indexed = false;
  const preprintDoi = "10.64898/2026.10.15.759522";
  const work = JSON.parse(fixture("openalex-work.json"));
  const lookup: Route = (url) => {
    if (url.host !== "api.openalex.org" || !url.searchParams.get("filter")?.startsWith("doi:")) return undefined;
    const asked = url.searchParams.get("filter")!.slice(4).split("|");
    return Response.json({
      results:
        indexed && asked.includes(preprintDoi)
          ? [
              {
                ...work,
                id: "https://openalex.org/W1",
                doi: `https://doi.org/${preprintDoi}`,
                ids: {},
                is_retracted: true,
                cited_by_count: 2,
              },
            ]
          : [],
    });
  };
  const env = setup([lookup, onlyEpmc, recorded], { now: () => now });
  try {
    const first = await env.search.search({ query: "protein language model" });
    const paper = first.papers.find((p) => p.ids.doi === preprintDoi)!;
    assert.equal(paper.enrichment, "pending");
    assert.equal(first.enrichment.pending, 3);
    // Same day, OpenAlex has indexed it now, but the miss is cached for an hour.
    indexed = true;
    await env.search.search({ query: "unrelated words", limit: 1 });
    assert.equal(env.store.get(paper.id)!.enrichment, "pending");
    now += 2 * 60 * 60 * 1000;
    const later = await env.search.search({ query: "unrelated words", limit: 1 });
    assert.ok(later.enrichment.done >= 1);
    const enriched = env.store.get(paper.id)!;
    assert.equal(enriched.enrichment, "done");
    assert.equal(enriched.retracted, true);
    assert.equal(enriched.citedByCount, 2);
    assert.equal(enriched.ids.openalex, "W1");
    assert.ok(enriched.sources.includes("openalex"));
  } finally {
    env.done();
  }
});

test("the same DOI found by two queries on the same day is looked up in OpenAlex once", async () => {
  const env = setup([
    openalexKnowsNothing,
    (url) => (url.host === "www.ebi.ac.uk" ? undefined : onlyEpmc(url)),
    recorded,
  ]);
  try {
    await env.search.search({ query: "protein language model" });
    // A second query finds the same works again; their DOIs were already asked for today.
    for (const p of env.store.all()) env.store.setEnrichment(p.id, "pending");
    const lookups = () => env.fake.requests.filter((r) => r.url.searchParams.get("filter")?.startsWith("doi:")).length;
    const before = lookups();
    await env.search.search({ query: "protein language model again" });
    assert.equal(lookups(), before, "answered from the cache");
  } finally {
    env.done();
  }
});

test("date window and limits", async () => {
  const env = setup([openalexKnowsNothing, recorded]);
  try {
    const result = await env.search.search({ query: "protein language model", since: "2026-10-01" });
    assert.ok(
      result.papers.every((p) => p.publishedAt! >= "2026-10-01"),
      result.papers.map((p) => p.publishedAt).join(","),
    );
    assert.equal((await env.search.search({ query: "protein", limit: 2 })).papers.length, 2);
    await assert.rejects(env.search.search({ query: "protein", limit: 101 }), /limit must be 1 to 100/);
    await assert.rejects(env.search.search({ query: "  " }), /query must not be empty/);
  } finally {
    env.done();
  }
});
