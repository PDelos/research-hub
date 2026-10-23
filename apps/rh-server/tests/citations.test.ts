// Spec paper-representations: citation links and the pair report (task 4.5).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectDb } from "../src/db.ts";
import { PaperStore } from "../src/papers/store.ts";
import { Citations } from "../src/representations/citations.ts";
import { tempDir } from "./helpers.ts";

test("shared references, direct citation and co-citation", () => {
  const t = tempDir();
  const { db } = openProjectDb(join(t.dir, "project.sqlite"));
  try {
    const store = new PaperStore(db);
    const add = (w: string, references: string[] = []) =>
      store.upsert({ source: "openalex", externalId: w, ids: { openalex: w }, title: `Work ${w}`, authors: [], references }).id;
    // A cites B; both reference W10, W11, W12; C and D cite both A and B.
    const a = add("W1", ["W2", "W10", "W11", "W12", "W13"]);
    const b = add("W2", ["W10", "W11", "W12", "W14"]);
    add("W3", ["W1", "W2"]);
    add("W4", ["https://openalex.org/W1", "W2", "W99"]);
    const citations = new Citations(db);
    assert.deepEqual(citations.report(a, b), { aCitesB: true, bCitesA: false, sharedReferences: 3, coCitedBy: 2 });
    assert.deepEqual(citations.report(b, a), { aCitesB: false, bCitesA: true, sharedReferences: 3, coCitedBy: 2 });
    assert.deepEqual(citations.references(a), [b]);
    assert.equal(citations.citedBy(a).length, 2);
  } finally {
    db.close();
    t.cleanup();
  }
});
