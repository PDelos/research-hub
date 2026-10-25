// Spec paper-representations: whole and facet vectors, compute once, similarity, model change (tasks 4.3, 4.4, 4.6).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { JevLedger } from "@rh/jev";
import { ensureVectorTables, openProjectDb, Settings } from "../src/db.ts";
import { PaperStore } from "../src/papers/store.ts";
import { EmbeddingLedger, FakeEmbedder, type Embedder } from "../src/representations/embed.ts";
import { FacetLabeler } from "../src/representations/facets.ts";
import { PaperVectors } from "../src/representations/vectors.ts";
import { scriptedJev } from "./fixtures/scripted-jev.ts";
import { tempDir } from "./helpers.ts";

const JEV_DIR = join(import.meta.dirname, "../prompt_engineering/jev");

/** Counts texts sent to an embedder. */
function counting(inner: Embedder) {
  const sent: string[][] = [];
  return {
    sent,
    embedder: {
      get model() {
        return inner.model;
      },
      get dims() {
        return inner.dims;
      },
      embed: (texts: string[]) => (sent.push(texts), inner.embed(texts)),
    } satisfies Embedder,
  };
}

function setup(dims = 256, embedder?: Embedder) {
  const t = tempDir();
  const { db } = openProjectDb(join(t.dir, "project.sqlite"));
  ensureVectorTables(db, dims);
  const settings = new Settings(db);
  const store = new PaperStore(db);
  const jev = scriptedJev();
  const ledger = new EmbeddingLedger(db);
  const counted = counting(embedder ?? new FakeEmbedder(dims, ledger));
  const facets = new FacetLabeler({ db, jevDir: JEV_DIR, decide: jev.decide, ledger: new JevLedger() });
  const vectors = new PaperVectors({ db, settings, store, embedder: counted.embedder, facets });
  vectors.syncModel();
  let n = 0;
  const add = (title: string, abstract?: string) =>
    store.upsert({
      source: "arxiv",
      externalId: String(++n),
      ids: { arxiv: `2601.${String(n).padStart(5, "0")}` },
      title,
      abstract,
      authors: [],
    }).id;
  return { db, settings, store, jev, counted, facets, vectors, add, ledger, done: () => (db.close(), t.cleanup()) };
}

test("a paper with background, method and result sentences gets four vectors; a missing facet and a title-only paper get fewer", async () => {
  const s = setup();
  try {
    const full = s.add(
      "Contacts for orphan proteins",
      "Orphan proteins lack homologs. We fine-tune ESM-2 with a contact head. Precision improves to 0.74.",
    );
    const noResult = s.add(
      "Gene regulation",
      "Gene regulatory networks are hard to infer. We train a graph neural network on single-cell data.",
    );
    const titleOnly = s.add("A fresh preprint without abstract");
    const result = await s.vectors.represent([full, noResult, titleOnly]);
    assert.deepEqual(result, { represented: 3, skipped: 0, facetFailures: 0 });
    assert.deepEqual(s.vectors.kinds(full), ["background", "method", "result", "whole"]);
    assert.deepEqual(s.vectors.kinds(noResult), ["background", "method", "whole"]);
    assert.deepEqual(s.vectors.kinds(titleOnly), ["whole"]);
    assert.equal(s.store.get(titleOnly)!.titleOnly, true);
    const row = s.db
      .prepare("SELECT model, dims FROM representations WHERE paper_id = ? AND kind = 'whole'")
      .get(full) as any;
    assert.deepEqual({ ...row }, { model: "offline/fake-embedding", dims: 256 });
    assert.equal(s.vectors.vector(full, "whole")!.length, 256);
    assert.equal(s.jev.calls.length, 2, "one Jev call per paper with an abstract");
    assert.equal(s.counted.sent.length, 1, "all texts in one batched embedding request");
    assert.equal(s.counted.sent[0].length, 4 + 3 + 1);
    assert.equal(
      s.counted.sent[0][0],
      "Contacts for orphan proteins\n\nOrphan proteins lack homologs. We fine-tune ESM-2 with a contact head. Precision improves to 0.74.",
    );
  } finally {
    s.done();
  }
});

test("a paper seen again with the current model and command version sends no embedding or Jev request", async () => {
  const s = setup();
  try {
    const id = s.add("Contacts", "Orphan proteins lack homologs. We fine-tune ESM-2. Precision improves.");
    await s.vectors.represent([id]);
    const jevCalls = s.jev.calls.length;
    const embedCalls = s.counted.sent.length;
    assert.deepEqual(await s.vectors.represent([id, id]), { represented: 0, skipped: 1, facetFailures: 0 });
    assert.equal(s.jev.calls.length, jevCalls);
    assert.equal(s.counted.sent.length, embedCalls);
    // Gaining an abstract later (title-only → full) represents the paper again.
    const bare = s.add("Bare title paper");
    await s.vectors.represent([bare]);
    s.store.upsert({
      source: "openalex",
      externalId: "W1",
      ids: { arxiv: "2601.00002", openalex: "W1" },
      title: "Bare title paper",
      abstract: "Now there is background. We propose a method.",
      authors: [],
    });
    assert.equal(s.vectors.isCurrent(s.store.get(bare)!), false);
    await s.vectors.represent([bare]);
    assert.deepEqual(s.vectors.kinds(bare), ["background", "method", "whole"]);
  } finally {
    s.done();
  }
});

