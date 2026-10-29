// Spec engineer: Ideas and assessment, Paper-source plugins (v1-8 tasks 1.1, 1.2), offline: the engineer's model
// calls are faux rules, the web research and the new API are a fake fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EngineerExports } from "../plugins/rh.engineer/main.ts";
import { codeProblems, contractProblems, slug } from "../src/engineer/source-builder.ts";
import { validateCharter } from "../src/charter.ts";
import { engineerRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { fakeOpenRouter } from "./fixtures/openrouter.ts";
import { startTestServer } from "./helpers.ts";

/** A scholarly API at api.paperbase.org and OpenRouter's web search; counts API calls. */
function web() {
  const or = fakeOpenRouter([]);
  or.answer = "Paperbase has a free JSON search API at https://api.paperbase.org/search.";
  let apiCalls = 0;
  const fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.paperbase.org/search")) {
      apiCalls++;
      const q = new URL(url).searchParams.get("q");
      return Response.json({
        items: [
          { id: 1, doi: "10.1/pb.1", title: `Paperbase result on ${q}`, authors: ["A. B."], year: 2026 },
          { id: 2, title: "" },
        ],
      });
    }
    return or.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { fetch, or, calls: () => apiCalls };
}

async function setup() {
  const w = web();
  const server = await startTestServer({ hub: { paperFetch: w.fetch, fauxRules: [engineerRule] } });
  const p = server.hub.project;
  p.brief.write("# x");
  p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  p.charters.approve();
  const engineer = await p.plugins.exportsOf<EngineerExports>("rh.engineer");
  return { server, p, engineer, w };
}

test("contract and code checks name what is wrong", () => {
  assert.equal(slug("Paperbase API (v2)!"), "paperbase-api-v2");
  assert.deepEqual(contractProblems([], "x", 5), ["search returned no papers for a common query"]);
  assert.match(
    contractProblems([{ title: "T", source: "y", externalId: "1", authors: [], ids: {} }], "x", 5).join(),
    /source must be "x".*needs an identifier/,
  );
  assert.deepEqual(
    codeProblems('export async function activate({ rh }) { return { sources: { "x": {} } }; }', "x"),
    [],
  );
  assert.match(
    codeProblems('import fs from "node:fs"; export async function activate() { await fetch("u"); }', "x").join(),
    /must not import.*not fetch/,
  );
});

test("an idea is researched and assessed; Build writes, tests and fixes a source plugin, installed disabled; Enable turns it on", async () => {
  const s = await setup();
  try {
    const started = s.engineer.propose("Add Paperbase (https://api.paperbase.org/docs) as a paper source");
    assert.equal(started.stage, "researching");
    const assessed = await s.engineer.settled(started.id);
    assert.equal(assessed.stage, "assessed", JSON.stringify(assessed.log));
    assert.equal(assessed.assessment!.kind, "paper-source");
    assert.equal(assessed.assessment!.api!.baseUrl, "https://api.paperbase.org");
    assert.equal(s.w.or.research.length, 1, "one web search");
    assert.equal(assessed.costUsd, 0.02);

    s.engineer.build(started.id);
    const built = await s.engineer.settled(started.id);
    assert.equal(built.stage, "proposed", JSON.stringify(built.log));
    assert.equal(built.pluginId, "eng.paperbase");
    assert.equal(built.numbers!.attempts, 2, "the first version failed its test and was fixed");
    assert.ok(built.log.some((l) => /Test failed: paper 0: source must be "paperbase"/.test(l.text)));
    assert.ok(s.w.calls() >= 2);
    const plugin = s.p.plugins.kernel.list().find((x) => x.id === "eng.paperbase")!;
    assert.equal(plugin.state, "disabled", "installed disabled");
    const manifest = s.p.plugins.kernel.manifest("eng.paperbase")!;
    assert.deepEqual(manifest.permissions.network, ["api.paperbase.org"], "only the API's host");
    assert.equal(manifest.kind, "addon");

    const enabled = await s.engineer.enable(started.id);
    assert.equal(enabled.stage, "installed");
    assert.notEqual(
      s.p.plugins.kernel.list().find((x) => x.id === "eng.paperbase")!.state,
      "disabled",
      "enabled (it loads when a search needs it)",
    );
  } finally {
    await s.server.stop();
  }
});

test("rejecting a built plugin removes it; ideas the engineer cannot build say so", async () => {
  const s = await setup();
  try {
    const a = s.engineer.propose("Add Paperbase (https://api.paperbase.org/docs) as a paper source");
    await s.engineer.settled(a.id);
    s.engineer.build(a.id);
    await s.engineer.settled(a.id);
    const rejected = await s.engineer.reject(a.id);
    assert.equal(rejected.stage, "rejected");
    assert.ok(!s.p.plugins.kernel.list().some((x) => x.id === "eng.paperbase"), "uninstalled");
    assert.throws(() => s.engineer.build(a.id), /is rejected/);

    const other = s.engineer.propose("Make the interface purple");
    const done = await s.engineer.settled(other.id);
    assert.equal(done.stage, "not-buildable");
    assert.match(done.log.at(-1)!.text, /cannot build this kind/);
    assert.throws(() => s.engineer.propose("hi"), /a few words/);
  } finally {
    await s.server.stop();
  }
});
