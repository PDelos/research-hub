// Spec project-charter end to end with the scripted charter writer: brief (2.1, 2.2), drafting in its own
// conversation on the review model (3.2, 3.3), the correction loop (3.4), answers (3.5), approval and versions (3.6),
// pause and resume (4.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, say } from "@rh/durable-agent";
import { charterWriterRule, fauxCharter } from "../src/faux-rules.ts";
import { startTestServer, TOKEN, until, type TestServer } from "./helpers.ts";

const BRIEF =
  "# Protein language models\nI want to understand how protein language models learn structure and where they fail.";

function api(server: TestServer) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
}

async function settled(call: ReturnType<typeof api>) {
  let last: any;
  await until(
    async () => {
      last = (await call("GET", "/v1/charter")).body;
      return last.run && last.run.status !== "running";
    },
    20_000,
    "charter run settled",
  );
  return last;
}

test("2.1 + 3.3 a fresh project needs a brief; a valid brief yields a Q1..Qn draft with questions on the review model", async () => {
  const server = await startTestServer();
  const http = api(server);
  try {
    assert.equal((await http("GET", "/v1/brief")).body.status, "needs-brief");
    const big = await http("PUT", "/v1/brief", { brief: "x".repeat(60_000) });
    assert.equal(big.status, 400);
    assert.match(big.body.error.message, /the limit is 50,000/);
    assert.equal((await http("GET", "/v1/brief")).body.brief, null, "nothing stored");

    assert.equal((await http("PUT", "/v1/brief", { brief: BRIEF })).status, 200);
    const view = await settled(http);
    assert.equal(view.run.status, "done");
    assert.equal(view.status, "charter-review");
    assert.deepEqual(
      view.draft.charter.questions.map((q: any) => q.id),
      ["Q1", "Q2", "Q3"],
    );
    assert.equal(view.questions.length, 2);
    assert.equal(view.questionsLeft, 3);

    // Separate from chat: the chat transcript has no drafting messages; the drafting run used the review model.
    const transcript = JSON.stringify((await http("GET", "/v1/transcript")).body.items);
    assert.ok(!transcript.includes("Draft the charter"));
    await until(
      async () => (await http("GET", "/v1/runs")).body.some((r: any) => r.text.includes("Draft the charter")),
      5_000,
      "run recorded",
    );
    const runs = (await http("GET", "/v1/runs")).body;
    const draftRun = runs.find((r: any) => r.text.includes("Draft the charter"));
    assert.deepEqual(draftRun.models, ["anthropic/claude-sonnet-5.5"]);
    assert.notEqual(draftRun.conversationId, (await http("GET", "/v1/agent")).body.conversationId);
  } finally {
    await server.stop();
  }
});

test("3.2 a replayed tool call records the draft and the questions once; a sixth question is refused", async () => {
  const server = await startTestServer();
  try {
    const project = server.hub.project;
    project.brief.write(BRIEF);
    project.settings.set("charter_run", {
      id: 1,
      kind: "draft",
      status: "running",
      round: 1,
      invalidSaves: 0,
      saved: false,
      startedAt: "now",
      prompt: "",
    });
    // A fake tool API with a durable memo, as pi-durable gives a replayed call.
    const memo = new Map<string, unknown>();
    const fakeApi = {
      memo: async (key: string, ...rest: unknown[]) => {
        if (rest.length === 2) memo.set(key, rest[0]);
        return memo.get(key);
      },
    } as any;
    const save = project.charterWriter.tools.save;
    await save.execute(fauxCharter(BRIEF), fakeApi, {} as any);
    await save.execute(fauxCharter(BRIEF), fakeApi, {} as any);
    const drafts = project.db.prepare("SELECT COUNT(*) n FROM charters").get() as { n: number };
    assert.equal(drafts.n, 1, "the replay found the memo instead of saving again");

    const ask = project.charterWriter.tools.ask;
    const askApi = { memo: fakeApi.memo } as any;
    memo.clear();
    await ask.execute({ questions: ["a?", "b?", "c?", "d?", "e?"] }, askApi, {} as any);
    await ask.execute({ questions: ["a?", "b?", "c?", "d?", "e?"] }, askApi, {} as any);
    assert.equal(project.questions.all().length, 5, "the replay did not ask twice");
    memo.clear();
    const sixth = await ask.execute({ questions: ["sixth?"] }, { memo: fakeApi.memo } as any, {} as any);
    assert.equal(sixth.isError, true);
    assert.match(sixth.content[0].text, /only 0 more scoping questions allowed/);
    assert.equal(project.questions.all().length, 5);
  } finally {
    await server.stop();
  }
});

