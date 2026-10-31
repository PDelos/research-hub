// What a run does for each focus (spec weekly-upgrade; design v1-4, v1-6): ranking variants replayed on the user's
// judgments (the best "better" one applied as one undoable change), embedder candidates benchmarked and the winner
// proposed, other converters benchmarked and a winner proposed, or add-on sources scouted on the web.
import type { BuiltinHost } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import type { HarnessExports, StoredReplay } from "../rh.harness/main.ts";
import { summarize } from "../rh.harness/main.ts";
import type { EmbedderExports } from "../rh.papers/main.ts";
import type { ProviderExports } from "../rh.provider-openrouter/main.ts";
import type { SweepExports } from "../rh.sweep/main.ts";
import { embedderUpgrade } from "./embedder-upgrade.ts";
import { converterAlternatives, type Focus } from "./focus.ts";
import type { CatalogModel, UpgradeReport } from "./main.ts";
import { jsonArray, plainReason } from "./model-answers.ts";
import { analyze, rankingGrid } from "./ranking.ts";
import type { UpgradeStore } from "./store.ts";

const EMBED_CATALOG = "https://openrouter.ai/api/v1/embeddings/models";
/** A converter must beat the active one by this much on the converter preset. */
const CONVERTER_MARGIN = 0.02;

export type Outcome = { report: Omit<UpgradeReport, "focus" | "reason"> };

export interface ProcedureDeps {
  context: PluginContext;
  host: BuiltinHost;
  harness: HarnessExports;
  sweep: SweepExports;
  store: UpgradeStore;
  research: ProviderExports["research"];
  researchUsd: () => number;
}

/** The embedder plugin active now. */
export async function activeEmbedder(host: BuiltinHost): Promise<EmbedderExports> {
  const choice = host.services.contributions.activeContribution("papers.embedder", host.settingsOf("rh.papers"));
  return host.exportsOf<EmbedderExports>(choice?.pluginId ?? "rh.embedder-openrouter");
}

/** Replay the ranking variants the failure analysis suggests; apply the best one that replays as better. */
async function ranking(deps: ProcedureDeps, runId: number): Promise<Outcome> {
  const { host, harness, sweep, store } = deps;
  const analysis = analyze(host.db);
  const tried: UpgradeReport["tried"] = [];
  let best: { replay: StoredReplay; why: string } | undefined;
  for (const candidate of rankingGrid(sweep.currentSettings(), analysis)) {
    const storedReplay = await harness.replay(candidate.variant, `upgrade-${runId}`);
    const { report } = storedReplay;
    tried.push({
      what: JSON.stringify(candidate.variant),
      why: candidate.why,
      verdict: report.verdict,
      numbers: { heldOutDiff: report.heldOut.diff, heldOutLow: report.heldOut.low },
      note: summarize(report),
    });
    if (report.verdict === "not enough data") break;
    if (report.verdict === "better" && (!best || report.heldOut.low > best.replay.report.heldOut.low))
      best = { replay: storedReplay, why: candidate.why };
  }
  if (!best) {
    const result =
      tried[0]?.verdict === "not enough data"
        ? `Nothing changed: ${tried[0].note}`
        : "Nothing changed: no variant replayed as better.";
    return { report: { analysis, tried, result } };
  }
  await host.configure("rh.sweep", best.replay.variant as Record<string, unknown>, `proposal:upgrade-${runId}`);
  const commit = (await host.pluginHistory(1))[0]?.id ?? null;
  store.addProposal(
    runId,
    "ranking",
    { variant: best.replay.variant, replayId: best.replay.id, why: best.why },
    { commit },
  );
  return {
    report: {
      analysis,
      tried,
      result: `Applied ${JSON.stringify(best.replay.variant)} (${best.why}); ${summarize(best.replay.report)} Undo it from the Upgrades tab or the digest.`,
    },
  };
}

/** OpenRouter's embedding models with their price, context and whether they take a size. */
async function embeddingCatalog(context: PluginContext): Promise<CatalogModel[]> {
  const body = await context.rh.http.json<{
    data?: {
      id: string;
      created?: number;
      context_length?: number;
      pricing?: { prompt?: string | number };
      supported_parameters?: string[];
      description?: string;
    }[];
  }>(EMBED_CATALOG);
  return (body.data ?? []).map((m) => ({
    id: m.id,
    created: m.created ?? 0,
    contextLength: m.context_length ?? 0,
    pricePerMillion: Number(m.pricing?.prompt ?? 0) * 1e6,
    dimensionsParam: (m.supported_parameters ?? []).includes("dimensions"),
    description: (m.description ?? "").slice(0, 300),
  }));
}

