// The project runtime: the data directory, project.sqlite (app + telemetry), the pi-durable
// harness on agent.sqlite with the research-desk root conversation, the telemetry projector and Jev recording.
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
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
import type { Decide, JevClient, JevLedger } from "@rh/jev";
import type { PapersConfig, ScheduleDefaults } from "./config.ts";
import type { Agents } from "./agents.ts";
import type { Brief, Charters, ProjectState, ScopingQuestions } from "./charter.ts";
import type { CharterWriter } from "./charter-writer.ts";
import type { Scheduler } from "./schedule.ts";
import type { PaperDecisions } from "./sweep/decisions.ts";
import type { SweepRunner } from "./sweep/sweep.ts";
import type { CardStore } from "./sweep/cards.ts";
import type { Feedback } from "./feedback/feedback.ts";
import type { ReasonParser } from "./feedback/reasons.ts";
import type { CardWriter } from "./sweep/card-writer.ts";
import type { PaperService } from "./papers/service.ts";
import type { Vault } from "./kb/vault.ts";
import type { Ingest } from "./kb/ingest.ts";
import type { KbIndex } from "./kb/search.ts";
import type { KbViewer } from "./kb/viewer.ts";
import { openProjectDb, Settings, type Db, type SelfCheck } from "./db.ts";
import type { Profile } from "./config.ts";
import type { Logger } from "./logger.ts";
import { Telemetry } from "./telemetry.ts";
import type { AgentHooks, BuiltinHost } from "./kernel/builtin.ts";
import { startPluginHost, type PluginHost } from "./kernel/host.ts";
import type { CharterExports } from "../plugins/rh.charter/main.ts";
import type { DecisionExports } from "../plugins/rh.decision-jev/main.ts";
import type { DeskExports } from "../plugins/rh.desk/main.ts";
import type { FeedbackExports } from "../plugins/rh.feedback/main.ts";
import type { KbExports } from "../plugins/rh.kb/main.ts";
import type { PapersExports } from "../plugins/rh.papers/main.ts";
import type { ProviderExports } from "../plugins/rh.provider-openrouter/main.ts";
import type { ScheduleExports } from "../plugins/rh.schedule/main.ts";
import type { SweepExports } from "../plugins/rh.sweep/main.ts";

/**
 * v0.0 first stored the project in <data>/projects/default/. Move those files to <data>/ once, so an existing
 * conversation and its runs survive the switch to one project per container.
 */
/** Remove a directory left empty by the move, with its stale lock files; one still in use stays. */
function removeEmptiedDir(dir: string) {
  try {
    for (const file of readdirSync(dir)) if (file.endsWith(".lock")) rmSync(join(dir, file));
    rmdirSync(dir);
  } catch {}
}

export function migrateLegacyLayout(dataDir: string, log?: Logger): boolean {
  const legacy = join(dataDir, "projects", "default");
  if (!existsSync(join(legacy, "agent.sqlite")) || existsSync(join(dataDir, "agent.sqlite"))) return false;
  for (const name of readdirSync(legacy)) {
    if (name.endsWith(".lock")) continue;
    renameSync(join(legacy, name), join(dataDir, name));
  }
  for (const dir of [legacy, join(dataDir, "projects")]) removeEmptiedDir(dir);
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
  /** RH_PROFILE (default full here, so callers that open a project directly keep every feature). */
  profile?: Profile;
}

type HostFactory = NonNullable<Parameters<typeof startPluginHost>[0]["builtinHost"]>;

/** What built-in plugins get as `context.host`: the project's shared services and plugin management. */
function builtinHostFactory(
  shared: Pick<BuiltinHost, "name" | "dir" | "db" | "settings" | "telemetry" | "log" | "options" | "observe">,
  plugins: () => PluginHost,
): HostFactory {
  return (services, exportsOf, pluginState, kernel): BuiltinHost => ({
    ...shared,
    offline: shared.options.offline,
    services,
    exportsOf,
    pluginHistory: (limit = 100) => pluginState.history(limit),
    configure: (pluginId, changes, actor) => kernel().configure(pluginId, changes, actor),
    undo: async (commit, actor) => void (await kernel().undo(commit, actor)),
    settingsOf: (pluginId) => kernel().settings(pluginId),
    // Called after start-up (the engineer builds later), when the plugin host exists.
    manage: {
      install: async (folder, actor) => {
        const plan = await plugins().installer.prepare({ folder });
        await plugins().installer.confirm(plan.planId, actor);
        return plan.id;
      },
      setEnabled: (pluginId, enabled, actor) => kernel().setEnabled(pluginId, enabled, { actor }),
      uninstall: (pluginId, actor) => plugins().installer.uninstall(pluginId, { actor, deleteData: true }),
    },
  });
}

