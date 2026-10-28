// Spec slots: Converter slot in the catalog (v1-6 task 2.2): scoring, the preset on cached samples, and the weekly
// upgrade's converter focus with and without an alternative converter.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessExports } from "../plugins/rh.harness/main.ts";
import type { UpgradesExports } from "../plugins/rh.upgrades/main.ts";
import { CONVERTER_PAPERS, headingRecall, wordF1 } from "../src/harness/benchmarks/converter.ts";
import { arxivHtmlToSections } from "../src/fulltext/parse.ts";
import { ARXIV_HTML } from "./fixtures/fulltext/documents.ts";
import { startTestServer } from "./helpers.ts";

const PDF = readFileSync(join(import.meta.dirname, "fixtures/fulltext/paper.pdf"));
const TRUTH = arxivHtmlToSections(ARXIV_HTML);

/** The first two sample papers cached (fixture HTML as truth, fixture PDF); the rest stay unavailable offline. */
function seed(dataDir: string) {
  const dir = join(dataDir, "plugins", "data", "rh.harness", "benchmarks", "converter-v1");
  mkdirSync(dir, { recursive: true });
  for (const id of CONVERTER_PAPERS.slice(0, 2))
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, truth: TRUTH, pdf: PDF.toString("base64") }));
}

test("word F1 and heading recall", () => {
  assert.equal(wordF1("the protein model", "the protein model"), 1);
  assert.equal(wordF1("alpha beta", "gamma delta"), 0);
  assert.ok(Math.abs(wordF1("protein model", "protein model folding structure") - 2 / 3) < 1e-9);
  assert.equal(
    headingRecall(
      [
        { title: "1. Introduction", text: "x" },
        { title: "3 RESULTS", text: "x" },
      ],
      TRUTH,
    ),
    2 / 3,
  );
});

test("the converter preset runs on the cached sample; the weekly upgrade skips the converter without an alternative", async () => {
  const server = await startTestServer();
  try {
    seed(server.dataDir);
    const harness = await server.hub.project.plugins.exportsOf<HarnessExports>("rh.harness");
    assert.ok(harness.slots().some((s) => s.id === "converter" && s.active.name === "PDF text (pdf.js)"));
    const r = await server.client.runBenchmark("converter");
    assert.equal(r.candidate.converter, "pdf-text");
    assert.equal(r.result.tasks[0].items, 2);
    assert.ok(r.result.value! > 0 && r.result.value! < 1, String(r.result.value));
    assert.match(r.result.tasks[0].note!, /offline and not cached/);
    await assert.rejects(server.client.runBenchmark("converter", { converter: "docling" }), /not available here/);

    const upgrades = await server.hub.project.plugins.exportsOf<UpgradesExports>("rh.upgrades");
    const run = await upgrades.run({ focus: "converter" });
    assert.match(run.report!.result, /no other converter is available here/);
  } finally {
    await server.stop();
  }
});

test("with Docling available, a better converter is proposed and approving switches the slot", async () => {
  const md = TRUTH.map((s) => `## ${s.title}\n\n${s.text}`).join("\n\n");
  const docling = createServer((req, res) => {
    if (req.url === "/health") return void res.end("ok");
    req.resume();
    req.on("end", () => res.end(JSON.stringify({ document: { md_content: md }, status: "success" })));
  });
  await new Promise<void>((r) => docling.listen(0, "127.0.0.1", r));
  process.env.RH_DOCLING_URL = `http://127.0.0.1:${(docling.address() as { port: number }).port}`;
  const server = await startTestServer();
  try {
    seed(server.dataDir);
    const upgrades = await server.hub.project.plugins.exportsOf<UpgradesExports>("rh.upgrades");
    const run = await upgrades.run({ focus: "converter" });
    assert.equal(run.report!.tried.length, 2, run.report!.result);
    assert.equal(run.report!.tried[1].verdict, "better");
    const [p] = upgrades.proposals("proposed");
    assert.equal(p.kind, "converter");
    assert.equal(p.payload.converter, "docling");
    await upgrades.approve(p.id);
    assert.equal(server.hub.project.plugins.kernel.settings("rh.fulltext")["fulltext.converter"], "docling");
  } finally {
    delete process.env.RH_DOCLING_URL;
    await server.stop();
    docling.close();
  }
});
