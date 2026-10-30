// Evidence notes in the vault (spec knowledge-vault; design D2): code writes each note's file name, properties and
// backlinks; the librarian supplies the sections and chooses the links.
import type { Charters } from "../charter.ts";
import { nowIso, type Db } from "../db.ts";
import type { Feedback } from "../feedback/feedback.ts";
import type { Paper } from "../papers/store.ts";
import type { CardStore } from "../sweep/cards.ts";
import { noteStem, slug, type Vault } from "./vault.ts";

/** The sections of an evidence note, in order: key and heading. */
export const SECTIONS = [
  ["summary", "Summary"],
  ["contributions", "Contributions"],
  ["method", "Method"],
  ["results", "Results"],
  ["limitations", "Limitations"],
  ["open_questions", "Open questions"],
] as const;

const yaml = (v: unknown) => JSON.stringify(v);

export class EvidenceNotes {
  constructor(
    private readonly deps: {
      db: Db;
      vault: Vault;
      cards: CardStore;
      feedback: Feedback;
      charters: Charters;
      now: () => number;
    },
  ) {}

  /** The stem of a paper's note, once it is written. */
  stem(paperId: number): string | undefined {
    return (
      this.deps.db.prepare("SELECT stem FROM kb_notes WHERE paper_id = ?").get(paperId) as { stem: string } | undefined
    )?.stem;
  }

  /** The note links to at least one concept or question page that exists and links back. */
  connected(stem: string): boolean {
    const text = this.deps.vault.read(`sources/${stem}.md`) ?? "";
    for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const target = m[1].trim();
      for (const folder of ["concepts", "questions"]) {
        const page = this.deps.vault.read(`${folder}/${target.replace(/^(concepts|questions)\//, "")}.md`);
        if (page?.includes(`[[${stem}]]`)) return true;
      }
    }
    return false;
  }

  existing(folder: "concepts" | "sources"): string[] {
    return this.deps.vault
      .markdownFiles()
      .filter((f) => f.startsWith(`${folder}/`))
      .map((f) => f.slice(folder.length + 1, -3));
  }

  /** Write a paper's note under sources/ and index it; returns its stem. */
  write(paper: Paper, cardId: number, sections: Record<string, string>): string {
    const stem = this.deps.vault.freeStem(noteStem(paper));
    const front = this.frontMatter(paper, cardId);
    const body = SECTIONS.map(([key, heading]) => `## ${heading}\n\n${sections[key].trim()}\n`).join("\n");
    this.deps.vault.create(`sources/${stem}.md`, `---\n${front}\n---\n\n${body}\n## Related papers\n`);
    const first = sections.summary.trim().split(/(?<=[.!?])\s+/)[0];
    const summary = first.length <= 200 ? first : `${first.slice(0, 200).replace(/\s+\S*$/, "")}…`;
    this.deps.db
      .prepare("INSERT OR IGNORE INTO kb_notes (paper_id, stem, summary, created_at) VALUES (?, ?, ?, ?)")
      .run(paper.id, stem, summary, nowIso());
    return this.stem(paper.id)!;
  }

  /** The note's properties: identifiers, the card's scores, when it was added, and why the user kept it. */
  private frontMatter(paper: Paper, cardId: number): string {
    const card = this.deps.cards.get(cardId);
    const judgment = this.deps.feedback.get(cardId);
    const kind = this.deps.db
      .prepare("SELECT kind FROM sweep_papers WHERE paper_id = ? AND kind IS NOT NULL LIMIT 1")
      .get(paper.id) as { kind: string } | undefined;
    // Missing values (null or undefined) are left out.
    const props: [string, unknown][] = [
      ["title", paper.title],
      ["authors", paper.authors.slice(0, 10)],
      ...(Object.entries(paper.ids) as [string, string][]).filter(([k]) => k !== "s2"),
      ["year", paper.year],
      ["venue", paper.venue ?? paper.server],
      ["level", card?.level],
      ["kind", kind?.kind],
      ["relevance", card?.relevance],
      ["trust", card?.trust],
      ["value", card?.value],
      ["kb_added", new Date(this.deps.now()).toISOString().slice(0, 10)],
      ["why", judgment?.reason ?? ""],
      ["link", paper.ids.doi ? `https://doi.org/${paper.ids.doi}` : paper.url],
    ];
    return props
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}: ${yaml(v)}`)
      .join("\n");
  }

  /** Link the note to concept and question pages (created when missing) and to related notes, both ways. */
  link(stem: string, concepts: string[], questions: string[], related: string[]): string {
    const { vault } = this.deps;
    const charter = this.deps.charters.approved()!.charter;
    const linked: string[] = [];
    const backlink = `- [[${stem}]]`;
    const ensurePage = (rel: string, title: string) => {
      if (vault.create(rel, `# ${title}\n\n## Papers\n\n${backlink}\n`)) return;
      if (!(vault.read(rel) ?? "").includes(`[[${stem}]]`)) vault.appendUnderHeading(rel, "## Papers", backlink);
    };
    for (const concept of concepts) {
      const page = slug(concept);
      ensurePage(`concepts/${page}.md`, concept.charAt(0).toUpperCase() + concept.slice(1));
      vault.appendUnderHeading(`sources/${stem}.md`, "## Related papers", `- Concept: [[${page}]]`);
      linked.push(`concepts/${page}`);
    }
    for (const id of questions) {
      const charterQuestion = charter.questions.find((x) => x.id === id)!;
      const page = `${id.toLowerCase()}-${slug(charterQuestion.text, 6)}`;
      ensurePage(`questions/${page}.md`, `${id}: ${charterQuestion.text}`);
      vault.appendUnderHeading(`sources/${stem}.md`, "## Related papers", `- Question: [[${page}]]`);
      linked.push(`questions/${page}`);
    }
    // Existing related notes gain a line under their own Related papers; nothing else in them changes.
    for (const other of related) {
      const rel = `sources/${other.replace(/\.md$/, "")}.md`;
      if (other === stem || !vault.read(rel)) continue;
      if (!(vault.read(rel) ?? "").includes(`[[${stem}]]`))
        vault.appendUnderHeading(rel, "## Related papers", `- [[${stem}]]`);
      vault.appendUnderHeading(`sources/${stem}.md`, "## Related papers", `- [[${other.replace(/\.md$/, "")}]]`);
      linked.push(rel.slice(0, -3));
    }
    return `Linked [[${stem}]] with ${linked.join(", ")}.`;
  }
}
