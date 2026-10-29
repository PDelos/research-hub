// Spec knowledge-vault: search from the files, external edits, keyword search, the desk sees the index (task 2.2).
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { call, say, type FauxRule } from "@rh/durable-agent";
import { validateCharter } from "../src/charter.ts";
import { ftsQuery, noteTitle } from "../src/kb/search.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { startTestServer } from "./helpers.ts";

const note = (title: string, body: string) =>
  `---\ntitle: ${JSON.stringify(title)}\nlevel: "core"\n---\n\n## Summary\n\n${body}\n\n## Related papers\n`;

async function withVault(rules?: FauxRule[]) {
  const server = await startTestServer({ hub: { ticker: false, ...(rules ? { fauxRules: rules } : {}) } });
  const projectRuntime = server.hub.project;
  projectRuntime.brief.write("# x");
  projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  projectRuntime.charters.approve();
  projectRuntime.syncVault();
  projectRuntime.vault.create(
    "sources/lin-2023-evolutionary-scale.md",
    note("Evolutionary-scale prediction", "ESM-2 predicts a contact map from attention; contact maps guide folding."),
  );
  projectRuntime.vault.create(
    "sources/rao-2021-msa-transformer.md",
    note("MSA Transformer", "Alignments improve contact precision for Q2 tasks."),
  );
  projectRuntime.vault.create(
    "concepts/protein-language-models.md",
    "# Protein language models\n\n## Papers\n\n- [[lin-2023-evolutionary-scale]]\n",
  );
  projectRuntime.vault.appendIndex('- [[lin-2023-evolutionary-scale]] · ESM-2 and ESMFold · advanced · "foundation"');
  projectRuntime.vault.appendIndex("- [[rao-2021-msa-transformer]] · MSA Transformer for contacts (Q2) · core");
  projectRuntime.kbIndex.sync();
  return { server, p: projectRuntime };
}

test("keyword search ranks notes with an excerpt; rebuilding from the files gives the same results", async () => {
  const { server, p: projectRuntime } = await withVault();
  try {
    const hits = projectRuntime.kbIndex.search("contact map");
    assert.ok(hits.length >= 2);
    assert.equal(hits[0].stem, "lin-2023-evolutionary-scale", "two mentions rank first");
    assert.match(hits[0].excerpt, /\*\*contact\*\* \*\*map/i);
    assert.equal(hits[0].title, "Evolutionary-scale prediction");
    const before = JSON.stringify(hits);
    projectRuntime.db.exec("DELETE FROM kb_fts; DELETE FROM kb_files;");
    assert.deepEqual(projectRuntime.kbIndex.search("contact map"), []);
    projectRuntime.kbIndex.rebuild();
    assert.equal(JSON.stringify(projectRuntime.kbIndex.search("contact map")), before);
    assert.deepEqual(projectRuntime.kbIndex.search('NEAR("x") OR *'), [], "query syntax is never passed through");
    assert.equal(ftsQuery('ESM-2 "contact"'), '"esm" "2" "contact"');
    assert.equal(noteTitle("a/b.md", "# Heading\n"), "Heading");
  } finally {
    await server.stop();
  }
});

test("an external edit (as in Obsidian) is searchable within 10 seconds", async () => {
  const { server, p: projectRuntime } = await withVault();
  try {
    projectRuntime.kbIndex.start();
    const started = Date.now();
    appendFileSync(
      join(projectRuntime.vault.dir, "sources/rao-2021-msa-transformer.md"),
      "\nThe user added: zinc fingers matter.\n",
    );
    writeFileSync(join(projectRuntime.vault.dir, "questions/q9-new-page.md"), "# Q9\n\nAbout zinc fingers too.\n");
    while (projectRuntime.kbIndex.search("zinc fingers").length < 2) {
      if (Date.now() - started > 10_000) throw new Error("not indexed within 10 s");
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(Date.now() - started < 10_000);
  } finally {
    await server.stop();
  }
});

test("the desk always sees the index and opens only the notes it cites", async () => {
  let seen = "";
  const rule: FauxRule = (turn) => {
    if (turn.sections["card-writer"] || turn.sections["librarian"] || turn.sections["charter-writer"]) return undefined;
    seen = turn.sections["knowledge-base-index"] ?? "";
    const q2 = seen.split("\n").find((l) => l.includes("Q2"));
    const stem = q2?.match(/\[\[([^\]]+)\]\]/)?.[1];
    if (!turn.results.length && stem) return call("query_kb", { stem });
    return say(`From the index: ${stem} covers Q2. ${turn.results[0]?.text.split("\n")[0] ?? ""}`);
  };
  const { server, p: projectRuntime } = await withVault([rule]);
  try {
    const sent = await server.client.send("Which knowledge-base papers cover Q2?", { waitMs: 10_000 });
    assert.match(seen, /## Knowledge base index \(2 papers;/);
    assert.match(sent.answer!.text, /rao-2021-msa-transformer covers Q2\. sources\/rao-2021-msa-transformer\.md/);
    const calls = projectRuntime.db.prepare("SELECT tool_name FROM tool_calls").all() as any[];
    assert.deepEqual(
      calls.map((c) => c.tool_name),
      ["query_kb"],
      "only the cited note is opened",
    );
  } finally {
    await server.stop();
  }
});

test("Library API: knowledge-base papers with status, a parsed note, and search", async () => {
  const { parseNote } = await import("../src/routes-kb.ts");
  assert.deepEqual(
    parseNote('---\ntitle: "A: b"\nyear: 2023\nauthors: ["X"]\nraw: plain text\n---\n\n## Summary\n\nHi\n'),
    {
      properties: { title: "A: b", year: 2023, authors: ["X"], raw: "plain text" },
      body: "\n## Summary\n\nHi\n",
    },
  );
  const { server } = await withVault();
  try {
    const note = await server.client.kbNote("lin-2023-evolutionary-scale");
    assert.equal(note.path, "sources/lin-2023-evolutionary-scale.md");
    assert.equal(note.properties.title, "Evolutionary-scale prediction");
    assert.match(note.body, /## Summary/);
    assert.equal((await server.client.kbNote("protein-language-models")).path, "concepts/protein-language-models.md");
    await assert.rejects(server.client.kbNote("missing-note"), /No note missing-note/);
    await assert.rejects(server.client.kbNote("../charter"), /stem must be/);
    const hits = await server.client.kbSearch("contact map");
    assert.equal(hits[0].stem, "lin-2023-evolutionary-scale");
    assert.deepEqual(await server.client.kbPapers(), [], "no starred papers yet");
  } finally {
    await server.stop();
  }
});