/** The compaction points (saved in settings) and the chat model's context window they apply to. */
class Compaction {
  window = 1_000_000;
  private readonly setting: CompactionSetting;

  constructor(private readonly settings: Settings) {
    this.setting = settings.get("compaction", { points: DEFAULT_POINTS, enabled: true });
  }

  /** Keep at most half the background point verbatim, so a low point still leaves something to summarize. */
  policy() {
    const { points, enabled } = this.setting;
    return toPolicy(this.window, points, enabled, Math.min(KEEP_RECENT, Math.floor(points.background / 2)));
  }

  view() {
    return { ...this.setting, window: this.window };
  }

  set(next: Partial<CompactionSetting>): CompactionSetting {
    if (next.points) this.setting.points = next.points;
    if (next.enabled !== undefined) this.setting.enabled = next.enabled;
    this.settings.set("compaction", this.setting);
    return { ...this.setting };
  }
}

/** The root conversation on the configured chat model, and a way to read its model and context window. */
async function openRoot(harness: ProjectRuntime["harness"], catalog: ModelCatalog, log: Logger) {
  const context = harness.ctx;
  const chatModel = catalog.forJob("chat");
  const root = await harness.harness.root(context, { agent: { model: chatModel, thinkingLevel: "low" } });
  await applyChatModel(root, context, chatModel, log);
  const model = async () => {
    const agent = await root.agent(context);
    const id = agent.model?.modelId ?? chatModel.modelId;
    return { id, window: catalog.info(id)?.contextWindow ?? 1_000_000 };
  };
  return { root, model };
}

/** Agent events into the project log as agent.<event>. */
function agentObserver(log: Logger) {
  return observability({
    event: (e) =>
      log[e.level === "debug" ? "debug" : e.level](`agent.${e.event}`, {
        conversationId: e.conversationId,
        taskId: e.taskId,
        ...e.data,
      }),
  });
}

/** The desk and its separate agents, with every active plugin's agent extensions and tools. */
function projectAgents(
  desk: DeskExports,
  hooks: AgentHooks[],
  observe: ReturnType<typeof agentObserver>,
  options: OpenProjectOptions,
) {
  return desk.createAgents({
    extra: [
      observe,
      ...hooks.flatMap((h) => h?.agentExtensions ?? []),
      desk.pluginTools(),
      ...(options.extensions ?? []),
    ],
    separate: hooks.flatMap((h) => h?.separateExtensions ?? []),
    ...(options.deskTools ? { deskTools: options.deskTools } : {}),
  });
}

/** Every active plugin's agent extensions and lifecycle hooks (the agent runtime is the kernel's, design D2). */
async function agentHooks(plugins: PluginHost): Promise<AgentHooks[]> {
  const hooks: AgentHooks[] = [];
  for (const plugin of plugins.kernel.list())
    if (plugin.state === "active") hooks.push(await plugins.exportsOf<AgentHooks>(plugin.id));
  return hooks;
}

type RootConversation = Awaited<ReturnType<ProjectRuntime["harness"]["harness"]["root"]>>;
type ChatModel = ReturnType<ModelCatalog["forJob"]>;

/** The root conversation keeps the model it was created with; apply the configured chat model on every start. */
async function applyChatModel(
  root: RootConversation,
  context: ProjectRuntime["ctx"],
  chatModel: ChatModel,
  log: Logger,
): Promise<void> {
  const current = (await root.agent(context)).model;
  if (current?.modelId === chatModel.modelId && current?.provider === chatModel.provider) return;
  await root.configure({ model: chatModel }, context);
  log.info("agent.model_applied", { from: current?.modelId, to: chatModel.modelId });
}

