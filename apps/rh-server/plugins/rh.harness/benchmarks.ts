// Each slot's benchmark preset (spec harness: Slots and benchmarks; design v1-3, v1-4, v1-6): ranking by replay,
// the judge by its agreement with the user, embedders on SciDocs, LitSearch and the user's own stars, converters on
// arXiv papers with known sections, facets on PubMed RCT. Each run is stored with what it cost.
import type { BuiltinHost } from "../../src/kernel/builtin.ts";
import type { RhApi } from "../../src/kernel/api.ts";
import type { Variant } from "../../src/harness/replay.ts";
import {
  loadSample,
  SampleUnavailable,
  type DatasetIo,
  type RetrievalSample,
} from "../../src/harness/benchmarks/datasets.ts";
import { facetsTask, retrievalTask, type TaskResult } from "../../src/harness/benchmarks/runner.ts";
import { converterTask, loadConverterSample } from "../../src/harness/benchmarks/converter.ts";
import type { EmbedderExports, PapersExports } from "../rh.papers/main.ts";
import type { FullTextExports } from "../rh.fulltext/main.ts";
import type { Judge } from "./judge.ts";
import type { HarnessStore } from "./store.ts";
import type { BenchmarkRecord, StoredReplay } from "./main.ts";

export class BenchmarkInvalid extends Error {}

type Candidate = Record<string, unknown>;

