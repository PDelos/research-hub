// Jev degrades above ~32 KB of text, so oversized input fails before any request is sent.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { InputTooLargeError, JevClient, loadCommand, MAX_INPUT_BYTES, noul, runCommand } from "../src/index.ts";

const DIR = join(import.meta.dirname, "fixtures/commands");
const big = "x".repeat(40_000);

test("the limit is 30,000 bytes", () => {
  assert.equal(MAX_INPUT_BYTES, 30_000);
});

test("a 40,000-byte state is rejected by the client before fetch", async (t: TestContext) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("{}"));
  const client = new JevClient({ provider: "openrouter", apiKey: "dummy-key" });
  await assert.rejects(
    client.systemOne({ text: big }, { worth: noul("Is `text` worth reading?") }),
    (e: unknown) => e instanceof InputTooLargeError && e.bytes > 40_000,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("runCommand names the command in the error and never calls decide", async () => {
  let called = false;
  await assert.rejects(
    runCommand(
      loadCommand("worth-attention", DIR),
      { title: "t", source: "s", published_at: "2026-10-22", excerpt: big, taste_examples: [] },
      async () => {
        called = true;
        throw new Error("unreachable");
      },
    ),
    (e: unknown) => e instanceof InputTooLargeError && /command "worth-attention"/.test(e.message),
  );
  assert.equal(called, false);
});

test("an abstract-sized input passes", async () => {
  const client = new JevClient({ provider: "mock" });
  const result = await client.systemOne({ text: "y".repeat(3_000) }, { worth: noul("Is `text` worth reading?") });
  assert.ok(result.answers.worth);
});
