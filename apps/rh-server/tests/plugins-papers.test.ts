// Spec plugin-system: Extension points owned by plugins (Many sources), v0 as built-in plugins (Disable an optional
// feature) (task 2.2): searches query only the sources whose plugins are enabled, a plugin can add a source, and
// enrichment follows the enricher contribution.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectDb } from "../src/db.ts";
import { PoliteHttp } from "../src/papers/http.ts";
import { offlinePaperFetch } from "../src/papers/offline.ts";
import { PaperSearch } from "../src/papers/search.ts";
import type { PaperSource } from "../src/papers/sources/types.ts";
import { MetadataCache, PaperStore } from "../src/papers/store.ts";
import { fakeFetch, recorded, type Route } from "./fixtures/papers/fake-fetch.ts";
import { startTestServer, tempDir } from "./test-server.ts";

const noPacing = { "export.arxiv.org": 0, "api.openalex.org": 0, "www.ebi.ac.uk": 0, "api.semanticscholar.org": 0 };
const s2: Route = (url) => (url.host === "api.semanticscholar.org" ? Response.json({ data: [] }) : undefined);
const openalexKnowsNothing: Route = (url) =>
  url.host === "api.openalex.org" && url.searchParams.get("filter")?.startsWith("doi:")
    ? Response.json({ results: [] })
    : undefined;

const pubmed: PaperSource = {
  name: "pubmed",
  async search(sourceQuery) {
    return [
      {
        source: "pubmed",
        externalId: "PMID1",
        ids: { doi: "10.1000/pubmed.1" },
        title: `A PubMed paper about ${sourceQuery.query}`,
        abstract: "Background. Methods. Results.",
        authors: ["Ada Rivera"],
        publishedAt: "2026-10-01",
        year: 2026,
      },
    ];
  },
};

test("a search queries only the selected sources and adds plugin sources; a disabled Semantic Scholar gets no request", async () => {
  const temp = tempDir();
  const { db } = openProjectDb(join(temp.dir, "project.sqlite"));
  const fake = fakeFetch(s2, openalexKnowsNothing, recorded);
  try {
    const search = new PaperSearch({
      store: new PaperStore(db),
      cache: new MetadataCache(db),
      http: new PoliteHttp({ fetch: fake.fetch, pacing: noPacing, sleep: async () => {} }),
      s2ApiKey: "s2-key-abc",
      selected: async () => ({ builtin: new Set(["arxiv", "openalex"]), extra: [pubmed], enrich: false }),
    });
    const result = await search.search({ query: "protein language model", limit: 25 });
    assert.deepEqual(
      result.sources.map((r) => [r.source, r.status, r.error ?? ""]),
      [
        ["arxiv", "ok", ""],
        ["openalex", "ok", ""],
        ["pubmed", "ok", ""],
        ["europepmc", "skipped", "its plugin is disabled"],
        ["semanticscholar", "skipped", "its plugin is disabled"],
      ],
    );
    assert.ok(!fake.requests.some((r) => r.url.host === "api.semanticscholar.org"));
    assert.ok(!fake.requests.some((r) => r.url.host === "www.ebi.ac.uk"));
    assert.ok(result.papers.some((p) => p.sources.includes("pubmed") && p.title.startsWith("A PubMed paper")));
    // No enricher selected: no DOI batch lookup.
    assert.ok(!fake.requests.some((r) => r.url.searchParams.get("filter")?.startsWith("doi:")));
    assert.deepEqual(result.enrichment, { done: 0, pending: 0 });
  } finally {
    db.close();
    temp.cleanup();
  }
});

test("disabling a source plugin in a project removes the source from the next search; enabling brings it back", async () => {
  const hosts: string[] = [];
  const offline = offlinePaperFetch();
  const paperFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    hosts.push(new URL(input instanceof Request ? input.url : String(input)).host);
    return offline(input, init);
  }) as typeof fetch;
  const server = await startTestServer({ hub: { paperFetch } });
  try {
    const project = server.hub.project;
    const { kernel } = project.plugins;
    assert.equal(kernel.get("rh.source-europepmc")?.builtin, true);
    await kernel.setEnabled("rh.source-europepmc", false);
    hosts.length = 0;
    const without = await project.papers.find({ query: "protein folding", limit: 5 });
    assert.deepEqual(
      without.sources.find((s) => s.source === "europepmc"),
      {
        source: "europepmc",
        status: "skipped",
        count: 0,
        error: "its plugin is disabled",
      },
    );
    assert.ok(!hosts.includes("www.ebi.ac.uk"));
    assert.ok(hosts.includes("export.arxiv.org"));

    await kernel.setEnabled("rh.source-europepmc", true);
    hosts.length = 0;
    const back = await project.papers.find({ query: "protein folding", limit: 5 });
    assert.equal(back.sources.find((s) => s.source === "europepmc")?.status, "ok");
    assert.ok(hosts.includes("www.ebi.ac.uk"));

    // Without OpenAlex the records are not enriched.
    await kernel.setEnabled("rh.source-openalex", false);
    hosts.length = 0;
    const plain = await project.papers.find({ query: "enzyme design", limit: 5 });
    assert.ok(!hosts.includes("api.openalex.org"));
    assert.deepEqual(plain.enrichment, { done: 0, pending: 0 });

    // The embedder is required: there is no other.
    await assert.rejects(kernel.setEnabled("rh.embedder-openrouter", false), /cannot be disabled/);
  } finally {
    await server.stop();
  }
});
