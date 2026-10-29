// The card-writing turn of a sweep (spec paper-cards; design D6): a new ownerless pi-durable conversation per sweep on
// the `desk` model, with three tools. Scores come from code; the agent only writes summaries, which are checked
// against the abstract. Each tool's effect is memoized per call, and cards are unique per paper, so a replay after a
// crash never creates a second card. The sweep completes only when `complete_sweep` has been recorded.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  section,
  type ConversationId,
  type Extension,
  type Harness,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { allowOnly, defineAppTool, loadPrompt, once, toolError, toolText, type ModelCatalog } from "@rh/durable-agent";
import type { Charters } from "../charter.ts";
import type { Db } from "../db.ts";
import type { Logger } from "../logger.ts";
import type { PaperService } from "../papers/service.ts";
import type { Paper } from "../papers/store.ts";
import { CardStore } from "./cards.ts";
import type { PaperDecisions } from "./decisions.ts";
import { computeScores, type ScoreDetails } from "./scores.ts";
import type { CardStage, SweepPaper, SweepRecord, SweepRunner } from "./sweep.ts";

export const CARD_TOOLS = ["list_candidates", "present_paper", "complete_sweep"] as const;
export const SUMMARY_MAX_WORDS = 80;

/** Numbers in a text ("0.74", "12%", "2,000"), normalized for comparison. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, ""));
}

/** Numbers in the summary that do not appear in the title or abstract (an invented result). */
export function ungroundedNumbers(summary: string, source: string): string[] {
  const known = new Set(numbersIn(source));
  return [...new Set(numbersIn(summary))].filter((n) => !known.has(n));
}

export class CardWriter implements CardStage {
  readonly extension: Extension;
  readonly tools: Record<string, unknown>;
  private harness?: Harness;
  private ctx?: Context;
  private readonly watching = new Set<number>();

