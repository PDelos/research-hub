// Research Hub sends every live Jev decision through OpenRouter and never substitutes another answer.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { JevClient, noul } from "../src/index.ts";

const questions = { worth: noul("Is `text` worth reading?") };
const valid = {
  model: "typesafe/jev-1.14",
  answers: { worth: { type: "noul", noul: 0.8 } },
  usage: { input_tokens: 10, output_tokens: 1 },
};
const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const live = () => new JevClient({ provider: "openrouter", apiKey: "dummy-key", retryDelayMs: 0 });

test("every live request targets OpenRouter's decisions endpoint", async (t: TestContext) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    return ok(valid);
  });
  const client = live();
  await client.systemOne({ text: "a" }, questions);
  await client.systemOne({ text: "b" }, questions);
  assert.equal(urls.length, 2);
  for (const url of urls) assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
});

test("the TypeSafe-direct provider cannot be selected", () => {
  assert.throws(
    () => new JevClient({ provider: "typesafe" as never, apiKey: "k" }),
    /apiKey requires an explicit live opts.provider \(openrouter\)/,
  );
  assert.throws(() => new JevClient({ provider: "typesafe" as never }), /Unknown JEV backend/);
});

test("a failure after retries is an error, never a mock or substitute answer", async (t: TestContext) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => ok({}, 503));
  await assert.rejects(live().systemOne({ text: "x" }, questions), /HTTP 503/);
  assert.equal(fetch.mock.callCount(), 3);
});

test("the default live model is the pinned Jev release", async (t: TestContext) => {
  let sent: any;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return ok(valid);
  });
  const result = await live().systemOne({ text: "x" }, questions);
  assert.equal(sent.model, "typesafe/jev-1.14");
  assert.equal(result.meta.requestedModel, "typesafe/jev-1.14");
});
