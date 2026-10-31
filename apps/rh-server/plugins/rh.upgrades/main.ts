// Built-in plugin rh.upgrades (spec weekly-upgrade; design v1-4): once every `everyDays` days, after the nightly run,
// it works on exactly one focus chosen by Jev: the ranking slot (variants replayed on the user's judgments, the best
// "better" one applied as one undoable change), the embedder slot (cheap catalog models benchmarked on the fixed
// preset, a winner proposed for approval) or scouting add-ons (sources and integrations suggested from the web).
// It never changes the core or how a slot is measured.
import { hostOf, type BuiltinHost } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import type { HarnessExports } from "../rh.harness/main.ts";
import type { SweepExports } from "../rh.sweep/main.ts";
import type { PapersExports } from "../rh.papers/main.ts";
import type { ProviderExports } from "../rh.provider-openrouter/main.ts";
import { chooseFocus, FOCUSES, type Focus } from "./focus.ts";
import { activeEmbedder, PROCEDURES, type ProcedureDeps } from "./procedures.ts";
import { UpgradeInvalid, UpgradeStore } from "./store.ts";

export { jsonArray, plainReason } from "./model-answers.ts";
export { FOCUS_MIN_CONFIDENCE, FOCUSES, type Focus } from "./focus.ts";
export { UpgradeInvalid } from "./store.ts";

export interface CatalogModel {
  id: string;
  created: number;
  contextLength: number;
  pricePerMillion: number;
  dimensionsParam: boolean;
  description: string;
}

export interface UpgradeReport {
  focus: Focus;
  reason: string;
  /** The ranking analysis, the embedder catalog filter, or the scout question. */
  analysis?: unknown;
  tried: { what: string; why?: string; verdict?: string; numbers?: Record<string, number | null>; note?: string }[];
  result: string;
}

export interface UpgradeRun {
  id: number;
  focus: Focus;
  reason: string;
  status: "running" | "done" | "failed";
  report: UpgradeReport | null;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
  requestedBy: string;
}

export interface Proposal {
  id: number;
  runId: number;
  kind: "ranking" | "embedder" | "converter";
  payload: Record<string, unknown>;
  /** applied: changed right away with undo (ranking); proposed: waits for the user (embedder). */
  status: "applied" | "proposed" | "approved" | "rejected";
  commit: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface Suggestion {
  id: number;
  runId: number;
  name: string;
  url: string;
  reason: string;
  status: "open" | "dismissed";
  createdAt: string;
}

export interface UpgradesExports {
  /** Whether an upgrade is due now (enabled and `everyDays` since the last one; nightly runs drift, so 7 days ≈ 6.5). */
  due(now?: number): boolean;
  /** Whether a run is in progress. */
  busy(): boolean;
  run(options?: { focus?: Focus; requestedBy?: string }): Promise<UpgradeRun>;
  runs(limit?: number): UpgradeRun[];
  proposals(status?: Proposal["status"]): Proposal[];
  suggestions(includeDismissed?: boolean): Suggestion[];
  approve(id: number): Promise<Proposal>;
  reject(id: number): Proposal;
  dismiss(id: number): Suggestion;
  /** The focus Jev picks (or the rotation), with the reason. */
  chooseFocus(): Promise<{ focus: Focus; reason: string; costUsd: number }>;
}

/** Web research is paid per request (OpenRouter's web plugin); it counts in the run's cost and the plugin's budget. */
class ResearchMeter {
  usd = 0;

  constructor(
    private readonly context: PluginContext,
    private readonly provider: ProviderExports,
  ) {}

