// Spec full-text (v1-6 task 1.1): parsers for arXiv HTML, JATS, Docling markdown and PDF text, and facet grouping.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { extractText, getDocumentProxy } from "unpdf";
import {
  arxivHtmlToSections,
  facetTexts,
  headingOf,
  jatsToSections,
  markdownToSections,
  pdfTextToSections,
  withinBudget,
} from "../src/fulltext/parse.ts";
import { ARXIV_HTML, DOCLING_MD, JATS_XML } from "./fixtures/fulltext/documents.ts";

const titles = (s: { title: string }[]) => s.map((x) => x.title);

test("arXiv HTML: abstract and sections in order, math as TeX, no bibliography or appendix", () => {
  const sections = arxivHtmlToSections(ARXIV_HTML);
  assert.deepEqual(titles(sections), ["Abstract", "Introduction", "Our kernels", "Results"]);
  assert.match(sections[1].text, /with k=3 frames/);
  assert.equal(sections[0].text, "We report an AUROC of 0.87 on held-out genes.");
});

test("JATS: abstract and top-level sections with nested ones inside, without tables, citations as text", () => {
  const sections = jatsToSections(JATS_XML);
  assert.deepEqual(titles(sections), ["Abstract", "Main", "Methods", "Results"]);
  assert.match(sections[1].text, /Proteins fold 1\.\nThe Evoformer block\./);
  assert.doesNotMatch(sections[2].text, /table text/);
});

test("Docling markdown: split at # and ## headings, deeper ones kept inside, references and empty sections dropped", () => {
  const sections = markdownToSections(DOCLING_MD);
  assert.deepEqual(titles(sections), ["Abstract", "1 Introduction", "2 Methods"], "the title alone has no text");
  assert.match(sections[1].text, /### 1.1 Scope\nOnly yeast/);
});

test("PDF text: headings, running headers removed, hyphenation joined, references dropped (a real PDF)", async () => {
  const pdf = await getDocumentProxy(
    new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures/fulltext/paper.pdf"))),
  );
  const { text } = await extractText(pdf, { mergePages: false });
  const sections = pdfTextToSections(text as string[]);
  assert.deepEqual(titles(sections).slice(1), ["Abstract", "1 Introduction", "2 Methods", "3 Results", "4 Discussion"]);
  assert.ok(!sections.some((x) => x.text.includes("Fixture paper on ribosome profiling")), "running header removed");
  assert.match(sections[2].text, /linear models/);
  assert.ok(!sections.some((x) => /Ingolia/.test(x.text)));
  assert.equal(headingOf("0. Due to the inclusion of the product kernel"), undefined);
  assert.equal(headingOf("2.1 Datasets"), undefined, "subsections stay inside");
  assert.equal(headingOf("II. RESULTS"), "II. RESULTS");
  assert.equal(headingOf("2. Department of Physics, University of Gothenburg"), undefined, "an affiliation");
});

test("facets by heading, unnamed sections between background and results count as method; budget keeps every head", () => {
  const facets = facetTexts(arxivHtmlToSections(ARXIV_HTML));
  assert.match(facets.background!, /Translation/);
  assert.match(facets.method!, /12,000 transcripts/);
  assert.match(facets.result!, /0.87 AUROC/);
  const text = withinBudget(
    [
      { title: "A", text: "x".repeat(5000) },
      { title: "B", text: "short" },
    ],
    1000,
  );
  assert.ok(text.length <= 1000 && text.includes("## B\nshort"));
});
