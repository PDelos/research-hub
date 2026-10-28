// Spec knowledge-vault: evidence notes per ⭐, grounding, connections, index and log, user edits win (task 2.1).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { call, say, type FauxRule } from "@rh/durable-agent";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule, librarianRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { choice, noul, score, scripted } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers, type FakePaper } from "./fixtures/sweep-env.ts";
import { startTestServer, tempDir } from "./helpers.ts";

const passAll = (id: string, _c: string, q: any) =>
  id === "relevance"
    ? score(0.75, 5)
    : id === "matched_question"
      ? choice("Q1", Object.keys(q.criteria))
      : id === "worth"
        ? noul(0.8)
        : id === "generalizable"
          ? noul(0.1)
          : undefined;

async function project(
  papers: FakePaper[],
  rules: FauxRule[] = [cardWriterRule, librarianRule],
  dataDir?: string,
  extra: Record<string, unknown> = {},
) {
  const server = await startTestServer({
    dataDir,
    hub: {
      ticker: false,
      fauxRules: rules,
      jevDecide: scripted(passAll).decide,
      paperFetch: arxivOnlyFetch(papers),
      ...extra,
    },
  });
  const p = server.hub.project;
  if (!p.charters.approved()) {
    p.brief.write("# Protein LMs");
    p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    p.charters.approve();
    p.syncVault();
    p.scheduler.trigger("sweep");
    for (let i = 0; i < 500 && !p.sweeps.list()[0]; i++) await new Promise((r) => setTimeout(r, 10));
    await p.sweeps.settled(p.sweeps.list()[0].id, 30_000);
  }
  return { server, p };
}