  research: ProviderExports["research"] = async (prompt, options) => {
    const { budgets } = hostOf(this.context).services;
    budgets.assertWithin(this.context.id, this.context.manifest.permissions.budgetUsdPerDay);
    const result = await this.provider.research(prompt, options);
    this.usd += result.costUsd;
    if (result.costUsd) budgets.charge(this.context.id, result.costUsd);
    return result;
  };
}

/** One run on one focus: chosen (or asked for), worked on, reported with what it cost. */
async function runUpgrade(
  deps: ProcedureDeps & { meter: ResearchMeter; focusOf: () => ReturnType<typeof chooseFocus> },
  focus: Focus | undefined,
  requestedBy: string,
): Promise<UpgradeRun> {
  const { context, host, store, meter } = deps;
  const started = new Date().toISOString();
  meter.usd = 0;
  const chosen = focus
    ? { focus, reason: requestedBy === "user" ? "Asked for by you." : `Asked for by ${requestedBy}.`, costUsd: 0 }
    : await deps.focusOf();
  const id = store.startRun(chosen.focus, chosen.reason, requestedBy, started);
  context.log.info("upgrades.started", { id, focus: chosen.focus });
  let status: UpgradeRun["status"] = "done";
  let report: UpgradeReport;
  try {
    const { report: outcome } = await PROCEDURES[chosen.focus](deps, id);
    report = { focus: chosen.focus, reason: chosen.reason, ...outcome };
  } catch (error) {
    status = "failed";
    const result = `Failed: ${error instanceof Error ? error.message : String(error)}`;
    report = { focus: chosen.focus, reason: chosen.reason, tried: [], result };
    context.log.warn("upgrades.failed", { id, error: String(error) });
  }
  const run = store.finishRun(id, status, report, spentSince(host, started) + meter.usd);
  context.rh.events.emit("upgrade.finished", { id, focus: chosen.focus, status });
  return run;
}

/** Switch the embedder to an approved model; a model without a size parameter tells its size from one embedding. */
async function approveEmbedder(host: BuiltinHost, papers: PapersExports["papers"], current: Proposal): Promise<void> {
  let dims = Number(current.payload.dims);
  if (!dims) {
    const one = (await activeEmbedder(host)).createEmbedder({
      ledger: papers.embeddingLedger,
      model: String(current.payload.model),
      dims: 0,
    });
    dims = (await one.embed(["size probe"]))[0].length;
  }
  await host.configure(
    "rh.embedder-openrouter",
    { model: current.payload.model, dims },
    `proposal:upgrade-${current.runId}`,
  );
}

/** What the run spent: embeddings and Jev calls since it started (the web research is added separately). */
function spentSince(host: BuiltinHost, since: string): number {
  const row = host.db
    .prepare(
      "SELECT (SELECT COALESCE(SUM(cost_usd), 0) FROM embedding_calls WHERE created_at >= ?) + (SELECT COALESCE(SUM(CASE WHEN cost_source IN ('reported','estimated') THEN cost_usd END), 0) FROM jev_calls WHERE created_at >= ?) c",
    )
    .get(since, since) as { c: number };
  return Number(row.c);
}

/** The weekly run starts after the nightly work when due; it finishes before the plugin stops. */
function runWhenDue(context: PluginContext, exports: UpgradesExports): void {
  const pending = new Set<Promise<unknown>>();
  let stopped = false;
  context.rh.events.on("cycle.nightly", () => {
    if (stopped || exports.busy() || !exports.due()) return;
    const work = exports
      .run({ requestedBy: "schedule" })
      .catch((error) => context.log.warn("upgrades.nightly_failed", { error: String(error) }));
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  context.subscriptions.push({
    dispose: async () => {
      stopped = true;
      await Promise.all(pending);
    },
  });
}

export function activate(context: PluginContext): UpgradesExports {
  const host = hostOf(context);
  const harness = context.exports["rh.harness"] as HarnessExports;
  const { papers } = context.exports["rh.papers"] as PapersExports;
  const provider = context.exports["rh.provider-openrouter"] as ProviderExports;
  const store = new UpgradeStore(context.rh, host.db);
  const setting = <V>(key: string) => context.settings[key] as V;

  const meter = new ResearchMeter(context, provider);
  const deps: ProcedureDeps = {
    context,
    host,
    harness,
    sweep: context.exports["rh.sweep"] as SweepExports,
    store,
    research: (prompt, options) => meter.research(prompt, options),
    researchUsd: () => meter.usd,
  };
  const focusOf = () => chooseFocus({ context, host, harness, store });

  const open = (id: number) => {
    const current = store.proposal(id);
    if (current.status !== "proposed") throw new UpgradeInvalid(`proposal ${id} is ${current.status}`);
    return current;
  };

  let running: Promise<UpgradeRun> | undefined;
  const exports: UpgradesExports = {
    due(at = Date.now()) {
      if (!setting<boolean>("enabled")) return false;
      const last = store.lastStart();
      return !last || at - Date.parse(last) >= setting<number>("everyDays") * 0.93 * 86_400_000;
    },
    busy: () => running !== undefined,
    async run({ focus, requestedBy = "user" } = {}) {
      if (focus !== undefined && !FOCUSES.includes(focus))
        throw new UpgradeInvalid(`focus must be one of ${FOCUSES.join(", ")}`);
      if (running) throw new UpgradeInvalid("an upgrade is already running");
      running = runUpgrade({ ...deps, meter, focusOf }, focus, requestedBy);
      try {
        return await running;
      } finally {
        running = undefined;
      }
    },
    runs: (limit = 20) => store.runs(limit),
    proposals: (status) => store.proposals(status),
    suggestions: (includeDismissed) => store.suggestions(includeDismissed),
    async approve(id) {
      const current = open(id);
      if (current.kind === "converter")
        await host.configure(
          "rh.fulltext",
          { "fulltext.converter": current.payload.converter },
          `proposal:upgrade-${current.runId}`,
        );
      else if (current.kind === "embedder") await approveEmbedder(host, papers, current);
      else throw new UpgradeInvalid(`proposal ${id} cannot be approved`);
      store.decide(id, "approved", (await host.pluginHistory(1))[0]?.id ?? null);
      return store.proposal(id);
    },
    reject(id) {
      open(id);
      store.decide(id, "rejected");
      return store.proposal(id);
    },
    dismiss: (id) => store.dismiss(id),
    chooseFocus: focusOf,
  };
  runWhenDue(context, exports);
  return exports;
}
