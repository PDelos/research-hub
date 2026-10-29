// Spec engineer: Fine-tuned embedder on Kaggle; spec slots: Local embedder alternative (v1-8 tasks 2.1, 2.2), offline
// with a fake Kaggle API and a fake embedding server.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import type { EngineerExports } from "../plugins/rh.engineer/main.ts";
import type { PapersExports } from "../plugins/rh.papers/main.ts";
import { KaggleRunner, KaggleUnavailable, kaggleCredentials } from "../src/engineer/kaggle.ts";
import { trainingScript } from "../src/engineer/finetune.ts";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule, engineerRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { byId, noul, pick, score, scripted } from "./fixtures/jev-answers.ts";
import { fakeOpenRouter } from "./fixtures/openrouter.ts";
import { arxivOnlyFetch, fakePapers } from "./fixtures/sweep-env.ts";
import { startTestServer, until } from "./test-server.ts";

/** A fake Kaggle API: SaveKernel, then RUNNING once and COMPLETE, and two model files plus a log to download. */
function fakeKaggle() {
  const calls: { method: string; body: any; auth: string }[] = [];
  let polls = 0;
  const handle = async (url: string, init?: RequestInit): Promise<Response | undefined> => {
    if (url.startsWith("https://api.kaggle.com/v1/kernels.KernelsApiService/")) {
      const method = url.split("/").at(-1)!;
      calls.push({ method, body: JSON.parse(String(init?.body)), auth: String((init?.headers as any)?.authorization) });
      if (method === "SaveKernel") return Response.json({ ref: "me/x", url: "https://www.kaggle.com/code/me/x" });
      if (method === "GetKernelSessionStatus") return Response.json({ status: polls++ ? "COMPLETE" : "RUNNING" });
      if (method === "ListKernelSessionOutput")
        return Response.json({
          files: [
            { fileName: "model/config.json", url: "https://storage.googleapis.com/k/config.json" },
            { fileName: "model/1_Pooling/config.json", url: "https://storage.googleapis.com/k/pool.json" },
            { fileName: "run/log.txt", url: "https://storage.googleapis.com/k/log.txt" },
          ],
        });
    }
    if (url.startsWith("https://storage.googleapis.com/k/")) return new Response('{"fake": true}');
    return undefined;
  };
  return { calls, handle };
}

test("the Kaggle runner pushes a private GPU script, waits for COMPLETE and lists the output; errors and missing tokens say why", async () => {
  const kaggle = fakeKaggle();
  const runner = new KaggleRunner({
    request: async (url, init) => (await kaggle.handle(url, init as RequestInit))!,
    credentials: kaggleCredentials((n) => ({ KAGGLE_USERNAME: "me", KAGGLE_API_TOKEN: "tok" })[n]),
    sleep: async () => undefined,
  });
  const pushed = await runner.push("x", "Title", "print(1)");
  assert.equal(pushed.url, "https://www.kaggle.com/code/me/x");
  assert.deepEqual(
    { ...kaggle.calls[0].body, text: undefined },
    {
      slug: "me/x",
      newTitle: "Title",
      text: undefined,
      language: "python",
      kernelType: "script",
      isPrivate: true,
      enableGpu: true,
      enableInternet: true,
    },
  );
  assert.equal(kaggle.calls[0].auth, "Bearer tok");
  await runner.wait("x");
  assert.deepEqual(
    kaggle.calls.filter((c) => c.method === "GetKernelSessionStatus").map((c) => c.body),
    [
      { userName: "me", kernelSlug: "x" },
      { userName: "me", kernelSlug: "x" },
    ],
  );
  assert.equal((await runner.output("x")).files.length, 3);
  const failing = new KaggleRunner({
    request: async () => Response.json({ status: "ERROR", failureMessage: "CUDA out of memory" }),
    credentials: { username: "me", key: "k" },
    sleep: async () => undefined,
  });
  await assert.rejects(failing.wait("x"), /ERROR: CUDA out of memory/);
  assert.throws(() => kaggleCredentials(() => undefined), KaggleUnavailable);
  assert.throws(() => kaggleCredentials(() => undefined), /KAGGLE_API_TOKEN/);
  const script = trainingScript({ pairs: [{ query: "q", positive: "p" }], negatives: ["n"] });
  assert.match(script, /SentenceTransformer\("BAAI\/bge-small-en-v1.5"\)/);
  const payload = script.match(/b64decode\("([^"]+)"\)/)![1];
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64").toString()), {
    pairs: [{ query: "q", positive: "p" }],
    negatives: ["n"],
  });
});

