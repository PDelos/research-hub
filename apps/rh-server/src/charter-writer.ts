// The charter writer: a second, ownerless conversation on the `review` model that drafts and revises the charter.
// Its two tools record into project.sqlite at most once per tool call (a replay finds the memo). One drafting run =
// one submission; when it settles without a saved draft, or after 3 invalid saves, the run is marked failed.
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
import {
  Brief,
  CharterInvalid,
  Charters,
  MAX_SCOPING_QUESTIONS,
  ScopingQuestions,
  validateCharter,
} from "./charter.ts";
import { nowIso, Settings } from "./db.ts";
import type { Logger } from "./logger.ts";

export const CHARTER_TOOLS = ["save_charter_draft", "ask_scoping_questions"] as const;
export const MAX_INVALID_SAVES = 3;

export interface CharterRun {
  id: number;
  kind: "draft" | "revision";
  status: "running" | "done" | "failed";
  reason?: string;
  submissionId?: number;
  round: number;
  invalidSaves: number;
  saved: boolean;
  startedAt: string;
  endedAt?: string;
  /** The prompt the run was started with, so a retry repeats it. */
  prompt: string;
}

export class CharterBusy extends Error {
  constructor() {
    super("A charter run is already in progress");
    this.name = "CharterBusy";
  }
}

// The schema tells the model the shape; counts and lengths are checked by validateCharter, whose messages are exact.
const weighted = Type.Union([
  Type.String(),
  Type.Object({ text: Type.String(), weight: Type.Optional(Type.Number({ description: "0.1 to 2, default 1" })) }),
]);
const strings = (description: string) => Type.Array(Type.String(), { description });

export class CharterWriter {
  readonly extension: Extension;
  /** The tool registrations, exposed for replay tests. */
  readonly tools: { save: any; ask: any };
  private harness?: Harness;
  private ctx?: Context;
  private watching = new Set<number>();

