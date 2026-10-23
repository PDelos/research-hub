// Spec paper-sources: one record per work, title-only duplicates flagged, metadata cache (tasks 2.2, 2.3).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectDb } from "../src/db.ts";
import { MetadataCache, PaperStore, type SourcePaper } from "../src/papers/store.ts";
import { tempDir } from "./helpers.ts";

function withStore(run: (store: PaperStore, db: ReturnType<typeof openProjectDb>["db"]) => void | Promise<void>) {
  return async () => {
    const t = tempDir();
    const { db } = openProjectDb(join(t.dir, "project.sqlite"));
    try {
      await run(new PaperStore(db), db);
    } finally {
      db.close();
      t.cleanup();
    }
  };
}

const arxivPreprint: SourcePaper = {
  source: "arxiv",
  externalId: "2401.01234v2",
  ids: { arxiv: "2401.01234v2", doi: "10.1038/s41592-026-00001-x" },
  title: "Contact prediction with protein language models",
  abstract: "We predict contacts.",
  authors: ["A. Author", "B. Author"],
  publishedAt: "2024-01-03",
  server: "arXiv",
  url: "https://arxiv.org/abs/2401.01234",
  categories: ["q-bio.BM", "cs.LG"],
};

test(
  "preprint and journal version with the same DOI become one record with both identifiers, sources and the journal venue",
  withStore((store) => {
    const first = store.upsert(arxivPreprint);
    assert.equal(first.created, true);
    const second = store.upsert({
      source: "openalex",
      externalId: "W123456789",
      ids: { doi: "https://doi.org/10.1038/S41592-026-00001-X", openalex: "https://openalex.org/W123456789" },
      title: "Contact prediction with protein language models",
      abstract: "We predict contacts from single sequences with a protein language model.",
      authors: ["A. Author", "B. Author", "C. Author"],
      publishedAt: "2024-06-10",
      venue: "Nature Methods",
      citedByCount: 42,
      retracted: false,
    });
    assert.deepEqual(second, { id: first.id, created: false, merged: [] });
    assert.equal(store.count(), 1);
    const paper = store.get(first.id)!;
    assert.deepEqual(paper.ids, { doi: "10.1038/s41592-026-00001-x", arxiv: "2401.01234", openalex: "W123456789" });
    assert.deepEqual(paper.sources, ["arxiv", "openalex"]);
    assert.equal(paper.venue, "Nature Methods");
    assert.equal(paper.server, "arXiv");
    assert.deepEqual(paper.categories, ["q-bio.BM", "cs.LG"], "arXiv categories are stored and kept through the merge");
    assert.equal(paper.publishedAt, "2024-01-03", "the earliest appearance is kept");
    assert.equal(paper.citedByCount, 42);
    assert.equal(paper.authors.length, 3);
    assert.match(paper.abstract!, /single sequences/);
    // A later arXiv version (v3) still lands on the same record.
    assert.equal(store.upsert({ ...arxivPreprint, ids: { arxiv: "2401.01234v3" } }).id, first.id);
  }),
);

test(
  "a result whose identifiers point at two records merges them into the older one",
  withStore((store) => {
    const a = store.upsert({ ...arxivPreprint, ids: { arxiv: "2401.01234" } });
    const b = store.upsert({
      source: "europepmc",
      externalId: "PPR1",
      ids: { pmid: "38000001" },
      title: "Contact prediction with protein language models (journal)",
      authors: [],
      venue: "Bioinformatics",
    });
    assert.equal(store.count(), 2);
    const bridge = store.upsert({
      source: "openalex",
      externalId: "W9",
      ids: { arxiv: "2401.01234", pmid: "38000001", openalex: "W9" },
      title: "Contact prediction with protein language models",
      authors: [],
    });
    assert.deepEqual(bridge, { id: a.id, created: false, merged: [b.id] });
    assert.equal(store.count(), 1);
    const paper = store.get(a.id)!;
    assert.deepEqual(paper.ids, { arxiv: "2401.01234", pmid: "38000001", openalex: "W9" });
    assert.deepEqual(paper.sources.sort(), ["arxiv", "europepmc", "openalex"]);
    assert.equal(paper.venue, "Bioinformatics");
    assert.equal(store.get(b.id), undefined);
  }),
);

