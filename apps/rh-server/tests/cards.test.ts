// Spec paper-cards: scores from recorded signals, the card writer, grounding, one card per paper, completion
// (tasks 3.1, 3.2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, say, type FauxRule } from "@rh/durable-agent";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule } from "../src/faux-rules.ts";
import type { Paper } from "../src/papers/store.ts";
import { ungroundedNumbers } from "../src/sweep/card-writer.ts";
import { computeScores } from "../src/sweep/scores.ts";
import type { SweepPaper } from "../src/sweep/sweep.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { choice, noul, score, scripted } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers, type FakePaper } from "./fixtures/sweep-env.ts";
import { startTestServer } from "./helpers.ts";

const passAll = (id: string, _cmd: string, q: any) => {
  if (id === "relevance") return score(0.75, 5);
  if (id === "matched_question") return choice("Q2", Object.keys(q.criteria));
  if (id === "kind") return choice("method", Object.keys(q.criteria));
  if (id === "worth") return noul(0.8);
  if (id === "novelty") return score(2 / 3, 4);
  if (id === "level") return score(1 / 3, 4);
  if (id === "importance") return score(2 / 3, 4);
  return undefined;
};

const basePaper = (over: Partial<Paper>): Paper => ({
  id: 1, ids: {}, title: "T", abstract: "A.", authors: [], year: 2026, publishedAt: "2026-09-01", retracted: false, enrichment: "done",
  enrichmentAttempts: 1, titleOnly: false, categories: [], sources: ["arxiv"], createdAt: "", updatedAt: "", citedByCount: 0, ...over,
});
const sp: SweepPaper = { sweepId: 1, paperId: 1, status: "candidate", borderline: false, relevance: 0.75, matchedQuestion: "Q2", kind: "method", worth: 0.8, novelty: 2 / 3, level: "core", importance: 0.67, rank: 1 };

test("trust is field-aware: an arXiv cs.LG preprint is penalized less than a bioRxiv preprint, and both reasons say so", () => {
  const charter = validateCharter(sampleCharter());
  const opts = { orientation: true, now: Date.parse("2026-10-23"), decisions: {}, hasMethodFacet: false };
  const ai = computeScores(basePaper({ server: "arXiv", categories: ["cs.LG"] }), sp, charter, opts);
  const bio = computeScores(basePaper({ server: "bioRxiv" }), sp, charter, opts);
  assert.equal(ai.trust - bio.trust, 10);
  assert.match(ai.trustReason, /arXiv preprint \(cs\.LG: preprints are the norm, −5\)/);
  assert.match(bio.trustReason, /bioRxiv preprint, not peer-reviewed \(−15\)/);
  const journal = computeScores(basePaper({ venue: "Nature Methods", citedByCount: 40, publishedAt: "2024-10-23", oaUrl: "https://x" }), sp, charter, { ...opts, hasMethodFacet: true });
  assert.ok(journal.trust > ai.trust);
  assert.match(journal.trustReason, /peer-reviewed: Nature Methods · 40 citations \(20\.0\/year\) · open access · method described/);
  for (const s of [ai, bio, journal]) {
    for (const r of [s.relevanceReason, s.trustReason, s.valueReason]) assert.ok(r.length > 0 && r.length <= 120, r);
    for (const n of [s.relevance, s.trust, s.value]) assert.ok(Number.isInteger(n) && n >= 0 && n <= 100);
  }
  // Relevance: 100 × (0.75 × 0.75 + 0.25 × min(1, 1.5 / 2)) = 75.
  assert.equal(ai.relevance, 75);
  assert.match(ai.relevanceReason, /^Jev relevance 0\.75 · Q2 \(weight 1\.5\): Which tasks need fine-tuning\?/);
});

