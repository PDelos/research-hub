// Spec paper-sources: source clients map recorded responses into normalized records (tasks 3.2–3.5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { PoliteHttp } from "../src/papers/http.ts";
import { ArxivSource, parseArxivFeed } from "../src/papers/sources/arxiv.ts";
import { EuropePmcSource, mapEuropePmcRecord } from "../src/papers/sources/europepmc.ts";
import { abstractFromInvertedIndex, mapOpenAlexWork, OpenAlexSource } from "../src/papers/sources/openalex.ts";
import { mapS2Paper } from "../src/papers/sources/semanticscholar.ts";
import { queryTerms } from "../src/papers/sources/types.ts";
import { fakeFetch, fixture, recorded } from "./fixtures/papers/fake-fetch.ts";

const noPacing = { "export.arxiv.org": 0, "api.openalex.org": 0, "www.ebi.ac.uk": 0, "api.semanticscholar.org": 0 };

test("arXiv: id, title, abstract, authors and date from the Atom feed; the window goes into the query", async () => {
  const [first] = parseArxivFeed(fixture("arxiv-search.xml"));
  assert.equal(first.source, "arxiv");
  assert.equal(first.ids.arxiv, "2610.26747");
  assert.equal(first.externalId, "2610.26747");
  assert.equal(first.title, "recAMPLIFY: Large-Scale Pretraining of Recursive Protein Language Models");
  assert.match(first.abstract!, /^Protein language models \(pLMs\) are powerful tools/);
  assert.deepEqual(first.authors.slice(0, 2), ["Saurav Jha", "Qianli Liao"]);
  assert.equal(first.publishedAt, "2026-10-19");
  assert.equal(first.server, "arXiv");
  assert.equal(first.url, "https://arxiv.org/abs/2610.26747");
  assert.deepEqual(first.categories, ["cs.LG", "cs.AI", "cs.CL"], "primary category first");

  const fake = fakeFetch(recorded);
  const arxiv = new ArxivSource({ http: new PoliteHttp({ fetch: fake.fetch, pacing: noPacing }) });
  const results = await arxiv.search({ query: '"protein language model" contact', since: "2026-10-01", limit: 3 });
  assert.equal(results.length, 3);
  assert.ok(results.every((p) => p.publishedAt! >= "2026-10-01"));
  const q = fake.requests[0].url.searchParams;
  assert.equal(
    q.get("search_query"),
    'all:"protein language model" AND all:contact AND submittedDate:[202610010000 TO 299912312359]',
  );
  assert.equal(q.get("max_results"), "3");
  // The date window is also applied to what comes back.
  const late = await arxiv.search({ query: "protein", since: "2026-10-19", until: "2026-10-19", limit: 3 });
  assert.ok(late.length >= 1 && late.length < 3, `only papers from 2026-10-19: ${late.map((p) => p.publishedAt)}`);
  assert.ok(late.every((p) => p.publishedAt === "2026-10-19"));
  assert.throws(() => parseArxivFeed("<html>oops</html>"), /not an Atom feed/);
});

test("OpenAlex: fields, abstract from the inverted index, references, server names and the retracted flag", async () => {
  const work = mapOpenAlexWork(JSON.parse(fixture("openalex-work.json")))!;
  assert.equal(work.ids.openalex, "W4327550249");
  assert.equal(work.ids.doi, "10.1126/science.ade2574");
  assert.equal(work.ids.pmid, "36927031");
  assert.equal(work.venue, "Science");
  assert.equal(work.server, undefined);
  assert.match(work.title, /^Evolutionary-scale prediction of atomic-level protein structure/);
  assert.match(work.abstract!, /^Artificial intelligence/);
  assert.equal(work.publishedAt, "2023-03-16");
  assert.ok(work.citedByCount! > 1000);
  assert.equal(work.references!.length, 71);
  assert.equal(work.retracted, false);
  assert.equal(work.authors[0], "Zeming Lin");

  const retracted = mapOpenAlexWork(JSON.parse(fixture("openalex-retracted.json")).results[0])!;
  assert.equal(retracted.retracted, true);

  const search = JSON.parse(fixture("openalex-search.json")).results.map(mapOpenAlexWork);
  const preprint = search.find((p: any) => p.ids.doi === "10.1101/2025.06.02.657171");
  assert.equal(preprint.server, "bioRxiv");
  assert.equal(preprint.venue, undefined);
  assert.equal(abstractFromInvertedIndex({ Abstract: [0], We: [1], test: [2] }), "We test");
  assert.equal(abstractFromInvertedIndex(null), undefined);

  const fake = fakeFetch(recorded);
  const openalex = new OpenAlexSource({
    http: new PoliteHttp({ fetch: fake.fetch, pacing: noPacing, contactEmail: "me@example.org" }),
  });
  const results = await openalex.search({
    query: "protein language model contact prediction",
    since: "2025-01-01",
    limit: 3,
  });
  assert.equal(results.length, 3);
  const q = fake.requests[0].url.searchParams;
  assert.equal(q.get("mailto"), "me@example.org");
  assert.equal(q.get("filter"), "from_publication_date:2025-01-01");
  assert.equal(q.get("per-page"), "3");
});