/** An embedder candidate checked: an OpenRouter model id, or a local model folder, and a vector size. */
function embedderCandidate(candidate: Candidate): { model?: string; dims?: number; local: boolean } {
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

const mean = (tasks: TaskResult[]) => {
  const values = tasks.map((t) => t.value).filter((x): x is number => x !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
};

export interface BenchmarkDeps {
  host: BuiltinHost;
  rh: RhApi;
  papers: PapersExports["papers"];
  judge: Judge;
  store: HarnessStore;
  replay: (variant: Variant, requestedBy: string) => Promise<StoredReplay>;
}

export class Benchmarks {
  private readonly datasetIo: DatasetIo;
  /** Each slot's preset (slots without one are not listed). */
  readonly of: Record<string, (candidate: Candidate) => Promise<BenchmarkRecord>> = {
    ranking: (candidate) => this.ranking(candidate),
    judge: () => this.judge(),
    embedder: (candidate) => this.embedder(candidate),
    converter: (candidate) => this.converter(candidate),
    facets: () => this.facets(),
  };

  constructor(private readonly deps: BenchmarkDeps) {
    const { rh } = deps;
    this.datasetIo = {
      offline: deps.host.offline,
      fetchBytes: async (url) => {
        const response = await rh.http.request(url, { timeoutMs: 300_000, budgetMs: 600_000, attempts: 2 });
        if (!response.ok) throw new Error(`downloading ${url} failed: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
      readCache: (name) => (rh.files.exists("storage", name) ? rh.files.read("storage", name) : undefined),
      writeCache: (name, content) => rh.files.write("storage", name, content),
    };
  }

  /** Embeddings and Jev calls since `since` (what a benchmark run spent). */
  private costSince(since: string): number {
    const row = this.deps.host.db
      .prepare(
        "SELECT (SELECT COALESCE(SUM(cost_usd), 0) FROM embedding_calls WHERE created_at >= ?) + (SELECT COALESCE(SUM(CASE WHEN cost_source IN ('reported','estimated') THEN cost_usd END), 0) FROM jev_calls WHERE created_at >= ?) c",
      )
      .get(since, since) as { c: number };
    return Number(row.c);
  }

  /** The project's own task: each research question ranks your liked papers (on its question) among others. */
  private yourStars(): Pick<RetrievalSample, "queries" | "docs" | "relevant"> {
    const { db } = this.deps.host;
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
  }

  private async sampleTask(
    name: "scidocs" | "litsearch",
    embed: (t: string[]) => Promise<Float32Array[]>,
  ): Promise<TaskResult> {
    try {
      return await retrievalTask(name, (await loadSample(name, this.datasetIo)).sample, embed);
    } catch (error) {
      if (error instanceof SampleUnavailable || error instanceof Error)
        return { task: name, metric: "nDCG@10", value: null, items: 0, note: error.message };
      throw error;
    }
  }

  private async ranking(candidate: Candidate): Promise<BenchmarkRecord> {
    const { report } = await this.deps.replay(candidate as Variant, "benchmark");
    const task = {
      task: "replay",
      metric: "held-out nDCG difference",
      value: report.heldOut.diff,
      items: report.sweeps.labelled,
    };
    return this.deps.store.record({
      slot: "ranking",
      candidate,
      result: { tasks: [task], value: report.heldOut.diff, label: report.verdict },
      costUsd: 0,
    });
  }

  private async judge(): Promise<BenchmarkRecord> {
    const started = new Date().toISOString();
    const calibration = await this.deps.judge.calibrate();
    const task = {
      task: "your judged cards",
      metric: "agreement",
      value: calibration.agreement,
      items: calibration.cases,
    };
    return this.deps.store.record({
      slot: "judge",
      candidate: {},
      result: { tasks: [task], value: calibration.agreement, label: calibration.trusted ? "trusted" : "not trusted" },
      costUsd: this.costSince(started),
    });
  }

  private async embedder(candidate: Candidate): Promise<BenchmarkRecord> {
    const { host, papers } = this.deps;
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
      await this.sampleTask("scidocs", embed),
      await this.sampleTask("litsearch", embed),
      await retrievalTask("your-stars", this.yourStars(), embed),
    ];
    const value = mean(tasks);
    return this.deps.store.record({
      slot: "embedder",
      // The model asked for (offline, the fake embedder stands in for it).
      candidate: {
        model: candidateModel(model, local) ?? embedder.model,
        dims: embedder.dims,
        ...(model ? { candidate: true } : {}),
        ...(local ? { provider: "local" } : {}),
      },
      result: { tasks, value, label: value === null ? "no result" : `nDCG@10 ${value.toFixed(3)}` },
      costUsd: this.costSince(started),
    });
  }

  private async converter(candidate: Candidate): Promise<BenchmarkRecord> {
    const converter = candidate.converter;
    if (converter !== undefined && (typeof converter !== "string" || !/^[a-z0-9-]+$/.test(converter)))
      throw new BenchmarkInvalid("converter must be a converter id like pdf-text or docling");
    const fulltext = await this.deps.host.exportsOf<FullTextExports>("rh.fulltext");
    const views = await fulltext.converters();
    const chosen = typeof converter === "string" ? views.find((v) => v.id === converter) : views.find((v) => v.active);
    if (!chosen) throw new BenchmarkInvalid(`no converter ${String(converter)}`);
    if (!chosen.available) throw new BenchmarkInvalid(`${chosen.title} is not available here: ${chosen.reason ?? ""}`);
    const { perPaper, ...task } = await converterTask(await loadConverterSample(this.datasetIo), (pdf) =>
      fulltext.convert(pdf, chosen.id),
    );
    const scores = perPaper.map(
      (paper) => `${paper.id} F1 ${paper.f1.toFixed(2)} headings ${paper.headings.toFixed(2)}`,
    );
    const note = [task.note, scores.join("; ")].filter(Boolean).join(" | ").slice(0, 2_000);
    return this.deps.store.record({
      slot: "converter",
      candidate: { converter: chosen.id, ...(converter ? { candidate: !chosen.active } : {}) },
      result: {
        tasks: [{ ...task, note }],
        value: task.value,
        label: task.value === null ? "no result" : `score ${task.value.toFixed(3)}`,
      },
      costUsd: 0,
    });
  }

  private async facets(): Promise<BenchmarkRecord> {
    const started = new Date().toISOString();
    let task: TaskResult;
    try {
      task = await facetsTask((await loadSample("pubmed-rct", this.datasetIo)).sample, (title, sentences) =>
        this.deps.papers.facets.labelSentences(title, sentences),
      );
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      task = { task: "pubmed-rct", metric: "macro-F1", value: null, items: 0, note };
    }
    return this.deps.store.record({
      slot: "facets",
      candidate: { labeler: "Jev abstract-facets" },
      result: {
        tasks: [task],
        value: task.value,
        label: task.value === null ? "no result" : `macro-F1 ${task.value.toFixed(3)}`,
      },
      costUsd: this.costSince(started),
    });
  }
}