  constructor(
    private readonly deps: {
      settings: Settings;
      charters: Charters;
      questions: ScopingQuestions;
      brief: Brief;
      catalog: ModelCatalog;
      promptsDir: string;
      log: Logger;
      observe: Extension;
    },
  ) {
    const agentsDir = join(deps.promptsDir, "agents");
    const system = loadPrompt(agentsDir, "charter-writer", "SYSTEM_PROMPT.md", {});
    const save = defineAppTool({
      name: "save_charter_draft",
      description:
        "Save the complete charter draft: questions (3-7, {text, weight?}), concepts (1-30), subAreas (1-15), queries (5-20, text or {text, weight?}), outOfScope (0-20). Errors name exactly what to fix.",
      returns: "Text: the saved draft summary, or the exact rule violations to fix.",
      parameters: Type.Object({
        questions: Type.Array(weighted, { description: "3 to 7 research questions" }),
        concepts: strings("1 to 30 key concepts"),
        subAreas: strings("1 to 15 sub-areas"),
        queries: Type.Array(weighted, { description: "5 to 20 search queries" }),
        outOfScope: Type.Optional(strings("0 to 20 topics that are out of scope")),
      }),
      execute: async (args, api, ctx) => {
        const run = this.run();
        if (run?.status === "failed")
          return toolError("This drafting run has already failed; stop here.", ["Reply with one short sentence."]);
        let charter;
        try {
          charter = validateCharter(args);
        } catch (error) {
          if (!(error instanceof CharterInvalid)) throw error;
          const invalid = await once(api, "invalid", ctx, async () => {
            const current = this.run();
            if (!current) return 0;
            const next = current.invalidSaves + 1;
            this.update({ invalidSaves: next });
            if (next >= MAX_INVALID_SAVES)
              this.update({ status: "failed", reason: `${next} invalid drafts`, endedAt: nowIso() });
            return next;
          });
          return toolError(
            `The draft was not saved: ${error.problems.join("; ")}.`,
            invalid >= MAX_INVALID_SAVES
              ? ["Stop: this run has failed after too many invalid drafts."]
              : error.problems.map((p) => `Correct ${p.split(":")[0]} and call save_charter_draft again.`),
          );
        }
        const id = await once(api, "saved", ctx, async () => {
          const record = deps.charters.saveDraft(charter, "agent");
          this.update({ saved: true });
          return record.id;
        });
        return toolText(
          `Draft saved (#${id}): ${charter.questions.length} questions, ${charter.queries.length} queries, ${charter.concepts.length} concepts.`,
        );
      },
    });
    const ask = defineAppTool({
      name: "ask_scoping_questions",
      description: `Ask the user 1 to 5 scoping questions that change the charter. At most ${MAX_SCOPING_QUESTIONS} in the whole project.`,
      returns: "Text: how many questions were recorded, or why they were refused.",
      parameters: Type.Object({
        questions: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
          minItems: 1,
          maxItems: MAX_SCOPING_QUESTIONS,
        }),
      }),
      execute: async (args, api, ctx) => {
        const round = this.run()?.round ?? 1;
        // Memoized as text: "ok:<n>" or "error:<message>", so a replay neither asks twice nor changes the answer.
        const result = await once<string>(api, "asked", ctx, async () => {
          try {
            return `ok:${
              deps.questions.ask(
                round,
                args.questions.map((q) => q.trim()),
              ).length
            }`;
          } catch (error) {
            return `error:${error instanceof Error ? error.message : String(error)}`;
          }
        });
        if (result.startsWith("error:"))
          return toolError(`Not asked: ${result.slice(6)}.`, ["Save the draft without further questions."]);
        const n = Number(result.slice(3));
        return toolText(`${n} question${n === 1 ? "" : "s"} recorded for the user.`);
      },
    });
    this.tools = { save, ask };
    this.extension = defineExtension({
      name: "charter-writer",
      tools: [save, ask],
      sections: [section("charter-writer", () => system, { tag: false })],
      hooks: [allowOnly("charter-writer", CHARTER_TOOLS)],
    });
  }

  /** Called once the project's harness is open: re-attach to a run that was in flight before a restart. */
  attach(harness: Harness, ctx: Context): void {
    this.harness = harness;
    this.ctx = ctx;
    const run = this.run();
    if (run?.status === "running" && run.submissionId !== undefined) this.watch(run);
  }

  run(): CharterRun | undefined {
    return this.deps.settings.get<CharterRun | null>("charter_run", null) ?? undefined;
  }

  private update(patch: Partial<CharterRun>): void {
    const run = this.run();
    if (run) this.deps.settings.set("charter_run", { ...run, ...patch });
  }

  /** The charter conversation id, created on first use. */
  conversationId(): number | undefined {
    return this.deps.settings.get<number | null>("charter_conversation", null) ?? undefined;
  }

  private async conversation() {
    const { harness, ctx } = this.ready();
    const known = this.conversationId();
    if (known !== undefined) {
      const existing = await harness.conversation(known as ConversationId, ctx);
      if (existing) return existing;
    }
    const created = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: this.deps.catalog.forJob("review"),
          thinkingLevel: "low",
          extensions: [this.extension, this.deps.observe],
        },
      },
      ctx,
    );
    this.deps.settings.set("charter_conversation", created.id as number);
    return created;
  }

  private ready(): { harness: Harness; ctx: Context } {
    if (!this.harness || !this.ctx) throw new Error("The charter writer is not attached to a harness");
    return { harness: this.harness, ctx: this.ctx };
  }

  /** Start the first draft from the brief (or a fresh draft after the brief changed). */
  async draft(): Promise<CharterRun> {
    const brief = this.deps.brief.read();
    if (brief === undefined) throw new Error("There is no brief yet");
    const prompt = loadPrompt(join(this.deps.promptsDir, "agents"), "charter-writer", "USER_PROMPT_draft.md", {
      brief,
      questions_left: String(this.deps.questions.remaining()),
    });
    return this.start("draft", prompt);
  }

  /** Revise the open draft with the answers of the latest round. */
  async revise(answers: { question: string; answer: string }[]): Promise<CharterRun> {
    const draft = this.deps.charters.draft() ?? this.deps.charters.approved();
    const prompt = loadPrompt(join(this.deps.promptsDir, "agents"), "charter-writer", "USER_PROMPT_revise.md", {
      answers: answers.map((a) => `- Q: ${a.question}\n  A: ${a.answer}`).join("\n"),
      draft: JSON.stringify(draft?.charter ?? {}, null, 2),
    });
    return this.start("revision", prompt);
  }

  /** Repeat the last failed run with the same prompt. */
  async retry(): Promise<CharterRun> {
    const run = this.run();
    if (!run) throw new Error("There is no charter run to retry");
    if (run.status !== "failed") throw new Error(`The last charter run is ${run.status}, not failed`);
    return this.start(run.kind, run.prompt);
  }

  private async start(kind: CharterRun["kind"], prompt: string): Promise<CharterRun> {
    if (this.run()?.status === "running") throw new CharterBusy();
    const previous = this.run();
    const run: CharterRun = {
      id: (previous?.id ?? 0) + 1,
      kind,
      status: "running",
      round: (previous?.round ?? 0) + 1,
      invalidSaves: 0,
      saved: false,
      startedAt: nowIso(),
      prompt,
    };
    this.deps.settings.set("charter_run", run);
    const { ctx } = this.ready();
    const conversation = await this.conversation();
    const submission = await conversation.submit(
      { type: "input", content: prompt, requestId: `charter:${run.id}` },
      ctx,
    );
    this.update({ submissionId: submission.id as number });
    this.deps.log.info("charter.run_started", { run: run.id, kind, submissionId: submission.id });
    const started = this.run()!;
    this.watch(started);
    return started;
  }

  private watch(run: CharterRun): void {
    if (run.submissionId === undefined || this.watching.has(run.id)) return;
    this.watching.add(run.id);
    const { harness, ctx } = this.ready();
    void (async () => {
      try {
        const submission = await harness.submission(run.submissionId as SubmissionId, ctx);
        if (submission) await submission.wait(ctx);
        this.settle(run.id);
      } catch (error) {
        this.deps.log.warn("charter.watch_failed", { run: run.id, error: String(error) });
      } finally {
        this.watching.delete(run.id);
      }
    })();
  }

  /** Decide a finished run: done when it saved a draft, failed otherwise. */
  settle(runId: number): CharterRun | undefined {
    const run = this.run();
    if (!run || run.id !== runId || run.status !== "running") return run;
    if (run.saved) this.update({ status: "done", endedAt: nowIso() });
    else this.update({ status: "failed", reason: "the run ended without saving a draft", endedAt: nowIso() });
    const settled = this.run()!;
    this.deps.log.info("charter.run_settled", { run: runId, status: settled.status, reason: settled.reason });
    return settled;
  }
}
