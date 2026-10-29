// Spec knowledge-loop: Question finders, Level-up proposals, Taste-rule proposals (v1-7 tasks 2.1, 2.2, 3.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { KnowledgeExports } from "../plugins/rh.knowledge/main.ts";
import { methodTransferLeads, risingTopicLeads, unlinkedPairs, type LikedPaper } from "../src/knowledge/finders.ts";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule, knowledgeReviewRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { choice, noul, score, scripted } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers } from "./fixtures/sweep-env.ts";
import { startTestServer, until } from "./helpers.ts";

const v = (...xs: number[]) => new Float32Array(xs);
const paper = (id: number, question: string | null = "Q1"): LikedPaper => ({
  id,
  title: `Paper ${id}`,
  abstract: null,
  question,
});

test("method transfer: close methods on far-apart problems are leads, the strongest first", () => {
  // Papers 1 and 2 share a method (x axis) but study different problems; 3–6 are ordinary.
  const vectors: Record<number, { method: Float32Array; background: Float32Array }> = {
    1: { method: v(1, 0, 0), background: v(1, 0, 0) },
    2: { method: v(0.99, 0.1, 0), background: v(0, 0, 1) },
    3: { method: v(0, 1, 0), background: v(1, 0.1, 0) },
    4: { method: v(0, 0, 1), background: v(0.9, 0.2, 0) },
    5: { method: v(0.1, 0.9, 0.2), background: v(0.8, 0.3, 0) },
    6: { method: v(0.2, 0.1, 0.9), background: v(0.9, 0, 0.1) },
  };
  const leads = methodTransferLeads(
    [1, 2, 3, 4, 5, 6].map((id) => paper(id)),
    (id, kind) => (kind === "whole" ? undefined : vectors[id][kind]),
  );
  assert.deepEqual(leads[0].paperIds, [1, 2]);
  assert.match(leads[0].summary, /similar methods on different problems/);
});

test("missing links: close papers on different questions without a citation between them", () => {
  const whole: Record<number, Float32Array> = { 1: v(1, 0), 2: v(0.98, 0.1), 3: v(0.97, 0.12), 4: v(0, 1) };
  const cited = new Set(["1-3"]);
  const db = {
    prepare: () => ({
      get: (a: number, b: number) => (cited.has(`${a}-${b}`) || cited.has(`${b}-${a}`) ? {} : undefined),
    }),
  } as never;
  const pairs = unlinkedPairs(
    db,
    [paper(1, "Q1"), paper(2, "Q2"), paper(3, "Q2"), paper(4, "Q3")],
    (id) => whole[id],
    5,
  );
  assert.ok(pairs.length >= 1);
  assert.ok(pairs.every((p) => p.a.question !== p.b.question));
  assert.ok(!pairs.some((p) => [p.a.id, p.b.id].toSorted().join() === "1,3"), "1 cites 3");
});

test("rising topics: words much more frequent in the last 14 days, not in the charter", () => {
  const now = Date.parse("2026-10-29T00:00:00Z");
  const recent = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    title: i < 4 ? `Diffusion models for enzyme design ${i}` : `Protein folding ${i}`,
  }));
  const before = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, title: `Protein folding ${i}` }));
  const db = {
    prepare: () => ({ all: (from: string) => (Date.parse(from) >= now - 15 * 86_400_000 ? recent : before) }),
  } as never;
  const leads = risingTopicLeads(db, JSON.stringify({ questions: ["protein folding"] }), now);
  assert.ok(leads.length >= 1);
  assert.match(leads[0].summary, /“(diffusion|enzyme)/);
  assert.match(leads[0].summary, /4 of 10 papers gathered in the last 14 days, 0 of 30/);
  assert.ok(!leads.some((l) => /folding/.test(l.summary)), "in the charter");
  const fresh = {
    prepare: () => ({ all: (from: string) => (Date.parse(from) >= now - 15 * 86_400_000 ? recent : []) }),
  } as never;
  assert.deepEqual(risingTopicLeads(fresh, "{}", now), [], "nothing rises without history");
});

