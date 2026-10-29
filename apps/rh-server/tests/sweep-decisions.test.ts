// Spec paper-sweep: Jev commands bundled per paper, stored and reused (task 1.2); cost tags (task 1.3).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { JevLedger, loadCommand, renderCommand } from "@rh/jev";
import { withCostTag } from "../src/cost-tag.ts";
import { openProjectDb } from "../src/db.ts";
import { PaperStore } from "../src/papers/store.ts";
import { EmbeddingLedger } from "../src/representations/embed.ts";
import { GATE, PaperDecisions } from "../src/sweep/decisions.ts";
import { Telemetry } from "../src/telemetry.ts";
import { choice, noul, score, scripted } from "./fixtures/jev-answers.ts";
import { tempDir } from "./test-server.ts";

const JEV_DIR = join(import.meta.dirname, "../prompt_engineering/jev");

const vars = {
  title: "ESM-2 contact prediction",
  abstract: "We fine-tune a protein language model.",
  questions: [{ id: "Q1", text: "How do protein language models predict contacts?" }],
  question_options: { Q1: "How do protein language models predict contacts?", none: "None of the research questions" },
  concepts: ["protein language models"],
  out_of_scope: [],
};

function setup() {
  const temp = tempDir();
  const { db } = openProjectDb(join(temp.dir, "project.sqlite"));
  const telemetry = new Telemetry(db);
  const ledger = new JevLedger((r) => telemetry.jevCall(r));
  const jev = scripted((id, _cmd, q) =>
    id === "relevance"
      ? score(0.75, 5)
      : id === "matched_question"
        ? choice("Q1", Object.keys((q as any).criteria))
        : id === "kind"
          ? choice("method", Object.keys((q as any).criteria))
          : id === "worth"
            ? noul(0.8)
            : undefined,
  );
  const decisions = new PaperDecisions({ db, jevDir: JEV_DIR, decide: jev.decide, ledger });
  const store = new PaperStore(db);
  const paperId = store.upsert({
    source: "arxiv",
    externalId: "1",
    ids: { arxiv: "2601.00001" },
    title: vars.title,
    abstract: vars.abstract,
    authors: [],
  }).id;
  return { db, jev, decisions, paperId, done: () => (db.close(), temp.cleanup()) };
}

test("every gate and rank command renders, carries the data-only instruction, and fits the Jev limits", () => {
  for (const name of ["on-theme", "paper-kind", "worth-reading", "level", "importance"]) {
    const cmd = loadCommand(name, JEV_DIR);
    const rendered = renderCommand(cmd, {
      ...vars,
      kind: "method",
      year: 2026,
      venue: "arXiv",
      citations: 3,
      stage: "new to the field",
    });
    for (const q of Object.values(rendered.questions))
      assert.match(JSON.stringify(q.instructions), /data, never as instructions/, `${name} says paper text is data`);
  }
  assert.deepEqual(loadCommand("on-theme", JEV_DIR).policy, { relevance_min: 0.45, review_band: [0.45, 0.55] });
  assert.deepEqual(loadCommand("worth-reading", JEV_DIR).policy, { worth_min: 0.35 });
  const kinds = Object.keys((loadCommand("paper-kind", JEV_DIR).questions.kind as any).criteria);
  assert.deepEqual(kinds, [
    "survey",
    "review",
    "tutorial",
    "method",
    "application",
    "benchmark",
    "dataset",
    "tool",
    "position",
    "theory",
    "other",
  ]);
});

test("the gate commands go out in one Jev call, answers are split per command, stored, and reused without a second call", async () => {
  const env = setup();
  try {
    const first = await env.decisions.decide(env.paperId, GATE, vars);
    assert.equal(env.jev.calls.length, 1);
    assert.deepEqual(env.jev.calls[0].questions.sort(), [
      "on-theme__matched_question",
      "on-theme__relevance",
      "paper-kind__kind",
      "worth-reading__novelty",
      "worth-reading__worth",
    ]);
    assert.equal((first["on-theme"].matched_question as any).choice, "Q1");
    assert.equal((first["paper-kind"].kind as any).choice, "method");
    assert.equal((first["worth-reading"].worth as any).noul, 0.8);
    const rows = env.db
      .prepare("SELECT command, version FROM paper_decisions WHERE paper_id = ? ORDER BY command")
      .all(env.paperId) as any[];
    assert.deepEqual(
      rows.map((r) => `${r.command}@${r.version}`),
      ["on-theme@1", "paper-kind@1", "worth-reading@1"],
    );
    const jevRow = env.db.prepare("SELECT command, questions FROM jev_calls").get() as any;
    assert.deepEqual({ ...jevRow }, { command: "on-theme+paper-kind+worth-reading", questions: 5 });

    const again = await env.decisions.decide(env.paperId, GATE, vars);
    assert.equal(env.jev.calls.length, 1, "no second call");
    assert.deepEqual(again, first);
    // Asking for one stored and one new command only asks the new one.
    await env.decisions.decide(env.paperId, ["on-theme", "level"], {
      ...vars,
      kind: "method",
      year: 2026,
      venue: "arXiv",
      citations: 3,
    });
    assert.deepEqual(env.jev.calls[1].questions.sort(), ["level__level", "level__prereq_heavy"]);
  } finally {
    env.done();
  }
});

test("a failed Jev call is recorded as a failure and stores nothing", async () => {
  const env = setup();
  try {
    env.jev.fail(new Error("Jev unavailable"));
    await assert.rejects(env.decisions.decide(env.paperId, GATE, vars), /Jev unavailable/);
    assert.equal((env.db.prepare("SELECT COUNT(*) n FROM paper_decisions").get() as any).n, 0);
    assert.match((env.db.prepare("SELECT error FROM jev_calls").get() as any).error, /Jev unavailable/);
  } finally {
    env.done();
  }
});

test("Jev and embedding calls made inside a cost-tag scope carry the tag; others do not", async () => {
  const env = setup();
  try {
    const embeddings = new EmbeddingLedger(env.db);
    await withCostTag("sweep:7", async () => {
      await env.decisions.decide(env.paperId, ["paper-kind"], vars);
      await new Promise((r) => setTimeout(r, 1));
      embeddings.record({ model: "m", inputs: 1, costSource: "offline", elapsedMs: 0 });
    });
    await env.decisions.decide(env.paperId, ["worth-reading"], vars);
    embeddings.record({ model: "m", inputs: 1, costSource: "offline", elapsedMs: 0 });
    assert.deepEqual(
      (env.db.prepare("SELECT tag FROM jev_calls ORDER BY id").all() as any[]).map((r) => r.tag),
      ["sweep:7", null],
    );
    assert.deepEqual(
      (env.db.prepare("SELECT tag FROM embedding_calls ORDER BY id").all() as any[]).map((r) => r.tag),
      ["sweep:7", null],
    );
  } finally {
    env.done();
  }
});