test("nearest by topic: k = 8 of 50 papers, ordered by distance, excluding the paper itself", async () => {
  const s = setup();
  try {
    const topics = [
      "protein contact prediction",
      "single-cell gene regulation",
      "drug toxicity screening",
      "cryo-EM density maps",
      "variant effect prediction",
    ];
    const ids: number[] = [];
    for (let i = 0; i < 50; i++) {
      const topic = topics[i % topics.length];
      ids.push(
        s.add(
          `${topic} study ${i}`,
          `We study ${topic} in setting ${i}. We propose model ${i}. Accuracy improves by ${i}%.`,
        ),
      );
    }
    await s.vectors.represent(ids);
    const hits = await s.vectors.similar({ paperId: ids[0] }, { k: 8 });
    assert.equal(hits.length, 8);
    assert.ok(!hits.some((h) => h.paperId === ids[0]));
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i].distance >= hits[i - 1].distance);
    const sameTopic = hits.filter((h) => (h.paperId - ids[0]) % 5 === 0).length;
    assert.ok(sameTopic >= 8, `${sameTopic} of 8 share the topic`);
    const byText = await s.vectors.similar({ text: "cryo-EM density maps" }, { k: 3 });
    assert.ok(byText.every((h) => (h.paperId - ids[3]) % 5 === 0));
    await assert.rejects(s.vectors.similar({ paperId: ids[0] }, { k: 0 }), /k must be 1 to 100/);
  } finally {
    s.done();
  }
});

test("same method, different problem: a method search ranks by method and reports background distance", async () => {
  const s = setup();
  try {
    const anchor = s.add(
      "Protein contacts with transformers",
      "Protein contact maps are needed for folding. We train a graph transformer with attention pooling on residue graphs.",
    );
    const sameMethodOtherProblem = s.add(
      "Cell types with transformers",
      "Single-cell atlases contain unlabeled cell types. We train a graph transformer with attention pooling on cell graphs.",
    );
    const sameProblemOtherMethod = s.add(
      "Protein contacts by coevolution",
      "Protein contact maps are needed for folding. We use a Potts model fitted to multiple sequence alignments by pseudolikelihood.",
    );
    const unrelated = s.add(
      "Hospital staffing",
      "Hospitals struggle with staffing. We use questionnaires to survey nurses.",
    );
    await s.vectors.represent([anchor, sameMethodOtherProblem, sameProblemOtherMethod, unrelated]);
    const hits = await s.vectors.similar({ paperId: anchor }, { by: "method", k: 3 });
    assert.equal(hits[0].paperId, sameMethodOtherProblem, "the same method ranks first");
    const other = hits.find((h) => h.paperId === sameProblemOtherMethod)!;
    assert.ok(
      hits[0].backgroundDistance! > other.backgroundDistance!,
      "but its background is further away than the same-problem paper's",
    );
    assert.ok(hits.every((h) => h.wholeDistance !== undefined));
    // By whole vector the same-problem paper is the nearest instead.
    const byTopic = await s.vectors.similar({ paperId: anchor }, { k: 1 });
    assert.equal(byTopic[0].paperId, sameProblemOtherMethod);
  } finally {
    s.done();
  }
});

test("switching the embedding model clears old vectors, reports pending papers, and re-embeds without mixing models", async () => {
  const t = tempDir();
  const { db } = openProjectDb(join(t.dir, "project.sqlite"));
  try {
    ensureVectorTables(db, 64);
    const settings = new Settings(db);
    const store = new PaperStore(db);
    const jev = scriptedJev();
    const facets = new FacetLabeler({ db, jevDir: JEV_DIR, decide: jev.decide, ledger: new JevLedger() });
    const oldModel = new PaperVectors({ db, settings, store, embedder: new FakeEmbedder(64), facets });
    oldModel.syncModel();
    const ids = [1, 2, 3].map(
      (i) =>
        store.upsert({
          source: "arxiv",
          externalId: `${i}`,
          ids: { arxiv: `2601.0000${i}` },
          title: `Paper ${i}`,
          abstract: `Background ${i}. We propose method ${i}.`,
          authors: [],
        }).id,
    );
    await oldModel.represent(ids);
    const jevBefore = jev.calls.length;

    const other = new FakeEmbedder(32);
    Object.defineProperty(other, "model", { value: "other/embedding-model" });
    const newModel = new PaperVectors({ db, settings, store, embedder: other, facets });
    assert.equal(newModel.syncModel(), true);
    assert.equal(newModel.pending(), 3);
    assert.deepEqual(await newModel.similar({ paperId: ids[0] }), [], "no vectors from the old model are used");
    assert.equal(
      (db.prepare("SELECT COUNT(*) n FROM representations WHERE model != 'other/embedding-model'").get() as any).n,
      0,
    );
    await newModel.represent([ids[0]]);
    assert.equal(newModel.pending(), 2);
    assert.equal(await newModel.catchUp(), 2);
    assert.equal(newModel.pending(), 0);
    assert.equal(jev.calls.length, jevBefore, "facet labels are reused; only embeddings are redone");
    assert.equal(newModel.vector(ids[0], "whole")!.length, 32);
    assert.equal(newModel.syncModel(), false, "no change on the next start");
  } finally {
    db.close();
    t.cleanup();
  }
});
