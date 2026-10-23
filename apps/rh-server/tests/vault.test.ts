// Spec knowledge-vault: layout, charter.md, note names, section-safe appends, index and log (tasks 1.1, 1.2).
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { validateCharter } from "../src/charter.ts";
import { appendUnderHeading, noteStem, slug } from "../src/kb/vault.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { startTestServer, tempDir } from "./helpers.ts";

test("note names: first author's last name, year, first five title words", () => {
  assert.equal(noteStem({ authors: ["Zeming Lin", "Halil Akin"], year: 2023, title: "Evolutionary-scale prediction of atomic-level protein structure with a language model" }), "lin-2023-evolutionary-scale-prediction-of-atomic");
  assert.equal(noteStem({ authors: ["Lin Z", "Akin H"], year: 2023, title: "Short title" }), "lin-2023-short-title");
  assert.equal(noteStem({ authors: ["Müller, Anna"], year: 2021, title: "Über Protein: A Study!" }), "muller-2021-uber-protein-a-study");
  assert.equal(noteStem({ authors: [], title: "No authors" }), "anon-nd-no-authors");
  assert.equal(slug("ESM-2 & Contact Maps", 2), "esm-2");
});

test("appendUnderHeading adds a line at the end of a section and leaves every other line untouched", () => {
  const note = "# T\n\n## Summary\nMy own words.\n\n## Related papers\n- [[a]]\n\n## Notes\nKeep this.\n";
  const out = appendUnderHeading(note, "## Related papers", "- [[b]]");
  assert.equal(out, "# T\n\n## Summary\nMy own words.\n\n## Related papers\n- [[a]]\n- [[b]]\n\n## Notes\nKeep this.\n");
  assert.equal(appendUnderHeading("# T\n\n## Related papers\n", "## Related papers", "- [[x]]"), "# T\n\n## Related papers\n\n- [[x]]\n");
  assert.equal(appendUnderHeading("# T\n\nBody.\n", "## Papers", "- [[x]]"), "# T\n\nBody.\n\n## Papers\n\n- [[x]]\n");
  assert.equal(appendUnderHeading("## Papers\n- one\n### Sub\ntext\n## Next\n", "## Papers", "- two"), "## Papers\n- one\n### Sub\ntext\n- two\n\n## Next\n", "a sub-heading stays inside the section");
});

test("approving a charter creates the vault with the layout, the hub theme and charter.md; a user-edited charter.md is kept", async () => {
  const server = await startTestServer({ hub: { ticker: false } });
  const p = server.hub.project;
  try {
    assert.equal(p.vault.exists(), false, "no vault before a charter is approved");
    p.brief.write("# Protein LMs");
    p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    const res = await fetch(`${server.url}/v1/charter/approve`, { method: "POST", headers: { authorization: "Bearer test-api-token-0123456789", "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    for (const f of ["index.md", "log.md", "charter.md", "sources", "concepts", "questions", ".obsidian/snippets/research-hub.css", ".obsidian/appearance.json"])
      assert.ok(existsSync(join(p.vault.dir, f)), f);
    assert.match(p.vault.read("charter.md")!, /^# Charter \(version 1\)[\s\S]*\*\*Q2\*\* \(weight 1\.5\): Which tasks need fine-tuning\?/);
    assert.equal(JSON.parse(p.vault.read(".obsidian/appearance.json")!).enabledCssSnippets[0], "research-hub");

    // Version 2 refreshes charter.md while untouched; after a user edit it is kept.
    p.charters.saveDraft(validateCharter(sampleCharter({ concepts: ["contact maps"] })), "user");
    p.charters.approve();
    p.syncVault();
    assert.match(p.vault.read("charter.md")!, /version 2/);
    writeFileSync(join(p.vault.dir, "charter.md"), "# My charter notes\n");
    writeFileSync(join(p.vault.dir, ".obsidian/appearance.json"), '{"theme":"obsidian"}');
    p.charters.saveDraft(validateCharter(sampleCharter({ concepts: ["embeddings"] })), "user");
    p.charters.approve();
    p.syncVault();
    p.vault.ensure();
    assert.equal(p.vault.read("charter.md"), "# My charter notes\n", "user edits win");
    assert.equal(p.vault.read(".obsidian/appearance.json"), '{"theme":"obsidian"}', "the user's Obsidian theme choice is kept");
  } finally {
    await server.stop();
  }
});

test("an existing project with an approved charter but no vault gets one at startup; index and log are append-only", async () => {
  const t = tempDir();
  try {
    let server = await startTestServer({ dataDir: t.dir, hub: { ticker: false } });
    const p = server.hub.project;
    p.brief.write("# x");
    p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    p.charters.approve();
    await server.stop();
    server = await startTestServer({ dataDir: t.dir, hub: { ticker: false } });
    try {
      const vault = server.hub.project.vault;
      assert.ok(vault.exists());
      vault.appendIndex("- [[a-2020-one]] · first · core · \"why\"");
      vault.appendIndex("- [[b-2021-two]] · second · advanced · \"why\"");
      vault.appendLog("ingested [[a-2020-one]]");
      const index = vault.read("index.md")!;
      assert.equal(index.match(/^- \[\[/gm)!.length, 2);
      assert.ok(index.startsWith("# Knowledge base"));
      assert.match(vault.read("log.md")!, /^# Log\n\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2} ingested \[\[a-2020-one\]\]\n$/);
      assert.equal(vault.freeStem("a-2020-one"), "a-2020-one");
      writeFileSync(join(vault.dir, "sources", "a-2020-one.md"), "x");
      assert.equal(vault.freeStem("a-2020-one"), "a-2020-one-2");
      assert.equal(vault.create("sources/a-2020-one.md", "y"), false, "never overwrites");
      assert.equal(readFileSync(join(vault.dir, "sources", "a-2020-one.md"), "utf8"), "x");
      assert.deepEqual(vault.markdownFiles(), ["charter.md", "index.md", "log.md", "sources/a-2020-one.md"]);
    } finally {
      await server.stop();
    }
  } finally {
    t.cleanup();
  }
});