test("a review credits its finder, proposes level up and a taste rule; approvals change the sweep settings, undoably", async () => {
  const papers = fakePapers(12).map((p, i) => ({
    ...p,
    id: `2650.${70000 + i}`,
    title: i % 3 ? `Clinical trial report ${i}` : `Ribosome profiling study ${i}`,
  }));
  const jev = scripted((id, _c, q: any, state: any) => {
    const good = String(state.paper?.title ?? "").startsWith("Ribosome");
    if (id === "relevance") return score(0.75, 5);
    if (id === "matched_question") return choice(good ? "Q1" : "Q2", Object.keys(q.criteria));
    if (id === "worth") return noul(0.9);
    if (id === "level") return score(good ? 2 / 3 : 0, 4);
    if (id === "promise") return noul(0.8);
    return undefined;
  });
  const server = await startTestServer({
    hub: {
      ticker: false,
      fauxRules: [knowledgeReviewRule, cardWriterRule],
      jevDecide: jev.decide,
      paperFetch: arxivOnlyFetch(papers),
    },
  });
  const projectRuntime = server.hub.project;
  try {
    projectRuntime.brief.write("# x");
    projectRuntime.charters.saveDraft(
      validateCharter(
        sampleCharter({
          questions: ["How is translation measured?", "Which trials matter?", "What is missing?"].map((text) => ({
            text,
          })),
        }),
      ),
      "agent",
    );
    projectRuntime.charters.approve();
    await projectRuntime.plugins.kernel.configure("rh.sweep", { cardsPerSweep: 12, explorationPicks: 0 });
    const sweep = async () => {
      const n = projectRuntime.sweeps.list().length;
      projectRuntime.scheduler.trigger("sweep");
      await until(() => projectRuntime.sweeps.list().length === n + 1, 10_000, "sweep");
      await projectRuntime.sweeps.settled(projectRuntime.sweeps.list(1)[0].id, 30_000);
    };
    await sweep();
    for (const group of (await server.client.cards(200)).groups)
      for (const card of group.cards)
        await server.client.judge(card.id, card.paper.title.startsWith("Ribosome") ? "star" : "down");
    // Level up by the "too basic" route: the eight 👎 are marked too basic.
    projectRuntime.db.exec("UPDATE judgments SET reason_kind = 'too-basic' WHERE verdict = 'down'");
    const card = projectRuntime.cards.list()[1];
    projectRuntime.db
      .prepare(
        "INSERT INTO rule_candidates (card_id, reason, reason_kind, probability, status, created_at) VALUES (?, ?, 'off-topic', 0.9, 'open', ?)",
      )
      .run(card.id, "no clinical trials", new Date().toISOString());

    // History for rising topics: an older sweep (30 days ago) of 20 papers about something else.
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const oldSweep = Number(
      projectRuntime.db
        .prepare("INSERT INTO sweeps (trigger, status, phase, started_at) VALUES ('manual', 'completed', 'cards', ?)")
        .run(old).lastInsertRowid,
    );
    for (let i = 0; i < 20; i++) {
      const id = projectRuntime.papers.store.upsert({
        source: "arxiv",
        externalId: `old-${i}`,
        ids: { arxiv: `2601.${10000 + i}` },
        title: `Translation elongation kinetics ${i}`,
        authors: [],
      } as never).id;
      projectRuntime.db
        .prepare("INSERT INTO sweep_papers (sweep_id, paper_id, status) VALUES (?, ?, 'rejected')")
        .run(oldSweep, id);
    }
    const knowledge = await projectRuntime.plugins.exportsOf<KnowledgeExports>("rh.knowledge");
    const review = await knowledge.review();
    assert.ok(
      review.report.leads?.some((l) => l.finder === "rising-topics"),
      JSON.stringify(review.report),
    );
    const open = knowledge.proposals("proposed");
    const add = open.find((x) => x.kind === "add-question")!;
    assert.equal(add.finder, "rising-topics");
    const level = open.find((x) => x.kind === "level")!;
    assert.deepEqual(level.change.level, { from: "auto", to: "advanced" });
    const rule = open.find((x) => x.kind === "taste-rule")!;
    assert.equal(rule.change.rule, "Avoid: no clinical trials");

    await knowledge.approve(level.id);
    assert.equal(projectRuntime.plugins.kernel.settings("rh.sweep").level, "advanced");
    await knowledge.approve(rule.id);
    assert.deepEqual(projectRuntime.plugins.kernel.settings("rh.sweep").tasteRules, ["Avoid: no clinical trials"]);
    assert.equal(
      (projectRuntime.db.prepare("SELECT status FROM rule_candidates WHERE card_id = ?").get(card.id) as any).status,
      "accepted",
    );
    await knowledge.undo(rule.id);
    assert.deepEqual(projectRuntime.plugins.kernel.settings("rh.sweep").tasteRules, []);

    await knowledge.approve(add.id);
    // A liked card matched to the new question after its approval counts for the finder.
    projectRuntime.db
      .prepare(
        "UPDATE cards SET matched_question = 'Q4', created_at = ? WHERE id = (SELECT card_id FROM judgments WHERE verdict = 'star' LIMIT 1)",
      )
      .run(new Date(Date.now() + 1000).toISOString());
    const stats = await knowledge.finders();
    const rising = stats.find((s) => s.finder === "rising-topics")!;
    assert.equal(rising.proposed, 1);
    assert.equal(rising.approved, 1);
    assert.ok(rising.liked >= 1, "its question's cards were liked");
    assert.ok(stats.some((s) => s.finder === "interests"));
    assert.ok(stats.some((s) => s.finder === "method-transfer"));
  } finally {
    await server.stop();
  }
});