test("OpenAlex lookups: DOIs in one batched request, 404 means not found", async () => {
  const fake = fakeFetch((url) => {
    if (url.searchParams.get("filter")?.startsWith("doi:"))
      return Response.json({ results: [JSON.parse(fixture("openalex-work.json"))] });
    return undefined;
  });
  const openalex = new OpenAlexSource({ http: new PoliteHttp({ fetch: fake.fetch, pacing: noPacing }) });
  const found = await openalex.byDois(["10.1126/science.ade2574", "10.1101/9999.99.99.999999"]);
  assert.deepEqual([...found.keys()], ["10.1126/science.ade2574"]);
  assert.equal(fake.requests.length, 1);
  assert.equal(
    fake.requests[0].url.searchParams.get("filter"),
    "doi:10.1126/science.ade2574|10.1101/9999.99.99.999999",
  );
  assert.equal(await openalex.lookup("pmid", "1"), undefined);
});

test("Europe PMC: a bioRxiv preprint maps to server bioRxiv with DOI and abstract; journal articles keep venue and PMID", async () => {
  const [preprint] = JSON.parse(fixture("europepmc-search.json")).resultList.result.map(mapEuropePmcRecord);
  assert.equal(preprint.server, "bioRxiv");
  assert.equal(preprint.venue, undefined);
  assert.equal(preprint.ids.doi, "10.64898/2026.10.15.759522");
  assert.match(preprint.abstract, /^Mapping which antigen residues/);
  assert.equal(preprint.publishedAt, "2026-10-21");
  assert.equal(preprint.externalId, "PPR:PPR1348506");
  assert.equal(preprint.authors[0], "Babu D");

  const [journal] = JSON.parse(fixture("europepmc-journal.json")).resultList.result.map(mapEuropePmcRecord);
  assert.equal(journal.venue, "Journal of advanced research");
  assert.equal(journal.ids.pmid, "42826899");
  assert.equal(journal.server, undefined);
  assert.match(
    journal.abstract,
    /^Introduction: Peptide hormones/,
    "section headings stay with their sentence, HTML stripped",
  );
  assert.doesNotMatch(journal.abstract, /<h4>/);

  const fake = fakeFetch(recorded);
  const epmc = new EuropePmcSource({
    http: new PoliteHttp({ fetch: fake.fetch, pacing: noPacing, contactEmail: "me@example.org" }),
  });
  const results = await epmc.search({
    query: '"protein language model"',
    since: "2026-01-01",
    until: "2026-12-31",
    limit: 3,
  });
  assert.equal(results.length, 3);
  const q = fake.requests[0].url.searchParams;
  assert.equal(q.get("query"), '("protein language model") AND FIRST_PDATE:[2026-01-01 TO 2026-12-31]');
  assert.equal(q.get("email"), "me@example.org");
  assert.equal(q.get("resultType"), "core");
});

test("Semantic Scholar mapping and query terms", () => {
  const p = mapS2Paper({
    paperId: "0123456789abcdef0123456789abcdef01234567",
    title: "A paper",
    abstract: "Text.",
    authors: [{ name: "X Y" }],
    year: 2026,
    publicationDate: "2026-10-01",
    venue: "bioRxiv",
    externalIds: { DOI: "10.1101/2026.10.01.1", ArXiv: "2610.00001", PubMed: "1", CorpusId: 5 },
    citationCount: 3,
    url: "https://www.semanticscholar.org/paper/x",
  })!;
  assert.deepEqual(p.ids, {
    s2: "0123456789abcdef0123456789abcdef01234567",
    doi: "10.1101/2026.10.01.1",
    arxiv: "2610.00001",
    pmid: "1",
  });
  assert.deepEqual(queryTerms('ESM "contact prediction" AND (proteins) OR'), [
    "ESM",
    '"contact prediction"',
    "proteins",
  ]);
});
