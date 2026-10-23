import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import { call, defineAppTool, runParallel, say, spawnSubagents, toolText } from "../src/index.ts";
import { ask, fauxHarness, tempDir } from "./helpers.ts";

test("runParallel keeps order and bounds concurrency", async () => {
  let live = 0;
  let peak = 0;
  const out = await runParallel([5, 1, 3, 2], 2, async (n) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, n * 5));
    live--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20]);
  assert.equal(peak, 2);
});

test("children answer in their own conversations; the parent sees only their answer text", async () => {
  const t = tempDir();
  try {
    const research = defineAppTool({
      name: "research",
      description: "Research in parallel",
      parameters: Type.Object({ topics: Type.Array(Type.String()) }),
      replay: "safe",
      execute: async (args, api, ctx) => {
        const results = await spawnSubagents(
          api,
          ctx,
          args.topics.map((topic) => ({ prompt: `research ${topic}` })),
          { requestPrefix: `research:${api.taskId}` },
        );
        return toolText(results.map((r) => r.answerText).join(" | "));
      },
    });
    const { harness, ctx, root, close } = await fauxHarness(
      t.dir,
      [
        (turn) =>
          turn.lastUser.startsWith("research ")
            ? say(`found ${turn.lastUser.slice(9)} with a long private transcript`)
            : undefined,
        (turn) =>
          turn.results.length === 0
            ? call("research", { topics: ["pi", "jev", "exe"] })
            : say(`summary: ${turn.results[0].text}`),
      ],
      [defineExtension({ name: "research", tools: [research] })],
    );
    const settled = await ask(root, ctx, "dig in");
    assert.equal(settled.status, "done");
    const conversations = (await harness.commit((tx) => tx.scanConversations({}, 20), ctx)).items;
    assert.equal(conversations.length, 4, "root plus three children");
    assert.ok(
      conversations.slice(1).every((c) => c.owner !== undefined),
      "children are task owned",
    );
    const view = await root.context(ctx);
    const text = JSON.stringify(view.messages);
    assert.match(text, /found pi with a long private transcript \| found jev/);
    assert.doesNotMatch(text, /"research pi"/, "the child's prompt stays in the child");
    await close();
  } finally {
    t.cleanup();
  }
});
