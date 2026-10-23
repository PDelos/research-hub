// The Jev model comes from configuration (RH_MODEL_JEV), defaults to a pinned release, and is recorded.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DEFAULT_JEV_MODEL, JevClient, JevLedger, jevModelFromEnv, noul } from "../src/index.ts";

const questions = { worth: noul("Is `text` worth reading?") };
const ok = (model: string) =>
  new Response(
    JSON.stringify({
      model,
      answers: { worth: { type: "noul", noul: 0.7 } },
      usage: { input_tokens: 12, output_tokens: 1 },
    }),
    { status: 200 },
  );

test("RH_MODEL_JEV wins, the pinned release is the default", () => {
  assert.equal(DEFAULT_JEV_MODEL, "typesafe/jev-1.14");
  assert.equal(jevModelFromEnv({}), "typesafe/jev-1.14");
  assert.equal(jevModelFromEnv({ RH_MODEL_JEV: " ~typesafe/jev-latest " }), "~typesafe/jev-latest");
});

test("the configured model is sent and the ledger records the resolved model ID", async (t: TestContext) => {
  let sent: any;
  t.mock.method(globalThis, "fetch", async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return ok("typesafe/jev-1.13");
  });
  const client = new JevClient({
    provider: "openrouter",
    apiKey: "dummy-key",
    model: jevModelFromEnv({ RH_MODEL_JEV: "typesafe/jev-1.13" }),
  });
  const records: unknown[] = [];
  const ledger = new JevLedger((r) => records.push(r));
  const result = await client.systemOne({ text: "x" }, questions);
  const record = ledger.record(result, { command: "ping", version: 1 });
  assert.equal(sent.model, "typesafe/jev-1.13");
  assert.equal(record.model, "typesafe/jev-1.13");
  assert.equal(record.command, "ping");
  assert.equal(record.version, 1);
  assert.equal(records.length, 1);
});
