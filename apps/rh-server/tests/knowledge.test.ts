// Spec knowledge-loop: Knowledge review, Charter changes from evidence, New research questions, Approve / reject /
// undo (v1-5 tasks 2.1–2.3), offline with scripted Jev and the offline review model (faux rule).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { KnowledgeExports } from "../plugins/rh.knowledge/main.ts";
import { applyChange, ChangeRefused, ChangeStale } from "../plugins/rh.knowledge/evidence.ts";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule, deskToolRule, knowledgeReviewRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { choice, noul, score, scripted } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers } from "./fixtures/sweep-env.ts";
import { startTestServer, until } from "./helpers.ts";

const QUESTIONS = [
  "How is translation measured?",
  "Which assays scale?",
  "What do models miss?",
  "Is it used in clinics?",
];

/** Two sweeps of 12 papers: "Ribosome profiling" ones match Q1 and are liked; "Clinical trial" ones match Q4 and are disliked as off topic. */
async function project(o: { promise?: number; sweeps?: number } = {}) {
  let batch = 0;
  const batches = Array.from({ length: o.sweeps ?? 2 }, (_, b) =>
    fakePapers(12, "x").map((p, i) => ({
      ...p,
      id: `26${40 + b}.${60000 + i}`,
      title: i % 3 ? `Clinical trial report ${b}-${i}` : `Ribosome profiling study ${b}-${i}`,
    })),
  );
  const jev = scripted((id, _c, q: any, state: any) => {
    const good = String(state.paper?.title ?? "").startsWith("Ribosome");
    if (id === "relevance") return score(0.75, 5);
    if (id === "matched_question") return choice(good ? "Q1" : "Q4", Object.keys(q.criteria));
    if (id === "kind") return choice("survey", Object.keys(q.criteria));
    if (id === "worth") return noul(0.9);
    if (id === "promise") return noul(o.promise ?? 0.8);
    return undefined;
  });
  const server = await startTestServer({
    hub: {
      ticker: false,
      fauxRules: [knowledgeReviewRule, cardWriterRule, deskToolRule],
      jevDecide: jev.decide,
      paperFetch: ((i: any, init: any) => arxivOnlyFetch(batches[batch] ?? [])(i, init)) as typeof fetch,
    },
  });
  const p = server.hub.project;
  p.brief.write("# x");
  p.charters.saveDraft(validateCharter(sampleCharter({ questions: QUESTIONS.map((text) => ({ text })) })), "agent");
  p.charters.approve();
  await p.plugins.kernel.configure("rh.sweep", { cardsPerSweep: 12, explorationPicks: 0 });
  const sweep = async () => {
    const n = p.sweeps.list().length;
    p.scheduler.trigger("sweep");
    await until(() => p.sweeps.list().length === n + 1, 10_000, "sweep");
    await p.sweeps.settled(p.sweeps.list(1)[0].id, 30_000);
  };
  for (let b = 0; b < batches.length; b++) {
    batch = b;
    await sweep();
  }
  for (const group of (await server.client.cards(200)).groups)
    for (const card of group.cards) {
      const good = card.paper.title.startsWith("Ribosome");
      await server.client.judge(card.id, good ? "star" : "down", good ? undefined : "not my field");
    }
  p.db.exec("UPDATE judgments SET reason_kind = 'off-topic' WHERE verdict = 'down'");
  const knowledge = await p.plugins.exportsOf<KnowledgeExports>("rh.knowledge");
  return { server, p, knowledge, jev, sweep, setBatch: (b: number) => (batch = b) };
}

test("applyChange keeps ids, refuses to go under the minimums and reports a vanished target as stale", () => {
  const c = validateCharter(sampleCharter({ questions: QUESTIONS.map((text) => ({ text })) }), { keepIds: true });
  const retired = applyChange(c, { kind: "retire-question", target: "Q2" });
  assert.deepEqual(
    retired.questions.map((q) => q.id),
    ["Q1", "Q3", "Q4"],
  );
  assert.throws(() => applyChange(retired, { kind: "retire-question", target: "Q1" }), ChangeRefused);
  assert.throws(
    () => applyChange(retired, { kind: "weight", targetKind: "question", target: "Q2", to: 0.5 }),
    ChangeStale,
  );
  const added = validateCharter(
    applyChange(retired, { kind: "add-question", text: "New?", queries: ["new q", "ESM embeddings"] }),
    {
      keepIds: true,
    },
  );
  assert.equal(added.questions.at(-1)!.id, "Q5");
  assert.equal(added.queries.filter((q) => q.text === "ESM embeddings").length, 1, "no duplicate query");
});

