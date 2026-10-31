// Built-in plugin rh.harness (spec harness; design v1-2 D5): replays of past sweeps with a variant of the sweep's
// settings, scored on the user's judgments (and the judge's labels while it is calibrated), with nightly labelling
// within a daily budget, a Quality view and the desk's replay_variant tool.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import { defineAppTool, once, toolError, toolText } from "@rh/durable-agent";
import { loadHistory, userLabels } from "../../src/harness/history.ts";
import { replay, type ReplayReport, type Variant } from "../../src/harness/replay.ts";
import { hostOf, type AgentHooks } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { SettingsInvalid } from "../../src/kernel/settings.ts";
import type { PapersExports } from "../rh.papers/main.ts";
import type { SweepExports } from "../rh.sweep/main.ts";
import { Judge, type Calibration } from "./judge.ts";
import { SLOTS, type SlotInfo } from "../../src/harness/slots.ts";
import type { SourceAttribution } from "@rh/sdk";
import { sourceAttribution } from "../../src/harness/attribution.ts";
import { BenchmarkInvalid, Benchmarks } from "./benchmarks.ts";
import { slotViews } from "./slots.ts";
import { HarnessStore } from "./store.ts";

export interface StoredReplay {
  id: number;
  variant: Variant;
  requestedBy: string;
  createdAt: string;
  report: ReplayReport;
}

export interface Quality {
  judge: Calibration | null;
  /** The current settings replayed over the history: what the user would have seen, scored per sweep. */
  overTime: { sweepId: number; startedAt: string; ndcg?: number; precision5?: number; coverage: number }[];
  labels: { judged: number; judge: number };
  replays: StoredReplay[];
}

export interface BenchmarkRecord {
  id: number;
  slot: string;
  preset: string;
  /** What was measured: the active implementation ({}) or a candidate (e.g. { model }). */
  candidate: Record<string, unknown>;
  result: BenchmarkResult;
  costUsd: number;
  createdAt: string;
}

export interface BenchmarkResult {
  tasks: { task: string; metric: string; value: number | null; items: number; note?: string }[];
  /** The preset's headline number (mean over tasks). */
  value: number | null;
  label: string;
}

export interface SlotView extends SlotInfo {
  active: { name: string; pluginId: string; detail?: Record<string, unknown> };
  alternatives: { pluginId: string; name: string }[];
  last: BenchmarkRecord | null;
}

export { BenchmarkInvalid } from "./benchmarks.ts";

export interface HarnessExports extends AgentHooks {
  /** What each paper source brought in the period (default: the last 30 days). */
  attribution(from?: string, to?: string): SourceAttribution[];
  /** Run a slot's preset on the active implementation ({}) or a candidate, and store the result. */
  runBenchmark(slot: string, candidate?: Record<string, unknown>): Promise<BenchmarkRecord>;
  /** The slot catalog with what is active, the alternatives and the last benchmark of each. */
  slots(): SlotView[];
  benchmarks(slot?: string, limit?: number): BenchmarkRecord[];
  replay(variant: Variant, requestedBy?: string): Promise<StoredReplay>;
  replays(limit?: number): StoredReplay[];
  quality(): Quality;
  judge: Judge;
  /** The nightly work: recalibrate, then label within the budget. */
  night(): Promise<{ calibration: Calibration; labelled: number; stoppedByBudget: boolean }>;
}

/** One line a person can read: "better: nDCG 0.62 → 0.71 on held-out sweeps (+0.09, 95 % interval 0.04 to 0.12)". */
export function summarize(replayReport: ReplayReport): string {
  const twoDecimals = (x: number | undefined) => (x === undefined ? "–" : x.toFixed(2));
  const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
  if (replayReport.verdict === "not enough data")
    return `not enough data: ${replayReport.sweeps.labelled} of ${replayReport.sweeps.total} sweeps have judged cards (3 needed).`;
  return (
    `${replayReport.verdict}: nDCG ${twoDecimals(replayReport.mean.current.ndcg)} → ${twoDecimals(replayReport.mean.candidate.ndcg)}; on the ${replayReport.heldOut.n} latest sweeps ` +
    `${sign(replayReport.heldOut.diff)} (95 % interval ${sign(replayReport.heldOut.low)} to ${sign(replayReport.heldOut.high)}), earlier sweeps ${sign(replayReport.train.diff)}; ` +
    `precision@5 ${twoDecimals(replayReport.mean.current.precision5)} → ${twoDecimals(replayReport.mean.candidate.precision5)}` +
    (replayReport.estimated ? `; ${replayReport.estimated} papers scored with estimated importance` : "") +
    (replayReport.judgeUsed ? "; unjudged papers labelled by the calibrated judge" : "; only your judgments used")
  );
}

export class VariantInvalid extends Error {}

