// The project runtime: the data directory, project.sqlite (app + telemetry), the pi-durable
// harness on agent.sqlite with the research-desk root conversation, the telemetry projector and Jev recording.
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
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
import type { Decide, JevClient, JevLedger } from "@rh/jev";
import { createAgents, type Agents } from "./agents.ts";
import { Brief, Charters, ProjectState, ScopingQuestions } from "./charter.ts";
import { CharterWriter } from "./charter-writer.ts";
import type { PapersConfig, ScheduleDefaults } from "./config.ts";
import { Scheduler } from "./schedule.ts";
import { PaperService } from "./papers/service.ts";
import { PaperDecisions } from "./sweep/decisions.ts";
import { SweepRunner } from "./sweep/sweep.ts";
import { CardStore } from "./sweep/cards.ts";
import { Feedback } from "./feedback/feedback.ts";
import { ReasonParser } from "./feedback/reasons.ts";
import { feedbackTools } from "./feedback/tools.ts";
import { Vault } from "./kb/vault.ts";
import { Ingest } from "./kb/ingest.ts";
import { KbIndex } from "./kb/search.ts";
import { KbViewer } from "./kb/viewer.ts";
import { kbTools } from "./kb/tools.ts";
import { CardWriter } from "./sweep/card-writer.ts";
import { paperTools } from "./papers/tool.ts";
import { ensureVectorTables, openProjectDb, Settings, type Db, type SelfCheck } from "./db.ts";
import type { Logger } from "./logger.ts";
import { Telemetry } from "./telemetry.ts";
import type { BuiltinHost } from "./kernel/builtin.ts";
import { startPluginHost, type PluginHost } from "./kernel/host.ts";
import type { DecisionExports } from "../plugins/rh.decision-jev/main.ts";
import type { ProviderExports } from "../plugins/rh.provider-openrouter/main.ts";

/**
 * v0.0 first stored the project in <data>/projects/default/. Move those files to <data>/ once, so an existing
 * conversation and its runs survive the switch to one project per container.
 */
export function migrateLegacyLayout(dataDir: string, log?: Logger): boolean {
  const legacy = join(dataDir, "projects", "default");
  if (!existsSync(join(legacy, "agent.sqlite")) || existsSync(join(dataDir, "agent.sqlite"))) return false;
  for (const name of readdirSync(legacy)) {
    if (name.endsWith(".lock")) continue;
    renameSync(join(legacy, name), join(dataDir, name));
  }
  for (const dir of [legacy, join(dataDir, "projects")]) {
    try {
      for (const f of readdirSync(dir)) if (f.endsWith(".lock")) rmSync(join(dir, f));
      rmdirSync(dir);
    } catch {}
  }
  log?.info("storage.migrated", { from: legacy, to: dataDir });
  return true;
}

export interface CompactionSetting {
  points: CompactionPoints;
  enabled: boolean;
}