test("3.4 an invalid draft is corrected and never stored; 3 invalid saves fail the run and retry works", async () => {
  let invalidMode = "once";
  let invalidSent = 0;
  const nine = Array.from({ length: 9 }, (_, i) => ({ text: `question ${i}` }));
  const rule = (turn: any) => {
    if (!turn.sections["charter-writer"]) return undefined;
    const saved = turn.results.filter((r: any) => r.name === "save_charter_draft");
    if (saved.some((r: any) => !r.isError)) return say("Saved.");
    const lastError = saved.at(-1);
    if (lastError && /already failed|Stop: this run has failed/.test(lastError.text)) return say("Stopping.");
    const bad = invalidMode === "always" || (invalidMode === "once" && saved.length === 0);
    if (bad) {
      invalidSent++;
      return call("save_charter_draft", { ...fauxCharter(BRIEF), questions: nine });
    }
    return call("save_charter_draft", fauxCharter(BRIEF));
  };
  const server = await startTestServer({ hub: { fauxRules: [rule] } });
  const http = api(server);
  try {
    await http("PUT", "/v1/brief", { brief: BRIEF });
    const first = await settled(http);
    assert.equal(first.run.status, "done");
    assert.equal(first.run.invalidSaves, 1);
    const errors = (await http("GET", "/v1/runs")).body;
    const detail = (await http("GET", `/v1/runs/${errors.find((r: any) => r.text.includes("Draft the charter")).id}`))
      .body;
    assert.ok(detail.toolCallList.some((c: any) => c.isError && /questions: 9 given, 3 to 7 allowed/.test(c.result)));
    assert.equal(
      (server.hub.project.db.prepare("SELECT COUNT(*) n FROM charters").get() as any).n,
      1,
      "only the valid draft",
    );

    invalidMode = "always";
    await http("PUT", "/v1/brief", { brief: `${BRIEF}\nA second version.` });
    const failed = await settled(http);
    assert.equal(failed.run.status, "failed");
    assert.match(failed.run.reason, /3 invalid drafts/);

    invalidMode = "never";
    assert.equal((await http("POST", "/v1/charter/retry")).status, 200);
    const retried = await settled(http);
    assert.equal(retried.run.status, "done");
    assert.ok(invalidSent >= 4);
  } finally {
    await server.stop();
  }
});

test("3.5 + 3.6 + 2.2 answers revise the draft; approval versions it; edits and new briefs make drafts, v1 stays readable", async () => {
  const server = await startTestServer();
  const http = api(server);
  try {
    await http("PUT", "/v1/brief", { brief: BRIEF });
    const draft = await settled(http);
    const q = draft.questions.find((x: any) => /clinical/i.test(x.text));
    const answered = await http("POST", "/v1/charter/answers", {
      answers: [{ id: q.id, answer: "Clinical applications are out of scope" }],
    });
    assert.equal(answered.status, 200);
    const revised = await settled(http);
    assert.equal(revised.run.kind, "revision");
    assert.ok(
      revised.draft.charter.outOfScope.includes("Clinical applications"),
      JSON.stringify(revised.draft.charter.outOfScope),
    );
    assert.equal(
      (await http("POST", "/v1/charter/answers", { answers: [{ id: q.id, answer: "again" }] })).status,
      400,
      "already answered",
    );

    const approved = (await http("POST", "/v1/charter/approve")).body;
    assert.equal(approved.status, "active");
    assert.equal(approved.approved.version, 1);
    assert.equal((await http("POST", "/v1/charter/approve")).status, 409, "no draft to approve");

    const edited = structuredClone(approved.approved.charter);
    edited.questions[1].text = "Which fine-tuning strategies transfer best?";
    assert.equal((await http("PUT", "/v1/charter", { charter: edited })).status, 200);
    const bad = await http("PUT", "/v1/charter", { charter: { ...edited, questions: [] } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /questions: 0 given, 3 to 7 allowed/);
    const v2 = (await http("POST", "/v1/charter/approve")).body;
    assert.equal(v2.approved.version, 2);
    assert.equal(v2.approved.charter.questions[1].text, "Which fine-tuning strategies transfer best?");
    const v1 = (await http("GET", "/v1/charter/versions/1")).body;
    assert.notEqual(v1.charter.questions[1].text, "Which fine-tuning strategies transfer best?");

    await http("PUT", "/v1/brief", { brief: `${BRIEF}\nNow also RNA.` });
    const afterBrief = await settled(http);
    assert.ok(afterBrief.draft, "a new draft");
    assert.equal(afterBrief.approved.version, 2, "the approved charter stays in force");
    assert.equal(afterBrief.status, "active");
  } finally {
    await server.stop();
  }
});

test("4.1 pause and resume: status changes, chat keeps working", async () => {
  const server = await startTestServer({ hub: { fauxRules: [charterWriterRule, (t) => say(`echo ${t.lastUser}`)] } });
  const http = api(server);
  try {
    await http("PUT", "/v1/brief", { brief: BRIEF });
    await settled(http);
    await http("POST", "/v1/charter/approve");
    assert.equal((await http("POST", "/v1/project/pause")).body.status, "paused");
    const chat = await server.client.send("still here?", { waitMs: 10_000 });
    assert.equal(chat.answer?.text, "echo still here?");
    assert.equal((await http("POST", "/v1/project/resume")).body.status, "active");
  } finally {
    await server.stop();
  }
});

test("charter routes need a token, and a second brief while drafting is refused", async () => {
  const slow = (turn: any) => (turn.sections["charter-writer"] ? say("thinking ".repeat(200)) : undefined);
  const server = await startTestServer({ hub: { fauxRules: [slow], fauxTokensPerSecond: 50 } });
  const http = api(server);
  try {
    assert.equal((await fetch(`${server.url}/v1/charter`)).status, 401);
    await http("PUT", "/v1/brief", { brief: BRIEF });
    const second = await http("PUT", "/v1/brief", { brief: `${BRIEF} again` });
    assert.equal(second.status, 409);
    const view = await settled(http);
    assert.equal(view.run.status, "failed", "a run that never saves a draft fails");
    assert.match(view.run.reason, /without saving a draft/);
  } finally {
    await server.stop();
  }
});
