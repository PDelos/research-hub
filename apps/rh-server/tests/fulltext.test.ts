// Spec full-text: Full-text sources, Converter slot (v1-6 tasks 1.2, 1.3), offline with a fake fetch and a fake
// Docling Serve.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import type { FullTextExports } from "../plugins/rh.fulltext/main.ts";
import type { PapersExports } from "../plugins/rh.papers/main.ts";
import { ARXIV_HTML, DOCLING_MD, JATS_XML } from "./fixtures/fulltext/documents.ts";
import { startTestServer } from "./test-server.ts";

const PDF = readFileSync(join(import.meta.dirname, "fixtures/fulltext/paper.pdf"));

/** Routes the full-text sources; everything else 404. Counts requests per URL. */
function fakeWeb() {
  const hits = new Map<string, number>();
  const webFetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    hits.set(url, (hits.get(url) ?? 0) + 1);
    if (url === "https://arxiv.org/html/2601.00001")
      return new Response(ARXIV_HTML, { headers: { "content-type": "text/html" } });
    if (url === "https://arxiv.org/pdf/2601.00002")
      return new Response(PDF, { headers: { "content-type": "application/pdf" } });
    if (url === "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC123/fullTextXML") return new Response(JATS_XML);
    if (url === "https://api.biorxiv.org/details/biorxiv/10.1101/2026.01.01.000001")
      return Response.json({
        collection: [{ jatsxml: "https://www.biorxiv.org/content/early/2026/01/01/x.source.xml" }],
      });
    if (url === "https://www.biorxiv.org/content/early/2026/01/01/x.source.xml") return new Response(JATS_XML);
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: webFetch, hits };
}

async function setup() {
  const web = fakeWeb();
  const server = await startTestServer({ hub: { paperFetch: web.fetch } });
  const projectRuntime = server.hub.project;
  const { papers } = await projectRuntime.plugins.exportsOf<PapersExports>("rh.papers");
  const add = (ids: Record<string, string>, extra: Record<string, unknown> = {}) =>
    papers.store.upsert({
      source: "openalex",
      externalId: `W${Math.random()}`,
      ids,
      title: `Paper ${JSON.stringify(ids)}`,
      abstract: "An abstract.",
      authors: [],
      ...extra,
    } as never).id;
  const fulltext = await projectRuntime.plugins.exportsOf<FullTextExports>("rh.fulltext");
  return { server, p: projectRuntime, papers, add, fulltext, web };
}

test("sources in order: arXiv HTML, Europe PMC, bioRxiv, the PDF through the converter; misses say why", async () => {
  const env = await setup();
  try {
    const html = await env.fulltext.ensure(env.add({ arxiv: "2601.00001" }));
    assert.equal(html.source, "arxiv-html");
    assert.deepEqual(
      html.sections.map((x) => x.title),
      ["Abstract", "Introduction", "Our kernels", "Results"],
    );

    const pdfOnly = await env.fulltext.ensure(env.add({ arxiv: "2601.00002" }));
    assert.equal(pdfOnly.source, "pdf:pdf-text");
    assert.ok(pdfOnly.sections.some((x) => x.title === "2 Methods"));
    assert.match(pdfOnly.notes[0], /arxiv-html: HTTP 404/);

    assert.equal((await env.fulltext.ensure(env.add({ pmcid: "PMC123" }))).source, "europepmc-jats");
    assert.equal((await env.fulltext.ensure(env.add({ doi: "10.1101/2026.01.01.000001" }))).source, "biorxiv-jats");

    const closed = await env.fulltext.ensure(
      env.add({ doi: "10.1000/closed" }, { oaUrl: "https://publisher.example.com/x.pdf" }),
    );
    assert.equal(closed.status, "missing");
    assert.match(closed.notes.join(), /publisher.example.com is not on the open-access host list/);
    const nothing = await env.fulltext.ensure(env.add({ doi: "10.1000/none" }));
    assert.match(nothing.notes[0], /no arXiv id, PMCID, bioRxiv DOI or open-access link/);

    // Stored: a second ensure does not fetch again; refetch does.
    const id = html.paperId;
    await env.fulltext.ensure(id);
    assert.equal(env.web.hits.get("https://arxiv.org/html/2601.00001"), 1);
    await env.fulltext.refetch(id);
    assert.equal(env.web.hits.get("https://arxiv.org/html/2601.00001"), 2);

    // Facet vectors came from the sections.
    assert.ok(env.papers.vectors.kinds(id).includes("method"), JSON.stringify(env.papers.vectors.kinds(id)));
  } finally {
    await env.server.stop();
  }
});