export interface ProjectRuntime {
  readonly name: string;
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
  readonly brief: Brief;
  readonly charters: Charters;
  readonly questions: ScopingQuestions;
  readonly state: ProjectState;
  readonly charterWriter: CharterWriter;
  readonly scheduler: Scheduler;
  readonly papers: PaperService;
  readonly decisions: PaperDecisions;
  readonly sweeps: SweepRunner;
  readonly cards: CardStore;
  readonly feedback: Feedback;
  readonly reasons: ReasonParser;
  readonly vault: Vault;
  readonly ingest: Ingest;
  readonly kbIndex: KbIndex;
  readonly kbViewer: KbViewer;
  /** The project's plugins: kernel, contributions and state (v1-0). */
  readonly plugins: PluginHost;
  /** Create the vault and refresh charter.md after a charter approval. */
  syncVault(): void;
  readonly cardWriter: CardWriter;
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

export interface OpenProjectOptions {
  name: string;
  dataDir: string;
  promptsDir: string;
  catalog: ModelCatalog;
  jev: JevClient;
  log: Logger;
  /** Extra extensions (tests use this to add tools). */
  extensions?: Extension[];
  deskTools?: readonly string[];
  schedule: ScheduleDefaults;
  papers: PapersConfig;
  offline: boolean;
  openrouterKey?: string;
  /** Tests: the fetch used for paper sources and embeddings. */
  paperFetch?: typeof fetch;
  /** Pick up requested sweeps (default true). */
  runSweeps?: boolean;
  /** Tests: answer Jev questions with this instead of the Jev client. */
  decide?: Decide;
  kbViewer?: { enabled: boolean; dir: string; obsidianVersion: string; restartDelays?: number[] };
}

export async function openProject(options: OpenProjectOptions): Promise<ProjectRuntime> {
  const { name, log } = options;
  const dir = options.dataDir;
  mkdirSync(dir, { recursive: true });
  migrateLegacyLayout(dir, log);
  const { db, check } = openProjectDb(join(dir, "project.sqlite"));
  ensureVectorTables(db, options.papers.embedDims);
  const settings = new Settings(db);
  const telemetry = new Telemetry(db);
  const plog = log;
  // Plugins first: built-in plugins provide the services below (design D8).
  const plugins = await startPluginHost({
    dataDir: dir,
    db,
    vaultDir: join(dir, "vault"),
    log: plog,
    ...(options.paperFetch ? { fetch: options.paperFetch } : {}),
    builtinHost: (services): BuiltinHost => ({
      name,
      dir,
      db,
      settings,
      telemetry,
      log: plog,
      offline: options.offline,
      options,
      services,
    }),
  });
  const { catalog } = await plugins.exportsOf<ProviderExports>("rh.provider-openrouter");
  const jevPlugin = await plugins.exportsOf<DecisionExports>("rh.decision-jev");
  const observe = observability({
    event: (e) =>
      plog[e.level === "debug" ? "debug" : e.level](`agent.${e.event}`, {
        conversationId: e.conversationId,
        taskId: e.taskId,
        ...e.data,
      }),
  });
  const brief = new Brief(dir);
  const charters = new Charters(db);
  const questions = new ScopingQuestions(db);
  const state = new ProjectState(settings, brief, charters);
  const charterWriter = new CharterWriter({
    settings,
    charters,
    questions,
    brief,
    catalog,
    promptsDir: options.promptsDir,
    log: plog,
    observe,
  });
  const scheduler = new Scheduler({ db, settings, state, charters, defaults: options.schedule, log: plog });
  const { ledger: jevLedger, decide, jevDir } = jevPlugin;
  // Before the harness opens: a resumed search_papers call may need it during replay.
  const papers = new PaperService({
    db,
    settings,
    config: options.papers,
    offline: options.offline,
    openrouterKey: options.openrouterKey,
    jevDir,
    decide: decide,
    jevLedger,
    log: plog,
    fetch: options.paperFetch,
  });
  const feedback = new Feedback({ db, charters, log: plog });
  feedback.replay();
  const vault = new Vault(join(dir, "vault"), {
    templateDir: join(dirname(options.promptsDir), "vault-template"),
    settings,
    log: plog,
  });
  /** Create the vault and refresh charter.md once a charter is approved (user edits to charter.md win). */
  const syncVault = () => {
    const approved = charters.approved();
    if (!approved) return;
    vault.ensure();
    vault.writeCharter(approved.charter, approved.version!);
  };
  syncVault();
  const decisions = new PaperDecisions({
    db,
    jevDir,
    decide,
    ledger: jevLedger,
    taste: () =>
      feedback
        .recent(8)
        .map((j) => ({ title: j.title, verdict: j.verdict, ...(j.reason ? { reason: j.reason.slice(0, 200) } : {}) })),
  });
  const reasons = new ReasonParser({ db, jevDir, decide, ledger: jevLedger, log: plog });
  // Classify reasons after each judgment (in the background; a Jev failure leaves them pending for the next one).
  feedback.onChange(() => void reasons.parsePending());
  const sweeps = new SweepRunner({
    db,
    settings,
    charters,
    papers,
    decisions,
    log: plog,
    judged: () => feedback.count(),
    judgedPaper: (paperId) => feedback.isJudged(paperId),
    weight: (kind, key, fallback) => feedback.weight(kind, key, fallback),
  });
  const cards = new CardStore(db);
  const cardWriter = new CardWriter({
    db,
    cards,
    runner: sweeps,
    papers,
    decisions,
    charters,
    catalog,
    promptsDir: options.promptsDir,
    log: plog,
    observe,
  });
  sweeps.setCardStage(cardWriter);
  const kbIndex = new KbIndex({ db, vault, log: plog });
  const kbViewer = new KbViewer({
    enabled: options.kbViewer?.enabled ?? false,
    ignisDir: options.kbViewer?.dir ?? "/opt/ignis",
    stateDir: join(dir, "kb-viewer"),
    vaultDir: vault.dir,
    projectName: name,
    obsidianVersion: options.kbViewer?.obsidianVersion ?? "1.14.4",
    offline: options.offline,
    log: plog.child({ component: "kb-viewer" }),
    restartDelays: options.kbViewer?.restartDelays,
  });
  const ingest = new Ingest({
    db,
    vault,
    store: papers.store,
    cards,
    feedback,
    charters,
    catalog,
    promptsDir: options.promptsDir,
    log: plog,
    observe,
  });
  // A new ⭐ (or any judgment change) may queue a knowledge-base request.
  feedback.onChange(() => ingest.pickUp());
  const runSweeps = options.runSweeps !== false;
  const unsubscribeSweeps = scheduler.onRequested((run) => {
    if (run.kind === "sweep" && runSweeps) sweeps.pickUp();
  });
  const agents = createAgents({
    promptsDir: options.promptsDir,
    projectName: name,
    extra: [
      observe,
      paperTools(() => papers),
      feedbackTools(() => ({ cards, feedback, store: papers.store })),
      kbTools(() => ({ vault, index: kbIndex })),
      ...(options.extensions ?? []),
    ],
    separate: [charterWriter.extension, cardWriter.extension, ingest.extension],
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
  charterWriter.attach(harness.harness, ctx);
  cardWriter.attach(harness.harness, ctx);
  ingest.attach(harness.harness, ctx);
  ingest.pickUp();
  kbIndex.start();
  void kbViewer.start();
  papers.start();
  if (runSweeps) sweeps.pickUp();
  void reasons.parsePending();

  plog.info("project.opened", { dir, rootConversation: root.id, model: (await model()).id, check });

  return {
    name,
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
    brief,
    charters,
    questions,
    state,
    charterWriter,
    scheduler,
    papers,
    decisions,
    sweeps,
    cards,
    feedback,
    reasons,
    vault,
    ingest,
    kbIndex,
    kbViewer,
    plugins,
    syncVault() {
      syncVault();
      kbIndex.start();
      ingest.pickUp();
      void kbViewer.start();
    },
    cardWriter,
    model,
    compaction: () => ({ ...compaction, window }),
    setCompaction(next) {
      if (next.points) compaction.points = next.points;
      if (next.enabled !== undefined) compaction.enabled = next.enabled;
      settings.set("compaction", compaction);
      return { ...compaction };
    },
    jevPing: (text) => jevPlugin.ping(text),
    async close() {
      scheduler.stop();
      await ingest.close();
      kbIndex.stop();
      await kbViewer.stop();
      unsubscribeSweeps();
      await sweeps.close();
      await papers.close();
      stopProjector();
      await harness.close();
      await plugins.stop();
      db.close();
      plog.info("project.closed", {});
    },
  };
}