/** The project's database and the plugin host; built-in plugins provide the project's services (design D8). */
async function startProjectPlugins(options: OpenProjectOptions) {
  const { name, log } = options;
  const dir = options.dataDir;
  mkdirSync(dir, { recursive: true });
  migrateLegacyLayout(dir, log);
  const { db, check } = openProjectDb(join(dir, "project.sqlite"));
  // The vector tables are sized by the paper service from the embedder plugin's settings (v1-4: they may differ
  // from RH_EMBED_DIMS after an approved upgrade).
  const settings = new Settings(db);
  const telemetry = new Telemetry(db);
  const observe = agentObserver(log);
  const plugins = await startPluginHost({
    dataDir: dir,
    db,
    vaultDir: join(dir, "vault"),
    log,
    // First-start enablement follows the configuration (RH_KB_VIEWER may come from the .env file).
    env: {
      ...process.env,
      RH_KB_VIEWER: options.kbViewer?.enabled === false ? "off" : "on",
      RH_PROFILE: options.profile ?? "full",
    },
    ...(options.paperFetch ? { fetch: options.paperFetch } : {}),
    builtinHost: builtinHostFactory({ name, dir, db, settings, telemetry, log, options, observe }, () => plugins),
  });
  return { db, check, settings, telemetry, observe, plugins };
}

/** Stop in reverse order of use: background work first, then the agent harness, the plugins and the database. */
async function closeProject(parts: {
  scheduler: ProjectRuntime["scheduler"];
  ingest: ProjectRuntime["ingest"];
  kbIndex: ProjectRuntime["kbIndex"];
  kb: KbExports;
  sweeps: ProjectRuntime["sweeps"];
  papers: ProjectRuntime["papers"];
  stopProjector: () => void;
  harness: ProjectRuntime["harness"];
  plugins: PluginHost;
  db: Db;
  log: Logger;
}): Promise<void> {
  parts.scheduler.stop();
  await parts.ingest.close();
  parts.kbIndex.stop();
  await parts.kb.kbViewer().stop();
  await parts.sweeps.close();
  await parts.papers.close();
  parts.stopProjector();
  await parts.harness.close();
  await parts.plugins.stop();
  parts.db.close();
  parts.log.info("project.closed", {});
}

export async function openProject(options: OpenProjectOptions): Promise<ProjectRuntime> {
  const { name, log } = options;
  const dir = options.dataDir;
  const plog = log;
  const { db, check, settings, telemetry, observe, plugins } = await startProjectPlugins(options);
  const { catalog } = await plugins.exportsOf<ProviderExports>("rh.provider-openrouter");
  const jevPlugin = await plugins.exportsOf<DecisionExports>("rh.decision-jev");
  const { brief, charters, questions, state, charterWriter } = await plugins.exportsOf<CharterExports>("rh.charter");
  const { scheduler } = await plugins.exportsOf<ScheduleExports>("rh.schedule");
  const { ledger: jevLedger } = jevPlugin;
  // Before the harness opens: a resumed search_papers call may need it during replay.
  const { papers } = await plugins.exportsOf<PapersExports>("rh.papers");
  const { feedback, reasons } = await plugins.exportsOf<FeedbackExports>("rh.feedback");
  const { decisions, sweeps, cards, cardWriter } = await plugins.exportsOf<SweepExports>("rh.sweep");
  const desk = await plugins.exportsOf<DeskExports>("rh.desk");
  const kb = await plugins.exportsOf<KbExports>("rh.kb");
  const { vault, kbIndex, ingest } = kb;
  const hooks = await agentHooks(plugins);
  const agents = projectAgents(desk, hooks, observe, options);
  const compaction = new Compaction(settings);
  const harness = await openDurableHarness({
    dbPath: join(dir, "agent.sqlite"),
    catalog,
    extensions: agents.all,
    defaults: agents.defaults,
    compaction: () => compaction.policy(),
    logger: plog,
  });
  const context = harness.ctx;
  const stopProjector = startProjector(harness.harness, telemetry, plog);
  const { root, model } = await openRoot(harness, catalog, plog);
  compaction.window = (await model()).window;
  harness.harness.resume();
  for (const h of hooks) h?.attach?.(harness.harness, context);
  for (const h of hooks) h?.ready?.();

  plog.info("project.opened", { dir, rootConversation: root.id, model: (await model()).id, check });

  return {
    name,
    dir,
    db,
    check,
    settings,
    telemetry,
    harness,
    ctx: context,
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
    // The active viewer can change at runtime (kb.viewer): always the current one.
    get kbViewer() {
      return kb.kbViewer();
    },
    plugins,
    syncVault: () => kb.syncVault(),
    cardWriter,
    model,
    compaction: () => compaction.view(),
    setCompaction: (next) => compaction.set(next),
    jevPing: (text) => jevPlugin.ping(text),
    close: () =>
      closeProject({ scheduler, ingest, kbIndex, kb, sweeps, papers, stopProjector, harness, plugins, db, log }),
  };
}
