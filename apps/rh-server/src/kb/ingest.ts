// Ingest (spec knowledge-vault; design D2): each pending ⭐ request becomes one evidence note written by the
// librarian (an ownerless pi-durable conversation on the `reader` model). Code owns the file name, the properties,
// the backlinks, the index line and the log entry; the librarian writes only the sections and chooses the links.
// A paper counts as ingested only when its note links to a concept or question page that links back.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, section, type Extension, type Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { allowOnly, defineAppTool, loadPrompt, once, toolError, toolText, type ModelCatalog } from "@rh/durable-agent";
import type { Charters } from "../charter.ts";
import { nowIso, type Db } from "../db.ts";
import type { Feedback } from "../feedback/feedback.ts";
import type { Logger } from "../logger.ts";
import type { Paper, PaperStore } from "../papers/store.ts";
import { ungroundedNumbers } from "../sweep/card-writer.ts";
import type { CardStore } from "../sweep/cards.ts";
import { noteStem, slug, type Vault } from "./vault.ts";

export const LIBRARIAN_TOOLS = ["write_evidence_note", "link_note"] as const;
export const NOT_STATED = "Not stated in the abstract";
export const SECTIONS = [
  ["summary", "Summary"],
  ["contributions", "Contributions"],
  ["method", "Method"],
  ["results", "Results"],
  ["limitations", "Limitations"],
  ["open_questions", "Open questions"],
] as const;
export const MAX_ATTEMPTS = 3;
export const RETRY_MS = 60_000;

export interface KbRequest {
  paperId: number;
  cardId: number;
  status: "pending" | "cancelled" | "done" | "failed";
  attempts: number;
  nextAttemptAt?: number;
  reason?: string;
  conversationId?: number;
  submissionId?: number;
}

const yaml = (v: unknown) => JSON.stringify(v);