test("the engineer fine-tunes an embedder on Kaggle, benchmarks it locally, and Enable switches the embedder live", async () => {
  // The fake embedding server: texts about ribosomes and the first research question point the same way.
  const embedServer = createServer((request, response) => {
    if (request.url === "/health") return void response.end("{}");
    let body = "";
    request.on("data", (d) => (body += d));
    request.on("end", () => {
      const { texts } = JSON.parse(body) as { texts: string[] };
      const vectors = texts.map((text, i) => {
        const near = /Ribosome|transfer to structure/.test(text);
        // Texts about the topic point along the first axis; the rest spread out.
        const nearAxis = (j: number) => (j === 0 ? 1 : 0.01 * ((i + j) % 3));
        const raw = Array.from({ length: 8 }, (_, j) => (near ? nearAxis(j) : Math.sin(text.length * (j + 1))));
        const norm = Math.hypot(...raw) || 1;
        return raw.map((x) => x / norm);
      });
      response.end(JSON.stringify({ vectors }));
    });
  });
  await new Promise<void>((r) => embedServer.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    RH_LOCAL_EMBED_URL: `http://127.0.0.1:${(embedServer.address() as { port: number }).port}`,
    KAGGLE_USERNAME: "me",
    KAGGLE_API_TOKEN: "tok",
    RH_KAGGLE_POLL_MS: "5",
  });
  const kaggle = fakeKaggle();
  const or = fakeOpenRouter([]);
  let batch = 0;
  const batches = [0, 1].map((b) =>
    fakePapers(12).map((p, i) => ({
      ...p,
      id: `2660.${b}${String(i).padStart(4, "0")}`,
      title: `Ribosome profiling ${b}-${i}`,
    })),
  );
  const server = await startTestServer({
    hub: {
      ticker: false,
      fauxRules: [engineerRule, cardWriterRule],
      jevDecide: scripted(byId({ relevance: score(0.75, 5), matched_question: pick("Q1"), worth: noul(0.9) })).decide,
      paperFetch: (async (input: any, init: any) =>
        (await kaggle.handle(String(input), init)) ??
        (String(input).startsWith("https://openrouter.ai")
          ? or.fetch(input, init)
          : arxivOnlyFetch(batches[batch])(input, init))) as typeof fetch,
    },
  });
  const projectRuntime = server.hub.project;
  try {
    projectRuntime.brief.write("# x");
    projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    projectRuntime.charters.approve();
    await projectRuntime.plugins.kernel.configure("rh.sweep", { cardsPerSweep: 12, explorationPicks: 0 });
    for (const b of [0, 1]) {
      batch = b;
      projectRuntime.db.exec("DELETE FROM metadata_cache");
      projectRuntime.scheduler.trigger("sweep");
      await until(() => projectRuntime.sweeps.list().length === b + 1, 10_000, "sweep");
      await projectRuntime.sweeps.settled(projectRuntime.sweeps.list(1)[0].id, 30_000);
    }
    for (const group of (await server.client.cards(200)).groups)
      for (const c of group.cards) await server.client.judge(c.id, "star");
    // Decoys sharing the question's words: the offline embedder ranks them high, the fine-tuned one does not.
    const { papers: store } = await projectRuntime.plugins.exportsOf<PapersExports>("rh.papers");
    for (let i = 0; i < 30; i++)
      store.store.upsert({
        source: "openalex",
        externalId: `decoy-${i}`,
        ids: { doi: `10.9/decoy.${i}` },
        title: `How do protein LMs transfer to structure decoy ${i}`,
        abstract: "Protein LMs transfer to structure.",
        authors: [],
      } as never);

    const engineer = await projectRuntime.plugins.exportsOf<EngineerExports>("rh.engineer");
    const idea = engineer.propose("Try fine-tuning the embedder on my stars");
    assert.equal((await engineer.settled(idea.id)).assessment!.kind, "embedder-finetune");
    engineer.build(idea.id);
    const built = await engineer.settled(idea.id);
    assert.equal(built.stage, "proposed", JSON.stringify(built.log, null, 1));
    assert.ok(built.log.some((l) => /Training data: 24 question–paper pairs/.test(l.text)));
    assert.ok(built.log.some((l) => /kaggle.com\/code\/me\/x/.test(l.text)));
    assert.equal(built.numbers!.model, `engineer/${idea.id}/model`);
    assert.equal(built.numbers!.dims, 8);
    assert.ok(existsSync(join(server.dataDir, `engineer/${idea.id}/model/1_Pooling/config.json`)));
    assert.ok(!existsSync(join(server.dataDir, `engineer/${idea.id}/model/log.txt`)), "only model/ files");
    const pushed = kaggle.calls.find((c) => c.method === "SaveKernel")!.body;
    assert.match(pushed.text, /MultipleNegativesRankingLoss/);

    await engineer.enable(idea.id);
    assert.equal(projectRuntime.plugins.kernel.settings("rh.papers")["papers.embedder"], "local");
    const { papers } = await projectRuntime.plugins.exportsOf<PapersExports>("rh.papers");
    await until(() => papers.vectors.model === `local/engineer/${idea.id}/model`, 10_000, "embedder switched");
    await until(() => papers.vectors.pending() === 0, 20_000, "re-embedded");
  } finally {
    for (const n of ["RH_LOCAL_EMBED_URL", "KAGGLE_USERNAME", "KAGGLE_API_TOKEN", "RH_KAGGLE_POLL_MS"])
      delete process.env[n];
    await server.stop();
    embedServer.close();
  }
});

test("without a Kaggle token the fine-tune stops and says what to set", async () => {
  const server = await startTestServer({ hub: { fauxRules: [engineerRule] } });
  try {
    const projectRuntime = server.hub.project;
    projectRuntime.brief.write("# x");
    projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    projectRuntime.charters.approve();
    const engineer = await projectRuntime.plugins.exportsOf<EngineerExports>("rh.engineer");
    const idea = engineer.propose("Try fine-tuning the embedder on my stars");
    await engineer.settled(idea.id);
    engineer.build(idea.id);
    const failed = await engineer.settled(idea.id);
    assert.equal(failed.stage, "failed");
    assert.match(failed.log.at(-1)!.text, /set KAGGLE_USERNAME and KAGGLE_API_TOKEN/);
  } finally {
    await server.stop();
  }
});
