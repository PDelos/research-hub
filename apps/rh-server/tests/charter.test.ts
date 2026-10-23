// Spec project-charter: charter rules (task 3.1), versions, scoping questions, brief, derived status (task 1.2).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  Brief,
  BriefInvalid,
  CharterInvalid,
  Charters,
  ProjectState,
  ScopingQuestions,
  validateCharter,
  type Charter,
} from "../src/charter.ts";
import { openProjectDb, Settings } from "../src/db.ts";
import { tempDir } from "./helpers.ts";

export const sampleCharter = (over: Partial<Record<keyof Charter, unknown>> = {}) => ({
  questions: [{ text: "How do protein LMs transfer to structure?" }, { text: "Which tasks need fine-tuning?", weight: 1.5 }, { text: "What do embeddings miss?" }],
  concepts: ["protein language models", "contact maps"],
  subAreas: ["structure prediction"],
  queries: ["protein language model", "ESM embeddings", "contact prediction", "protein fine-tuning", { text: "PLM benchmark", weight: 0.5 }],
  outOfScope: [],
  ...over,
});

const problems = (input: unknown): string[] => {
  try {
    validateCharter(input);
    return [];
  } catch (e) {
    assert.ok(e instanceof CharterInvalid);
    return e.problems;
  }
};

test("3.1 a valid charter is normalized: Q1..Qn, default weight 1, queries as objects", () => {
  const c = validateCharter(sampleCharter());
  assert.deepEqual(c.questions.map((q) => q.id), ["Q1", "Q2", "Q3"]);
  assert.equal(c.questions[0].weight, 1);
  assert.equal(c.questions[1].weight, 1.5);
  assert.deepEqual(c.queries[0], { text: "protein language model", weight: 1 });
  assert.deepEqual(c.queries[4], { text: "PLM benchmark", weight: 0.5 });
});

test("3.1 every bound is enforced with an exact message", () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ text: `question ${i}` }));
  assert.deepEqual(problems(sampleCharter({ questions: nine })), ["questions: 9 given, 3 to 7 allowed"]);
  assert.deepEqual(problems(sampleCharter({ questions: nine.slice(0, 2) })), ["questions: 2 given, 3 to 7 allowed"]);
  assert.deepEqual(problems(sampleCharter({ queries: ["a", "b"] })), ["queries: 2 given, 5 to 20 allowed"]);
  assert.deepEqual(problems(sampleCharter({ concepts: [] })), ["concepts: 0 given, 1 to 30 allowed"]);
  assert.deepEqual(problems(sampleCharter({ subAreas: Array(16).fill("x") })), ["subAreas: 16 given, 1 to 15 allowed"]);
  assert.deepEqual(problems(sampleCharter({ outOfScope: Array(21).fill("x") })), ["outOfScope: 21 given, 0 to 20 allowed"]);
  assert.deepEqual(
    problems(sampleCharter({ questions: [{ text: "a", weight: 3 }, { text: "b" }, { text: "c" }] })),
    ["questions[1].weight: 3 given, a number from 0.1 to 2 allowed"],
  );
  assert.deepEqual(
    problems(sampleCharter({ questions: [{ text: "x".repeat(301) }, { text: "b" }, { text: "c" }] })),
    ["questions[1].text: 301 characters, at most 300 allowed"],
  );
  assert.deepEqual(problems(sampleCharter({ concepts: ["ok", ""] })), ["concepts[2]: must be nonblank text"]);
  assert.deepEqual(problems("nope").slice(0, 2), ["charter: must be an object", "questions: must be a list"]);
});

function store() {
  const t = tempDir();
  const { db } = openProjectDb(join(t.dir, "project.sqlite"));
  const settings = new Settings(db);
  const brief = new Brief(t.dir);
  const charters = new Charters(db);
  return { t, db, settings, brief, charters, state: new ProjectState(settings, brief, charters), questions: new ScopingQuestions(db) };
}

test("1.2 status is derived: needs-brief → charter-review → active; paused remembers what to return to", () => {
  const s = store();
  try {
    assert.equal(s.state.status(), "needs-brief");
    s.brief.write("# Protein LMs\nStudy them.");
    assert.equal(s.state.status(), "charter-review");
    s.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    assert.equal(s.state.status(), "charter-review");
    s.charters.approve();
    assert.equal(s.state.status(), "active");
    s.state.pause();
    assert.equal(s.state.status(), "paused");
    assert.equal(s.state.underlying(), "active");
    s.state.resume(Date.parse("2026-10-23T09:00:00Z"));
    assert.equal(s.state.status(), "active");
    assert.equal(s.state.resumedAt(), Date.parse("2026-10-23T09:00:00Z"));
  } finally {
    s.db.close();
    s.t.cleanup();
  }
});

test("charter versions: approval numbers versions, a new draft supersedes the old draft, versions stay readable", () => {
  const s = store();
  try {
    s.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    s.charters.saveDraft(validateCharter(sampleCharter({ concepts: ["second draft"] })), "agent");
    assert.deepEqual(s.charters.draft()!.charter.concepts, ["second draft"]);
    assert.equal(s.charters.approve()!.version, 1);
    assert.equal(s.charters.draft(), undefined);
    s.charters.saveDraft(validateCharter(sampleCharter({ concepts: ["edited"] })), "user");
    assert.equal(s.charters.approved()!.version, 1, "v1 stays in force until the next approval");
    assert.equal(s.charters.approve()!.version, 2);
    assert.deepEqual(s.charters.version(1)!.charter.concepts, ["second draft"]);
    assert.deepEqual(s.charters.versions().map((v) => v.version), [1, 2]);
    assert.throws(() => s.charters.saveDraft({ ...validateCharter(sampleCharter()), questions: [] }, "user"), CharterInvalid);
  } finally {
    s.db.close();
    s.t.cleanup();
  }
});

test("scoping questions cap at 5 in total and record answers", () => {
  const s = store();
  try {
    s.questions.ask(1, ["Applied or theoretical?", "Clinical in scope?", "Which organisms?"]);
    assert.throws(() => s.questions.ask(2, ["a", "b", "c"]), /only 2 more scoping questions allowed/);
    s.questions.ask(2, ["a", "b"]);
    assert.throws(() => s.questions.ask(3, ["sixth"]), /only 0 more/);
    const [first] = s.questions.open();
    s.questions.answer([{ id: first.id, answer: "Applied" }]);
    assert.equal(s.questions.open().length, 4);
    assert.equal(s.questions.all()[0].answer, "Applied");
  } finally {
    s.db.close();
    s.t.cleanup();
  }
});

test("brief: ≤ 50,000 characters of nonblank text, nothing stored on failure", () => {
  const s = store();
  try {
    assert.throws(() => s.brief.write("x".repeat(60_000)), (e: unknown) => e instanceof BriefInvalid && /the limit is 50,000/.test(e.message));
    assert.equal(s.brief.read(), undefined);
    assert.throws(() => s.brief.write("   "), BriefInvalid);
    assert.throws(() => s.brief.write(42), BriefInvalid);
    s.brief.write("é".repeat(50_000));
    assert.equal([...s.brief.read()!].length, 50_000);
  } finally {
    s.db.close();
    s.t.cleanup();
  }
});