test("the converter slot: pdf-text is active; Docling is unavailable without its image, and works with a Docling Serve", async () => {
  let docling: Server | undefined;
  const received: string[] = [];
  docling = createServer((request, response) => {
    if (request.url === "/health") return void response.end("ok");
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/v1/status/poll/"))
      return void response.end(JSON.stringify({ task_status: "success" }));
    if (request.url?.startsWith("/v1/result/"))
      return void response.end(JSON.stringify({ document: { md_content: DOCLING_MD }, status: "success" }));
    let body = "";
    request.on("data", (d: Buffer) => (body += d.toString("latin1")));
    request.on("end", () => {
      received.push(`${request.url} ${body}`);
      response.end(JSON.stringify({ task_id: "t1", task_status: "pending" }));
    });
  });
  await new Promise<void>((r) => docling!.listen(0, "127.0.0.1", r));
  const port = (docling.address() as { port: number }).port;

  const plain = await setup();
  try {
    const views = await plain.fulltext.converters();
    assert.deepEqual(
      views.map((v) => [v.id, v.active, v.available]),
      [
        ["docling", false, false],
        ["pdf-text", true, true],
      ].toSorted((a, b) => views.findIndex((v) => v.id === a[0]) - views.findIndex((v) => v.id === b[0])),
    );
    assert.match(views.find((v) => v.id === "docling")!.reason!, /research-hub:full/);
    await assert.rejects(plain.fulltext.convert(PDF, "docling"), /not available/);
  } finally {
    await plain.server.stop();
  }

  process.env.RH_DOCLING_URL = `http://127.0.0.1:${port}`;
  const env = await setup();
  try {
    assert.ok((await env.fulltext.converters()).find((v) => v.id === "docling")!.available);
    const sections = await env.fulltext.convert(PDF, "docling");
    assert.deepEqual(
      sections.map((x) => x.title),
      ["Abstract", "1 Introduction", "2 Methods"],
    );
    assert.match(received[0], /^\/v1\/convert\/file\/async /, "the async API");
    assert.match(received[0], /name="files"; filename="paper.pdf"/);
    assert.match(received[0], /name="to_formats"\r\n\r\nmd/);
    await env.p.plugins.kernel.configure("rh.fulltext", { "fulltext.converter": "docling" });
    const fullText = await env.fulltext.ensure(env.add({ arxiv: "2601.00002" }));
    assert.equal(fullText.source, "pdf:docling");
  } finally {
    delete process.env.RH_DOCLING_URL;
    await env.server.stop();
    docling.close();
  }
});