  constructor(
    private readonly deps: {
      db: Db;
      cards: CardStore;
      runner: SweepRunner;
      papers: PaperService;
      decisions: PaperDecisions;
      charters: Charters;
      catalog: ModelCatalog;
      promptsDir: string;
      log: Logger;
      observe: Extension;
      now?: () => number;
    },
  ) {
    const system = loadPrompt(join(deps.promptsDir, "agents"), "card-writer", "SYSTEM_PROMPT.md", {});
    const list = defineAppTool({
      name: "list_candidates",
      description:
        "List today's ranked candidates with title, abstract, level, kind, matched question and computed scores.",
      returns: "Text: one block per candidate, in rank order.",
      parameters: Type.Object({}),
      execute: async () => {
        const sweep = this.current();
        if (!sweep) return toolError("No sweep is waiting for cards.", ["Stop here."]);
        const blocks = this.candidates(sweep).map(({ sp, paper }) => {
          const scores = this.scores(sweep, sp, paper);
          return [
            `#${paper.id} (rank ${sp.rank}) ${paper.title} (${paper.year ?? "n.d."}) · ${paper.venue ?? paper.server ?? "unknown venue"}`,
            `level ${scores.level} · kind ${sp.kind ?? "other"} · question ${sp.matchedQuestion ?? "none"}${sp.borderline ? " · BORDERLINE" : ""}`,
            `scores: relevance ${scores.relevance}, trust ${scores.trust}, value ${scores.value}`,
            `abstract: ${paper.abstract ? paper.abstract.slice(0, 2000) : "(no abstract)"}`,
          ].join("\n");
        });
        return toolText(blocks.length ? blocks.join("\n\n") : "No candidates.");
      },
    });
    const present = defineAppTool({
      name: "present_paper",
      description: `Present one candidate as a card with your summary (at most ${SUMMARY_MAX_WORDS} words, from its title and abstract only).`,
      returns: "Text: the card that was created, or what to fix.",
      parameters: Type.Object({
        paper_id: Type.Number({ description: "The candidate's id (the number after #)" }),
        summary: Type.String({ description: `At most ${SUMMARY_MAX_WORDS} words, grounded in the abstract` }),
      }),
      execute: async (args, api, context) => {
        const sweep = this.current();
        if (!sweep) return toolError("No sweep is waiting for cards.", ["Stop here."]);
        const entry = this.candidates(sweep, true).find(({ paper }) => paper.id === args.paper_id);
        if (!entry)
          return toolError(`Paper ${args.paper_id} is not a candidate of this sweep.`, [
            "Use an id from list_candidates.",
          ]);
        const summary = args.summary.trim().replace(/\s+/g, " ");
        const words = summary ? summary.split(" ").length : 0;
        if (words < 1 || words > SUMMARY_MAX_WORDS)
          return toolError(`The summary has ${words} words; 1 to ${SUMMARY_MAX_WORDS} are allowed.`, [
            "Shorten it and call present_paper again.",
          ]);
        const invented = ungroundedNumbers(summary, `${entry.paper.title} ${entry.paper.abstract ?? ""}`);
        if (invented.length)
          return toolError(
            `The summary states numbers that are not in the title or abstract: ${invented.join(", ")}.`,
            ["Remove them and describe only what the abstract says."],
          );
        const cardId = await once<number>(api, "card", context, async () => {
          const { card } = this.deps.cards.create({
            paperId: entry.paper.id,
            sweepId: sweep.id,
            rank: entry.sp.rank,
            summary,
            scores: this.scores(sweep, entry.sp, entry.paper),
          });
          this.deps.db
            .prepare("UPDATE sweep_papers SET status = 'presented' WHERE sweep_id = ? AND paper_id = ?")
            .run(sweep.id, entry.paper.id);
          return card.id;
        });
        const card = this.deps.cards.get(cardId)!;
        return toolText(
          `Card #${card.id} for paper ${card.paperId}: relevance ${card.relevance}, trust ${card.trust}, value ${card.value}, ${card.level}${card.borderline ? ", borderline" : ""}.`,
        );
      },
    });
    const complete = defineAppTool({
      name: "complete_sweep",
      description:
        "Finish the sweep after presenting the candidates; list every candidate you did not present with a reason.",
      returns: "Text: the completion record, or which candidates still need a card or a reason.",
      parameters: Type.Object({
        skipped: Type.Optional(
          Type.Array(Type.Object({ paper_id: Type.Number(), reason: Type.String({ minLength: 1, maxLength: 300 }) }), {
            description: "Candidates not presented, each with the reason",
          }),
        ),
      }),
      execute: async (args, api, context) => {
        const sweep = this.current();
        if (!sweep) return toolError("No sweep is waiting for cards.", ["Stop here."]);
        const skipped = (args.skipped ?? []).map((s) => ({ paperId: s.paper_id, reason: s.reason.trim() }));
        const all = this.candidates(sweep, true);
        const open = all.filter(
          ({ sp, paper }) => sp.status !== "presented" && !skipped.some((s) => s.paperId === paper.id && s.reason),
        );
        if (open.length)
          return toolError(
            `Not complete: ${open.map(({ paper }) => `#${paper.id}`).join(", ")} have neither a card nor a skip reason.`,
            ["Present them with present_paper or list them in skipped with a reason."],
          );
        const result = await once<string>(api, "complete", context, async () => {
          const mark = this.deps.db.prepare(
            "UPDATE sweep_papers SET status = 'skipped', reason = ? WHERE sweep_id = ? AND paper_id = ? AND status = 'candidate'",
          );
          for (const s of skipped) mark.run(s.reason, sweep.id, s.paperId);
          const presented = all
            .filter(({ paper }) => this.deps.cards.byPaper(paper.id)?.sweepId === sweep.id)
            .map(({ paper }) => paper.id);
          this.deps.runner.recordCompletion(sweep.id, {
            presented,
            skipped: skipped.filter((s) => all.some(({ paper }) => paper.id === s.paperId)),
          });
          return `Sweep ${sweep.id} complete: ${presented.length} cards, ${skipped.length} skipped.`;
        });
        return toolText(result);
      },
    });
    this.tools = { list, present, complete };
    this.extension = defineExtension({
      name: "card-writer",
      tools: [list, present, complete],
      sections: [section("card-writer", () => system, { tag: false })],
      hooks: [allowOnly("card-writer", CARD_TOOLS)],
    });
  }