test("a review proposes from evidence and from the review model; approving creates the version the next sweep uses", async () => {
  const s = await project();
  try {
    const review = await s.knowledge.review();
    const open = s.knowledge.proposals("proposed");
    const kinds = open.map((p) => p.kind).toSorted();
    assert.ok(kinds.includes("retire-question"), JSON.stringify(review.report));
    assert.ok(kinds.includes("add-question"));
    assert.ok(kinds.includes("add-out-of-scope"));
    assert.ok(kinds.includes("weight"), "Q4's weight fell with every 👎");
    const retire = open.find((p) => p.kind === "retire-question")!;
    assert.equal(retire.change.target, "Q4");
    assert.match(retire.title, /Retire Q4 \(Is it used in clinics\?\)/);
    assert.equal(retire.evidence.papers.length, 5);
    const add = open.find((p) => p.kind === "add-question")!;
    assert.match(add.change.text!, /profiling/);
    assert.deepEqual(add.change.queries, ["profiling methods", "profiling survey"]);
    assert.equal(add.evidence.score, 0.8);
    assert.match(add.evidence.summary, /such as “Ribosome profiling study/, "ids become titles");
    assert.ok(add.evidence.papers.every((p) => p.title.startsWith("Ribosome")));
    assert.equal(open.find((p) => p.kind === "add-out-of-scope")!.change.topic, "clinical");
    assert.ok(review.report.directions[0].kept);

    // A second review refreshes the open proposals instead of adding copies.
    await s.knowledge.review();
    assert.equal(s.knowledge.proposals("proposed").length, open.length);

    // Approve the new question: version 2 with Q5 and its queries; the next sweep searches them.
    const approved = s.knowledge.approve(add.id);
    assert.equal(approved.appliedVersion, 2);
    const v2 = s.p.charters.approved()!;
    assert.equal(v2.version, 2);
    assert.deepEqual(v2.charter.questions.at(-1), { id: "Q5", text: add.change.text, weight: 1 });
    s.setBatch(5);
    await s.sweep();
    const queries = JSON.stringify(s.p.db.prepare("SELECT queries_json FROM sweeps ORDER BY id DESC LIMIT 1").get());
    assert.match(queries, /profiling methods/);

    // Retire Q4 (ids stay), then the weight proposal for Q4 is stale.
    s.knowledge.approve(retire.id);
    assert.deepEqual(
      s.p.charters.approved()!.charter.questions.map((q) => q.id),
      ["Q1", "Q2", "Q3", "Q5"],
    );
    const weight = s.knowledge.proposals("proposed").find((p) => p.kind === "weight" && p.change.target === "Q4");
    if (weight) {
      assert.throws(() => s.knowledge.approve(weight.id), /stale/);
      assert.equal(s.knowledge.proposals("stale").length, 1);
    }
    // Undo works only on the latest change.
    assert.throws(() => s.knowledge.undo(add.id), /a later charter version exists/);
    const undone = s.knowledge.undo(retire.id);
    assert.equal(undone.status, "undone");
    assert.equal(s.p.charters.approved()!.version, 4);
    assert.ok(s.p.charters.approved()!.charter.questions.some((q) => q.id === "Q4"));
  } finally {
    await s.server.stop();
  }
});

test("rejected proposals are not proposed again; low-promise directions are dropped; no evidence, no model call", async () => {
  const s = await project({ promise: 0.2 });
  try {
    await s.knowledge.review();
    assert.ok(!s.knowledge.proposals("proposed").some((p) => p.kind === "add-question"), "under 0.5");
    const report = s.knowledge.reviews(1)[0].report;
    assert.equal(report.directions[0].kept, false);
    assert.equal(report.directions[0].score, 0.2);
    const retire = s.knowledge.proposals("proposed").find((p) => p.kind === "retire-question")!;
    assert.equal(s.knowledge.reject(retire.id, "I still care about clinics").reason, "I still care about clinics");
    await s.knowledge.review();
    assert.ok(!s.knowledge.proposals("proposed").some((p) => p.kind === "retire-question"));
    assert.throws(() => s.knowledge.approve(retire.id), /is rejected/);
  } finally {
    await s.server.stop();
  }
  const empty = await project({ sweeps: 0 });
  try {
    const r = await empty.knowledge.review();
    assert.deepEqual(r.report.proposals, []);
    assert.match(r.report.notes.join(" "), /No judgments or comments/);
  } finally {
    await empty.server.stop();
  }
});

test("the API runs a review in the background, decides proposals, and the digest runs the review and lists them", async () => {
  const s = await project();
  try {
    const { client } = s.server;
    assert.deepEqual((await client.knowledge()).proposals, []);
    assert.deepEqual(await client.runKnowledgeReview(), { started: true });
    await until(
      async () => !(await client.knowledge()).running && (await client.knowledge()).reviews.length > 0,
      10_000,
    );
    const view = await client.knowledge();
    const add = view.proposals.find((p) => p.kind === "add-question")!;
    const oos = view.proposals.find((p) => p.kind === "add-out-of-scope")!;
    assert.equal((await client.approveKnowledge(add.id)).status, "approved");
    assert.equal((await client.rejectKnowledge(oos.id, "clinics are fine")).reason, "clinics are fine");
    await assert.rejects(client.approveKnowledge(add.id), /is approved/);
    await assert.rejects(client.approveKnowledge(999), /no proposal 999/);
    assert.equal((await client.undoKnowledge(add.id)).status, "undone");
    const charter = await client.charter();
    assert.equal(charter.approved?.version, 3);

    const digest = await s.server.hub.project.plugins
      .exportsOf<import("../plugins/rh.digest/main.ts").DigestExports>("rh.digest")
      .then((d) => d.buildDigest(Date.now() + 1000));
    assert.equal((await client.knowledge()).reviews[0].requestedBy, "digest", "the digest ran a review first");
    const listed = digest.charter!.proposals;
    assert.ok(listed.some((p) => p.id === add.id && p.status === "undone"));
    assert.ok(listed.some((p) => p.id === oos.id && p.status === "rejected"));
    assert.ok(listed.some((p) => p.kind === "retire-question" && p.status === "proposed"));
    await client.commentDigest(digest.id, "charter", "Good ideas");
  } finally {
    await s.server.stop();
  }
});
