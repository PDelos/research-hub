// Built-in plugin rh.engineer (spec engineer; design v1-8): ideas become plugins. Each idea is researched (web search
// and the review model) and assessed; on the user's Build it is built and tested, and a passing plugin is proposed with
// its numbers. Nothing is installed enabled without the user's approval.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Charter } from "../../src/charter.ts";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import type { CharterExports } from "../rh.charter/main.ts";
import type { ProviderExports } from "../rh.provider-openrouter/main.ts";
import type { HarnessExports } from "../rh.harness/main.ts";
import type { LocalEmbedderExports } from "../rh.embedder-local/main.ts";
import { finetuneBuilder } from "./finetune-builder.ts";
import { assessIdea, type IdeaKind } from "./assess.ts";
import { EngineerInvalid, IdeaStore } from "./ideas.ts";

export { EngineerInvalid } from "./ideas.ts";
import { sourcePluginBuilder } from "./source-plugin-builder.ts";

export { ENGINEER_ASSESS_MARKER, IDEA_KINDS, type IdeaKind } from "./assess.ts";
export type Stage =
  | "researching"
  | "assessed"
  | "building"
  | "proposed"
  | "installed"
  | "rejected"
  | "failed"
  | "not-buildable";

export interface Assessment {
  worth: boolean;
  kind: IdeaKind;
  gain: string;
  cost: string;
  risk: string;
  plan: string;
  api?: { baseUrl?: string; docsUrl?: string; name?: string };
  citations?: { url: string; title?: string }[];
}

export interface Idea {
  id: number;
  source: "suggestion" | "user" | "slot";
  text: string;
  stage: Stage;
  assessment: Assessment | null;
  pluginId: string | null;
  log: { at: string; text: string }[];
  numbers: Record<string, unknown> | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

/** A builder for one kind of idea: builds, tests and leaves a proposal (or throws with the reason). */
export interface BuildContext {
  idea: Idea;
  say(text: string): void;
  /** The idea's own folder under the data directory. */
  dir: string;
}
export type Builder = (b: BuildContext) => Promise<{ pluginId?: string; numbers?: Record<string, unknown> }>;

export interface EngineerExports {
  ideas(limit?: number): Idea[];
  idea(id: number): Idea;
  /** Start working on an idea (research and assessment run in the background). */
  propose(text: string, source?: Idea["source"]): Idea;
  build(id: number): Idea;
  reject(id: number): Promise<Idea>;
  /** A built plugin: enable it (it was installed disabled) or remove it. */
  enable(id: number): Promise<Idea>;
  /** Builders for other kinds (v1-8 task 2: the fine-tuned embedder). */
  registerBuilder(kind: IdeaKind, builder: Builder): void;
  /** Wait for the idea's current stage to finish (tests). */
  settled(id: number): Promise<Idea>;
}

/** Reject an idea that is not in progress; a proposed plugin is removed. */
async function rejectIdea(host: ReturnType<typeof hostOf>, store: IdeaStore, id: number): Promise<void> {
  const current = store.get(id);
  if (!["assessed", "proposed", "not-buildable", "failed"].includes(current.stage))
    throw new EngineerInvalid(`idea ${id} is ${current.stage}`);
  if (current.stage === "proposed" && current.pluginId)
    await host.manage
      .uninstall(current.pluginId, "user")
      .catch((error) => store.say(id, `Remove failed: ${String(error)}`));
  store.update(id, { stage: "rejected" });
  store.say(id, current.stage === "proposed" ? "Rejected; the plugin was removed." : "Rejected.");
}

/** Switch the Embedder slot to the fine-tuned model: two undoable settings; papers re-embed in the background. */
async function switchToFinetuned(host: ReturnType<typeof hostOf>, store: IdeaStore, current: Idea): Promise<void> {
  const { model, dims } = current.numbers as { model: string; dims: number };
  await host.configure("rh.embedder-local", { model, dims }, `proposal:engineer-${current.id}`);
  await host.configure("rh.papers", { "papers.embedder": "local" }, `proposal:engineer-${current.id}`);
  store.update(current.id, { stage: "installed" });
  store.say(
    current.id,
    `Switched the embedder to the fine-tuned model (${model}); the papers are re-embedded in the background.`,
  );
}

/** The kinds of plugin the engineer can build: a paper source for a free API, and a fine-tuned embedder. */
function defaultBuilders(context: PluginContext, store: IdeaStore, charter: () => Charter | undefined) {
  const host = hostOf(context);
  const builders = new Map<IdeaKind, Builder>();
  builders.set(
    "paper-source",
    sourcePluginBuilder({
      rh: context.rh,
      host,
      charge: (id, usd) => store.charge(id, usd),
      testQuery: () => charter()?.queries[0]?.text ?? "protein language model",
      maxAttempts: () => context.settings.maxAttempts as number,
    }),
  );
  builders.set(
    "embedder-finetune",
    finetuneBuilder({
      db: host.db,
      rh: context.rh,
      dataDir: host.dir,
      project: host.name,
      charter,
      harness: context.exports["rh.harness"] as HarnessExports,
      local: () => host.exportsOf<LocalEmbedderExports>("rh.embedder-local"),
    }),
  );
  return builders;
}

/** Research and builds run in the background, one per idea; a failure is logged on the idea and marks it failed. */
class Background {
  private readonly running = new Map<number, Promise<void>>();