  attach(harness: Harness, context: Context): void {
    this.harness = harness;
    this.ctx = context;
  }

  /** The sweep in its cards phase (one sweep runs at a time per project). */
  current(): SweepRecord | undefined {
    const sweep = this.deps.runner.running();
    return sweep?.phase === "cards" ? sweep : undefined;
  }

  private candidates(sweep: SweepRecord, includePresented = false): { sp: SweepPaper; paper: Paper }[] {
    return this.deps.runner
      .papers(sweep.id)
      .filter(
        (sp) =>
          sp.status === "candidate" || (includePresented && (sp.status === "presented" || sp.status === "skipped")),
      )
      .map((sp) => ({ sp, paper: this.deps.papers.store.get(sp.paperId)! }))
      .filter((c) => !!c.paper);
  }

  private scores(sweep: SweepRecord, sp: SweepPaper, paper: Paper) {
    const decisions: ScoreDetails["decisions"] = {};
    for (const name of ["on-theme", "paper-kind", "worth-reading", "level", "importance"] as const) {
      const answers = this.deps.decisions.stored(paper.id, name);
      if (answers) decisions[name] = { version: this.deps.decisions.command(name).version, answers };
    }
    return computeScores(paper, sp, this.deps.runner.charter(), {
      orientation: sweep.orientation,
      now: (this.deps.now ?? Date.now)(),
      decisions,
      hasMethodFacet: this.deps.papers.vectors.kinds(paper.id).includes("method"),
    });
  }

  private ready(): { harness: Harness; ctx: Context } {
    if (!this.harness || !this.ctx) throw new Error("The card writer is not attached to a harness");
    return { harness: this.harness, ctx: this.ctx };
  }

  async start(sweep: SweepRecord): Promise<void> {
    if (sweep.submissionId !== undefined) return this.resume(sweep);
    const { harness, ctx: context } = this.ready();
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: this.deps.catalog.forJob("desk"),
          thinkingLevel: "low",
          extensions: [this.extension, this.deps.observe],
        },
      },
      context,
    );
    const prompt = loadPrompt(join(this.deps.promptsDir, "agents"), "card-writer", "USER_PROMPT_cards.md", {
      sweep_id: String(sweep.id),
      candidates: String(this.candidates(sweep).length),
      stage: sweep.orientation ? "new to the field: foundations first" : "familiar with the field",
    });
    const submission = await conversation.submit(
      { type: "input", content: prompt, requestId: `cards:${sweep.id}` },
      context,
    );
    this.deps.runner.cardsStarted(sweep.id, conversation.id as number, submission.id as number);
    this.deps.log.info("cards.run_started", {
      sweep: sweep.id,
      conversationId: conversation.id,
      submissionId: submission.id,
    });
    this.resume(this.deps.runner.get(sweep.id)!);
  }

  resume(sweep: SweepRecord): void {
    if (sweep.submissionId === undefined || this.watching.has(sweep.id)) return;
    this.watching.add(sweep.id);
    const { harness, ctx: context } = this.ready();
    void (async () => {
      try {
        const submission = await harness.submission(sweep.submissionId as SubmissionId, context);
        if (submission) await submission.wait(context);
        this.settle(sweep.id);
      } catch (error) {
        this.deps.log.warn("cards.watch_failed", { sweep: sweep.id, error: String(error) });
      } finally {
        this.watching.delete(sweep.id);
      }
    })();
  }

  /** Decide a finished turn: completed when complete_sweep was recorded, failed otherwise (cards stay). */
  settle(sweepId: number): void {
    const sweep = this.deps.runner.get(sweepId);
    if (!sweep || sweep.status !== "running") return;
    if (sweep.completion) this.deps.runner.cardsSettled(sweepId, { ok: true });
    else
      this.deps.runner.cardsSettled(sweepId, {
        ok: false,
        reason: "the card writer ended without calling complete_sweep",
      });
  }

  /** The conversation of a sweep's card turn (for the Runs view). */
  conversationOf(sweep: SweepRecord): ConversationId | undefined {
    return sweep.conversationId as ConversationId | undefined;
  }
}
