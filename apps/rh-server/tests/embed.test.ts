// Spec paper-representations: the embedding client batches, records cost, and has a deterministic offline fake (task 4.1).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectDb } from "../src/db.ts";
import { PoliteHttp } from "../src/papers/http.ts";
import { EmbeddingLedger, FakeEmbedder, OpenRouterEmbedder } from "../src/representations/embed.ts";
import { tempDir } from "./helpers.ts";

const cosine = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);

test("OpenRouter embeddings: 70 texts go out in batches of 32, 32 and 6 with dimensions; tokens and reported cost are recorded", async () => {
  const t = tempDir();
  const { db } = openProjectDb(join(t.dir, "project.sqlite"));
  try {
    const bodies: any[] = [];
    let auth = "";
    const fetchImplementation = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      auth = new Headers(init.headers).get("authorization") ?? "";
      // Answer out of order to check the index sort.
      const data = body.input
        .map((_: string, i: number) => ({
          index: i,
          embedding: Array.from({ length: 4 }, (_, k) => (k === i % 4 ? 3 : 0)),
        }))
        .reverse();
      return Response.json({ data, usage: { total_tokens: body.input.length * 5, cost: body.input.length * 1e-8 } });
    }) as typeof fetch;
    const ledger = new EmbeddingLedger(db);
    const embedder = new OpenRouterEmbedder({
      apiKey: "sk-test-key",
      model: "qwen/qwen3-embedding-8b",
      dims: 4,
      ledger,
      http: new PoliteHttp({ fetch: fetchImplementation }),
    });
    const texts = Array.from({ length: 70 }, (_, i) => `text ${i}`);
    const vectors = await embedder.embed(texts);
    assert.deepEqual(
      bodies.map((b) => b.input.length),
      [32, 32, 6],
    );
    assert.ok(bodies.every((b) => b.model === "qwen/qwen3-embedding-8b" && b.dimensions === 4));
    assert.equal(auth, "Bearer sk-test-key");
    assert.equal(vectors.length, 70);
    assert.deepEqual([...vectors[1]], [0, 1, 0, 0], "ordered by index and L2-normalized");
    const totals = ledger.totals();
    assert.equal(totals.calls, 3);
    assert.equal(totals.inputs, 70);
    assert.equal(totals.tokens, 350);
    assert.ok(Math.abs(totals.usd - 70e-8) < 1e-12);
    const rows = db.prepare("SELECT cost_source FROM embedding_calls").all() as any[];
    assert.ok(rows.every((r) => r.cost_source === "reported"));
  } finally {
    db.close();
    t.cleanup();
  }
});

test("a wrong dimension or an error answer fails the call and is recorded as an error", async () => {
  const t = tempDir();
  const { db } = openProjectDb(join(t.dir, "project.sqlite"));
  try {
    const ledger = new EmbeddingLedger(db);
    const wrongDims = new OpenRouterEmbedder({
      apiKey: "k",
      model: "m",
      dims: 8,
      ledger,
      http: new PoliteHttp({
        fetch: (async () => Response.json({ data: [{ index: 0, embedding: [1, 0] }] })) as typeof fetch,
      }),
    });
    await assert.rejects(wrongDims.embed(["x"]), /returned 2 dimensions, RH_EMBED_DIMS is 8/);
    const errorBody = new OpenRouterEmbedder({
      apiKey: "k",
      model: "m",
      dims: 8,
      ledger,
      http: new PoliteHttp({
        fetch: (async () => Response.json({ error: { message: "model not found" } })) as typeof fetch,
      }),
    });
    await assert.rejects(errorBody.embed(["x"]), /model not found/);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM embedding_calls WHERE error IS NOT NULL").get() as any).n, 2);
    assert.equal(ledger.totals().calls, 0, "failed calls are not counted as spending");
  } finally {
    db.close();
    t.cleanup();
  }
});

test("the offline fake is deterministic, unit length, and closer for texts sharing words", async () => {
  const fake = new FakeEmbedder(256);
  const [left, a2, b, c] = await fake.embed([
    "graph neural network for protein contact prediction",
    "graph neural network for protein contact prediction",
    "graph neural network for single-cell gene regulation",
    "a survey of hospital staffing policies",
  ]);
  assert.deepEqual([...left], [...a2]);
  assert.ok(Math.abs(cosine(left, left) - 1) < 1e-5);
  assert.ok(cosine(left, b) > cosine(left, c), `${cosine(left, b)} > ${cosine(left, c)}`);
  assert.ok(cosine(left, b) > 0.3);
});