const done = async (p: any, n: number, ms = 15_000) => {
  const end = Date.now() + ms;
  while (p.ingest.requests().filter((r: any) => r.status === "done").length < n) {
    if (Date.now() > end) throw new Error(`ingest: ${JSON.stringify(p.ingest.requests())}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("a starred paper becomes one connected evidence note with all properties and sections; index and log grow", async () => {
  const papers = fakePapers(4);
  papers[3].abstract = "Protein language models are widely used. We use attention maps as features.";
  const { server, p } = await project(papers);
  try {
    const cards = p.cards.list();
    p.feedback.judge(cards[0].id, "star", "Exactly the foundation I need");
    await done(p, 1);
    const paper = p.papers.store.get(cards[0].paperId)!;
    const stem = p.ingest.note(paper.id)!;
    assert.match(stem, /^author-2026-paper-\d+-on-protein-language$/);
    const note = p.vault.read(`sources/${stem}.md`)!;
    for (const prop of [
      "title",
      "authors",
      "arxiv",
      "year",
      "venue",
      "level",
      "kind",
      "relevance",
      "trust",
      "value",
      "kb_added",
      "why",
    ])
      assert.match(note, new RegExp(`^${prop}: `, "m"), prop);
    assert.match(note, /^why: "Exactly the foundation I need"$/m);
    for (const h of [
      "Summary",
      "Contributions",
      "Method",
      "Results",
      "Limitations",
      "Open questions",
      "Related papers",
    ])
      assert.match(note, new RegExp(`^## ${h}$`, "m"), h);
    assert.match(note, /## Limitations\n\nNot stated in the abstract/);
    // First paper of a concept: the page is created and links back; the note links to it and to Q1's page.
    const concept =
      p.vault.read("concepts/how-do-protein-lms-transfer-to-structure.md") ??
      p.vault.read("concepts/protein-language-models.md")!;
    assert.ok(concept.includes(`[[${stem}]]`));
    assert.match(note, /- Concept: \[\[protein-language-models\]\]/);
    assert.match(note, /- Question: \[\[q1-how-do-protein-lms-transfer-to\]\]/);
    assert.ok(p.vault.read("questions/q1-how-do-protein-lms-transfer-to.md")!.includes(`[[${stem}]]`));

    // Two more: the index has three paper lines and the log three entries; a paper with no results says so.
    p.feedback.judge(cards[1].id, "star");
    const noResults = cards.find((c) =>
      p.papers.store.get(c.paperId)!.abstract!.startsWith("Protein language models are widely used"),
    )!;
    p.feedback.judge(noResults.id, "star", "simple and clear");
    await done(p, 3);
    const index = p.vault.read("index.md")!;
    assert.equal(index.match(/^- \[\[/gm)!.length, 3);
    assert.match(
      index,
      /- \[\[author-2026-paper-\d+-on-protein-language\]\] · .+ · advanced · "Exactly the foundation I need"/,
    );
    assert.equal(p.vault.read("log.md")!.match(/ingested \[\[/g)!.length, 3);
    const plain = p.vault.read(`sources/${p.ingest.note(noResults.paperId)}.md`)!;
    assert.match(plain, /## Results\n\nNot stated in the abstract/);
    assert.equal((p.db.prepare("SELECT COUNT(*) n FROM kb_notes").get() as any).n, 3);
    const library = await server.client.kbPapers();
    assert.equal(library.length, 3);
    assert.ok(library.every((x) => x.status === "done" && x.stem && x.level));
    assert.equal(library.find((x) => x.paperId === cards[0].paperId)!.reason, "Exactly the foundation I need");
  } finally {
    await server.stop();
  }
});

test("an invented number is refused; an edited note keeps the user's Summary when a later paper links to it", async () => {
  let tried = false;
  const strict: FauxRule = (turn) => {
    if (!turn.sections["librarian"]) return undefined;
    if (!tried) {
      tried = true;
      return call("write_evidence_note", {
        summary: "Improves accuracy by 99%.",
        contributions: "x",
        method: "x",
        results: "x",
        limitations: "x",
        open_questions: "x",
      });
    }
    if (turn.results.some((r) => r.name === "link_note" && !r.isError)) return say("ok");
    if (turn.results.some((r) => r.name === "write_evidence_note" && !r.isError)) {
      const notes = turn.lastUser
        .match(/^EXISTING_NOTES: (.*)$/m)![1]
        .split("; ")
        .filter((n) => n !== "(none yet)");
      return call("link_note", { concepts: ["protein language models"], related: notes });
    }
    return librarianRule(turn);
  };
  const { server, p } = await project(fakePapers(3), [cardWriterRule, strict]);
  try {
    const cards = p.cards.list();
    p.feedback.judge(cards[0].id, "star");
    await done(p, 1);
    const first = p.ingest.note(cards[0].paperId)!;
    const view = JSON.stringify(
      p.db.prepare("SELECT result_text FROM tool_calls WHERE tool_name = 'write_evidence_note'").all(),
    );
    assert.match(view, /numbers not in the title, abstract, full text or reason: 99/);
    // The user rewrites the Summary in Obsidian.
    const path = join(p.vault.dir, "sources", `${first}.md`);
    const edited = readFileSync(path, "utf8").replace(/## Summary\n\n[^\n]*/, "## Summary\n\nMy own summary, keep it.");
    writeFileSync(path, edited);
    p.feedback.judge(cards[1].id, "star");
    await done(p, 2);
    const after = readFileSync(path, "utf8");
    const second = p.ingest.note(cards[1].paperId)!;
    assert.match(after, /## Summary\n\nMy own summary, keep it\./);
    assert.equal(after, `${edited.trimEnd()}\n- [[${second}]]\n`, "only one line was added, under Related papers");
  } finally {
    await server.stop();
  }
});

test("a crash during the librarian's turn: after restart the ingest completes with exactly one note", async () => {
  const t = tempDir();
  try {
    const papers = fakePapers(2);
    const first = await project(papers, [cardWriterRule, librarianRule], t.dir, { fauxTokensPerSecond: 30 });
    const card = first.p.cards.list()[0];
    first.p.feedback.judge(card.id, "star", "great");
    for (let i = 0; i < 500 && !first.p.ingest.note(card.paperId); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(first.p.ingest.note(card.paperId), "the note was written before the crash");
    await first.server.stop();
    const second = await project(papers, [cardWriterRule, librarianRule], t.dir);
    try {
      await done(second.p, 1);
      assert.equal((second.p.db.prepare("SELECT COUNT(*) n FROM kb_notes").get() as any).n, 1);
      assert.equal(second.p.vault.markdownFiles().filter((f) => f.startsWith("sources/")).length, 1);
      assert.equal(second.p.vault.read("index.md")!.match(/^- \[\[/gm)!.length, 1);
    } finally {
      await second.server.stop();
    }
  } finally {
    t.cleanup();
  }
});
