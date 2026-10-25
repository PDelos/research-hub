// Spec paper-sources: identifiers and titles normalized; sentences split for facet labeling (task 2.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanText,
  normalizeArxivId,
  normalizeDate,
  normalizeDoi,
  normalizeIds,
  normalizeOpenAlexId,
  normalizePmcid,
  normalizePmid,
  normalizeTitle,
  splitSentences,
} from "../src/papers/normalize.ts";

test("DOIs in every common form normalize to the same value", () => {
  for (const raw of [
    "10.1101/2026.10.01.123456",
    "https://doi.org/10.1101/2026.10.01.123456",
    "http://dx.doi.org/10.1101/2026.10.01.123456",
    "doi:10.1101/2026.10.01.123456",
    "  10.1101/2026.10.01.123456 ",
  ])
    assert.equal(normalizeDoi(raw), "10.1101/2026.10.01.123456");
  assert.equal(normalizeDoi("10.1038/S41586-021-03819-2"), "10.1038/s41586-021-03819-2");
  assert.equal(normalizeDoi("not a doi"), undefined);
  assert.equal(normalizeDoi(""), undefined);
});

test("arXiv IDs lose their version and URL; old-style IDs are kept", () => {
  for (const raw of [
    "2401.01234",
    "2401.01234v3",
    "arXiv:2401.01234v1",
    "http://arxiv.org/abs/2401.01234v2",
    "https://arxiv.org/pdf/2401.01234v2.pdf",
  ])
    assert.equal(normalizeArxivId(raw), "2401.01234");
  assert.equal(normalizeArxivId("q-bio/0601001v1"), "q-bio/0601001");
  assert.equal(normalizeArxivId("math.GT/0309136"), "math.gt/0309136");
  assert.equal(normalizeArxivId("hello"), undefined);
  assert.deepEqual(normalizeIds({ doi: "https://doi.org/10.48550/arXiv.2401.01234" }), {
    doi: "10.48550/arxiv.2401.01234",
    arxiv: "2401.01234",
  });
});

test("PubMed, PMC and OpenAlex IDs", () => {
  assert.equal(normalizePmid("12345678"), "12345678");
  assert.equal(normalizePmid(12345678), "12345678");
  assert.equal(normalizePmid("https://pubmed.ncbi.nlm.nih.gov/12345678/"), "12345678");
  assert.equal(normalizePmid("PMC123"), undefined);
  assert.equal(normalizePmcid("pmc7654321"), "PMC7654321");
  assert.equal(normalizePmcid("7654321"), "PMC7654321");
  assert.equal(normalizePmcid("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7654321/"), "PMC7654321");
  assert.equal(normalizeOpenAlexId("https://openalex.org/W2741809807"), "W2741809807");
  assert.equal(normalizeOpenAlexId("w2741809807"), "W2741809807");
  assert.equal(normalizeOpenAlexId("A123"), undefined);
});

test("titles, text and dates", () => {
  assert.equal(normalizeTitle("  Protein Language Models: A Révïew!  "), "protein language models a review");
  assert.equal(normalizeTitle("Protein language models — a review"), "protein language models a review");
  assert.equal(cleanText("<p>We use <i>ESM-2</i> &amp; MSA&nbsp;data.</p>\n"), "We use ESM-2 & MSA data.");
  assert.equal(normalizeDate("2026-10-23T10:00:00Z"), "2026-10-23");
  assert.equal(normalizeDate("2026-10"), "2026-10-01");
  assert.equal(normalizeDate("2026"), "2026-01-01");
  assert.equal(normalizeDate("unknown"), undefined);
});

test("sentence splitting keeps decimals, e.g., et al. and initials intact", () => {
  const abstract =
    "Protein structure prediction remains hard for orphan proteins (e.g. viral proteins). " +
    "Following Lin et al. we fine-tune ESM-2 with 650M parameters. " +
    "Contact precision improves from 0.61 to 0.74 on CASP15! " +
    "Is this enough? We think so, as shown by J. Smith in Fig. 3. " +
    "Code is available.";
  assert.deepEqual(splitSentences(abstract), [
    "Protein structure prediction remains hard for orphan proteins (e.g. viral proteins).",
    "Following Lin et al. we fine-tune ESM-2 with 650M parameters.",
    "Contact precision improves from 0.61 to 0.74 on CASP15!",
    "Is this enough?",
    "We think so, as shown by J. Smith in Fig. 3.",
    "Code is available.",
  ]);
  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(
    splitSentences("We release the weights under the MIT License. 1"),
    ["We release the weights under the MIT License."],
    "a trailing footnote mark is dropped",
  );
  assert.deepEqual(splitSentences("One sentence without a period"), ["One sentence without a period"]);
  assert.deepEqual(splitSentences("<p>First part.</p><p>Second part.</p>"), ["First part.", "Second part."]);
  assert.deepEqual(splitSentences("We test i.e. three settings. Results follow."), [
    "We test i.e. three settings.",
    "Results follow.",
  ]);
});
