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
import {
  loadSample,
  SampleUnavailable,
  type DatasetIo,
  type RetrievalSample,
} from "../../src/harness/benchmarks/datasets.ts";
import { facetsTask, retrievalTask, type TaskResult } from "../../src/harness/benchmarks/runner.ts";
import type { EmbedderExports } from "../rh.papers/main.ts";
import type { SourceAttribution } from "@rh/sdk";
import { sourceAttribution } from "../../src/harness/attribution.ts";
import { converterTask, loadConverterSample } from "../../src/harness/benchmarks/converter.ts";
import type { FullTextExports } from "../rh.fulltext/main.ts";

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

export class BenchmarkInvalid extends Error {}

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
  const datasetIo: DatasetIo = {
    offline: host.offline,
    fetchBytes: async (url) => {
      const res = await rh.http.request(url, { timeoutMs: 300_000, budgetMs: 600_000, attempts: 2 });
      if (!res.ok) throw new Error(`downloading ${url} failed: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    readCache: (name) => (rh.files.exists("storage", name) ? rh.files.read("storage", name) : undefined),
    writeCache: (name, content) => rh.files.write("storage", name, content),
  };
  const costSince = (since: string) =>
    Number(
      (
        db
          .prepare(
            "SELECT (SELECT COALESCE(SUM(cost_usd), 0) FROM embedding_calls WHERE created_at >= ?) + (SELECT COALESCE(SUM(CASE WHEN cost_source IN ('reported','estimated') THEN cost_usd END), 0) FROM jev_calls WHERE created_at >= ?) c",
          )
          .get(since, since) as { c: number }
      ).c,
    );
  /** The project's own task: each research question ranks your liked papers (on its question) among others. */
  const yourStars = (): Pick<RetrievalSample, "queries" | "docs" | "relevant"> => {
    const charter = db
      .prepare("SELECT body_json FROM charters WHERE status = 'approved' ORDER BY version DESC LIMIT 1")
      .get() as { body_json: string } | undefined;
    const questions = charter ? (JSON.parse(charter.body_json).questions as { id: string; text: string }[]) : [];
    const liked = db
      .prepare(
        "SELECT p.id, p.title, p.abstract, c.matched_question q FROM judgments j JOIN cards c ON c.id = j.card_id JOIN papers p ON p.id = j.paper_id WHERE j.verdict IN ('up', 'star')",
      )
      .all() as { id: number; title: string; abstract: string | null; q: string | null }[];
    const likedIds = new Set(liked.map((l) => Number(l.id)));
    const others = (
      db.prepare("SELECT id, title, abstract FROM papers ORDER BY id DESC LIMIT 400").all() as {
        id: number;
        title: string;
        abstract: string | null;
      }[]
    )
      .filter((p) => !likedIds.has(Number(p.id)))
      .slice(0, 200);
    const text = (p: { title: string; abstract: string | null }) => `${p.title}. ${p.abstract ?? ""}`.slice(0, 2_000);
    const relevant: Record<string, string[]> = {};
    for (const l of liked) if (l.q) (relevant[l.q] ??= []).push(String(l.id));
    return {
      queries: questions.filter((q) => relevant[q.id]?.length).map((q) => ({ id: q.id, text: q.text })),
      docs: [...liked, ...others].map((p) => ({ id: String(p.id), text: text(p) })),
      relevant,
    };
  };
  /** Store a benchmark run (the slot's preset is the slot's id). */
  const record = (run: Omit<BenchmarkRecord, "id" | "createdAt" | "preset">): BenchmarkRecord => {
    const createdAt = new Date().toISOString();
    const { slot, candidate, result, costUsd } = run;
    const inserted = db
      .prepare(
        `INSERT INTO ${benchmarksTable} (slot, preset, candidate_json, result_json, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(slot, slot, JSON.stringify(candidate), JSON.stringify(result), costUsd, createdAt);
    context.log.info("harness.benchmark", { slot, candidate, value: result.value, costUsd });
    return { id: Number(inserted.lastInsertRowid), slot, preset: slot, candidate, result, costUsd, createdAt };
  };
  const mean = (tasks: TaskResult[]) => {
    const v = tasks.map((t) => t.value).filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const sampleTask = async (
    name: "scidocs" | "litsearch",
    embed: (t: string[]) => Promise<Float32Array[]>,
  ): Promise<TaskResult> => {
    try {
      return await retrievalTask(name, (await loadSample(name, datasetIo)).sample, embed);
    } catch (error) {
      if (error instanceof SampleUnavailable || error instanceof Error)
        return { task: name, metric: "nDCG@10", value: null, items: 0, note: error.message };
      throw error;
    }
  };
  const sourceOwner = (source: string) => {
    for (const c of host.services.contributions.declaredContributions("papers.source"))
      if (c.id === source) return c.pluginId;
    return null;
  };
  const benchmarkRanking = async (candidate: Record<string, unknown>) => {
    const { report } = await exports.replay(candidate as Variant, "benchmark");
    const task = {
      task: "replay",
      metric: "held-out nDCG difference",
      value: report.heldOut.diff,
      items: report.sweeps.labelled,
    };
    return record({
      slot: "ranking",
      candidate,
      result: { tasks: [task], value: report.heldOut.diff, label: report.verdict },
      costUsd: 0,
    });
  };

  const benchmarkJudge = async () => {
    const started = new Date().toISOString();
    const calibration = await judge.calibrate();
    const task = {
      task: "your judged cards",
      metric: "agreement",
      value: calibration.agreement,
      items: calibration.cases,
    };
    return record({
      slot: "judge",
      candidate: {},
      result: { tasks: [task], value: calibration.agreement, label: calibration.trusted ? "trusted" : "not trusted" },
      costUsd: costSince(started),
    });
  };

  const benchmarkEmbedder = async (candidate: Record<string, unknown>) => {
    const started = new Date().toISOString();
    const { model, dims, local } = embedderCandidate(candidate);
    const choice = host.services.contributions.activeContribution("papers.embedder", host.settingsOf("rh.papers"));
    const provider = await host.exportsOf<EmbedderExports>(
      local ? "rh.embedder-local" : (choice?.pluginId ?? "rh.embedder-openrouter"),
    );
    const embedder = provider.createEmbedder({
      ledger: papers.embeddingLedger,
      ...(model ? { model } : {}),
      ...(dims ? { dims } : {}),
    });
    const embed = (texts: string[]) => embedder.embed(texts);
    const tasks = [
      await sampleTask("scidocs", embed),
      await sampleTask("litsearch", embed),
      await retrievalTask("your-stars", yourStars(), embed),
    ];
    const value = mean(tasks);
    return record({
      slot: "embedder",
      // The model asked for (offline, the fake embedder stands in for it).
      candidate: {
        model: candidateModel(model, local) ?? embedder.model,
        dims: embedder.dims,
        ...(model ? { candidate: true } : {}),
        ...(local ? { provider: "local" } : {}),
      },
      result: { tasks, value, label: value === null ? "no result" : `nDCG@10 ${value.toFixed(3)}` },
      costUsd: costSince(started),
    });
  };

  const benchmarkConverter = async (candidate: Record<string, unknown>) => {
    const converter = candidate.converter;
    if (converter !== undefined && (typeof converter !== "string" || !/^[a-z0-9-]+$/.test(converter)))
      throw new BenchmarkInvalid("converter must be a converter id like pdf-text or docling");
    const fulltext = await host.exportsOf<FullTextExports>("rh.fulltext");
    const views = await fulltext.converters();
    const chosen = typeof converter === "string" ? views.find((v) => v.id === converter) : views.find((v) => v.active);
    if (!chosen) throw new BenchmarkInvalid(`no converter ${String(converter)}`);
    if (!chosen.available) throw new BenchmarkInvalid(`${chosen.title} is not available here: ${chosen.reason ?? ""}`);
    const { perPaper, ...task } = await converterTask(await loadConverterSample(datasetIo), (pdf) =>
      fulltext.convert(pdf, chosen.id),
    );
    const scores = perPaper.map(
      (paper) => `${paper.id} F1 ${paper.f1.toFixed(2)} headings ${paper.headings.toFixed(2)}`,
    );
    const note = [task.note, scores.join("; ")].filter(Boolean).join(" | ").slice(0, 2_000);
    return record({
      slot: "converter",
      candidate: { converter: chosen.id, ...(converter ? { candidate: !chosen.active } : {}) },
      result: {
        tasks: [{ ...task, note }],
        value: task.value,
        label: task.value === null ? "no result" : `score ${task.value.toFixed(3)}`,
      },
      costUsd: 0,
    });
  };

  const benchmarkFacets = async () => {
    const started = new Date().toISOString();
    let task: TaskResult;
    try {
      task = await facetsTask((await loadSample("pubmed-rct", datasetIo)).sample, (title, sentences) =>
        papers.facets.labelSentences(title, sentences),
      );
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      task = { task: "pubmed-rct", metric: "macro-F1", value: null, items: 0, note };
    }
    return record({
      slot: "facets",
      candidate: { labeler: "Jev abstract-facets" },
      result: {
        tasks: [task],
        value: task.value,
        label: task.value === null ? "no result" : `macro-F1 ${task.value.toFixed(3)}`,
      },
      costUsd: costSince(started),
    });
  };

  /** Each slot's preset (slots without one are not listed). */
  const benchmarkOf: Record<string, (candidate: Record<string, unknown>) => Promise<BenchmarkRecord>> = {
    ranking: benchmarkRanking,
    judge: benchmarkJudge,
    embedder: benchmarkEmbedder,
    converter: benchmarkConverter,
    facets: benchmarkFacets,
  };

  const exports: HarnessExports = {
    attribution(
      from = new Date(Date.now() - 30 * 86_400_000).toISOString(),
      to = new Date(Date.now() + 1000).toISOString(),
    ) {
      return sourceAttribution(db, from, to, sourceOwner);
    },
    benchmarks,
    async runBenchmark(slotId, candidate = {}) {
      const slot = SLOTS.find((s) => s.id === slotId);
      if (!slot) throw new BenchmarkInvalid(`No slot ${slotId}`);
      const benchmark = benchmarkOf[slotId];
      if (!slot.preset || !benchmark) throw new BenchmarkInvalid(`The ${slot.title} slot has no benchmark preset yet`);
      return benchmark(candidate);
    },
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
        converter: (() => {
          const c = host.services.contributions.activeContribution(
            "fulltext.converter",
            host.settingsOf("rh.fulltext"),
          );
          return {
            name: String(c?.title ?? "none"),
            pluginId: c?.pluginId ?? "rh.converter-pdf",
            detail: { converter: c?.id },
          };
        })(),
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

/** An embedder candidate checked: an OpenRouter model id, or a local model folder, and a vector size. */
function embedderCandidate(candidate: Record<string, unknown>): { model?: string; dims?: number; local: boolean } {
  const { model, dims } = candidate;
  const local = candidate.provider === "local";
  if (local && (typeof model !== "string" || !model))
    throw new BenchmarkInvalid("a local candidate needs model (a folder inside the data folder)");
  if (!local && model !== undefined && (typeof model !== "string" || !/^[a-z0-9-]+\/[\w.:-]+$/i.test(model)))
    throw new BenchmarkInvalid("model must be an OpenRouter model id like google/gemini-embedding-2");
  if (dims !== undefined && (!Number.isInteger(dims) || (dims as number) < 32 || (dims as number) > 4096))
    throw new BenchmarkInvalid("dims must be a whole number from 32 to 4096");
  return { ...(typeof model === "string" ? { model } : {}), ...(typeof dims === "number" ? { dims } : {}), local };
}

/** The model a benchmark record names: the candidate asked for (local models prefixed), else the active one. */
function candidateModel(model: unknown, local: boolean): string | undefined {
  if (typeof model !== "string") return undefined;
  return local ? `local/${model}` : model;
}
