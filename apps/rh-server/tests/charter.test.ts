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
} from "../src/charter.ts";
import { openProjectDb, Settings } from "../src/db.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { tempDir } from "./test-server.ts";

const problems = (input: unknown): string[] => {
  try {
    validateCharter(input);
    return [];
  } catch (error) {
    assert.ok(error instanceof CharterInvalid);
    return error.problems;
  }
};

test("3.1 a valid charter is normalized: Q1..Qn, default weight 1, queries as objects", () => {
  const charter = validateCharter(sampleCharter());
  assert.deepEqual(
    charter.questions.map((q) => q.id),
    ["Q1", "Q2", "Q3"],
  );
  assert.equal(charter.questions[0].weight, 1);
  assert.equal(charter.questions[1].weight, 1.5);
  assert.deepEqual(charter.queries[0], { text: "protein language model", weight: 1 });
  assert.deepEqual(charter.queries[4], { text: "PLM benchmark", weight: 0.5 });
});

test("3.1 every bound is enforced with an exact message", () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ text: `question ${i}` }));
  assert.deepEqual(problems(sampleCharter({ questions: nine })), ["questions: 9 given, 3 to 7 allowed"]);
  assert.deepEqual(problems(sampleCharter({ questions: nine.slice(0, 2) })), ["questions: 2 given, 3 to 7 allowed"]);
  assert.deepEqual(problems(sampleCharter({ queries: ["a", "b"] })), ["queries: 2 given, 5 to 20 allowed"]);
  assert.deepEqual(problems(sampleCharter({ concepts: [] })), ["concepts: 0 given, 1 to 30 allowed"]);
  assert.deepEqual(problems(sampleCharter({ subAreas: Array(16).fill("x") })), ["subAreas: 16 given, 1 to 15 allowed"]);
  assert.deepEqual(problems(sampleCharter({ outOfScope: Array(21).fill("x") })), [
    "outOfScope: 21 given, 0 to 20 allowed",
  ]);
  assert.deepEqual(problems(sampleCharter({ questions: [{ text: "a", weight: 3 }, { text: "b" }, { text: "c" }] })), [
    "questions[1].weight: 3 given, a number from 0.1 to 2 allowed",
  ]);
  assert.deepEqual(problems(sampleCharter({ questions: [{ text: "x".repeat(301) }, { text: "b" }, { text: "c" }] })), [
    "questions[1].text: 301 characters, at most 300 allowed",
  ]);
  assert.deepEqual(problems(sampleCharter({ concepts: ["ok", ""] })), ["concepts[2]: must be nonblank text"]);
  assert.deepEqual(problems("nope").slice(0, 2), [
    "charter: must be an object",
    "questions: must be a list (a JSON array), not missing",
  ]);
});

function store() {
  const temp = tempDir();
  const { db } = openProjectDb(join(temp.dir, "project.sqlite"));
  const settings = new Settings(db);
  const brief = new Brief(temp.dir);
  const charters = new Charters(db);
  return {
    t: temp,
    db,
    settings,
    brief,
    charters,
    state: new ProjectState(settings, brief, charters),
    questions: new ScopingQuestions(db),
  };
}

test("1.2 status is derived: needs-brief → charter-review → active; paused remembers what to return to", () => {
  const env = store();
  try {
    assert.equal(env.state.status(), "needs-brief");
    env.brief.write("# Protein LMs\nStudy them.");
    assert.equal(env.state.status(), "charter-review");
    env.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    assert.equal(env.state.status(), "charter-review");
    env.charters.approve();
    assert.equal(env.state.status(), "active");
    env.state.pause();
    assert.equal(env.state.status(), "paused");
    assert.equal(env.state.underlying(), "active");
    env.state.resume(Date.parse("2026-10-23T09:00:00Z"));
    assert.equal(env.state.status(), "active");
    assert.equal(env.state.resumedAt(), Date.parse("2026-10-23T09:00:00Z"));
  } finally {
    env.db.close();
    env.t.cleanup();
  }
});