/** The desk's replay_variant tool: "would X be better?" answered from the past sweeps, no new searches. */
function replayTool(replayVariant: HarnessExports["replay"]) {
  return defineAppTool({
    name: "replay_variant",
    description:
      "Replay the project's past sweeps with other sweep settings (relevanceMin, worthMin, rankWeights, cardsPerSweep, explorationPicks) and compare with the current settings on the user's judgments. No new searches or paid calls. Use it to answer 'would X be better?'.",
    returns:
      "Text: the verdict (better, worse, inconclusive, not enough data) with nDCG, the held-out difference and its 95 % interval.",
    parameters: Type.Object({
      variant: Type.Unsafe<Variant>({ type: "object", description: 'e.g. {"cardsPerSweep": 10}' }),
    }),
    execute: async (args, api, toolContext) => {
      const answer = JSON.parse(
        await once<string>(api, "replay", toolContext, async () => {
          try {
            return JSON.stringify({ text: summarize((await replayVariant(args.variant, "desk")).report) });
          } catch (error) {
            return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
          }
        }),
      ) as { text?: string; error?: string };
      return answer.error
        ? toolError(`Not replayed: ${answer.error}`, [
            "Use only relevanceMin, worthMin, rankWeights, cardsPerSweep, explorationPicks.",
          ])
        : toolText(answer.text ?? "");
    },
  });
}

/** Nightly work runs after rh.digest records the night; it finishes before the plugin stops. */
function runNightly(context: PluginContext, night: () => Promise<unknown>): void {
  const pending = new Set<Promise<unknown>>();
  let stopped = false;
  context.rh.events.on("cycle.nightly", () => {
    if (stopped) return;
    const work = night().catch((error) => context.log.warn("harness.night_failed", { error: String(error) }));
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

export async function activate(context: PluginContext): Promise<HarnessExports> {
  const host = hostOf(context);
  const { db } = host;
  const { rh } = context;
  const sweep = context.exports["rh.sweep"] as SweepExports;
  const { papers } = context.exports["rh.papers"] as PapersExports;
  const judge = new Judge(rh, db, { trust_min_agreement: 0.7, trust_min_cases: 20 });
  const store = new HarnessStore(rh, db, judge, context.log);
  const labels = () => {
    const judgeLabels = judge.labelsIfTrusted();
    return { user: userLabels(db), ...(judgeLabels ? { judge: judgeLabels } : {}) };
  };
  const sourceOwner = (source: string) =>
    host.services.contributions.declaredContributions("papers.source").find((c) => c.id === source)?.pluginId ?? null;

  const exports: HarnessExports = {
    attribution(
      from = new Date(Date.now() - 30 * 86_400_000).toISOString(),
      to = new Date(Date.now() + 1000).toISOString(),
    ) {
      return sourceAttribution(db, from, to, sourceOwner);
    },
    benchmarks: (slot, limit = 20) => store.benchmarks(slot, limit),
    async runBenchmark(slotId, candidate = {}) {
      const slot = SLOTS.find((s) => s.id === slotId);
      if (!slot) throw new BenchmarkInvalid(`No slot ${slotId}`);
      const benchmark = benchmarks.of[slotId];
      if (!slot.preset || !benchmark) throw new BenchmarkInvalid(`The ${slot.title} slot has no benchmark preset yet`);
      return benchmark(candidate);
    },
    slots: () => slotViews(host, sweep, judge, store),
    judge,
    async replay(variant, requestedBy = "user") {
      if (!variant || typeof variant !== "object" || Array.isArray(variant))
        throw new VariantInvalid("variant must be an object of sweep settings");
      try {
        sweep.validateVariant(variant);
      } catch (error) {
        if (error instanceof SettingsInvalid) throw new VariantInvalid(error.problems.join("; "));
        throw error;
      }
      const report = replay(loadHistory(db, papers.vectors), sweep.currentSettings(), variant, labels());
      context.log.info("harness.replayed", { variant, verdict: report.verdict, requestedBy });
      return store.addReplay(variant, report, requestedBy);
    },
    replays: (limit = 50) => store.replays(limit),
    quality() {
      const currentLabels = labels();
      const report = replay(loadHistory(db, undefined), sweep.currentSettings(), {}, currentLabels);
      return {
        judge: judge.latestCalibration() ?? null,
        overTime: report.perSweep.map((p) => ({ sweepId: p.sweepId, startedAt: p.startedAt, ...p.current })),
        labels: { judged: currentLabels.user.size, judge: currentLabels.judge?.size ?? 0 },
        replays: store.replays(20),
      };
    },
    async night() {
      const calibration = await judge.calibrate();
      const { labelled, stoppedByBudget } = await judge.labelRecent();
      context.log.info("harness.night", {
        trusted: calibration.trusted,
        agreement: calibration.agreement,
        labelled,
        stoppedByBudget,
      });
      return { calibration, labelled, stoppedByBudget };
    },
  };
  const benchmarks = new Benchmarks({ host, rh, papers, judge, store, replay: (v, by) => exports.replay(v, by) });
  runNightly(context, () => exports.night());
  return {
    ...exports,
    agentExtensions: [
      defineExtension({ name: "harness-tools", tools: [replayTool((v, by) => exports.replay(v, by))] }),
    ],
  };
}
