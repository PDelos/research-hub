// A tiny host process for crash tests: open the harness, submit or resume, print what happened, exit.
//   host.ts <dir> submit <requestId> <text>
//   host.ts <dir> resume
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import { call, defineAppTool, once, say, spawnSubagents, toolText } from "../../src/index.ts";
import { fauxHarness } from "../helpers.ts";

const [dir, mode, requestId, text] = process.argv.slice(2);
const effects = join(dir, "effects.log");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const slowSafe = defineAppTool({
  name: "slow_safe",
  description: "A replay-safe slow effect",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api, ctx) => {
    await once(api, "effect", ctx, async () => {
      appendFileSync(effects, `safe ${api.callId}\n`);
      return "applied";
    });
    await sleep(Number(process.env.SLOW_MS ?? 1500));
    return toolText("safe finished");
  },
});

const slowUnsafe = defineAppTool({
  name: "slow_unsafe",
  description: "An unsafe slow effect",
  parameters: Type.Object({}),
  execute: async (_args, api) => {
    appendFileSync(effects, `unsafe ${api.callId}\n`);
    await sleep(Number(process.env.SLOW_MS ?? 1500));
    return toolText("unsafe finished");
  },
});

const spawnTwo = defineAppTool({
  name: "spawn_two",
  description: "Run two child agents",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api, ctx) => {
    const results = await spawnSubagents(
      api,
      ctx,
      [{ prompt: "child task 0" }, { prompt: "child task 1" }],
      { requestPrefix: `kids:${api.taskId}` },
    );
    return toolText(results.map((r) => `${r.conversationId}:${r.answerText}`).join(" | "));
  },
});

const { harness, ctx, root, close } = await fauxHarness(
  dir,
  [
    (t) =>
      t.lastUser.startsWith("child task") && t.results.length === 0
        ? call("slow_safe", {})
        : undefined,
    (t) => (t.lastUser.startsWith("child task") ? say(`${t.lastUser} done`) : undefined),
    (t) =>
      t.results.length > 0 ? say(`result: ${t.results.map((r) => r.text).join(" | ")}`) : undefined,
    (t) => (t.lastUser === "safe" ? call("slow_safe", {}) : undefined),
    (t) => (t.lastUser === "unsafe" ? call("slow_unsafe", {}) : undefined),
    (t) => (t.lastUser === "spawn" ? call("spawn_two", {}) : undefined),
  ],
  [defineExtension({ name: "crash", tools: [slowSafe, slowUnsafe, spawnTwo] })],
);

if (mode === "submit") {
  await root.submit({ type: "input", content: text, requestId }, ctx);
  harness.resume();
  await root.waitForIdle(ctx);
} else {
  harness.resume();
  await root.waitForIdle(ctx);
}
const page = await root.entries({ order: "ascending" }, 200, undefined, ctx);
const results = page.items
  .filter((e) => e.kind === "pi.tool-result")
  .map((e) => e.model?.[0] as any);
const answers = page.items
  .filter((e) => e.kind === "pi.assistant")
  .map((e) =>
    (e.model?.[0] as any).content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(""),
  );
const conversations = (await harness.commit((tx) => tx.scanConversations({}, 100), ctx)).items
  .length;
console.log(
  JSON.stringify({
    results: results.map((r) => ({
      name: r.toolName,
      isError: r.isError,
      text: r.content.map((c: any) => c.text).join(""),
    })),
    answers,
    conversations,
  }),
);
await close();
