import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import {
  allowOnly,
  call,
  defineAppTool,
  enumFeedback,
  say,
  toolError,
  toolText,
} from "../src/index.ts";
import { ask, fauxHarness, tempDir } from "./helpers.ts";

const COMPONENTS = ["headline", "brief"] as const;
const present = defineAppTool({
  name: "present",
  description: "Present a card",
  parameters: Type.Object({
    component: Type.Union(COMPONENTS.map((c) => Type.Literal(c))),
    title: Type.String(),
  }),
  enums: { component: COMPONENTS },
  example: { component: "brief", title: "A title" },
  replay: "safe",
  execute: async (args) =>
    args.title.length < 3
      ? toolError("present failed: title is too short", ["Use a title of 3 or more characters."])
      : toolText(`presented ${args.component}`),
});

test("enumFeedback lists every valid value and the example", () => {
  assert.throws(
    () =>
      enumFeedback(
        "present",
        { component: "poster" },
        { component: COMPONENTS },
        { component: "brief" },
      ),
    /must be one of: headline, brief\. You sent "poster"\. Example call: \{"component":"brief"\}/,
  );
  assert.doesNotThrow(() =>
    enumFeedback("present", { component: "brief" }, { component: COMPONENTS }),
  );
});

test("a bad enum comes back to the model with the fix, and the corrected call succeeds", async () => {
  const t = tempDir();
  try {
    const { ctx, root, close } = await fauxHarness(
      t.dir,
      [
        (turn) =>
          turn.results.length === 0
            ? call("present", { component: "poster", title: "Hello" })
            : undefined,
        (turn) =>
          turn.results.length === 1
            ? call("present", { component: "brief", title: "x" })
            : undefined,
        (turn) =>
          turn.results.length === 2
            ? call("present", { component: "brief", title: "Hello" })
            : undefined,
        (turn) => say(turn.results.map((r) => `${r.isError ? "ERR" : "OK"} ${r.text}`).join("\n")),
      ],
      [defineExtension({ name: "cards", tools: [present] })],
    );
    const settled = await ask(root, ctx, "present something");
    assert.equal(settled.status, "done");
    const page = await root.entries({ order: "ascending" }, 50, undefined, ctx);
    const results = page.items
      .filter((e) => e.kind === "pi.tool-result")
      .map((e) => e.model![0] as any);
    assert.equal(results.length, 3);
    assert.equal(results[0].isError, true);
    assert.match(results[0].content[0].text, /must be one of: headline, brief/);
    assert.equal(results[1].isError, true);
    assert.match(results[1].content[0].text, /Fix: Use a title of 3 or more characters/);
    assert.equal(results[2].isError, false);
    await close();
  } finally {
    t.cleanup();
  }
});

test("allowOnly blocks tools outside the list", async () => {
  const t = tempDir();
  try {
    const { ctx, root, close } = await fauxHarness(
      t.dir,
      [
        (turn) =>
          turn.results.length === 0
            ? call("present", { component: "brief", title: "Hello" })
            : say(turn.results[0].text),
      ],
      [
        defineExtension({
          name: "cards",
          tools: [present],
          hooks: [allowOnly("researcher", ["read_item"])],
        }),
      ],
    );
    await ask(root, ctx, "go");
    const page = await root.entries({ order: "ascending" }, 50, undefined, ctx);
    const result = page.items.find((e) => e.kind === "pi.tool-result")!.model![0] as any;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not allowed for researcher/);
    await close();
  } finally {
    t.cleanup();
  }
});