  constructor(
    private readonly store: IdeaStore,
    private readonly log: PluginContext["log"],
  ) {}

  run(id: number, work: () => Promise<void>): void {
    const promise = work()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.store.say(id, `Failed: ${message}`);
        this.store.update(id, { stage: "failed" });
        this.log.warn("engineer.failed", { idea: id, error: message });
      })
      .finally(() => this.running.delete(id));
    this.running.set(id, promise);
  }

  async settled(id: number): Promise<void> {
    await this.running.get(id);
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.running.values());
  }
}

export function activate(context: PluginContext): EngineerExports {
  const host = hostOf(context);
  const { db } = host;
  const { rh } = context;
  const provider = context.exports["rh.provider-openrouter"] as ProviderExports;
  const { charters } = context.exports["rh.charter"] as CharterExports;
  const store = new IdeaStore(rh, db, context.log);
  const idea = (id: number) => store.get(id);
  const update: IdeaStore["update"] = (id, fields) => store.update(id, fields);
  const say = (id: number, text: string) => store.say(id, text);

  const assess = (id: number) =>
    assessIdea(
      { store, provider, rh, charter: () => charters.approved()?.charter, canBuild: (kind) => builders.has(kind) },
      id,
    );

  const builders = defaultBuilders(context, store, () => charters.approved()?.charter);

  const background = new Background(store, context.log);
  const runInBackground = (id: number, work: () => Promise<void>) => background.run(id, work);

  const exports: EngineerExports = {
    ideas: (limit = 50) => store.list(limit),
    idea,
    propose(text, source = "user") {
      const body = text.trim().replace(/\s+/g, " ");
      if (body.length < 5) throw new EngineerInvalid("describe the idea in a few words");
      if (body.length > 2_000) throw new EngineerInvalid("an idea is at most 2,000 characters");
      const id = store.add(source, body);
      runInBackground(id, () => assess(id));
      return idea(id);
    },
    build(id) {
      const current = idea(id);
      if (current.stage !== "assessed") throw new EngineerInvalid(`idea ${id} is ${current.stage}`);
      const builder = builders.get(current.assessment!.kind);
      if (!builder) throw new EngineerInvalid(`the engineer cannot build ${current.assessment!.kind} plugins`);
      update(id, { stage: "building" });
      say(id, "Building.");
      const dir = join(host.dir, "engineer", String(id));
      mkdirSync(dir, { recursive: true });
      runInBackground(id, async () => {
        const result = await builder({ idea: idea(id), say: (t) => say(id, t), dir });
        update(id, {
          stage: "proposed",
          plugin_id: result.pluginId ?? null,
          numbers_json: result.numbers ? JSON.stringify(result.numbers) : null,
        });
      });
      return idea(id);
    },
    async reject(id) {
      await rejectIdea(host, store, id);
      return idea(id);
    },
    async enable(id) {
      const current = idea(id);
      if (current.stage !== "proposed") throw new EngineerInvalid(`idea ${id} has nothing waiting`);
      if (current.assessment?.kind === "embedder-finetune") {
        await switchToFinetuned(host, store, current);
        return idea(id);
      }
      if (!current.pluginId) throw new EngineerInvalid(`idea ${id} has no plugin waiting`);
      await host.manage.setEnabled(current.pluginId, true, "user");
      update(id, { stage: "installed" });
      say(id, `Enabled ${current.pluginId}.`);
      return idea(id);
    },
    registerBuilder(kind, builder) {
      builders.set(kind, builder);
    },
    async settled(id) {
      await background.settled(id);
      return idea(id);
    },
  };
  context.subscriptions.push({ dispose: () => background.drain() });
  return exports;
}
