// One project's runtime: its folder under <data>/projects/<slug>/, project.sqlite (app + telemetry), the pi-durable
// harness on agent.sqlite with the research-desk root conversation, the telemetry projector and Jev recording.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Conversation, Extension } from "@earendil-works/pi-durable";
import {
  DEFAULT_POINTS,
  KEEP_RECENT,
  observability,
  openDurableHarness,
  startProjector,
  toPolicy,
  type CompactionPoints,
  type DurableHarness,
  type ModelCatalog,
} from "@rh/durable-agent";
import { JevLedger, loadCommand, runCommand, type JevClient } from "@rh/jev";
import { createAgents, type Agents } from "./agents.ts";
import { openProjectDb, Settings, type Db, type SelfCheck } from "./db.ts";
import type { Logger } from "./logger.ts";
import { Telemetry } from "./telemetry.ts";

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface CompactionSetting {
  points: CompactionPoints;
  enabled: boolean;
}

export interface ProjectRuntime {
  readonly slug: string;
  readonly dir: string;
  readonly db: Db;
  readonly check: SelfCheck;
  readonly settings: Settings;
  readonly telemetry: Telemetry;
  readonly harness: DurableHarness;
  readonly ctx: Context;
  readonly root: Conversation;
  readonly agents: Agents;
  readonly jevLedger: JevLedger;
  model(): Promise<{ id: string; window: number }>;
  compaction(): CompactionSetting & { window: number };
  setCompaction(next: Partial<CompactionSetting>): CompactionSetting;
  /** Run the `ping` Jev command and record it. */
  jevPing(text?: string): Promise<{
    provider: string;
    model: string;
    elapsedMs: number;
    cost: { amount: number | null; source: string };
    greeting: number;
  }>;
  close(): Promise<void>;
}

export async function openProject(options: {
  slug: string;
  dataDir: string;
  promptsDir: string;
  catalog: ModelCatalog;
  jev: JevClient;
  log: Logger;
  /** Extra extensions (tests use this to add tools). */
  extensions?: Extension[];
  deskTools?: readonly string[];
}): Promise<ProjectRuntime> {
  const { slug, catalog, log } = options;
  if (!SLUG.test(slug)) throw new Error(`Invalid project slug "${slug}"`);
  const dir = join(options.dataDir, "projects", slug);
  mkdirSync(dir, { recursive: true });
  const { db, check } = openProjectDb(join(dir, "project.sqlite"));
  const settings = new Settings(db);
  const telemetry = new Telemetry(db);
  const plog = log.child({ project: slug });
  const observe = observability({
    event: (e) => plog[e.level === "debug" ? "debug" : e.level](`agent.${e.event}`, { conversationId: e.conversationId, taskId: e.taskId, ...e.data }),
  });
  const agents = createAgents({
    promptsDir: options.promptsDir,
    projectSlug: slug,
    extra: [observe, ...(options.extensions ?? [])],
    deskTools: options.deskTools,
  });
  const compaction: CompactionSetting = settings.get("compaction", { points: DEFAULT_POINTS, enabled: true });
  let window = 1_000_000;
  const harness = await openDurableHarness({
    dbPath: join(dir, "agent.sqlite"),
    catalog,
    extensions: agents.all,
    defaults: agents.defaults,
    // Keep at most half the background point verbatim, so a low point still leaves something to summarize.
    compaction: () =>
      toPolicy(
        window,
        compaction.points,
        compaction.enabled,
        Math.min(KEEP_RECENT, Math.floor(compaction.points.background / 2)),
      ),
    logger: plog,
  });
  const ctx = harness.ctx;
  const stopProjector = startProjector(harness.harness, telemetry, plog);
  const chatModel = catalog.forJob("chat");
  const root = await harness.harness.root(ctx, { agent: { model: chatModel, thinkingLevel: "low" } });
  // The root conversation keeps the model it was created with; apply the configured chat model on every start.
  const current = (await root.agent(ctx)).model;
  if (current?.modelId !== chatModel.modelId || current?.provider !== chatModel.provider) {
    await root.configure({ model: chatModel }, ctx);
    plog.info("agent.model_applied", { from: current?.modelId, to: chatModel.modelId });
  }
  const model = async () => {
    const agent = await root.agent(ctx);
    const id = agent.model?.modelId ?? chatModel.modelId;
    return { id, window: catalog.info(id)?.contextWindow ?? 1_000_000 };
  };
  window = (await model()).window;
  harness.harness.resume();

  const jevLedger = new JevLedger((record) => telemetry.jevCall(record));
  const jevDir = join(options.promptsDir, "jev");

  plog.info("project.opened", { dir, rootConversation: root.id, model: (await model()).id, check });

  return {
    slug,
    dir,
    db,
    check,
    settings,
    telemetry,
    harness,
    ctx,
    root,
    agents,
    jevLedger,
    model,
    compaction: () => ({ ...compaction, window }),
    setCompaction(next) {
      if (next.points) compaction.points = next.points;
      if (next.enabled !== undefined) compaction.enabled = next.enabled;
      settings.set("compaction", compaction);
      return { ...compaction };
    },
    async jevPing(text = "Good morning, research desk!") {
      const cmd = loadCommand("ping", jevDir);
      try {
        const { result } = await runCommand(cmd, { text }, (s, q, o) => options.jev.systemOne(s, q, o));
        jevLedger.record(result, { command: cmd.name, version: cmd.version });
        const answer = result.answers.greeting as { noul: number };
        return {
          provider: result.meta.provider,
          model: result.meta.resolvedModel,
          elapsedMs: result.meta.elapsedMs,
          cost: result.meta.cost,
          greeting: answer.noul,
        };
      } catch (error) {
        jevLedger.fail(error, { command: cmd.name, version: cmd.version, questions: 1 });
        throw error;
      }
    },
    async close() {
      stopProjector();
      await harness.close();
      db.close();
      plog.info("project.closed", {});
    },
  };
}
