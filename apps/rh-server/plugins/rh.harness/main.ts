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

export interface HarnessExports extends AgentHooks {
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
export function summarize(r: ReplayReport): string {
  const n = (x: number | undefined) => (x === undefined ? "–" : x.toFixed(2));
  const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
  if (r.verdict === "not enough data")
    return `not enough data: ${r.sweeps.labelled} of ${r.sweeps.total} sweeps have judged cards (3 needed).`;
  return (
    `${r.verdict}: nDCG ${n(r.mean.current.ndcg)} → ${n(r.mean.candidate.ndcg)}; on the ${r.heldOut.n} latest sweeps ` +
    `${sign(r.heldOut.diff)} (95 % interval ${sign(r.heldOut.low)} to ${sign(r.heldOut.high)}), earlier sweeps ${sign(r.train.diff)}; ` +
    `precision@5 ${n(r.mean.current.precision5)} → ${n(r.mean.candidate.precision5)}` +
    (r.estimated ? `; ${r.estimated} papers scored with estimated importance` : "") +
    (r.judgeUsed ? "; unjudged papers labelled by the calibrated judge" : "; only your judgments used")
  );
}

export class VariantInvalid extends Error {}

export async function activate(context: PluginContext): Promise<HarnessExports> {
  const host = hostOf(context);
  const { db } = host;
  const { rh } = context;
  const sweep = context.exports["rh.sweep"] as SweepExports;
  const { papers } = context.exports["rh.papers"] as PapersExports;
  const judge = new Judge(rh, db, { trust_min_agreement: 0.7, trust_min_cases: 20 });
  const replaysTable = rh.db.table("replays");
  const benchmarksTable = rh.db.table("benchmarks");
  rh.db.migrate([
    ...judge.migrations(),
    {
      version: 3,
      sql: `CREATE TABLE ${benchmarksTable} (id INTEGER PRIMARY KEY, slot TEXT NOT NULL, preset TEXT NOT NULL,
              candidate_json TEXT NOT NULL, result_json TEXT NOT NULL, cost_usd REAL NOT NULL, created_at TEXT NOT NULL)`,
    },
    {
      version: 2,
      sql: `CREATE TABLE ${replaysTable} (id INTEGER PRIMARY KEY, variant_json TEXT NOT NULL, report_json TEXT NOT NULL,
              verdict TEXT NOT NULL, requested_by TEXT NOT NULL, created_at TEXT NOT NULL)`,
    },
  ]);

  const toStored = (r: {
    id: number;
    variant_json: string;
    report_json: string;
    requested_by: string;
    created_at: string;
  }): StoredReplay => ({
    id: Number(r.id),
    variant: JSON.parse(r.variant_json) as Variant,
    requestedBy: r.requested_by,
    createdAt: r.created_at,
    report: JSON.parse(r.report_json) as ReplayReport,
  });
  const labels = () => {
    const judgeLabels = judge.labelsIfTrusted();
    return { user: userLabels(db), ...(judgeLabels ? { judge: judgeLabels } : {}) };
  };

  const benchmarks = (slot?: string, limit = 20): BenchmarkRecord[] =>
    (
      db
        .prepare(`SELECT * FROM ${benchmarksTable} ${slot ? "WHERE slot = ?" : ""} ORDER BY id DESC LIMIT ?`)
        .all(...(slot ? [slot, limit] : [limit])) as {
        id: number;
        slot: string;
        preset: string;
        candidate_json: string;
        result_json: string;
        cost_usd: number;
        created_at: string;
      }[]
    ).map((r) => ({
      id: Number(r.id),
      slot: r.slot,
      preset: r.preset,
      candidate: JSON.parse(r.candidate_json),
      result: JSON.parse(r.result_json),
      costUsd: r.cost_usd,
      createdAt: r.created_at,
    }));
  const plugins = () => host.services.contributions;
  const exports: HarnessExports = {
    benchmarks,
    slots() {
      const { options } = host;
      const alternatives = (slot: string) =>
        plugins()
          .slotPlugins(slot)
          .map((p) => ({ pluginId: p.id, name: p.displayName }));
      const replay0 = exports.replays(1)[0];
      const active: Record<string, SlotView["active"]> = {
        ranking: { name: "Rank formula and Jev gates", pluginId: "rh.sweep", detail: { ...sweep.currentSettings() } },
        embedder: {
          name: `${options.papers.embedModel} (${options.papers.embedDims} dimensions)`,
          pluginId: "rh.embedder-openrouter",
          detail: { model: options.papers.embedModel, dims: options.papers.embedDims },
        },
        facets: { name: "Jev abstract-facets", pluginId: "rh.papers" },
        judge: { name: "Jev would-like", pluginId: "rh.harness", detail: { ...judge.latestCalibration() } },
        "kb-search": { name: "SQLite full-text search", pluginId: "rh.kb" },
        models: {
          name: "OpenRouter models per job",
          pluginId: "rh.provider-openrouter",
          detail: { ...options.catalog.jobs },
        },
      };
      return SLOTS.map((slot) => {
        let last = benchmarks(slot.id, 1)[0] ?? null;
        if (slot.id === "ranking" && replay0)
          last = {
            id: replay0.id,
            slot: "ranking",
            preset: "ranking",
            candidate: replay0.variant as Record<string, unknown>,
            result: {
              tasks: [
                {
                  task: "replay",
                  metric: "held-out nDCG difference",
                  value: replay0.report.heldOut.diff,
                  items: replay0.report.sweeps.labelled,
                },
              ],
              value: replay0.report.heldOut.diff,
              label: replay0.report.verdict,
            },
            costUsd: 0,
            createdAt: replay0.createdAt,
          };
        return {
          ...slot,
          active: active[slot.id],
          alternatives: alternatives(slot.id).filter((a) => a.pluginId !== active[slot.id].pluginId),
          last,
        };
      });
    },
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
      const createdAt = new Date().toISOString();
      const r = db
        .prepare(
          `INSERT INTO ${replaysTable} (variant_json, report_json, verdict, requested_by, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(JSON.stringify(variant), JSON.stringify(report), report.verdict, requestedBy, createdAt);
      context.log.info("harness.replayed", { variant, verdict: report.verdict, requestedBy });
      return { id: Number(r.lastInsertRowid), variant, requestedBy, createdAt, report };
    },
    replays(limit = 50) {
      return (
        db.prepare(`SELECT * FROM ${replaysTable} ORDER BY id DESC LIMIT ?`).all(limit) as {
          id: number;
          variant_json: string;
          report_json: string;
          requested_by: string;
          created_at: string;
        }[]
      ).map(toStored);
    },
    quality() {
      const l = labels();
      const report = replay(loadHistory(db, undefined), sweep.currentSettings(), {}, l);
      return {
        judge: judge.latestCalibration() ?? null,
        overTime: report.perSweep.map((p) => ({ sweepId: p.sweepId, startedAt: p.startedAt, ...p.current })),
        labels: { judged: l.user.size, judge: l.judge?.size ?? 0 },
        replays: exports.replays(20),
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

  // Nightly work runs after rh.digest records the night; it finishes before the plugin stops.
  const pending = new Set<Promise<unknown>>();
  let stopped = false;
  rh.events.on("cycle.nightly", () => {
    if (stopped) return;
    const work = exports.night().catch((error) => context.log.warn("harness.night_failed", { error: String(error) }));
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  context.subscriptions.push({
    dispose: async () => {
      stopped = true;
      await Promise.all(pending);
    },
  });

  const tool = defineAppTool({
    name: "replay_variant",
    description:
      "Replay the project's past sweeps with other sweep settings (relevanceMin, worthMin, rankWeights, cardsPerSweep, explorationPicks) and compare with the current settings on the user's judgments. No new searches or paid calls. Use it to answer 'would X be better?'.",
    returns:
      "Text: the verdict (better, worse, inconclusive, not enough data) with nDCG, the held-out difference and its 95 % interval.",
    parameters: Type.Object({
      variant: Type.Unsafe<Variant>({ type: "object", description: 'e.g. {"cardsPerSweep": 10}' }),
    }),
    execute: async (args, api, ctx) => {
      const answer = JSON.parse(
        await once<string>(api, "replay", ctx, async () => {
          try {
            return JSON.stringify({ text: summarize((await exports.replay(args.variant, "desk")).report) });
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
  return { ...exports, agentExtensions: [defineExtension({ name: "harness-tools", tools: [tool] })] };
}