test(
  "two results with the same normalized title but no shared identifier stay two records, flagged",
  withStore((store) => {
    const a = store.upsert({ source: "arxiv", externalId: "x", ids: { arxiv: "2401.00001" }, title: "Graph Neural Networks for Gene Regulation", authors: [] });
    const b = store.upsert({ source: "europepmc", externalId: "y", ids: { doi: "10.1101/2026.01.01.000001" }, title: "Graph neural networks for gene regulation.", authors: [] });
    assert.notEqual(a.id, b.id);
    assert.equal(store.count(), 2);
    assert.equal(store.get(b.id)!.possibleDuplicateOf, a.id);
    assert.equal(store.get(a.id)!.possibleDuplicateOf, undefined);
  }),
);

test(
  "title-only papers, retraction and enrichment state",
  withStore((store) => {
    const { id } = store.upsert({ source: "europepmc", externalId: "PPR2", ids: { doi: "10.1101/2026.10.01.555555" }, title: "A fresh preprint", authors: [], server: "bioRxiv" });
    let paper = store.get(id)!;
    assert.equal(paper.titleOnly, true);
    assert.equal(paper.enrichment, "pending");
    assert.deepEqual(store.pendingEnrichment().map((p) => p.id), [id]);
    store.setEnrichment(id, "pending");
    assert.equal(store.get(id)!.enrichmentAttempts, 1);
    store.upsert({ source: "openalex", externalId: "W5", ids: { doi: "10.1101/2026.10.01.555555", openalex: "W5" }, title: "A fresh preprint", abstract: "Now with text.", authors: [], retracted: true });
    store.setEnrichment(id, "done");
    paper = store.get(id)!;
    assert.equal(paper.titleOnly, false);
    assert.equal(paper.retracted, true);
    assert.equal(paper.enrichment, "done");
    assert.deepEqual(store.pendingEnrichment(), []);
  }),
);

test(
  "citation links resolve to known papers, also when the cited paper arrives later",
  withStore((store, db) => {
    const a = store.upsert({ source: "openalex", externalId: "W1", ids: { openalex: "W1" }, title: "Citing paper", authors: [], references: ["https://openalex.org/W2", "W3"] });
    const b = store.upsert({ source: "openalex", externalId: "W2", ids: { openalex: "W2" }, title: "Cited paper", authors: [] });
    const links = db.prepare("SELECT cited_value, cited_paper_id FROM citation_links WHERE citing_paper_id = ? ORDER BY cited_value").all(a.id) as any[];
    assert.deepEqual(links.map((l) => [l.cited_value, l.cited_paper_id === null ? null : Number(l.cited_paper_id)]), [["W2", b.id], ["W3", null]]);
  }),
);

test(
  "the metadata cache answers the same key once within 7 days and misses expire after an hour",
  withStore(async (_store, db) => {
    let now = Date.parse("2026-10-23T08:00:00Z");
    const cache = new MetadataCache(db, () => now);
    let calls = 0;
    const fetchWork = async () => (calls++, { id: "W1" });
    assert.deepEqual(await cache.through("openalex:doi:10.1/x", fetchWork), { id: "W1" });
    now += 6 * 60 * 60 * 1000; // later the same day
    assert.deepEqual(await cache.through("openalex:doi:10.1/x", fetchWork), { id: "W1" });
    assert.equal(calls, 1, "same DOI on the same day hits the network once");
    now += 7 * 24 * 60 * 60 * 1000;
    await cache.through("openalex:doi:10.1/x", fetchWork);
    assert.equal(calls, 2, "after 7 days it is fetched again");
    let misses = 0;
    const missing = async () => (misses++, undefined);
    await cache.through("openalex:doi:10.1/new", missing);
    await cache.through("openalex:doi:10.1/new", missing);
    assert.equal(misses, 1);
    now += 61 * 60 * 1000;
    await cache.through("openalex:doi:10.1/new", missing);
    assert.equal(misses, 2);
    assert.ok(cache.purge() >= 0);
  }),
);