test("summaries may not state numbers absent from the title and abstract", () => {
  assert.deepEqual(ungroundedNumbers("Improves precision to 0.74 on 2,000 proteins.", "precision rises from 0.61 to 0.74 on 2000 proteins"), []);
  assert.deepEqual(ungroundedNumbers("Improves accuracy by 12%.", "accuracy improves"), ["12"]);
  assert.deepEqual(ungroundedNumbers("Uses ESM-2.", "We fine-tune ESM-2."), []);
});

async function activeServer(papers: FakePaper[], rules: FauxRule[] = [cardWriterRule], works?: (doi: string) => Record<string, unknown> | undefined) {
  const jev = scripted(passAll);
  const server = await startTestServer({ hub: { ticker: false, fauxRules: rules, jevDecide: jev.decide, paperFetch: arxivOnlyFetch(papers, works) } });
  const p = server.hub.project;
  p.brief.write("# Protein LMs");
  p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  p.charters.approve();
  return { server, p, jev };
}

async function sweepOnce(p: Awaited<ReturnType<typeof activeServer>>["p"]) {
  p.scheduler.trigger("sweep");
  for (let i = 0; i < 500 && !p.sweeps.list()[0]; i++) await new Promise((r) => setTimeout(r, 10));
  return p.sweeps.settled(p.sweeps.list()[0].id, 30_000);
}