test("charter versions: approval numbers versions, a new draft supersedes the old draft, versions stay readable", () => {
  const env = store();
  try {
    env.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    env.charters.saveDraft(validateCharter(sampleCharter({ concepts: ["second draft"] })), "agent");
    assert.deepEqual(env.charters.draft()!.charter.concepts, ["second draft"]);
    assert.equal(env.charters.approve()!.version, 1);
    assert.equal(env.charters.draft(), undefined);
    env.charters.saveDraft(validateCharter(sampleCharter({ concepts: ["edited"] })), "user");
    assert.equal(env.charters.approved()!.version, 1, "v1 stays in force until the next approval");
    assert.equal(env.charters.approve()!.version, 2);
    assert.deepEqual(env.charters.version(1)!.charter.concepts, ["second draft"]);
    assert.deepEqual(
      env.charters.versions().map((v) => v.version),
      [1, 2],
    );
    assert.throws(
      () => env.charters.saveDraft({ ...validateCharter(sampleCharter()), questions: [] }, "user"),
      CharterInvalid,
    );
  } finally {
    env.db.close();
    env.t.cleanup();
  }
});

test("scoping questions cap at 5 in total and record answers", () => {
  const env = store();
  try {
    env.questions.ask(1, ["Applied or theoretical?", "Clinical in scope?", "Which organisms?"]);
    assert.throws(() => env.questions.ask(2, ["a", "b", "c"]), /only 2 more scoping questions allowed/);
    env.questions.ask(2, ["a", "b"]);
    assert.throws(() => env.questions.ask(3, ["sixth"]), /only 0 more/);
    const [first] = env.questions.open();
    env.questions.answer([{ id: first.id, answer: "Applied" }]);
    assert.equal(env.questions.open().length, 4);
    assert.equal(env.questions.all()[0].answer, "Applied");
  } finally {
    env.db.close();
    env.t.cleanup();
  }
});

test("brief: ≤ 50,000 characters of nonblank text, nothing stored on failure", () => {
  const env = store();
  try {
    assert.throws(
      () => env.brief.write("x".repeat(60_000)),
      (e: unknown) => e instanceof BriefInvalid && /the limit is 50,000/.test(e.message),
    );
    assert.equal(env.brief.read(), undefined);
    assert.throws(() => env.brief.write("   "), BriefInvalid);
    assert.throws(() => env.brief.write(42), BriefInvalid);
    env.brief.write("é".repeat(50_000));
    assert.equal([...env.brief.read()!].length, 50_000);
  } finally {
    env.db.close();
    env.t.cleanup();
  }
});

test("lists sent as JSON-encoded strings are accepted; other non-lists name the expected type", () => {
  const charter = validateCharter({
    ...sampleCharter(),
    concepts: JSON.stringify(["protein language model", "ESM"]),
    queries: JSON.stringify(["a b", "c d", "e f", "g h", "i j"]),
  });
  assert.deepEqual(charter.concepts, ["protein language model", "ESM"]);
  assert.equal(charter.queries.length, 5);
  assert.deepEqual(problems(sampleCharter({ concepts: "just text" })), [
    "concepts: must be a list (a JSON array), not string",
  ]);
});

test("an approved version keeps question ids: retiring one does not shift the others, a new one gets the next id", () => {
  const env = store();
  try {
    env.charters.saveDraft(
      validateCharter(sampleCharter({ questions: ["A?", "B?", "C?", "D?"].map((text) => ({ text })) })),
      "agent",
    );
    env.charters.approve();
    const open = env.charters.saveDraft(validateCharter(sampleCharter()), "user");
    const v1 = env.charters.approved()!.charter;
    const retired = env.charters.approveVersion(
      { ...v1, questions: v1.questions.filter((q) => q.id !== "Q2") },
      "user",
    );
    assert.equal(retired.version, 2);
    assert.deepEqual(
      retired.charter.questions.map((q) => q.id),
      ["Q1", "Q3", "Q4"],
    );
    const added = env.charters.approveVersion(
      { ...retired.charter, questions: [...retired.charter.questions, { text: "E?" } as never] },
      "user",
    );
    assert.deepEqual(
      added.charter.questions.map((q) => `${q.id} ${q.text}`),
      ["Q1 A?", "Q3 C?", "Q4 D?", "Q5 E?"],
    );
    assert.equal(env.charters.draft()?.id, open.id, "an open draft is untouched");
    // Drafts are renumbered as before.
    assert.deepEqual(
      env.charters.saveDraft(added.charter, "user").charter.questions.map((q) => q.id),
      ["Q1", "Q2", "Q3", "Q4"],
    );
  } finally {
    env.db.close();
  }
});