export class Ingest {
  readonly extension: Extension;
  private harness?: Harness;
  private ctx?: Context;
  private timer?: ReturnType<typeof setTimeout>;
  private watching = new Set<number>();
  private closed = false;
  /** A start in progress (one librarian turn at a time; pickUp calls during it are folded into one more pass). */
  private starting?: Promise<void>;
  private again = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly deps: {
      db: Db;
      vault: Vault;
      store: PaperStore;
      cards: CardStore;
      feedback: Feedback;
      charters: Charters;
      catalog: ModelCatalog;
      promptsDir: string;
      log: Logger;
      observe: Extension;
      now?: () => number;
      retryMs?: number;
    },
  ) {
    const system = loadPrompt(join(deps.promptsDir, "agents"), "librarian", "SYSTEM_PROMPT.md", {});
    const sectionText = (d: string) => Type.String({ description: d });
    const write = defineAppTool({
      name: "write_evidence_note",
      description: `Write the starred paper's evidence note. Every section is required; a section the abstract does not support reads exactly "${NOT_STATED}".`,
      returns: "Text: the note's name, or what to fix.",
      parameters: Type.Object({
        summary: sectionText("Two or three sentences: what the paper does and why it matters for the project"),
        contributions: sectionText("What is new"),
        method: sectionText("How they did it"),
        results: sectionText("What they found"),
        limitations: sectionText("Stated limitations"),
        open_questions: sectionText("Questions the paper leaves open"),
      }),
      execute: async (args, api, ctx) => {
        const request = this.active();
        if (!request) return toolError("No paper is being ingested.", ["Stop here."]);
        const paper = this.deps.store.get(request.paperId)!;
        const existing = this.note(paper.id);
        if (existing) return toolText(`The note ${existing} already exists; now call link_note.`);
        const sections = args as Record<(typeof SECTIONS)[number][0], string>;
        const problems: string[] = [];
        for (const [key] of SECTIONS) if (!sections[key]?.trim()) problems.push(`${key} is empty (write "${NOT_STATED}" if the abstract says nothing about it)`);
        const reason = this.deps.feedback.get(request.cardId)?.reason ?? "";
        const source = `${paper.title} ${paper.abstract ?? ""} ${reason}`;
        const invented = ungroundedNumbers(SECTIONS.map(([k]) => sections[k] ?? "").join(" "), source);
        if (invented.length) problems.push(`numbers not in the title, abstract or reason: ${invented.join(", ")}`);
        if (problems.length) return toolError(`The note was not written: ${problems.join("; ")}.`, ["Fix exactly these and call write_evidence_note again."]);
        const stem = await once<string>(api, "note", ctx, async () => this.writeNote(paper, request, sections));
        return toolText(`Wrote sources/${stem}.md. Now call link_note with at least one concept or research question.`);
      },
    });
    const link = defineAppTool({
      name: "link_note",
      description: "Connect the new note: concepts (short noun phrases), research question ids (Q1…), and optionally existing notes it relates to.",
      returns: "Text: the pages linked, or what to fix.",
      parameters: Type.Object({
        concepts: Type.Optional(Type.Array(Type.String({ minLength: 2, maxLength: 80 }), { maxItems: 5 })),
        questions: Type.Optional(Type.Array(Type.String(), { maxItems: 7 })),
        related: Type.Optional(Type.Array(Type.String(), { maxItems: 5, description: "Stems of existing notes" })),
      }),
      execute: async (args, api, ctx) => {
        const request = this.active();
        if (!request) return toolError("No paper is being ingested.", ["Stop here."]);
        const stem = this.note(request.paperId);
        if (!stem) return toolError("There is no note yet.", ["Call write_evidence_note first."]);
        const charter = this.deps.charters.approved()?.charter;
        const questions = (args.questions ?? []).map((q) => q.trim().toUpperCase()).filter((q) => charter?.questions.some((x) => x.id === q));
        const concepts = (args.concepts ?? []).map((c) => c.trim()).filter((c) => slug(c));
        if (!questions.length && !concepts.length)
          return toolError("Nothing to link: give at least one concept or a research question id from the list.", ["Call link_note again."]);
        const result = await once<string>(api, "link", ctx, async () => this.link(stem, concepts, questions, args.related ?? []));
        this.tryComplete(request.paperId);
        return toolText(result);
      },
    });
    this.extension = defineExtension({
      name: "librarian",
      tools: [write, link],
      sections: [section("librarian", () => system, { tag: false })],
      hooks: [allowOnly("librarian", LIBRARIAN_TOOLS)],
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attach(harness: Harness, ctx: Context): void {
    this.harness = harness;
    this.ctx = ctx;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  requests(): KbRequest[] {
    return (this.deps.db.prepare("SELECT * FROM kb_requests ORDER BY created_at").all() as any[]).map(toRequest);
  }

  /** The request whose librarian turn is running (one at a time). */
  private active(): KbRequest | undefined {
    const row = this.deps.db.prepare("SELECT * FROM kb_requests WHERE status = 'pending' AND submission_id IS NOT NULL ORDER BY created_at LIMIT 1").get();
    return row ? toRequest(row) : undefined;
  }

  note(paperId: number): string | undefined {
    return (this.deps.db.prepare("SELECT stem FROM kb_notes WHERE paper_id = ?").get(paperId) as { stem: string } | undefined)?.stem;
  }

  /** Start or resume work: re-attach to a running turn, otherwise start the next due request. */
  pickUp(): void {
    if (this.closed || !this.harness || !this.deps.vault.exists()) return;
    if (this.starting) {
      this.again = true;
      return;
    }
    const active = this.active();
    if (active) {
      this.watch(active);
      return;
    }
    const next = this.deps.db
      .prepare("SELECT * FROM kb_requests WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT 1")
      .get(this.now());
    if (next) {
      this.starting = this.start(toRequest(next))
        .catch((error) => this.deps.log.error("kb.ingest_start_failed", { error: String(error) }))
        .finally(() => {
          this.starting = undefined;
          if (this.again) {
            this.again = false;
            this.pickUp();
          }
        });
      return;
    }
    const later = this.deps.db.prepare("SELECT MIN(next_attempt_at) at FROM kb_requests WHERE status = 'pending'").get() as { at: number | null };
    if (later.at !== null && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pickUp();
      }, Math.max(0, Number(later.at) - this.now()));
      this.timer.unref?.();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async start(request: KbRequest): Promise<void> {
    if (!this.harness || !this.ctx) return;
    // A note may already exist and be connected (a crash before the request was marked done).
    if (this.tryComplete(request.paperId)) {
      queueMicrotask(() => this.pickUp());
      return;
    }
    const paper = this.deps.store.get(request.paperId)!;
    const card = this.deps.cards.get(request.cardId);
    const charter = this.deps.charters.approved()!.charter;
    const prompt = loadPrompt(join(this.deps.promptsDir, "agents"), "librarian", "USER_PROMPT_ingest.md", {
      title: paper.title,
      authors: paper.authors.slice(0, 8).join(", ") || "unknown",
      year: String(paper.year ?? "unknown"),
      venue: paper.venue ?? paper.server ?? "unknown",
      level: card?.level ?? "unknown",
      matched_question: card?.matchedQuestion ?? "none",
      reason: this.deps.feedback.get(request.cardId)?.reason ?? "(none)",
      abstract: paper.abstract ?? "(no abstract)",
      questions: charter.questions.map((q) => `${q.id}: ${q.text}`).join("\n"),
      concepts: this.existing("concepts").join("; ") || "(none yet)",
      charter_concepts: charter.concepts.join("; "),
      notes: this.existing("sources").slice(-30).join("; ") || "(none yet)",
    });
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: this.deps.catalog.forJob("reader"), thinkingLevel: "low", extensions: [this.extension, this.deps.observe] },
      },
      this.ctx,
    );
    const submission = await conversation.submit({ type: "input", content: prompt, requestId: `ingest:${paper.id}:${request.attempts + 1}` }, this.ctx);
    this.deps.db
      .prepare("UPDATE kb_requests SET conversation_id = ?, submission_id = ?, updated_at = ? WHERE paper_id = ?")
      .run(conversation.id as number, submission.id as number, nowIso(), paper.id);
    this.deps.log.info("kb.ingest_started", { paperId: paper.id, attempt: request.attempts + 1 });
    this.watch(toRequest(this.deps.db.prepare("SELECT * FROM kb_requests WHERE paper_id = ?").get(paper.id)));
  }

  private watch(request: KbRequest): void {
    if (request.submissionId === undefined || this.watching.has(request.paperId) || !this.harness || !this.ctx) return;
    this.watching.add(request.paperId);
    const { harness, ctx } = this;
    void (async () => {
      try {
        const submission = await harness.submission(request.submissionId as SubmissionId, ctx);
        if (submission) await submission.wait(ctx);
        this.settle(request.paperId);
      } catch (error) {
        this.deps.log.warn("kb.ingest_watch_failed", { paperId: request.paperId, error: String(error) });
      } finally {
        this.watching.delete(request.paperId);
        if (!this.closed) queueMicrotask(() => this.pickUp());
      }
    })();
  }

  /** After the librarian's turn: done when connected; otherwise retry later, up to 3 attempts. */
  settle(paperId: number): void {
    const row = this.deps.db.prepare("SELECT * FROM kb_requests WHERE paper_id = ?").get(paperId);
    if (!row) return;
    const request = toRequest(row);
    if (request.status !== "pending") return;
    if (this.tryComplete(paperId)) return;
    const attempts = request.attempts + 1;
    const reason = this.note(paperId) ? "the note is not linked to a concept or question yet" : "the librarian did not write the note";
    const failed = attempts >= MAX_ATTEMPTS;
    this.deps.db
      .prepare("UPDATE kb_requests SET attempts = ?, status = ?, reason = ?, next_attempt_at = ?, submission_id = NULL, updated_at = ? WHERE paper_id = ?")
      .run(attempts, failed ? "failed" : "pending", reason, failed ? null : this.now() + (this.deps.retryMs ?? RETRY_MS), nowIso(), paperId);
    this.deps.log.warn("kb.ingest_incomplete", { paperId, attempts, failed, reason });
    this.emit();
  }

  /** Mark the request done if the note exists and is connected; appends the index line and the log entry once. */
  tryComplete(paperId: number): boolean {
    const stem = this.note(paperId);
    const request = this.deps.db.prepare("SELECT status, card_id FROM kb_requests WHERE paper_id = ?").get(paperId) as
      | { status: string; card_id: number }
      | undefined;
    if (!stem || !request || request.status === "done") return request?.status === "done";
    if (!this.connected(stem)) return false;
    const paper = this.deps.store.get(paperId)!;
    const summary = (this.deps.db.prepare("SELECT summary FROM kb_notes WHERE paper_id = ?").get(paperId) as { summary: string | null }).summary ?? "";
    const level = this.deps.cards.get(Number(request.card_id))?.level ?? "unknown";
    const reason = this.deps.feedback.get(Number(request.card_id))?.reason;
    this.deps.vault.appendIndex(`- [[${stem}]] · ${summary} · ${level}${reason ? ` · "${reason.replace(/\s+/g, " ")}"` : ""}`);
    this.deps.vault.appendLog(`ingested [[${stem}]] (${paper.title})`);
    this.deps.db
      .prepare("UPDATE kb_requests SET status = 'done', submission_id = NULL, reason = NULL, updated_at = ? WHERE paper_id = ?")
      .run(nowIso(), paperId);
    this.deps.log.info("kb.ingested", { paperId, stem });
    this.emit();
    return true;
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

  private existing(folder: "concepts" | "sources"): string[] {
    return this.deps.vault
      .markdownFiles()
      .filter((f) => f.startsWith(`${folder}/`))
      .map((f) => f.slice(folder.length + 1, -3));
  }

  private writeNote(paper: Paper, request: KbRequest, sections: Record<string, string>): string {
    const card = this.deps.cards.get(request.cardId);
    const judgment = this.deps.feedback.get(request.cardId);
    const stem = this.deps.vault.freeStem(noteStem(paper));
    const props: [string, unknown][] = [
      ["title", paper.title],
      ["authors", paper.authors.slice(0, 10)],
      ...(Object.entries(paper.ids) as [string, string][]).filter(([k]) => k !== "s2"),
      ["year", paper.year ?? null],
      ["venue", paper.venue ?? paper.server ?? null],
      ["level", card?.level ?? null],
      ["kind", (this.deps.db.prepare("SELECT kind FROM sweep_papers WHERE paper_id = ? AND kind IS NOT NULL LIMIT 1").get(paper.id) as { kind: string } | undefined)?.kind ?? null],
      ["relevance", card?.relevance ?? null],
      ["trust", card?.trust ?? null],
      ["value", card?.value ?? null],
      ["kb_added", new Date(this.now()).toISOString().slice(0, 10)],
      ["why", judgment?.reason ?? ""],
      ["link", paper.ids.doi ? `https://doi.org/${paper.ids.doi}` : (paper.url ?? null)],
    ];
    const front = props.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${yaml(v)}`).join("\n");
    const body = SECTIONS.map(([key, heading]) => `## ${heading}\n\n${sections[key].trim()}\n`).join("\n");
    this.deps.vault.create(`sources/${stem}.md`, `---\n${front}\n---\n\n${body}\n## Related papers\n`);
    const summary = sections.summary.trim().split(/(?<=[.!?])\s+/)[0].slice(0, 200);
    this.deps.db.prepare("INSERT OR IGNORE INTO kb_notes (paper_id, stem, summary, created_at) VALUES (?, ?, ?, ?)").run(paper.id, stem, summary, nowIso());
    return this.note(paper.id)!;
  }

  private link(stem: string, concepts: string[], questions: string[], related: string[]): string {
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
      const q = charter.questions.find((x) => x.id === id)!;
      const page = `${id.toLowerCase()}-${slug(q.text, 6)}`;
      ensurePage(`questions/${page}.md`, `${id}: ${q.text}`);
      vault.appendUnderHeading(`sources/${stem}.md`, "## Related papers", `- Question: [[${page}]]`);
      linked.push(`questions/${page}`);
    }
    // Existing related notes gain a line under their own Related papers; nothing else in them changes.
    for (const other of related) {
      const rel = `sources/${other.replace(/\.md$/, "")}.md`;
      if (other === stem || !vault.read(rel)) continue;
      if (!(vault.read(rel) ?? "").includes(`[[${stem}]]`)) vault.appendUnderHeading(rel, "## Related papers", `- [[${stem}]]`);
      vault.appendUnderHeading(`sources/${stem}.md`, "## Related papers", `- [[${other.replace(/\.md$/, "")}]]`);
      linked.push(rel.slice(0, -3));
    }
    return `Linked [[${stem}]] with ${linked.join(", ")}.`;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

function toRequest(r: any): KbRequest {
  return {
    paperId: Number(r.paper_id),
    cardId: Number(r.card_id),
    status: r.status,
    attempts: Number(r.attempts ?? 0),
    nextAttemptAt: r.next_attempt_at === null || r.next_attempt_at === undefined ? undefined : Number(r.next_attempt_at),
    reason: r.reason ?? undefined,
    conversationId: r.conversation_id === null || r.conversation_id === undefined ? undefined : Number(r.conversation_id),
    submissionId: r.submission_id === null || r.submission_id === undefined ? undefined : Number(r.submission_id),
  };
}