async function embedder(deps: ProcedureDeps, runId: number): Promise<Outcome> {
  const { context, store } = deps;
  return embedderUpgrade({
    harness: deps.harness,
    research: deps.research,
    active: (await activeEmbedder(deps.host)).config(),
    catalog: await embeddingCatalog(context),
    maxPricePerMillion: context.settings.maxEmbedPricePerMillion as number,
    maxRunUsd: context.settings.maxRunUsd as number,
    researchUsd: deps.researchUsd,
    propose: (payload) => store.addProposal(runId, "embedder", payload),
  });
}

/** Benchmark each other available converter; propose the best one that beats the active one by the margin. */
async function converter(deps: ProcedureDeps, runId: number): Promise<Outcome> {
  const { harness, store } = deps;
  const alternatives = await converterAlternatives(deps.host);
  if (!alternatives.length)
    return {
      report: {
        tried: [],
        result: "Nothing changed: no other converter is available here (Docling needs the research-hub:full image).",
      },
    };
  const numbers = (r: Awaited<ReturnType<HarnessExports["runBenchmark"]>>) => ({ score: r.result.value });
  const base = await harness.runBenchmark("converter");
  const tried: UpgradeReport["tried"] = [{ what: `${base.candidate.converter} (active)`, numbers: numbers(base) }];
  let winner: { id: string; value: number } | undefined;
  for (const c of alternatives) {
    try {
      const run = await harness.runBenchmark("converter", { converter: c.id });
      const value = run.result.value;
      const wins = value !== null && base.result.value !== null && value >= base.result.value + CONVERTER_MARGIN;
      tried.push({ what: c.title, verdict: wins ? "better" : "not better", numbers: numbers(run) });
      if (wins && (!winner || value > winner.value)) winner = { id: c.id, value };
    } catch (error) {
      tried.push({ what: c.title, note: `failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (!winner) return { report: { tried, result: "Nothing changed: no converter beat the active one by 0.02." } };
  const proposed = store.addProposal(runId, "converter", {
    converter: winner.id,
    value: winner.value,
    activeValue: base.result.value,
    active: base.candidate.converter,
  });
  return {
    report: {
      tried,
      result: `Proposed switching the converter to ${winner.id}: ${winner.value.toFixed(3)} vs ${(base.result.value ?? 0).toFixed(3)}. Approve it in the Upgrades tab (proposal ${proposed.id}).`,
    },
  };
}

const isSuggestion = (x: unknown): x is { name: string; url: string; reason?: string } =>
  !!x &&
  typeof (x as { name?: unknown }).name === "string" &&
  typeof (x as { url?: unknown }).url === "string" &&
  /^https?:\/\//.test((x as { url: string }).url);

/** Ask the web for free paper sources the project does not have yet; list them as add-on suggestions. */
async function scout(deps: ProcedureDeps, runId: number): Promise<Outcome> {
  const { host, store } = deps;
  const charter = host.db
    .prepare("SELECT body_json FROM charters WHERE status = 'approved' ORDER BY version DESC LIMIT 1")
    .get() as { body_json: string } | undefined;
  const body = charter ? (JSON.parse(charter.body_json) as { questions?: { text: string }[] }) : {};
  const installed = host.services.contributions.declaredContributions("papers.source").map((c) => c.id);
  const known = [...installed, ...store.suggestions(true).map((s) => s.name)];
  const questions =
    (body.questions ?? []).map((q) => `- ${q.text}`).join("\n") || "- (no charter yet: AI and bioinformatics)";
  const answer = await deps.research(
    `A self-hosted research assistant collects new scientific papers for these research questions:\n${questions}\n\nIt already has these paper sources: ${installed.join(", ")}. Already suggested: ${known.join(", ") || "none"}.\nSearch the web for up to 5 free scholarly paper APIs or integrations (preprint servers, databases, citation graphs) it does not have yet that fit these questions. Answer only with a JSON array of objects {"name": "...", "url": "<official API or documentation link>", "reason": "<one sentence on why it fits>"}.`,
    { maxResults: 5 },
  );
  const lower = new Set(known.map((k) => k.toLowerCase()));
  const items = jsonArray(answer.text)
    .filter(isSuggestion)
    .filter((x) => !lower.has(x.name.toLowerCase()))
    .slice(0, 5);
  for (const s of items)
    store.addSuggestion(runId, {
      name: s.name.slice(0, 120),
      url: s.url.slice(0, 500),
      reason: plainReason(s.reason, 500),
    });
  return {
    report: {
      analysis: { installed, citations: answer.citations.slice(0, 10) },
      tried: items.map((s) => ({ what: s.name, why: plainReason(s.reason, 500), note: s.url })),
      result: items.length
        ? `${items.length} add-on suggestions listed in the Upgrades tab.`
        : "No new sources or integrations found.",
    },
  };
}

export const PROCEDURES: Record<Focus, (deps: ProcedureDeps, runId: number) => Promise<Outcome>> = {
  ranking,
  embedder,
  converter,
  "scout-addons": scout,
};