test("a sweep's candidates become complete cards written by the card writer, and the sweep completes", async () => {
  const papers = fakePapers(9);
  const retracted = `10.48550/arxiv.${papers[8].id}`;
  const { server, p } = await activeServer(papers, [cardWriterRule], (doi) =>
    doi === retracted ? { id: "https://openalex.org/W9", doi: `https://doi.org/${doi}`, display_name: papers[8].title, is_retracted: true } : undefined,
  );
  try {
    const sweep = await sweepOnce(p);
    assert.equal(sweep.status, "completed", sweep.error);
    const cards = p.cards.list();
    assert.equal(cards.length, 7);
    for (const card of cards) {
      const paper = p.papers.store.get(card.paperId)!;
      assert.ok(paper.title && paper.authors.length && paper.year && (paper.venue ?? paper.server) && (paper.url ?? paper.ids.doi));
      assert.ok(card.summary.split(" ").length <= 80);
      assert.equal(card.matchedQuestion, "Q2");
      assert.equal(card.level, "core");
      for (const r of [card.relevanceReason, card.trustReason, card.valueReason]) assert.ok(r && r.length <= 120);
      // Traceability: every score shows its decisions with command versions, and its inputs.
      assert.deepEqual(Object.keys(card.details.decisions).sort(), ["importance", "level", "on-theme", "paper-kind", "worth-reading"]);
      assert.ok(Object.values(card.details.decisions).every((d) => d.version === 1));
      assert.ok(card.details.formulas.trust && card.details.inputs.relevance === 0.75);
    }
    assert.deepEqual(cards.map((c) => c.rank), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(p.cards.byPaper(p.papers.store.find({ arxiv: papers[8].id })!.id), undefined, "the retracted paper has no card");
    assert.deepEqual(sweep.completion!.skipped, []);
    assert.equal(sweep.completion!.presented.length, 7);
    assert.equal(sweep.phases.cards?.status, "done");
  } finally {
    await server.stop();
  }
});

test("an invented number is refused; presenting a paper twice keeps one card; a skipped candidate is listed with its reason", async () => {
  let tried = false;
  const tricky: FauxRule = (turn) => {
    if (!turn.sections["card-writer"]) return undefined;
    const listed = turn.results.find((r) => r.name === "list_candidates");
    if (!listed) return call("list_candidates", {});
    const ids = [...listed.text.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
    const presents = turn.calls.filter((c) => c.name === "present_paper");
    if (!tried) {
      tried = true;
      return call("present_paper", { paper_id: ids[0], summary: "This method improves accuracy by 99% over all baselines." });
    }
    // Then: present the first paper twice (a replay), every other except the last, and skip the last.
    const plan = [ids[0], ids[0], ...ids.slice(1, -1)];
    const done = presents.length - 1;
    if (done < plan.length) return call("present_paper", { paper_id: plan[done], summary: "A protein language model method for better contact maps." });
    if (!turn.calls.some((c) => c.name === "complete_sweep")) return call("complete_sweep", { skipped: [] });
    if (!turn.results.some((r) => r.name === "complete_sweep" && !r.isError))
      return call("complete_sweep", { skipped: [{ paper_id: ids.at(-1), reason: "duplicate of a paper already in the feed" }] });
    return say("done");
  };
  const { server, p } = await activeServer(fakePapers(4), [tricky]);
  try {
    const sweep = await sweepOnce(p);
    assert.equal(sweep.status, "completed", sweep.error);
    // Tool results as recorded by telemetry.
    await new Promise((r) => setTimeout(r, 200));
    const view = JSON.stringify(p.db.prepare("SELECT tool_name, is_error, result_text FROM tool_calls ORDER BY id").all());
    assert.match(view, /states numbers that are not in the title or abstract: 99/);
    assert.match(view, /have neither a card nor a skip reason/);
    assert.equal(p.cards.count(), 3, "one card per paper even when presented twice");
    assert.ok(p.cards.list().every((c) => !/99/.test(c.summary)));
    const skipped = p.sweeps.papers(sweep.id).find((x) => x.status === "skipped")!;
    assert.equal(skipped.reason, "duplicate of a paper already in the feed");
    assert.deepEqual(sweep.completion!.skipped.map((s) => s.reason), ["duplicate of a paper already in the feed"]);
  } finally {
    await server.stop();
  }
});

test("a card turn that ends without complete_sweep fails the sweep and keeps its cards", async () => {
  const lazy: FauxRule = (turn) => {
    if (!turn.sections["card-writer"]) return undefined;
    const listed = turn.results.find((r) => r.name === "list_candidates");
    if (!listed) return call("list_candidates", {});
    if (!turn.calls.some((c) => c.name === "present_paper"))
      return call("present_paper", { paper_id: Number(listed.text.match(/^#(\d+)/)![1]), summary: "A protein language model method." });
    return say("I am done.");
  };
  const { server, p } = await activeServer(fakePapers(3), [lazy]);
  try {
    const sweep = await sweepOnce(p);
    assert.equal(sweep.status, "failed");
    assert.equal(sweep.error, "the card writer ended without calling complete_sweep");
    assert.equal(p.cards.count(), 1);
  } finally {
    await server.stop();
  }
});

test("a restart during the card turn re-attaches and completes the sweep with one card per paper", async () => {
  const { tempDir } = await import("./helpers.ts");
  const t = tempDir();
  try {
    const papers = fakePapers(3);
    const jev = scripted(passAll);
    const opts = { dataDir: t.dir, hub: { ticker: false, fauxRules: [cardWriterRule], fauxTokensPerSecond: 40, jevDecide: jev.decide, paperFetch: arxivOnlyFetch(papers) } };
    const first = await startTestServer(opts);
    const p = first.hub.project;
    p.brief.write("# Protein LMs");
    p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    p.charters.approve();
    p.scheduler.trigger("sweep");
    for (let i = 0; i < 1000 && !(p.sweeps.list()[0]?.phase === "cards" && p.cards.count() >= 1); i++) await new Promise((r) => setTimeout(r, 10));
    const id = p.sweeps.list()[0].id;
    assert.equal(p.sweeps.get(id)!.status, "running", "stopped in the middle of the card turn");
    await first.stop();

    const second = await startTestServer({ ...opts, hub: { ...opts.hub, fauxTokensPerSecond: undefined } });
    try {
      const sweep = await second.hub.project.sweeps.settled(id, 30_000);
      assert.equal(sweep.status, "completed", sweep.error);
      assert.equal(second.hub.project.cards.count(), 3);
      assert.equal(new Set(second.hub.project.cards.list().map((c) => c.paperId)).size, 3);
    } finally {
      await second.stop();
    }
  } finally {
    t.cleanup();
  }
});
