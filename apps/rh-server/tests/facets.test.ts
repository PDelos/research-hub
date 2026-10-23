// Spec paper-representations: facet labels by Jev (task 4.2).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { JevLedger, loadCommand, renderCommand } from "@rh/jev";
import { openProjectDb } from "../src/db.ts";
import { PaperStore } from "../src/papers/store.ts";
import { FacetLabeler } from "../src/representations/facets.ts";
import { scriptedJev } from "./fixtures/scripted-jev.ts";
import { tempDir } from "./helpers.ts";

const JEV_DIR = join(import.meta.dirname, "../prompt_engineering/jev");

const SIX = [
  "Protein contact prediction is central to structure modeling.",
  "Orphan proteins lack homologs, which limits alignment-based methods.",
  "We fine-tune ESM-2 on 20,000 structures with a contact head.",
  "Our model uses attention maps as pairwise features.",
  "Precision improves from 0.61 to 0.74 on CASP15 targets.",
  "Code is available online.",
].join(" ");

function setup(rule?: Parameters<typeof scriptedJev>[0]) {
  const t = tempDir();
  const { db } = openProjectDb(join(t.dir, "project.sqlite"));
  const jev = scriptedJev(rule);
  const records: any[] = [];
  const store = new PaperStore(db);
  for (let i = 1; i <= 4; i++) store.upsert({ source: "arxiv", externalId: String(i), ids: { arxiv: `2601.0000${i}` }, title: `Paper ${i}`, authors: [] });
  const labeler = new FacetLabeler({ db, jevDir: JEV_DIR, decide: jev.decide, ledger: new JevLedger((r) => records.push(r)) });
  return { db, jev, records, labeler, done: () => (db.close(), t.cleanup()) };
}

test("the abstract-facets command renders one choice per sentence with the sentence in its instructions", () => {
  const cmd = loadCommand("abstract-facets", JEV_DIR);
  const rendered = renderCommand(cmd, { title: "T", sentences: ["A.", "B."] });
  assert.deepEqual(Object.keys(rendered.questions), ["facet_0", "facet_1"]);
  const q = rendered.questions.facet_1 as any;
  assert.equal(q.type, "choice");
  assert.equal(q.instructions.sentence, "B.");
  assert.deepEqual(Object.keys(q.criteria), ["background", "method", "result", "other"]);
  assert.deepEqual(rendered.state, { title: "T", abstract_sentences: ["A.", "B."] });
  assert.equal(cmd.policy.min_confidence, 0.5);
});

test("an abstract with 6 sentences gets one label per sentence from one abstract-facets call, with the version recorded", async () => {
  const s = setup();
  try {
    const labels = await s.labeler.label({ id: 1, title: "Contacts for orphan proteins", abstract: SIX });
    assert.equal(labels.length, 6);
    assert.deepEqual(labels.map((l) => l.facet), ["background", "background", "method", "method", "result", "other"]);
    assert.equal(s.jev.calls.length, 1);
    assert.equal(s.jev.calls[0].sentences.length, 6);
    assert.equal(s.records.length, 1);
    assert.equal(s.records[0].command, "abstract-facets");
    assert.equal(s.records[0].version, 1);
    const rows = s.db.prepare("SELECT facet, command_version FROM facet_labels WHERE paper_id = 1 ORDER BY sentence_index").all() as any[];
    assert.equal(rows.length, 6);
    assert.ok(rows.every((r) => r.command_version === 1));
    assert.deepEqual(s.labeler.stored(1)!.map((l) => l.facet), labels.map((l) => l.facet));
    assert.deepEqual(FacetLabeler.group(labels), {
      background: [SIX.split(". ")[0] + ".", "Orphan proteins lack homologs, which limits alignment-based methods."],
      method: ["We fine-tune ESM-2 on 20,000 structures with a contact head.", "Our model uses attention maps as pairwise features."],
      result: ["Precision improves from 0.61 to 0.74 on CASP15 targets."],
    });
  } finally {
    s.done();
  }
});

test("a sentence labeled method with confidence 0.4 counts as other and is left out of every facet", async () => {
  const s = setup((sentence) => (sentence.startsWith("We fine-tune") ? ["method", 0.4] : ["background", 0.9]));
  try {
    const labels = await s.labeler.label({ id: 2, title: "T", abstract: SIX });
    const uncertain = labels.find((l) => l.sentence.startsWith("We fine-tune"))!;
    assert.equal(uncertain.facet, "other");
    assert.equal(uncertain.chosen, "method");
    assert.equal(uncertain.confidence, 0.4);
    assert.equal(FacetLabeler.group(labels).method, undefined);
  } finally {
    s.done();
  }
});

test("no abstract means no Jev call; very long abstracts are cut at sentence boundaries to fit 30,000 bytes", async () => {
  const s = setup();
  try {
    assert.deepEqual(await s.labeler.label({ id: 3, title: "Only a title" }), []);
    assert.equal(s.jev.calls.length, 0);
    const long = Array.from({ length: 120 }, (_, i) => `Sentence number ${i} describes a long and detailed background of the problem with many words in it.`).join(" ");
    const labels = await s.labeler.label({ id: 4, title: "Long", abstract: long });
    assert.equal(labels.length, 120);
    const asked = s.jev.calls[0].sentences.length;
    assert.ok(asked < 120 && asked > 10, `asked about ${asked} sentences`);
    assert.ok(labels.slice(asked).every((l) => l.facet === "other" && l.confidence === 0));
  } finally {
    s.done();
  }
});