test("a starred paper's note is written with its full text; facet vectors come from its sections", async () => {
  const { validateCharter } = await import("../src/charter.ts");
  const { cardWriterRule, librarianRule } = await import("../src/faux-rules.ts");
  const { sampleCharter } = await import("./fixtures/charter.ts");
  const { choice, noul, score, scripted } = await import("./fixtures/jev-answers.ts");
  const { arxivOnlyFetch, fakePapers } = await import("./fixtures/sweep-env.ts");
  const papers = fakePapers(3);
  const base = arxivOnlyFetch(papers);
  const server = await startTestServer({
    hub: {
      ticker: false,
      fauxRules: [cardWriterRule, librarianRule],
      jevDecide: scripted((id, _c, q: any) =>
        id === "relevance"
          ? score(0.75, 5)
          : id === "matched_question"
            ? choice("Q1", Object.keys(q.criteria))
            : id === "worth"
              ? noul(0.8)
              : undefined,
      ).decide,
      paperFetch: ((input: any, init: any) =>
        String(input).startsWith("https://arxiv.org/html/")
          ? Promise.resolve(new Response(ARXIV_HTML))
          : base(input, init)) as typeof fetch,
    },
  });
  const projectRuntime = server.hub.project;
  try {
    projectRuntime.brief.write("# Protein LMs");
    projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    projectRuntime.charters.approve();
    projectRuntime.syncVault();
    projectRuntime.scheduler.trigger("sweep");
    for (let i = 0; i < 500 && !projectRuntime.sweeps.list()[0]; i++) await new Promise((r) => setTimeout(r, 10));
    await projectRuntime.sweeps.settled(projectRuntime.sweeps.list()[0].id, 30_000);
    const card = projectRuntime.cards.list()[0];
    projectRuntime.feedback.judge(card.id, "star", "Great");
    for (let i = 0; i < 1500 && !projectRuntime.ingest.requests().some((r: any) => r.status === "done"); i++)
      await new Promise((r) => setTimeout(r, 20));
    const fulltext = await projectRuntime.plugins.exportsOf<FullTextExports>("rh.fulltext");
    assert.equal(fulltext.get(card.paperId)?.source, "arxiv-html");
    const prompts = (
      projectRuntime.db.prepare("SELECT text FROM agent_runs WHERE text LIKE 'Add this starred paper%'").all() as {
        text: string;
      }[]
    ).map((r) => r.text);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /FULL_TEXT \(sections, possibly trimmed\):\n## Abstract\nWe report an AUROC of 0.87/);
    assert.match(prompts[0], /## Our kernels\nWe fine-tune on 12,000 transcripts/);
    const { papers: service } = await projectRuntime.plugins.exportsOf<PapersExports>("rh.papers");
    assert.ok(service.vectors.kinds(card.paperId).includes("method"));
  } finally {
    await server.stop();
  }
});

test("the API returns a paper's full text or its absence, fetches it on request, and lists the converters", async () => {
  const env = await setup();
  try {
    const id = env.add({ arxiv: "2601.00001" });
    const none = await env.server.client.fullText(id);
    assert.equal(none.status, "none");
    const got = await env.server.client.fetchFullText(id);
    assert.equal(got.source, "arxiv-html");
    assert.equal((await env.server.client.fullText(id)).sections.length, 4);
    await assert.rejects(env.server.client.fullText(999_999), /No paper 999999/);
    const converters = await env.server.client.converters();
    assert.deepEqual(converters.find((c) => c.active)?.id, "pdf-text");
  } finally {
    await env.server.stop();
  }
});

test("with RH_DOCLING=on the hub starts docling-serve itself on first use and stops it with the project", async () => {
  process.env.RH_DOCLING = "on";
  process.env.RH_DOCLING_CMD = join(import.meta.dirname, "fixtures/fulltext/fake-docling-serve.mjs");
  process.env.RH_DOCLING_PORT = String(15_000 + Math.floor(Math.random() * 1000));
  const env = await setup();
  const health = `http://127.0.0.1:${process.env.RH_DOCLING_PORT}/health`;
  try {
    await assert.rejects(fetch(health), "not started before the first conversion");
    const sections = await env.fulltext.convert(PDF, "docling");
    assert.deepEqual(
      sections.map((x) => x.text),
      ["Started by the hub.", "Supervised."],
    );
  } finally {
    await env.server.stop();
    for (const k of ["RH_DOCLING", "RH_DOCLING_CMD", "RH_DOCLING_PORT"]) delete process.env[k];
  }
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(fetch(health), "stopped with the project");
});
